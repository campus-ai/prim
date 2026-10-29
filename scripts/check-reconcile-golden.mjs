// Exercise the built CLI and hook against an isolated protocol fixture.
// This does not launch an agent host or claim to verify its approval UI.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "prim-reconcile-golden-"));
const requests = [];
let verdict = "block";
let planScopeOnly = false;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
  requests.push({ path: request.url, body });
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/cli/reconcile/resolve") {
    response.end(
      JSON.stringify({
        ok: true,
        checkId: body.checkId,
        decisionId: "dec_0123abcd",
        outcome: body.outcome,
        recordedAt: 1_700_000_000_000,
        duplicate: false,
      }),
    );
  } else if (request.url === "/api/cli/decisions/conflict-check") {
    const effectiveVerdict =
      planScopeOnly && !body.paths?.includes("gameplans/pilot.yaml") ? "allow" : verdict;
    response.end(
      JSON.stringify({
        protocolVersion: 3,
        checkId: "check-1",
        verdict: effectiveVerdict,
        reasonCode: effectiveVerdict === "allow" ? "semantically_compatible" : "semantic_conflict",
        message:
          effectiveVerdict === "allow"
            ? "Compatible change."
            : "The proposed change conflicts with an active governing Decision.",
        conflicts:
          effectiveVerdict === "allow"
            ? []
            : [
                { decisionId: "dec_0123abcd", shortId: "0123abcd", title: "Keep durable retries" },
                {
                  decisionId: "dec_abcd0123",
                  shortId: "abcd0123",
                  title: "Preserve customer work",
                },
              ],
        bypassed: [],
      }),
    );
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "fixture_not_found" }));
  }
});

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CI: "1",
    NO_COLOR: "1",
    PRIM_CONFIG_DIR: join(root, "config"),
    PRIM_UNINSTALL_ORCHESTRATOR: "1",
    PRIM_TOKEN: "prim_pat_local_protocol_fixture",
    PRIM_HOOK_MODE: "block",
    PRIM_API_URL: `http://127.0.0.1:${server.address().port}`,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const run = (file, args, input) =>
    new Promise((resolveResult, reject) => {
      const child = execFile(
        process.execPath,
        [join(packageRoot, file), ...args],
        { cwd: root, env, timeout: 15_000 },
        (error, stdout, stderr) => {
          if (error && typeof error.code !== "number") return reject(error);
          resolveResult({ code: error?.code ?? 0, stdout, stderr });
        },
      );
      child.stdin.end(input);
    });
  const expectedRejection = {
    ok: false,
    error: "human_approval_required",
    decisionId: "dec_0123abcd",
    message:
      "Overriding a governing Decision requires explicit human approval. This host cannot provide verifiable human approval, so reconcile bypasses are disabled. Keep the edit blocked and choose a compatible change.",
  };
  for (const args of [
    ["reconcile", "dec_0123abcd"],
    ["--yes", "reconcile", "dec_0123abcd"],
    ["--non-interactive", "--yes", "reconcile", "dec_0123abcd", "--flag", "flag-1", "--json"],
  ]) {
    const result = await run("dist/index.js", args);
    assert.equal(result.code, 2);
    assert.deepEqual(JSON.parse(result.stdout), expectedRejection);
    assert.equal(result.stderr, `[prim] reconcile rejected: ${expectedRejection.message}\n`);
  }
  const bareId = await run("dist/index.js", ["reconcile", "0123abcd"]);
  assert.equal(bareId.code, 2);
  assert.deepEqual(JSON.parse(bareId.stdout), expectedRejection);
  const legacyId = "j57b04m7f2z3xv647yxxkcdzy17h6k2z";
  const legacy = await run("dist/index.js", ["reconcile", legacyId]);
  assert.equal(legacy.code, 2);
  assert.equal(JSON.parse(legacy.stdout).error, "human_approval_required");
  assert.ok(!`${legacy.stdout}${legacy.stderr}`.includes(legacyId));
  assert.deepEqual(requests, [], "Bare reconcile must reject without contacting the server");
  const help = await run("dist/index.js", ["reconcile", "--help"]);
  assert.equal(help.code, 0);
  assert.ok(help.stdout.includes("bypasses are disabled"));

  for (const outcome of ["followed", "superseded"]) {
    const result = await run("dist/index.js", [
      "reconcile",
      "dec_0123abcd",
      "--check",
      "check-1",
      "--outcome",
      outcome,
    ]);
    assert.equal(result.code, 0);
    assert.equal(JSON.parse(result.stdout).outcome, outcome);
    assert.equal(requests.at(-1).path, "/api/cli/reconcile/resolve");
  }

  const git = (...args) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "--initial-branch=main");
  git("config", "prim.active", "true");
  git("config", "prim.repoSyncId", "fixture-repository");
  git("remote", "add", "origin", "https://github.com/fixture/reconcile.git");
  git("config", "prim.repoSyncRepository", "fixture/reconcile");
  const file = join(root, "queue.ts");
  const original = "export const retryPolicy = 'durable';\n";
  await writeFile(file, original);
  const patch =
    "*** Begin Patch\n*** Update File: queue.ts\n@@\n-export const retryPolicy = 'durable';\n+export const retryPolicy = 'memory';\n*** End Patch";
  const hook = async () => {
    const result = await run(
      "dist/hooks/pre-tool-use.js",
      ["--agent", "codex"],
      JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "reconcile-golden",
        tool_use_id: crypto.randomUUID(),
        cwd: root,
        tool_name: "apply_patch",
        tool_input: { command: patch },
      }),
    );
    assert.equal(result.code, 0);
    return JSON.parse(result.stdout);
  };
  for (const wireVerdict of ["block", "ask"]) {
    verdict = wireVerdict;
    const output = await hook();
    assert.equal(output.hookSpecificOutput.permissionDecision, "deny", JSON.stringify(output));
    const reason = output.hookSpecificOutput.permissionDecisionReason;
    for (const required of [
      "dec_0123abcd",
      "dec_abcd0123",
      "Keep durable retries",
      "Preserve customer work",
      "queue.ts",
      "memory",
      "explicit human approval",
      "bypasses are disabled",
    ]) {
      assert.ok(reason.includes(required), `Missing conflict context: ${required}`);
    }
    assert.ok(!reason.includes("To reconcile, run:"));
    assert.equal((await run("dist/index.js", ["--yes", "reconcile", "dec_0123abcd"])).code, 2);
    assert.equal((await hook()).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(await readFile(file, "utf8"), original);
  }
  verdict = "block";
  const longEdit = await run(
    "dist/hooks/pre-tool-use.js",
    [],
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "reconcile-golden",
      tool_use_id: "long-edit",
      cwd: root,
      tool_name: "Edit",
      tool_input: {
        file_path: file,
        old_string: "durable ".repeat(100),
        new_string: "replace with in-memory retries",
      },
    }),
  );
  assert.ok(
    JSON.parse(longEdit.stdout).hookSpecificOutput.permissionDecisionReason.includes(
      "replace with in-memory retries",
    ),
  );
  verdict = "allow";
  assert.notEqual((await hook()).hookSpecificOutput?.permissionDecision, "deny");
  planScopeOnly = true;
  verdict = "block";
  await mkdir(join(root, "gameplans"));
  await writeFile(join(root, "gameplans", "pilot.yaml"), "projectName: pilot\n");
  const planEdit = await run(
    "dist/hooks/pre-tool-use.js",
    ["--agent", "codex"],
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "gameplan-golden",
      tool_use_id: "plan-edit",
      cwd: root,
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: gameplans/pilot.yaml\n@@\n-projectName: pilot\n+projectName: new-pilot\n*** End Patch",
      },
    }),
  );
  assert.equal(planEdit.code, 0);
  assert.equal(JSON.parse(planEdit.stdout).hookSpecificOutput.permissionDecision, "deny");
  assert.deepEqual(requests.at(-1).body.paths, ["gameplans/pilot.yaml"]);
  assert.ok(!requests.some((request) => request.path === "/api/cli/reconcile/issue"));
  process.stdout.write(
    `${JSON.stringify({ ok: true, scenarios: ["offline rejection golden", "confirmation flags", "resolution recording", "block-reconcile-retry", "ask mapping", "compatible edit", "plan-path conflict"] })}\n`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(root, { recursive: true, force: true });
}
