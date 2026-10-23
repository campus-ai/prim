import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { DEMO_ADHERE, DEMO_INITIAL, DEMO_SUPERSEDE } from "../demo/story.js";

const exec = promisify(execFile);
const cli = resolve("dist/index.js");
const roots: string[] = [];
const sandboxes = new Set<string>();
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of [...roots.splice(0), ...sandboxes])
    rmSync(root, { recursive: true, force: true });
  sandboxes.clear();
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prim-demo-test-"));
  roots.push(root);
  const repo = join(root, "repo");
  const config = join(root, "config");
  mkdirSync(repo);
  const env = {
    ...process.env,
    HOME: join(root, "home"),
    PRIM_CONFIG_DIR: config,
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_DATA_HOME: join(root, "data"),
    PRIM_API_URL: "http://127.0.0.1:1",
    PRIM_TOKEN: "test-token",
    PRIM_UNATTENDED: "1",
    PRIM_NON_INTERACTIVE: "1",
    NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "0",
  };
  for (const args of [
    ["init", "-q"],
    ["remote", "add", "origin", "https://github.com/example/demo-test.git"],
    ["config", "prim.active", "true"],
    ["config", "prim.repoSyncId", "repo_demo"],
    ["config", "prim.repoSyncRepository", "example/demo-test"],
  ])
    execFileSync("git", args, { cwd: repo, env });
  writeFileSync(join(repo, "real.ts"), "export const real = true;\n");

  const run = async (args: string[], extraEnv = {}, executable = cli) => {
    const out = await exec(process.execPath, [executable, ...args], {
      cwd: repo,
      env: { ...env, ...extraEnv },
      timeout: 10_000,
    });
    return { ...out, json: JSON.parse(out.stdout) };
  };
  const shell = async (command: string) => {
    const out = await exec("/bin/sh", ["-c", command], { cwd: repo, env, timeout: 10_000 });
    const json = JSON.parse(out.stdout);
    if (json.sandbox) sandboxes.add(json.sandbox);
    return { ...out, json };
  };
  const hook = async (bin: string, agent: string, envelope: unknown) => {
    const child = execFile(process.execPath, [resolve(`dist/hooks/${bin}.js`), "--agent", agent], {
      cwd: repo,
      env,
      timeout: 10_000,
    });
    child.stdin?.end(JSON.stringify(envelope));
    return await new Promise<{ stdout: string; stderr: string }>((res, rej) => {
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (data) => {
        stdout += data;
      });
      child.stderr?.on("data", (data) => {
        stderr += data;
      });
      child.on("error", rej);
      child.on("close", (code) =>
        code === 0 ? res({ stdout, stderr }) : rej(new Error(`${code}: ${stderr}`)),
      );
    });
  };
  const envelope = (
    agent: string,
    command: string,
    session = "tour-session",
    event = "PreToolUse",
  ) => {
    if (agent === "cursor")
      return {
        hook_event_name:
          event === "PreToolUse"
            ? "preToolUse"
            : event === "PostToolUse"
              ? "postToolUse"
              : event === "Stop"
                ? "stop"
                : event === "SessionEnd"
                  ? "sessionEnd"
                  : "afterAgentResponse",
        conversation_id: session,
        generation_id: "turn-1",
        tool_use_id: "tool-1",
        cwd: repo,
        workspace_roots: [repo],
        tool_name: "Shell",
        tool_input: { command },
        text: "fictional tour summary",
      };
    return {
      hook_event_name:
        agent === "hermes"
          ? event === "PreToolUse"
            ? "pre_tool_call"
            : event === "PostToolUse"
              ? "post_tool_call"
              : event === "SessionEnd"
                ? "on_session_end"
                : "post_llm_call"
          : event,
      session_id: session,
      cwd: repo,
      tool_use_id: "tool-1",
      tool_name: agent === "hermes" ? "terminal" : "Bash",
      tool_input: { command },
      last_assistant_message: "fictional tour summary",
    };
  };
  const call = async (agent: string, command: string, session = "tour-session") => {
    await hook("prim-hook", agent, envelope(agent, command, session));
    return shell(command);
  };
  const statePath = (id: string) => join(config, "demo", "runs", `${id}.json`);
  return { root, repo, config, env, run, shell, hook, envelope, call, statePath };
}

