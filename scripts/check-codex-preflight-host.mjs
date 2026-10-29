import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Optional actual-host E2E: Codex talks only to a local deterministic Responses
// provider. Temporary HOME/config/repo and a synthetic credential isolate it
// from the user's account, settings, and work. No model/API billing occurs.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "prim-codex-host-"));
const cases = ["allow", "paused", "malformed", "deadline", "crash", "timeout"];
let current;
let calls = 0;
let preflightRequests = 0;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || "{}");
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
        verdict: paused ? "unavailable" : "allow",
        reasonCode: paused ? "semantic_unavailable" : "no_conflicts",
        message: paused ? "Fixture evaluation paused" : "Fixture complete",
        conflicts: [],
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
  if (!request.url?.endsWith("/responses")) {
    response.statusCode = 404;
    response.end("{}");
    return;
  }
  calls += 1;
  const first = calls === 1;
  const item = first
    ? {
        id: "call_item",
        type: "function_call",
        call_id: "fixture_call",
        name: "exec_command",
        arguments: JSON.stringify({
          cmd: "printf sentinel > sentinel.txt",
          yield_time_ms: 1000,
          max_output_tokens: 1000,
        }),
      }
    : {
        id: "final_item",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Fixture finished." }],
      };
  response.setHeader("Content-Type", "text/event-stream");
  const send = (type, data) =>
    response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  send("response.created", {
    response: { id: `resp_${calls}`, status: "in_progress", output: [] },
  });
  send("response.output_item.added", { output_index: 0, item });
  send("response.output_item.done", { output_index: 0, item });
  send("response.completed", {
    response: {
      id: `resp_${calls}`,
      status: "completed",
      output: [item],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    },
  });
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
    const cwd = join(root, name);
    const home = join(cwd, "home");
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    const env = {
      HOME: home,
      CODEX_HOME: codexHome,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR ?? tmpdir(),
      SHELL: "/bin/zsh",
      LANG: "en_US.UTF-8",
      PRIM_CONFIG_DIR: join(home, "prim"),
      PRIM_API_URL: url,
      PRIM_TOKEN: "fixture-no-real-credential",
      PRIM_HOOK_MODE: "warn",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(home, "gitconfig"),
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
    writeFileSync(clock, "process.uptime = () => 238;\n");
    writeFileSync(
      wrapper,
      `import { readFileSync, writeFileSync } from 'node:fs';\nimport { spawnSync } from 'node:child_process';\nconst raw = readFileSync(0, 'utf8');\nwriteFileSync(${JSON.stringify(observed)}, raw);\n${name === "crash" ? "process.exit(1);" : name === "timeout" ? "await new Promise(resolve => setTimeout(resolve, 5000));" : `const result = spawnSync(${JSON.stringify(process.execPath)}, [${name === "deadline" ? `'--import', ${JSON.stringify(clock)}, ` : ""}${JSON.stringify(join(packageRoot, "dist/hook-runtime/hooks/pre-tool-use.js"))}, '--agent', 'codex'], { input: raw, encoding: 'utf8', env: process.env }); process.stdout.write(result.stdout); process.stderr.write(result.stderr); process.exit(result.status ?? 1);`}\n`,
    );
    const command = `'${process.execPath}' '${wrapper}'`;
    writeFileSync(
      join(codexHome, "hooks.json"),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command, timeout: name === "timeout" ? 1 : 300 }],
            },
          ],
        },
      }),
    );
    writeFileSync(
      join(codexHome, "config.toml"),
      `model = "gpt-5.2-codex"\nmodel_provider = "fixture"\napproval_policy = "never"\nsandbox_mode = "workspace-write"\n[features]\nhooks = true\nshell_snapshot = false\n[model_providers.fixture]\nname = "Loopback fixture"\nbase_url = "${url}/v1"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\nstream_idle_timeout_ms = 5000\n`,
    );
    const result = await new Promise((resolve, reject) => {
      const child = spawn(
        "codex",
        [
          "exec",
          "--ephemeral",
          "--skip-git-repo-check",
          "--dangerously-bypass-hook-trust",
          "--json",
          "-C",
          cwd,
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
        reject(new Error(`Codex ${name} timed out; ${stderr}; ${stdout}`));
      }, 20_000);
      child.once("error", reject);
      child.once("close", (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
    const observedInput = existsSync(observed) ? JSON.parse(readFileSync(observed, "utf8")) : null;
    const sentinelWritten = existsSync(join(cwd, "sentinel.txt"));
    const row = {
      case: name,
      exitCode: result.code,
      hookObserved: observedInput !== null,
      sentinelWritten,
      modelRequests: calls,
      preflightRequests,
    };
    if (!row.hookObserved)
      throw new Error(
        `Actual Codex hook did not fire: ${JSON.stringify(row)}\n${result.stdout}\n${result.stderr}`,
      );
    assert.equal(observedInput.tool_name, "Bash");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      sentinelWritten,
      name !== "paused" && name !== "malformed" && name !== "deadline",
      `${JSON.stringify(row)}\n${result.stdout}\n${result.stderr}`,
    );
    assert.equal(
      preflightRequests > 0,
      name === "allow" || name === "paused" || name === "malformed" || name === "deadline",
    );
    results.push(row);
    console.error(`PASS actual Codex ${name}: sentinel ${sentinelWritten ? "written" : "blocked"}`);
  }
  console.log(
    JSON.stringify({
      suite: "codex-preflight-host",
      deadlineTiming: "accelerated remaining budget",
      watchdogTimeoutSeconds: 1,
      results,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
