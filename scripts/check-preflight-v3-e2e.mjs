import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

// Packaged-process E2E: no imports from production source, real HTTP/Git/launcher.
// --package-root can point at an extracted npm tarball to test the deliverable.
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: { "package-root": { type: "string" }, schema: { type: "string" } },
});
const packageRoot = resolve(values["package-root"] ?? sourceRoot);
const packageVersion = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version;
const schemaPath = resolve(values.schema ?? join(sourceRoot, "contracts/cli-http-v1.schema.json"));
const schema = JSON.parse(readFileSync(schemaPath, "utf8"));
const fixtures = JSON.parse(
  readFileSync(join(dirname(schemaPath), "cli-http-v1.fixtures.json"), "utf8"),
).cases.filter(({ definition }) => definition.endsWith("V3"));
const ajv = new Ajv2020({ strict: false, allErrors: true }).addSchema(schema);
const validateRequest = ajv.getSchema(`${schema.$id}#/$defs/PreflightRequestV3`);
const validateResponse = ajv.getSchema(`${schema.$id}#/$defs/PreflightResponseV3`);
assert.ok(validateRequest && validateResponse);
// Request fixtures include pre-validation normalization cases; validate emitted requests below.
for (const fixture of fixtures.filter(({ definition }) => definition === "PreflightResponseV3")) {
  const validate = ajv.getSchema(`${schema.$id}#/$defs/${fixture.definition}`);
  assert.equal(validate(fixture.value), fixture.valid, fixture.name);
}
const root = mkdtempSync(join(tmpdir(), "prim-v3-e2e-"));
const cwd = join(root, "repo");
const home = join(root, "home");
const requests = [];
let respond;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw);
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/api/cli/decisions/conflict-check");
  assert.ok(validateRequest(body), JSON.stringify(validateRequest.errors));
  assert.equal(body.agent, "claude_code");
  assert.equal(body.operation, undefined);
  assert.equal(body.shellCheck, undefined);
  assert.equal(body.toolInputDigest, undefined);
  requests.push(body);
  const value = await respond(body, response);
  if (value === undefined) return;
  if (value.protocolVersion === 3)
    assert.ok(validateResponse(value), JSON.stringify(validateResponse.errors));
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  HOME: home,
  PRIM_CONFIG_DIR: join(root, "config"),
  XDG_CACHE_HOME: join(root, "cache"),
  GIT_CONFIG_GLOBAL: join(root, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  PRIM_API_URL: `http://127.0.0.1:${server.address().port}`,
  PRIM_TOKEN: "fixture-not-a-credential",
  PRIM_HOOK_MODE: "block",
  PRIM_BYPASS: "0",
  PRIM_UNINSTALL_ORCHESTRATOR: "1",
  NODE_OPTIONS: "",
};
const launcher = join(env.PRIM_CONFIG_DIR, "prim-hook-launcher-v1");
const input = {
  cwd,
  session_id: "session-v3",
  tool_use_id: "tool-v3",
  hook_event_name: "PreToolUse",
  tool_name: "Write",
  tool_input: { file_path: join(cwd, "target.txt"), content: "new" },
};
const shell = (command) => ({ ...input, tool_name: "Bash", tool_input: { command } });
const compatible = {
  protocolVersion: 3,
  verdict: "allow",
  reasonCode: "semantically_compatible",
  message: "Selected Decisions are compatible.",
  conflicts: [],
  bypassed: [],
};
const conflict = {
  ...compatible,
  verdict: "block",
  reasonCode: "high_confidence_contradiction",
  message: "Keep retries durable.",
  checkId: "check-v3",
  conflicts: [{ decisionId: "dec_0123abcd", title: "Durable retries" }],
};
function run(file, args, payload, overrides = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(file, args, { cwd, env: { ...env, ...overrides } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process exceeded 20 seconds: ${stderr}`));
    }, 20_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, elapsedMs: performance.now() - started });
    });
    child.stdin.end(
      payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload),
    );
  });
}
async function hook(payload = input, overrides = {}) {
  requests.length = 0;
  const result = await run(launcher, ["prim-pre-tool-use"], payload, overrides);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.elapsedMs < 15_500, `Supervisor budget exceeded: ${result.elapsedMs}`);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { ...result, output: JSON.parse(result.stdout) };
}
function allowed(result) {
  assert.equal(result.output.hookSpecificOutput.permissionDecision, "allow");
}
function unverified(result) {
  allowed(result);
  assert.match(result.output.systemMessage, /change was not verified/u);
  assert.match(result.output.hookSpecificOutput.additionalContext, /change was not verified/u);
}
const results = [];
async function scenario(name, action) {
  const started = performance.now();
  await action();
  results.push({ name, elapsedMs: Math.round(performance.now() - started) });
  console.error(`PASS ${name}`);
}
function git(...args) {
  execFileSync("git", args, { cwd, env });
}
try {
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  git("init", "-q");
  for (const [key, value] of [
    ["prim.active", "true"],
    ["prim.repoSyncId", "repo1"],
    ["prim.repoSyncRepository", "fixture/repo"],
    ["remote.origin.url", "https://github.com/fixture/repo.git"],
  ])
    git("config", "--local", key, value);
  const cli = join(packageRoot, "dist/index.js");
  await scenario("packaged installer creates 20-second synchronous Claude gate", async () => {
    const result = await run(process.execPath, [cli, "claude", "install", "--scope", "user"]);
    assert.equal(result.code, 0, result.stderr);
    const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
    const gate = settings.hooks.PreToolUse.flatMap((entry) => entry.hooks).find(({ command }) =>
      command.includes("prim-pre-tool-use"),
    );
    assert.equal(gate.timeout, 20);
    assert.equal(gate.async, undefined);
    assert.equal(gate.onFailure, undefined);
    assert.ok(settings.hooks.PostToolUse && settings.hooks.SessionStart && settings.hooks.Stop);
  });
  await scenario("compatible changes proceed with one V3 request", async () => {
    respond = () => compatible;
    const result = await hook();
    allowed(result);
    assert.equal(result.output.systemMessage, undefined);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].paths, ["target.txt"]);
    assert.equal(requests[0].clientVersion, packageVersion);
  });
  await scenario("conflict arriving after two seconds still blocks", async () => {
    respond = async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      return conflict;
    };
    const result = await hook(shell("printf new > target.txt"));
    assert.ok(result.elapsedMs >= 2_500);
    assert.equal(result.output.hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.stdout, /dec_0123abcd/u);
    assert.match(result.stdout, /bypasses are disabled/u);
    assert.equal(requests.length, 1);
  });
  await scenario("ask and block policies demote only in warn mode", async () => {
    for (const verdict of ["ask", "block"]) {
      respond = () => ({ ...conflict, verdict });
      const blocked = await hook();
      assert.equal(
        blocked.output.hookSpecificOutput.permissionDecision,
        verdict === "ask" ? "ask" : "deny",
      );
      const warned = await hook(input, { PRIM_HOOK_MODE: "warn" });
      allowed(warned);
      assert.match(warned.output.systemMessage, /dec_0123abcd/u);
      assert.equal(requests[0].clientMode, "warn");
    }
  });
  await scenario(
    "unresolved shell targets report unverified without requesting a repository scan",
    async () => {
      for (const command of [
        "python3 edit.py",
        "./opaque-edit.sh",
        "S=schema.ts; sed -n '1,10p' $S",
      ]) {
        unverified(await hook(shell(command)));
        assert.equal(requests.length, 0);
      }
    },
  );
  await scenario("missing binding reports unverified without a request", async () => {
    git("config", "--unset", "prim.repoSyncId");
    try {
      unverified(await hook());
      assert.equal(requests.length, 0);
    } finally {
      git("config", "prim.repoSyncId", "repo1");
    }
  });
  await scenario("off, bypass, inactive repo and read-only tools stay silent", async () => {
    for (const override of [{ PRIM_HOOK_MODE: "off" }, { PRIM_BYPASS: "1" }]) {
      const result = await hook(input, override);
      allowed(result);
      assert.equal(result.output.systemMessage, undefined);
      assert.equal(requests.length, 0);
    }
    git("config", "prim.active", "false");
    try {
      const result = await hook();
      allowed(result);
      assert.equal(result.output.systemMessage, undefined);
      assert.equal(requests.length, 0);
    } finally {
      git("config", "prim.active", "true");
    }
    const result = await hook(shell("git status --short"));
    allowed(result);
    assert.equal(result.output.systemMessage, undefined);
    assert.equal(requests.length, 0);
  });
  await scenario(
    "malformed response, service failure and unavailable result report unverified",
    async () => {
      for (const response of [
        () => ({ invalid: true }),
        () => ({ ...compatible, verdict: "unavailable" }),
        (_, res) => {
          res.statusCode = 503;
          res.end("{}");
        },
        (_, res) => {
          res.end("{invalid");
        },
      ]) {
        respond = response;
        unverified(await hook());
        assert.equal(requests.length, 1);
      }
    },
  );
  await scenario("12-second HTTP deadline allows with visible unverified feedback", async () => {
    respond = () => undefined;
    const result = await hook();
    unverified(result);
    assert.ok(result.elapsedMs >= 12_000 && result.elapsedMs < 14_500, `${result.elapsedMs}`);
    assert.equal(requests.length, 1);
  });
  await scenario(
    "worker crash and stalled worker produce one visible supervisor fallback",
    async () => {
      const preload = join(root, "fault.mjs");
      for (const fault of ["process.exit(23)", "await new Promise(r => setTimeout(r, 30000))"]) {
        writeFileSync(
          preload,
          `if(process.argv[1]?.endsWith('pre-tool-use-worker.js')) { ${fault}; }`,
        );
        unverified(await hook(input, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }));
        assert.equal(requests.length, 0);
      }
    },
  );
  await scenario(
    "backend V3 golden responses preserve conflicts, omissions and disclosure",
    async () => {
      for (const fixture of fixtures.filter(
        (fixture) => fixture.valid && fixture.definition === "PreflightResponseV3",
      )) {
        respond = () => fixture.value;
        const result = await hook();
        if (fixture.value.verdict === "unavailable") unverified(result);
        if (fixture.value.verdict === "block")
          assert.equal(result.output.hookSpecificOutput.permissionDecision, "deny");
        if (fixture.value.evaluationCoverage)
          assert.match(result.stdout, /incomplete|not evaluated/iu);
        if (fixture.value.decisionDisclosures) assert.match(result.stdout, /dec_0123abcd/u);
      }
    },
  );
  await scenario("candidate/evidence omissions without conflicts stay visible", async () => {
    for (const reasonCode of ["candidate_set_truncated", "evidence_incomplete"]) {
      respond = () => ({
        ...compatible,
        verdict: "warn",
        reasonCode,
        message: "Some governing Decisions were not evaluated; coverage is incomplete.",
      });
      const result = await hook();
      allowed(result);
      assert.match(result.output.systemMessage, /coverage is incomplete/u);
    }
  });
  await scenario(
    "partial targets and incomplete allow responses cannot imply full coverage",
    async () => {
      respond = () => compatible;
      const partial = await hook(shell("printf new > target.txt; ./opaque-edit.sh"));
      allowed(partial);
      assert.match(partial.stdout, /complete change was not verified/u);
      assert.equal(requests[0].coverage, "unverified");
      const coverage = fixtures.find(({ value }) => value.evaluationCoverage)?.value
        .evaluationCoverage;
      assert.ok(coverage);
      respond = () => ({ ...compatible, evaluationCoverage: coverage });
      const result = await hook();
      allowed(result);
      assert.match(result.output.systemMessage, /coverage is incomplete/u);
    },
  );
  await scenario("truncated shell proposal stays disclosed", async () => {
    respond = () => compatible;
    const result = await hook(shell(`printf '${"x".repeat(8_000)}' > target.txt`));
    allowed(result);
    assert.match(result.stdout, /complete change was not verified/u);
  });
  console.log(
    JSON.stringify({
      suite: "packaged-claude-v3",
      packageRoot,
      contractVersion: schema["x-primitive-contract-version"],
      results,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
