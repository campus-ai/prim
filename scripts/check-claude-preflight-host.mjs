import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Optional actual-host E2E. Uses only a deterministic loopback Messages provider,
// temporary HOME/config/repo, and a synthetic credential. Never installs or
// upgrades Claude, loads the user's account, or calls a real model provider.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({ options: { binary: { type: "string" } } });
const binaryOption = values.binary ?? process.env.CLI_CLAUDE_BIN ?? "claude";
const binary = binaryOption.includes("/") ? resolve(binaryOption) : binaryOption;
const versionOutput = execFileSync(binary, ["--version"], {
  encoding: "utf8",
  timeout: 5000,
}).trim();
const version = /^(\d+)\.(\d+)\.(\d+)(?=\s|$)/u.exec(versionOutput);
const supportedVersion =
  version &&
  (Number(version[1]) > 2 ||
    (Number(version[1]) === 2 &&
      (Number(version[2]) > 1 || (Number(version[2]) === 1 && Number(version[3]) >= 284))));
if (!supportedVersion)
  throw new Error(
    `Claude 2.1.284+ is required for this host fixture; found ${versionOutput}. Select a compatible binary with --binary or CLI_CLAUDE_BIN. This check never upgrades the host.`,
  );
const hostVersion = version.slice(1).join(".");
const root = mkdtempSync(join(tmpdir(), "prim-claude-host-"));
const cases = ["allow", "conflict", "paused", "malformed", "deadline", "crash", "timeout"];
let current;
let calls = 0;
let preflightRequests = 0;
const routes = [];
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || "{}");
  routes.push({
    path: request.url,
    model: body.model,
    stream: body.stream,
    toolNames: body.tools?.map((x) => x.name),
  });
  if (request.url === "/api/cli/decisions/conflict-check") {
    preflightRequests += 1;
    assert.equal(body.protocolVersion, 4);
    if (current === "malformed") {
      response.setHeader("Content-Type", "application/json");
      response.end("{invalid-json");
      return;
    }
    const paused = current === "paused" || current === "deadline";
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        protocolVersion: 4,
        state: current === "deadline" ? "processing" : paused ? "paused" : "completed",
        checkId: "hostcheck",
        evaluationId: "hosteval",
        verdict: current === "conflict" ? "block" : paused ? "unavailable" : "allow",
        reasonCode:
          current === "conflict"
            ? "high_confidence_contradiction"
            : paused
              ? "semantic_unavailable"
              : "no_conflicts",
        message: paused ? "Fixture evaluation paused" : "Fixture complete",
        conflicts: current === "conflict" ? [{ decisionId: "dec_0123abcd" }] : [],
        bypassed: [],
        evaluationCoverage: {
          candidateCount: 1,
          submittedCount: 1,
          evaluatedCount: paused ? 0 : 1,
          bypassedCount: 0,
          discoveryComplete: true,
          status: paused ? "partial" : "completed",
          semanticBatchCount: 1,
          completedSemanticBatchCount: paused ? 0 : 1,
        },
      }),
    );
    return;
  }
  if (request.url?.startsWith("/v1/messages/count_tokens")) {
    response.setHeader("Content-Type", "application/json");
    response.end('{"input_tokens":100}');
    return;
  }
  if (!request.url?.startsWith("/v1/messages")) {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  calls += 1;
  const first = calls === 1;
  const content = first
    ? {
        type: "tool_use",
        id: "toolu_fixture",
        name: "Bash",
        input: {
          command: "printf sentinel > sentinel.txt",
          description: "Write isolated fixture sentinel",
        },
      }
    : { type: "text", text: "Fixture finished." };
  const message = {
    id: `msg_fixture_${calls}`,
    type: "message",
    role: "assistant",
    model: body.model,
    content: [content],
    stop_reason: first ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
  if (!body.stream) {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(message));
    return;
  }
  response.setHeader("Content-Type", "text/event-stream");
  const send = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("message_start", {
    message: {
      ...message,
      content: [],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });
  send("content_block_start", {
    index: 0,
    content_block: first ? { ...content, input: {} } : { type: "text", text: "" },
  });
  send("content_block_delta", {
    index: 0,
    delta: first
      ? { type: "input_json_delta", partial_json: JSON.stringify(content.input) }
      : { type: "text_delta", text: content.text },
  });
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  send("message_stop", {});
  response.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const results = [];
try {
  for (const name of cases) {
    current = name;
    calls = 0;
    preflightRequests = 0;
    routes.length = 0;
    const cwd = join(root, name);
    const home = join(cwd, "home");
    const claudeHome = join(home, ".claude");
    mkdirSync(claudeHome, { recursive: true });
    const env = {
      HOME: home,
      CLAUDE_CONFIG_DIR: claudeHome,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      PRIM_CONFIG_DIR: join(home, "prim"),
      PRIM_API_URL: url,
      PRIM_TOKEN: "fixture-no-real-credential",
      PRIM_HOOK_MODE: name === "conflict" ? "block" : "warn",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
      ANTHROPIC_BASE_URL: url,
      ANTHROPIC_AUTH_TOKEN: "fixture-no-real-credential",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_UPDATES: "1",
      DISABLE_GROWTHBOOK: "1",
      DISABLE_INSTALLATION_CHECKS: "1",
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_DISABLE_1M_CONTEXT: "1",
    };
    execFileSync("git", ["init", "-q", cwd], { env });
    for (const [key, value] of [
      ["prim.active", "true"],
      ["prim.repoSyncId", "repo1"],
      ["prim.repoSyncRepository", "fixture/repo"],
      ["remote.origin.url", "https://github.com/fixture/repo.git"],
    ])
      execFileSync("git", ["config", "--local", key, value], { cwd, env });
    const observed = join(cwd, "hook-observed.json");
    const wrapper = join(cwd, "hook.mjs");
    const clock = join(cwd, "clock.mjs");
    writeFileSync(clock, "process.uptime = () => 0.5;\n");
    writeFileSync(
      wrapper,
      `import { readFileSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst raw=readFileSync(0,'utf8'); writeFileSync(${JSON.stringify(observed)},raw);\n${name === "crash" ? "process.exit(1);" : name === "timeout" ? "await new Promise(resolve=>setTimeout(resolve,5000));" : `const result=spawnSync(${JSON.stringify(process.execPath)},[${name === "deadline" ? `'--import',${JSON.stringify(clock)},` : ""}${JSON.stringify(join(packageRoot, "dist/hook-runtime/hooks/pre-tool-use.js"))},'--agent','claude'],{input:raw,encoding:'utf8',env:process.env}); process.stdout.write(result.stdout);process.stderr.write(result.stderr);process.exit(result.status??1);`}\n`,
    );
    const settings = join(cwd, "settings.json");
    writeFileSync(
      settings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: `'${process.execPath}' '${wrapper}'`,
                  timeout: 2,
                },
              ],
            },
          ],
        },
      }),
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        binary,
        [
          "-p",
          "--verbose",
          "--output-format",
          "stream-json",
          "--no-session-persistence",
          "--max-turns",
          "3",
          "--model",
          "claude-sonnet-4-5",
          "--dangerously-skip-permissions",
          "--setting-sources",
          "",
          "--settings",
          settings,
          "--strict-mcp-config",
          "--mcp-config",
          '{"mcpServers":{}}',
          "--tools",
          "Bash",
          "--",
          "Run the fixture command once, then stop.",
        ],
        { cwd, env, stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(
          new Error(`Claude ${name} timed out; ${stderr}; ${stdout}; ${JSON.stringify(routes)}`),
        );
      }, 30000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    const observedInput = existsSync(observed) ? JSON.parse(readFileSync(observed, "utf8")) : null;
    const row = {
      case: name,
      exitCode: result.code,
      hookObserved: observedInput !== null,
      sentinelWritten: existsSync(join(cwd, "sentinel.txt")),
      modelRequests: calls,
      preflightRequests,
    };
    if (!row.hookObserved)
      throw new Error(
        `Actual Claude hook did not fire: ${JSON.stringify(row)}\n${result.stdout}\n${result.stderr}\n${JSON.stringify(routes)}`,
      );
    assert.equal(observedInput.tool_name, "Bash");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      row.sentinelWritten,
      name !== "conflict",
      `${JSON.stringify(row)}\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      preflightRequests > 0,
      ["allow", "conflict", "paused", "malformed", "deadline"].includes(name),
      JSON.stringify(row),
    );
    results.push(row);
    console.error(
      `PASS actual Claude ${name}: sentinel ${row.sentinelWritten ? "written" : "blocked"}`,
    );
  }
  const summary = {
    suite: "claude-preflight-host",
    hostVersion,
    deadlineTiming: "accelerated remaining budget",
    watchdogTimeoutSeconds: 2,
    results,
  };
  console.log(JSON.stringify(summary));
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