async function serveStory(f: ReturnType<typeof fixture>) {
  const requests: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const runs = new Map<string, Record<string, unknown>>();
  let loseComplete = false;
  let loseCheck = false;
  let pendingCheck = false;
  let queues = 0;
  const server = createServer(async (req, res) => {
    const path = req.url ?? "";
    requests.push(path);
    res.setHeader("Content-Type", "application/json");
    let bytes = "";
    for await (const chunk of req) bytes += chunk;
    const body = bytes ? JSON.parse(bytes) : {};
    bodies.push(body);
    if (!path.startsWith("/api/cli/demo/")) {
      const result = path.startsWith("/api/cli/decisions/recent")
        ? { decisions: [], viewerHasDecisions: false }
        : path.includes("conflict-check")
          ? {
              protocolVersion: 3,
              verdict: "block",
              reasonCode: "high_confidence_contradiction",
              message: "real policy",
              conflicts: [],
              bypassed: [],
            }
          : { decisionId: "real-decision", shortId: "1234abcd", createdAt: 1 };
      res.end(JSON.stringify(result));
      return;
    }
    const action = path.split("/").at(-1);
    if (action === "start") {
      const id = body.localRunId.replaceAll("-", "");
      if (!runs.has(id))
        runs.set(id, {
          scenarioVersion: 1,
          fictional: true,
          evaluation: "live",
          runId: id,
          revision: 0,
          stage: "ready",
          authorName: "Avery",
          story: {
            orgName: "Example Team",
            recipient: "avery@example.invalid",
            decisionDate: "October, 8 2026",
          },
          email: "not_queued",
        });
      res.end(JSON.stringify(runs.get(id)));
      return;
    }
    const run = runs.get(body.runId ?? action);
    if (!run) {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
      return;
    }
    if (action === "check" && loseCheck) {
      loseCheck = false;
      Object.assign(run, {
        stage: "checking",
        verdict: "pending",
        revision: Number(run.revision) + 1,
      });
      res.destroy();
      return;
    }
    if (action === "check" && run.stage === "checking") {
      if (body.revision !== run.revision) {
        res.statusCode = 409;
        res.end('{"error":"stale revision"}');
        return;
      }
      Object.assign(run, { stage: "ready" });
    }
    if (action === "check" && run.stage === "ready") {
      if (pendingCheck)
        Object.assign(run, { verdict: "pending", reasonCode: "evaluator_unavailable" });
      else
        Object.assign(run, {
          stage: "blocked",
          verdict: "block",
          revision: Number(run.revision) + 1,
        });
    }
    if (action === "resolve" && run.stage === "blocked")
      Object.assign(run, {
        stage: "approved",
        verdict: "pass",
        choice: body.choice,
        ...(body.reason ? { reason: body.reason } : {}),
        revision: Number(run.revision) + 1,
        approvedDigest: createHash("sha256")
          .update(body.choice === "adhere" ? DEMO_ADHERE : DEMO_SUPERSEDE)
          .digest("hex"),
      });
    if (action === "complete" && run.stage === "approved") {
      Object.assign(run, {
        stage: "completed",
        email: "queued",
        revision: Number(run.revision) + 1,
      });
      queues++;
    }
    if (action === "complete" && loseComplete) {
      loseComplete = false;
      res.destroy();
      return;
    }
    if (action === "skip" && run.stage !== "completed") Object.assign(run, { stage: "skipped" });
    res.end(JSON.stringify(run));
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  f.env.PRIM_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    requests,
    bodies,
    runs,
    loseCheck: () => {
      loseCheck = true;
    },
    loseCompletion: () => {
      loseComplete = true;
    },
    pending: (value: boolean) => {
      pendingCheck = value;
    },
    queues: () => queues,
  };
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function blockedStory(f: ReturnType<typeof fixture>, agent = "codex") {
  const prepared = (await f.run(["demo", "--agent", agent])).json;
  const started = (await f.call(agent, prepared.nextAction)).json;
  const blocked = (await f.call(agent, started.attemptAction)).json;
  return { prepared, started, blocked };
}

describe("packaged author story", () => {
  it.each(["claude_code", "codex", "cursor", "hermes"])(
    "protects the story and both capture paths for %s",
    async (agent) => {
      const f = fixture();
      const { requests, queues } = await serveStory(f);
      const prepared = (await f.run(["demo", "--agent", agent])).json;
      expect(JSON.stringify(prepared)).not.toContain("CSV");
      const pending = await f.shell(prepared.nextAction);
      expect(pending.json).toMatchObject({ stage: "pending", isolation: "acknowledgment-missing" });
      expect(requests).toEqual([]);
      const started = (await f.call(agent, prepared.nextAction)).json;
      expect(started.stage).toBe("prompt");
      expect(started.presentation).toContain("Example Team's team");
      expect(started.nextAction).toBeUndefined();
      expect(started.awaitUserPrompt).toContain("including name and email");
      expect(requests).toEqual(["/api/cli/demo/start"]);
      expect(readFileSync(join(started.sandbox, "customers.ts"), "utf8")).toBe(DEMO_INITIAL);
      const blocked = (await f.call(agent, started.attemptAction)).json;
      expect(blocked.stage).toBe("conflict");
      expect(blocked.presentation).toContain("[DEMO] Primitive Caught a Conflict");
      expect(blocked.presentation).toContain(DEMO_INITIAL.trimEnd());
      expect(blocked.presentation).toContain("Avery's Decision from October, 8 2026");
      expect(readFileSync(join(started.sandbox, "customers.ts"), "utf8")).toBe(DEMO_INITIAL);
      const completed = await f.call(agent, blocked.choices.adhere);
      expect(completed.json.stage).toBe("completed");
      expect(completed.json.presentation).toContain("[DEMO] Accepted Avery's Decision");
      expect(completed.json.presentation).toContain("Check avery@example.invalid");
      expect(completed.stderr).toBe("");
      expect(completed.stdout.trim().split("\n")).toHaveLength(1);
      expect(existsSync(started.sandbox)).toBe(false);
      expect(queues()).toBe(1);
      expect((await f.call(agent, blocked.choices.adhere)).json.stage).toBe("completed");
      expect(queues()).toBe(1);
      // Late/resumed messages and both independent post-tool producers stay excluded.
      for (const event of [
        "PreToolUse",
        "PostToolUse",
        "Stop",
        "SessionEnd",
        "AssistantResponse",
      ]) {
        const eventData = f.envelope(agent, "echo fictional sample", "tour-session", event);
        await f.hook("prim-hook", agent, eventData);
        await f.hook("post-tool-use", agent, eventData);
      }
      // Use real editing-tool payloads so the direct ingest guard is exercised,
      // rather than relying on its normal early return for a read-only shell.
      const editEvent: Record<string, unknown> = {
        ...f.envelope(agent, "", "tour-session", "PostToolUse"),
        tool_name: agent === "hermes" ? "write_file" : agent === "codex" ? "apply_patch" : "Write",
        tool_input:
          agent === "hermes"
            ? { path: join(f.repo, "real.ts"), content: "fictional sample" }
            : agent === "codex"
              ? {
                  command:
                    "*** Begin Patch\n*** Update File: real.ts\n@@\n-export const real = true;\n+// fictional sample\n*** End Patch",
                }
              : { file_path: join(f.repo, "real.ts"), content: "fictional sample" },
        extra: { tool_call_id: "edit-1", status: "ok" },
      };
      await f.hook("post-tool-use", agent, editEvent);
      if (agent === "hermes") {
        await f.hook("post-tool-use", agent, {
          ...editEvent,
          hook_event_name: "post_approval_response",
          session_id: undefined,
          extra: { session_key: "tour-session", tool_call_id: "denied-1", choice: "deny" },
        });
      }
      expect(existsSync(join(f.config, "moves"))).toBe(false);
      expect(requests).not.toContain("/api/cli/moves/ingest");
      // A different session still captures, even in the same repository.
      await f.hook("prim-hook", agent, f.envelope(agent, "echo real work", "another-session"));
      expect(existsSync(join(f.config, "moves"))).toBe(true);
      await f.hook("post-tool-use", agent, {
        ...editEvent,
        ...(agent === "cursor"
          ? { conversation_id: "another-session" }
          : { session_id: "another-session" }),
      });
      expect(requests).toContain("/api/cli/moves/ingest");
      // Exclusion does not remove the explicitly approved authoring capability.
      const created = await f.run([
        "--yes",
        "decisions",
        "create",
        "--intent",
        "A real user-approved rule",
        "--attribution",
        "user",
      ]);
      expect(created.json.decisionId).toBe("real-decision");
      expect(requests).toContain("/api/cli/decisions/create");
      const welcome = await f.run([
        "welcome",
        "--capture-excluded",
        "--agent",
        agent === "claude_code" ? "claude" : agent,
      ]);
      expect(welcome.json.org).toBe("seed");
      expect(welcome.json.seedGuidance).toContain("Passive capture is excluded");
      expect(welcome.stderr).not.toContain("Capture is automatic");
    },
    30_000,
  );

  it("requires the user's reason, preserves it verbatim, and resumes a lost email response", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const { started, blocked } = await blockedStory(f);
    await expect(
      f.run(["demo", "resolve", blocked.runId, "--choice", "supersede"]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("your short reason") });
    const reason =
      "Customer's request for export 123e4567-e89b-42d3-a456-426614174000; $(echo never-run)";
    const command = `${blocked.choices.supersede.command} '--reason' ${quote(reason)}`;
    api.loseCompletion();
    const interrupted = (await f.call("codex", command)).json;
    expect(interrupted.stage).toBe("pending");
    expect(readFileSync(join(started.sandbox, "customers.ts"), "utf8")).toBe(DEMO_SUPERSEDE);
    const receipt = JSON.parse(readFileSync(f.statePath(blocked.runId), "utf8")).receipt;
    expect(receipt.appliedDigest).toHaveLength(64);
    const done = (await f.call("codex", interrupted.nextAction)).json;
    expect(done.stage).toBe("completed");
    expect(done.server.reason).toBe(reason);
    expect(done.presentation).toContain("[DEMO] Superceded Avery's Decision");
    expect(blocked.choices.supersede.prompt).toBe(
      "What's your rationale for superceding Avery's existing Decision?",
    );
    expect(api.queues()).toBe(1);
    expect(api.requests.filter((path) => path.endsWith("/resolve"))).toHaveLength(1);
    const completes = api.bodies.filter((body) => "appliedDigest" in body);
    expect(completes).toHaveLength(2);
    expect(completes[0]).toEqual(completes[1]);
  });
  it("refreshes a lost check revision on retry without mutating status reads", async () => {
    const f = fixture();
    const api = await serveStory(f);
    api.loseCheck();
    const { started, blocked } = await blockedStory(f);
    expect(blocked.stage).toBe("pending");
    const before = JSON.parse(readFileSync(f.statePath(blocked.runId), "utf8"));
    expect(before.needsStatus).toBe(true);
    const status = (await f.call("codex", blocked.statusAction)).json;
    expect(status.server.stage).toBe("checking");
    const after = JSON.parse(readFileSync(f.statePath(blocked.runId), "utf8"));
    expect(after.server).toEqual(before.server);
    const retry = (await f.call("codex", blocked.nextAction)).json;
    expect(retry.stage).toBe("conflict");
    expect(readFileSync(join(started.sandbox, "customers.ts"), "utf8")).toBe(DEMO_INITIAL);
  });
  it("leaves unavailable evaluation pending with unchanged bytes", async () => {
    const f = fixture();
    const api = await serveStory(f);
    api.pending(true);
    const { started, blocked } = await blockedStory(f);
    expect(blocked.stage).toBe("pending");
    expect(blocked.presentation).not.toContain("STOPPED THIS");
    expect(readFileSync(join(started.sandbox, "customers.ts"), "utf8")).toBe(DEMO_INITIAL);
    expect(api.queues()).toBe(0);
    api.pending(false);
    expect((await f.call("codex", blocked.nextAction)).json.stage).toBe("conflict");
  });
  it("rejects compound, stale and mismatched acknowledgments before revealing the story", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    await f.hook("prim-hook", "codex", f.envelope("codex", `${prepared.nextAction}; echo other`));
    expect((await f.shell(prepared.nextAction)).json.stage).toBe("pending");
    await Promise.all([
      f.hook("prim-hook", "codex", f.envelope("codex", prepared.nextAction)),
      f.hook("pre-tool-use", "codex", f.envelope("codex", prepared.nextAction)),
    ]);
    const path = f.statePath(prepared.runId);
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.acknowledgment.at -= 60_000;
    writeFileSync(path, JSON.stringify(state));
    expect((await f.shell(prepared.nextAction)).json.isolation).toBe("acknowledgment-expired");
    expect(api.requests).toEqual([]);
    const started = (await f.call("codex", prepared.nextAction)).json;
    expect((await f.call("codex", started.attemptAction, "another-session")).json.stage).toBe(
      "pending",
    );
    expect((await f.call("codex", started.attemptAction)).json.stage).toBe("conflict");
  });
  it("diagnoses a missing hook without writing state, calling the API, or looping status", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    const before = readFileSync(f.statePath(prepared.runId), "utf8");
    // A held lock must not prevent read-only diagnosis.
    mkdirSync(`${f.statePath(prepared.runId)}.lock`);
    const status = (await f.shell(prepared.statusAction)).json;
    expect(status).toMatchObject({
      stage: "pending",
      diagnostics: {
        expectedEvent: "PreToolUse",
        expectedTool: "Bash",
        hookObservation: null,
        trust: "unknown",
        capture: "not-verified",
      },
    });
    expect(status.nextAction).toBeUndefined();
    expect(status.diagnosticAction).toBeUndefined();
    expect(status.resumeAction).toContain("'resume'");
    expect(JSON.stringify(status)).not.toMatch(/CSV|customers|authorName|sandbox/);
    expect(readFileSync(f.statePath(prepared.runId), "utf8")).toBe(before);
    expect(api.requests).toEqual([]);
    expect((await f.run(["demo", "--agent", "codex"])).json.runId).not.toBe(prepared.runId);
  });
  it("reports configured hooks separately from execution and treats absent scopes as optional", async () => {
    const f = fixture();
    const status = await f.run(["codex", "status"]);
    expect(status.json.readiness).toMatchObject({
      configured: false,
      trust: "unknown",
      hookExecution: "not-verified",
      passiveCapture: "not-verified",
    });
    expect(status.stderr).toContain("not installed (optional when another scope is complete)");
    expect(status.stderr).not.toContain("✗");
  });
  it("reports a hook state-write failure without exposing sample content", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    mkdirSync(`${f.statePath(prepared.runId)}.lock`);
    await f.hook("prim-hook", "codex", f.envelope("codex", prepared.nextAction));
    const status = (await f.shell(prepared.statusAction)).json;
    expect(status.diagnostics.hookObservation.result).toBe("write-failed");
    expect(status.stage).toBe("pending");
    expect(JSON.stringify(status)).not.toMatch(/CSV|customers|sandbox/);
    expect(existsSync(join(f.config, "demo", "excluded-sessions"))).toBe(false);
    // An unrelated compound command still captures normally despite the lock.
    await f.hook(
      "prim-hook",
      "codex",
      f.envelope("codex", `${prepared.nextAction}; echo real-work`),
    );
    expect(existsSync(join(f.config, "moves"))).toBe(true);
  });
  it("reports malformed invocation and missing session without acknowledging either", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    await f.hook("prim-hook", "codex", f.envelope("codex", `${prepared.nextAction}; echo extra`));
    expect((await f.shell(prepared.statusAction)).json.diagnostics.hookObservation.result).toBe(
      "command-mismatch",
    );
    await f.hook("prim-hook", "codex", {
      ...f.envelope("codex", prepared.nextAction),
      session_id: "",
    });
    expect((await f.shell(prepared.statusAction)).json.diagnostics.hookObservation.result).toBe(
      "session-missing",
    );
    await f.hook("prim-hook", "codex", {
      ...f.envelope("codex", prepared.nextAction),
      tool_name: "exec_command",
      tool_input: { cmd: prepared.nextAction },
    });
    expect((await f.shell(prepared.statusAction)).json.diagnostics.hookObservation.result).toBe(
      "tool-mismatch",
    );
    const observation = readFileSync(
      join(f.config, "demo", "observations", `${prepared.runId}.json`),
      "utf8",
    );
    expect(observation).not.toContain(prepared.nextAction);
    expect(observation).not.toContain("tour-session");
    expect(
      JSON.parse(readFileSync(f.statePath(prepared.runId), "utf8")).acknowledgment,
    ).toBeUndefined();
  });
  it("resumes an expired launcher without exposing content or changing the bound session", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const { started, blocked } = await blockedStory(f);
    const path = f.statePath(started.runId);
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.launcher = ["/removed/node", "/removed/prim"];
    writeFileSync(path, JSON.stringify(state));
    const recovery = (await f.run(["demo", "resume", started.runId])).json;
    expect(recovery.nextAction).not.toContain("/removed");
    expect(JSON.stringify(recovery)).not.toMatch(/CSV|customers|authorName|sandbox/);
    expect((await f.call("codex", recovery.nextAction, "other-session")).json.stage).toBe(
      "pending",
    );
    const resumed = (await f.call("codex", recovery.nextAction)).json;
    expect(resumed.stage).toBe("conflict");
    expect((await f.call("codex", resumed.choices.adhere)).json.stage).toBe("completed");
    expect(api.queues()).toBe(1);
    expect(blocked.runId).toBe(resumed.runId);
  });
  it("reuses setup's pending run only for the same session and keeps explicit replays fresh", async () => {
    const f = fixture();
    const args = ["demo", "--agent", "codex", "--resume-pending"];
    const a = (await f.run(args, { CODEX_THREAD_ID: "a" })).json;
    expect((await f.run(args, { CODEX_THREAD_ID: "a" })).json.runId).toBe(a.runId);
    expect((await f.run(args, { CODEX_THREAD_ID: "b" })).json.runId).not.toBe(a.runId);
    expect(
      (await f.run(["demo", "--agent", "codex"], { CODEX_THREAD_ID: "a" })).json.runId,
    ).not.toBe(a.runId);
  });
  it("preserves foreign files and symlink targets during recovery", async () => {
    const f = fixture();
    await serveStory(f);
    const { started } = await blockedStory(f);
    const foreign = join(started.sandbox, "foreign");
    writeFileSync(foreign, "keep");
    await expect(f.shell(started.skipAction)).rejects.toMatchObject({
      stderr: expect.stringContaining("retained"),
    });
    expect(readFileSync(foreign, "utf8")).toBe("keep");
    rmSync(foreign);
    rmSync(join(started.sandbox, "customers.ts"));
    symlinkSync(join(f.repo, "real.ts"), join(started.sandbox, "customers.ts"));
    await expect(f.shell(started.skipAction)).rejects.toMatchObject({
      stderr: expect.stringContaining("retained"),
    });
    expect(readFileSync(join(f.repo, "real.ts"), "utf8")).toBe("export const real = true;\n");
    rmSync(join(started.sandbox, "customers.ts"));
    const recovery = (await f.run(["demo", "--agent", "codex"])).json.recoverableRuns;
    expect(recovery.some((run: { runId: string }) => run.runId === started.runId)).toBe(true);
    await f.shell(started.skipAction);
    expect(existsSync(started.sandbox)).toBe(false);
  });
  it("keeps independent runs separate and production enforcement active", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const a = (await f.run(["demo", "--agent", "codex"])).json;
    const b = (await f.run(["demo", "--agent", "codex"])).json;
    const started = await Promise.all([
      f.call("codex", a.nextAction, "a"),
      f.call("codex", b.nextAction, "b"),
    ]);
    expect(started[0].json.sandbox).not.toBe(started[1].json.sandbox);
    await f.shell(started[0].json.skipAction);
    expect(existsSync(started[1].json.sandbox)).toBe(true);
    const realEdit = {
      ...f.envelope("codex", "", "b"),
      tool_name: "apply_patch",
      tool_input: {
        command:
          "*** Begin Patch\n*** Update File: real.ts\n@@\n-export const real = true;\n+export const real = false;\n*** End Patch",
      },
    };
    const result = await f.hook("pre-tool-use", "codex", realEdit);
    expect(api.requests).toContain("/api/cli/decisions/conflict-check");
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });
  it("skips before isolation and retires legacy runs without revealing their samples", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    await f.call("codex", prepared.skipAction);
    expect(existsSync(join(f.config, "demo", "excluded-sessions"))).toBe(false);
    const old = (await f.run(["demo", "--agent", "codex"])).json;
    const state = JSON.parse(readFileSync(f.statePath(old.runId), "utf8"));
    state.version = 1;
    state.launcher = ["/removed/node", "/removed/prim"];
    writeFileSync(f.statePath(old.runId), JSON.stringify(state));
    const replay = (await f.run(["demo", "--agent", "codex"])).json;
    const cleanup = replay.recoverableRuns.find(
      (run: { runId: string }) => run.runId === old.runId,
    ).skipAction;
    expect(cleanup).not.toContain("/removed");
    expect((await f.shell(cleanup)).json.stage).toBe("skipped");
  });
  it.each(["seed", "active", "unknown"])(
    "keeps the post-tour %s handoff short and state-aware",
    async (org) => {
      const f = fixture();
      const server = createServer((_request, response) => {
        response.writeHead(org === "unknown" ? 503 : 200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ decisions: [], viewerHasDecisions: org === "active" }));
      });
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("missing server address");
      const output = await f.run(
        ["welcome", "--agent", "codex", "--capture-excluded", "--after-demo"],
        {
          PRIM_API_URL: `http://127.0.0.1:${address.port}`,
        },
      );
      expect(output.json).toMatchObject({ welcomed: true, org, captureExcluded: true });
      expect(output.json.recent).toBeUndefined();
      expect(output.json.presentation.split(/\s+/).length).toBeLessThan(40);
      expect(output.stderr).not.toContain("How it works");
      if (org === "seed") expect(output.json.seedGuidance).toContain("Passive capture is excluded");
      else expect(output.json.seedGuidance).toBeUndefined();
      if (org === "unknown") expect(output.json.presentation).toContain("unavailable");
    },
  );

  it("runs from distribution-only files and limits network calls to the explicit demo API", async () => {
    const f = fixture();
    const api = await serveStory(f);
    const packed = join(f.root, "package");
    mkdirSync(packed);
    cpSync(resolve("dist"), join(packed, "dist"), { recursive: true });
    cpSync(resolve("package.json"), join(packed, "package.json"));
    symlinkSync(resolve("node_modules"), join(packed, "node_modules"), "dir");
    const prepared = (
      await f.run(["demo", "--agent", "codex"], {}, join(packed, "dist", "index.js"))
    ).json;
    expect(api.requests).toEqual([]);
    const started = (await f.call("codex", prepared.nextAction)).json;
    expect(readdirSync(started.sandbox).sort()).toEqual([".owner", "customers.ts"]);
    const blocked = (await f.call("codex", started.attemptAction)).json;
    expect((await f.call("codex", blocked.choices.adhere)).json.stage).toBe("completed");
    expect(api.requests).toEqual([
      "/api/cli/demo/start",
      "/api/cli/demo/check",
      "/api/cli/demo/resolve",
      "/api/cli/demo/complete",
    ]);
  });
});
