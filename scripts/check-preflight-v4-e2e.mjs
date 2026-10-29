import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";

// This drives the built hook and installers with real process, HTTP, Git, and
// filesystem boundaries. It does not invoke an agent or touch the user's home.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = mkdtempSync(join(tmpdir(), "prim-preflight-v4-e2e-"));
const home = join(root, "home");
const cwd = join(root, "repo");
const bin = join(root, "bin");
const nearDeadline = join(root, "near-deadline.mjs");
const schemaArgument = process.argv.indexOf("--schema");
const schemaPath = schemaArgument < 0 ? undefined : process.argv[schemaArgument + 1];
const schema = schemaPath ? JSON.parse(readFileSync(schemaPath, "utf8")) : undefined;
const backendFixtures = schemaPath
  ? JSON.parse(
      readFileSync(join(dirname(schemaPath), "cli-http-v1.fixtures.json"), "utf8"),
    ).cases.filter(({ definition }) => definition.endsWith("V4"))
  : [];
const ajv = schema ? new Ajv2020({ strict: false, allErrors: true }).addSchema(schema) : undefined;
const validateRequest = ajv?.getSchema(`${schema.$id}#/$defs/PreflightRequestV4`);
const validateResponse = ajv?.getSchema(`${schema.$id}#/$defs/PreflightResponseV4`);
if (schema) {
  assert.ok(validateRequest && validateResponse, "Backend schema must export the V4 definitions");
  for (const fixture of backendFixtures) {
    const validate = ajv.getSchema(`${schema.$id}#/$defs/${fixture.definition}`);
    assert.equal(
      validate(fixture.value),
      fixture.valid,
      `${fixture.name}: ${JSON.stringify(validate.errors)}`,
    );
  }
  const validStart = backendFixtures.find(
    ({ definition, valid, value }) =>
      definition === "PreflightRequestV4" && valid && value.operation === "start",
  ).value;
  for (const digest of ["a".repeat(65), "a".repeat(63), "z".repeat(64)])
    assert.equal(validateRequest({ ...validStart, toolInputDigest: digest }), false);
}
const requests = [];
let respond;
const server = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  const body = JSON.parse(raw || "{}");
  if (validateRequest) assert.ok(validateRequest(body), JSON.stringify(validateRequest.errors));
  requests.push({ method: request.method, path: request.url, body });
  const value = respond(body, response);
  if (value === undefined) return;
  if (validateResponse && value.protocolVersion === 4 && value.evaluationCoverage)
    assert.ok(validateResponse(value), JSON.stringify(validateResponse.errors));
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(value));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  HOME: home,
  PRIM_CONFIG_DIR: join(root, "config"),
  CURSOR_CONFIG_DIR: join(root, "cursor"),
  HERMES_HOME: join(home, ".hermes"),
  CODEX_HOME: join(home, ".codex"),
  XDG_CACHE_HOME: join(root, "cache"),
  GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
  GIT_CONFIG_NOSYSTEM: "1",
  PRIM_API_URL: `http://127.0.0.1:${server.address().port}`,
  PRIM_TOKEN: "fixture-token-not-a-credential",
  PRIM_HOOK_MODE: "block",
  PRIM_BYPASS: "0",
  PRIM_UNINSTALL_ORCHESTRATOR: "1",
  PATH: `${bin}:${process.env.PATH}`,
  CODEX_THREAD_ID: "",
};
function completed(overrides = {}) {
  return {
    protocolVersion: 4,
    state: "completed",
    checkId: "check1",
    evaluationId: "evaluation1",
    verdict: "allow",
    reasonCode: "no_conflicts",
    message: "All eligible Decisions evaluated",
    conflicts: [],
    bypassed: [],
    evaluationCoverage: {
      candidateCount: 104,
      submittedCount: 100,
      evaluatedCount: 100,
      bypassedCount: 4,
      discoveryComplete: true,
      status: "completed",
      semanticBatchCount: 13,
      completedSemanticBatchCount: 13,
    },
    ...overrides,
  };
}
function processing(overrides = {}) {
  const value = completed({
    state: "processing",
    verdict: "unavailable",
    reasonCode: "processing",
    message: "Checking Decisions",
    retryAfterMs: 1,
    ...overrides,
  });
  value.evaluationCoverage = {
    ...value.evaluationCoverage,
    status: "partial",
    evaluatedCount: 8,
    completedSemanticBatchCount: 1,
  };
  return value;
}
function unidentifiedPause(overrides = {}) {
  return completed({
    state: "paused",
    verdict: "block",
    checkId: undefined,
    evaluationId: undefined,
    evaluationCoverage: {
      candidateCount: 0,
      submittedCount: 0,
      evaluatedCount: 0,
      bypassedCount: 0,
      discoveryComplete: false,
      status: "unavailable",
      semanticBatchCount: 0,
      completedSemanticBatchCount: 0,
    },
    ...overrides,
  });
}
function envelope(agent, content = "new", invocationId = "tool-1") {
  const base = {
    cwd,
    session_id: "session-1",
    tool_use_id: invocationId,
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: join(cwd, "target.txt"), content },
  };
  if (agent === "cursor")
    return {
      ...base,
      hook_event_name: "preToolUse",
      conversation_id: "session-1",
      generation_id: "turn-1",
      workspace_roots: [cwd],
    };
  if (agent === "hermes")
    return {
      ...base,
      hook_event_name: "pre_tool_call",
      tool_name: "write_file",
      tool_input: { path: join(cwd, "target.txt"), content },
      extra: { tool_call_id: invocationId },
    };
  if (agent === "codex")
    return {
      ...base,
      tool_name: "apply_patch",
      tool_input: {
        command: `*** Begin Patch\n*** Add File: target.txt\n+${content}\n*** End Patch`,
      },
    };
  return base;
}
async function run(args, input, overrides = {}, nodeArgs = [], rawInput = null) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, ...args], {
      cwd,
      env: { ...env, ...overrides },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Process timeout: ${args.join(" ")}\n${stderr}`));
    }, 15_000);
    child.once("error", reject);
    child.stdin.on("error", (error) => {
      // Explicit opt-outs can exit before a large fixture finishes writing.
      if (error.code !== "EPIPE") reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(rawInput ?? (input === undefined ? "" : JSON.stringify(input)));
  });
}
async function hook(agent = "claude_code", options = {}) {
  requests.length = 0;
  const result = await run(
    [join(packageRoot, "dist/hook-runtime/hooks/pre-tool-use.js"), "--agent", agent],
    options.input ?? envelope(agent),
    options.env,
    options.nodeArgs,
    options.rawInput,
  );
  assert.equal(result.code, 0, result.stderr);
  return { ...result, output: JSON.parse(result.stdout) };
}
function denied(agent, output) {
  if (agent === "cursor") return output.permission === "deny";
  if (agent === "hermes") return output.action === "block";
  return output.hookSpecificOutput?.permissionDecision === "deny";
}
let passed = 0;
async function scenario(name, action) {
  await action();
  passed += 1;
  console.error(`PASS ${name}`);
}
try {
  for (const path of [home, cwd, bin]) mkdirSync(path, { recursive: true });
  writeFileSync(join(root, "empty-git-config"), "");
  writeFileSync(nearDeadline, "process.uptime = () => 239.5;\n");
  execFileSync("git", ["init", "-q", cwd], { env });
  for (const [key, value] of [
    ["prim.active", "true"],
    ["prim.repoSyncId", "repo1"],
    ["prim.repoSyncRepository", "fixture/repo"],
    ["remote.origin.url", "https://github.com/fixture/repo.git"],
  ])
    execFileSync("git", ["config", "--local", key, value], { cwd, env });
  for (const [host, version] of [
    ["claude", "2.1.295"],
    ["cursor", "3.24.9"],
    ["hermes", "0.17.0"],
  ])
    writeFileSync(join(bin, host), `#!/bin/sh\nprintf '%s\\n' '${version}'\n`, { mode: 0o755 });
  for (const agent of ["claude_code", "cursor", "codex", "hermes"]) {
    for (const [name, options] of [
      ["oversized tool input", { input: envelope(agent, "x".repeat(1024 * 1024)) }],
      ["malformed JSON", { rawInput: '{"hook_event_name":' }],
      ["non-object envelope", { rawInput: "[]" }],
      ["missing event identity", { input: { ...envelope(agent), hook_event_name: undefined } }],
      ["missing tool identity", { input: { ...envelope(agent), tool_name: undefined } }],
    ]) {
      await scenario(`${agent}: ${name} pauses without a request`, async () => {
        respond = () => completed();
        const result = await hook(agent, { ...options, env: { PRIM_HOOK_MODE: "warn" } });
        assert.ok(denied(agent, result.output), result.stdout);
        assert.match(result.stdout, /Operation paused/u);
        assert.equal(requests.length, 0);
      });
      for (const optOut of [{ PRIM_HOOK_MODE: "off" }, { PRIM_BYPASS: "1" }])
        await scenario(`${agent}: explicit ${Object.keys(optOut)[0]} permits ${name}`, async () => {
          const result = await hook(agent, { ...options, env: optOut });
          assert.equal(denied(agent, result.output), false, result.stdout);
          assert.equal(requests.length, 0);
        });
    }
    await scenario(
      `${agent}: ID-less pre-admission pause preserves the service reason`,
      async () => {
        respond = () =>
          unidentifiedPause({
            reasonCode: "repository_unavailable",
            message: "The repository connection is unavailable",
          });
        const result = await hook(agent, { env: { PRIM_HOOK_MODE: "warn" } });
        assert.ok(denied(agent, result.output), result.stdout);
        assert.match(result.stdout, /The repository connection is unavailable/u);
        assert.doesNotMatch(result.stdout, /incompatible V4|resume/u);
        assert.equal(requests.length, 1);
      },
    );
    await scenario(`${agent}: pending waits for all 104 eligible Decisions`, async () => {
      respond = (body) => (body.operation === "start" ? processing() : completed());
      const result = await hook(agent);
      assert.equal(denied(agent, result.output), false);
      assert.deepEqual(
        requests.map(({ body }) => body.operation),
        ["start", "status"],
      );
      assert.ok(
        requests.every(
          ({ method, path }) => method === "POST" && path === "/api/cli/decisions/conflict-check",
        ),
      );
      assert.match(requests[0].body.toolInputDigest, /^[a-f0-9]{64}$/u);
      assert.equal(requests[0].body.protocolVersion, 4);
      assert.match(result.stderr, /Checking Decisions/u);
    });
    for (const state of ["processing", "paused", "expired"]) {
      await scenario(`${agent}: ${state} cannot allow in warn mode`, async () => {
        respond = () => processing({ state, verdict: "allow" });
        const result = await hook(agent, {
          env: { PRIM_HOOK_MODE: "warn" },
          ...(state === "processing"
            ? { nodeArgs: ["--import", pathToFileURL(nearDeadline).href] }
            : {}),
        });
        assert.ok(denied(agent, result.output), result.stdout);
        assert.match(result.stdout, /Operation paused/u);
      });
    }
  }
  const otherRepository = join(root, "other-repository");
  execFileSync("git", ["init", "-q", otherRepository], { env });
  for (const [name, input] of [
    ["multiple repositories", { ...envelope("cursor"), workspace_roots: [cwd, otherRepository] }],
    ["missing conversation identity", { ...envelope("cursor"), conversation_id: undefined }],
  ]) {
    await scenario(`cursor: normalization failure from ${name} pauses`, async () => {
      const result = await hook("cursor", { input });
      assert.ok(denied("cursor", result.output), result.stdout);
      assert.equal(requests.length, 0);
    });
    for (const optOut of [{ PRIM_HOOK_MODE: "off" }, { PRIM_BYPASS: "1" }])
      await scenario(`cursor: explicit ${Object.keys(optOut)[0]} permits ${name}`, async () => {
        const result = await hook("cursor", { input, env: optOut });
        assert.equal(denied("cursor", result.output), false, result.stdout);
        assert.equal(requests.length, 0);
      });
  }
  await scenario(
    "ID-less pause during polling preserves the known check and service reason",
    async () => {
      respond = (body) =>
        body.operation === "start"
          ? processing()
          : unidentifiedPause({
              verdict: "unavailable",
              reasonCode: "authority_changed",
              message: "The credential authority changed",
            });
      const result = await hook();
      assert.ok(denied("claude_code", result.output), result.stdout);
      assert.match(result.stdout, /The credential authority changed/u);
      assert.match(result.stdout, /preflight resume check1/u);
      assert.doesNotMatch(result.stdout, /different check identity|changed evaluation identity/u);
    },
  );
  await scenario("status preserves a legitimate ID-less paused response on stdout", async () => {
    respond = () =>
      unidentifiedPause({
        reasonCode: "authority_changed",
        message: "The credential authority changed",
      });
    const result = await run([
      join(packageRoot, "dist/index.js"),
      "decisions",
      "preflight",
      "status",
      "check1",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).reasonCode, "authority_changed");
  });
  await scenario("resume preserves an ID-less pause reason after receiving progress", async () => {
    respond = (body) =>
      body.operation === "resume"
        ? processing()
        : unidentifiedPause({
            reasonCode: "preflight_unavailable",
            message: "The enforcement service is temporarily unavailable",
          });
    const result = await run([
      join(packageRoot, "dist/index.js"),
      "decisions",
      "preflight",
      "resume",
      "check1",
    ]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /The enforcement service is temporarily unavailable/u);
    assert.doesNotMatch(result.stderr, /different check identity|changed evaluation identity/u);
  });
  await scenario("unresolved script writes pause before requesting a verdict", async () => {
    respond = () => completed();
    const input = {
      ...envelope("claude_code"),
      tool_name: "Bash",
      tool_input: {
        command: `node -e 'require("node:fs").writeFileSync(process.argv[1], "new")' target.txt`,
      },
    };
    const result = await hook("claude_code", { input, env: { PRIM_HOOK_MODE: "warn" } });
    assert.ok(denied("claude_code", result.output));
    assert.match(result.stdout, /write targets could not be determined/u);
    assert.equal(requests.length, 0);
  });
  await scenario(
    "literal script writes retain V4 verification and explicit approval context",
    async () => {
      respond = () =>
        completed({
          verdict: "block",
          reasonCode: "semantic_conflict",
          conflicts: [
            { decisionId: "dec_0123abcd", shortId: "0123abcd", title: "Keep durable retries" },
          ],
        });
      const input = {
        ...envelope("codex"),
        tool_name: "Bash",
        tool_input: {
          command: `node -e 'require("node:fs").writeFileSync("target.txt", "memory")'`,
        },
      };
      const result = await hook("codex", { input });
      assert.ok(denied("codex", result.output));
      assert.deepEqual(requests[0].body.paths, ["target.txt"]);
      assert.equal(requests[0].body.protocolVersion, 4);
      assert.equal(requests[0].body.coverage, "unverified");
      for (const expected of [
        "target.txt",
        "memory",
        "dec_0123abcd",
        "explicit human approval",
        "bypasses are disabled",
      ])
        assert.ok(result.stdout.includes(expected), expected);
    },
  );
  await scenario("V4 preserves disclosure when a shell proposal is truncated", async () => {
    respond = () => completed();
    const input = {
      ...envelope("claude_code"),
      tool_name: "Bash",
      tool_input: { command: `printf '${"x".repeat(8_000)}' > target.txt` },
    };
    const result = await hook("claude_code", { input });
    assert.equal(denied("claude_code", result.output), false);
    assert.deepEqual(requests[0].body.paths, ["target.txt"]);
    assert.match(result.stdout, /shell proposal was truncated/u);
  });
  await scenario("complete semantic block still demotes in warn mode", async () => {
    respond = () => completed({ verdict: "block", reasonCode: "conflict", message: "Conflict" });
    assert.equal(
      denied(
        "claude_code",
        (await hook("claude_code", { env: { PRIM_HOOK_MODE: "warn" } })).output,
      ),
      false,
    );
    assert.ok(denied("claude_code", (await hook()).output));
  });
  for (const [name, value] of [
    ["ID-less completed response", completed({ checkId: undefined, evaluationId: undefined })],
    ["ID-less processing response", processing({ checkId: undefined, evaluationId: undefined })],
    [
      "ID-less paused allow response",
      completed({ state: "paused", checkId: undefined, evaluationId: undefined }),
    ],
    [
      "partially identified pause",
      completed({ state: "paused", verdict: "block", evaluationId: undefined }),
    ],
    ["V3 response", { ...completed(), protocolVersion: 3 }],
    ["missing coverage", { ...completed(), evaluationCoverage: undefined }],
    [
      "partial completed coverage",
      {
        ...completed(),
        evaluationCoverage: { ...completed().evaluationCoverage, evaluatedCount: 99 },
      },
    ],
    [
      "unfinished discovery",
      {
        ...completed(),
        evaluationCoverage: { ...completed().evaluationCoverage, discoveryComplete: false },
      },
    ],
    [
      "unfinished semantic batch",
      {
        ...completed(),
        evaluationCoverage: { ...completed().evaluationCoverage, completedSemanticBatchCount: 12 },
      },
    ],
    ["unavailable verdict", completed({ verdict: "unavailable" })],
  ])
    await scenario(`${name} pauses without fallback`, async () => {
      respond = () => value;
      assert.ok(denied("claude_code", (await hook()).output));
      assert.equal(requests.length, 1);
    });
  await scenario("wrong poll identity pauses", async () => {
    respond = (body) =>
      body.operation === "start" ? processing() : completed({ checkId: "othercheck" });
    assert.ok(denied("claude_code", (await hook()).output));
  });
  await scenario("network failure pauses even in warn mode", async () => {
    respond = (_, response) => {
      response.destroy();
    };
    assert.ok(
      denied(
        "claude_code",
        (await hook("claude_code", { env: { PRIM_HOOK_MODE: "warn" } })).output,
      ),
    );
  });
  await scenario("malformed conflict records pause even in warn mode", async () => {
    respond = (_, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify(completed({ conflicts: [null] })));
    };
    assert.ok(
      denied(
        "claude_code",
        (await hook("claude_code", { env: { PRIM_HOOK_MODE: "warn" } })).output,
      ),
    );
    assert.equal(requests.length, 1);
  });
  await scenario("enforcement-disabled no-ID response preserves explicit exemption", async () => {
    respond = () =>
      completed({
        checkId: undefined,
        evaluationId: undefined,
        reasonCode: "enforcement_disabled",
        evaluationCoverage: {
          candidateCount: 0,
          submittedCount: 0,
          evaluatedCount: 0,
          bypassedCount: 0,
          discoveryComplete: false,
          status: "not_run",
          semanticBatchCount: 0,
          completedSemanticBatchCount: 0,
        },
      });
    assert.equal(denied("claude_code", (await hook()).output), false);
  });
  await scenario("enforcement disabled mid-poll is the sole identity exemption", async () => {
    respond = (body) =>
      body.operation === "start"
        ? processing()
        : completed({
            checkId: undefined,
            evaluationId: undefined,
            reasonCode: "enforcement_disabled",
            evaluationCoverage: {
              candidateCount: 0,
              submittedCount: 0,
              evaluatedCount: 0,
              bypassedCount: 0,
              discoveryComplete: false,
              status: "not_run",
              semanticBatchCount: 0,
              completedSemanticBatchCount: 0,
            },
          });
    assert.equal(denied("claude_code", (await hook()).output), false);
    assert.equal(requests.length, 2);
  });
  await scenario(
    "no-target policy exemption is bound to an unverified zero-path start",
    async () => {
      respond = () =>
        completed({
          checkId: undefined,
          evaluationId: undefined,
          reasonCode: "no_targets_skipped",
          evaluationCoverage: {
            candidateCount: 0,
            submittedCount: 0,
            evaluatedCount: 0,
            bypassedCount: 0,
            discoveryComplete: true,
            status: "completed",
            semanticBatchCount: 0,
            completedSemanticBatchCount: 0,
          },
        });
      assert.ok(denied("claude_code", (await hook()).output));
      const input = {
        ...envelope("claude_code"),
        tool_input: { file_path: join(root, "outside.txt"), content: "fixture" },
      };
      assert.equal(denied("claude_code", (await hook("claude_code", { input })).output), false);
      assert.deepEqual(requests[0].body.paths, []);
      assert.equal(requests[0].body.coverage, "unverified");
      const result = await run([
        join(packageRoot, "dist/index.js"),
        "decisions",
        "preflight",
        "status",
        "check1",
      ]);
      assert.equal(result.code, 1);
    },
  );
  await scenario(
    "digest distinguishes input beyond proposal limit and preserves retry identity",
    async () => {
      respond = () => completed();
      const prefix = "x".repeat(8_000);
      await hook("claude_code", { input: envelope("claude_code", `${prefix}a`, "first") });
      const first = requests[0].body;
      await hook("claude_code", { input: envelope("claude_code", `${prefix}b`, "second") });
      const changed = requests[0].body;
      assert.equal(first.proposal, changed.proposal);
      assert.notEqual(first.toolInputDigest, changed.toolInputDigest);
      await hook("claude_code", { input: envelope("claude_code", `${prefix}a`, "retry") });
      assert.equal(first.toolInputDigest, requests[0].body.toolInputDigest);
      assert.notEqual(first.invocationId, requests[0].body.invocationId);
    },
  );
  await scenario("240-second budget expires with explicit deny before host timeout", async () => {
    // Begin near the end of the process's real 240s budget; no production env
    // variable weakens the limit, and the built gate remains unchanged.
    const clock = join(root, "near-deadline.mjs");
    writeFileSync(clock, "process.uptime = () => 239.5;\n");
    respond = () => processing();
    const started = Date.now();
    const result = await hook("claude_code", { nodeArgs: ["--import", pathToFileURL(clock).href] });
    assert.ok(denied("claude_code", result.output));
    assert.match(result.stdout, /240-second/u);
    assert.ok(Date.now() - started < 3_000);
  });
  await scenario("single HTTP request has a 10-second deadline", async () => {
    respond = () => undefined;
    const started = Date.now();
    assert.ok(denied("claude_code", (await hook()).output));
    assert.ok(Date.now() - started >= 9_500);
    assert.ok(Date.now() - started < 13_000);
  });
  await scenario("explicit status/resume use V4 and resume polls to completion", async () => {
    requests.length = 0;
    respond = (body) => (body.operation === "resume" ? processing() : completed());
    let result = await run([
      join(packageRoot, "dist/index.js"),
      "decisions",
      "preflight",
      "resume",
      "check1",
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "completed");
    assert.deepEqual(
      requests.map(({ body }) => body.operation),
      ["resume", "status"],
    );
    respond = () => processing({ state: "paused" });
    result = await run([
      join(packageRoot, "dist/index.js"),
      "decisions",
      "preflight",
      "status",
      "check1",
    ]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(JSON.parse(result.stdout).state, "paused");
  });
  for (const fixture of backendFixtures.filter(
    ({ definition, valid }) => definition === "PreflightResponseV4" && valid,
  ))
    await scenario(`backend golden through built CLI: ${fixture.name}`, async () => {
      respond = (body) =>
        fixture.value.state === "processing" && body.operation !== "start"
          ? completed({ checkId: fixture.value.checkId, evaluationId: fixture.value.evaluationId })
          : fixture.value;
      const result = await hook();
      const expectedDeny =
        fixture.value.state === "paused" ||
        fixture.value.state === "expired" ||
        (["block", "ask", "unavailable"].includes(fixture.value.verdict) &&
          fixture.value.state !== "processing");
      assert.equal(denied("claude_code", result.output), expectedDeny);
    });
  for (const host of ["claude", "codex", "cursor", "hermes"])
    await scenario(`${host}: installer writes and repairs 300s failure policy`, async () => {
      const args = [join(packageRoot, "dist/index.js"), host, "install", "--scope", "user"];
      let result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      const location = JSON.parse(result.stdout).path;
      const raw = readFileSync(location, "utf8");
      const settings = host === "hermes" ? parseYaml(raw) : JSON.parse(raw);
      const event =
        host === "hermes" ? "pre_tool_call" : host === "cursor" ? "preToolUse" : "PreToolUse";
      const entries = settings.hooks[event];
      const gate =
        host === "claude" || host === "codex"
          ? entries
              .flatMap(({ hooks }) => hooks)
              .find(({ command }) => command.includes("prim-pre-tool-use"))
          : entries.find(({ command }) => command.includes("prim-pre-tool-use"));
      assert.equal(gate.timeout, 300);
      if (host === "claude") assert.equal(gate.onFailure, "block");
      if (host === "cursor") assert.equal(gate.failClosed, true);
      if (host === "hermes") assert.equal(gate.fail_closed, true);
      if (host === "codex") assert.match(result.stderr, /not guaranteed/u);
      if (host === "claude" || host === "codex") {
        gate.async = true;
        writeFileSync(location, JSON.stringify(settings));
        result = await run(args);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).changed, true);
      }
      writeFileSync(
        location,
        raw.replace(
          host === "hermes" ? "timeout: 300" : '"timeout": 300',
          host === "hermes" ? "timeout: 10" : '"timeout": 10',
        ),
      );
      result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).changed, true);
      result = await run(args);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).changed, false);
    });
  await scenario(
    "unsupported host capability is machine-readable without claiming readiness",
    async () => {
      writeFileSync(join(bin, "claude"), "#!/bin/sh\nprintf '%s\\n' '2.1.284'\n", { mode: 0o755 });
      const result = await run([join(packageRoot, "dist/index.js"), "claude", "status"]);
      assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).failureProtection.status, "unsupported");
      assert.match(result.stderr, /not ready/u);
    },
  );
  console.log(
    JSON.stringify({
      suite: "preflight-v4-e2e",
      passed,
      backendContractVersion: schema?.["x-primitive-contract-version"],
      backendFixturesChecked: backendFixtures.length,
      hostWatchdogFaultsExercised: false,
    }),
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
}
