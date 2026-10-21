import { execFile, execFileSync } from "node:child_process";
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

describe("packaged local onboarding", () => {
  it.each(["claude_code", "codex", "cursor", "hermes"])(
    "runs the two-choice tour and excludes both capture paths for %s",
    async (agent) => {
      const f = fixture();
      const requests: string[] = [];
      const server = createServer((req, res) => {
        requests.push(req.url ?? "");
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify(
            req.url?.startsWith("/api/cli/decisions/recent")
              ? { decisions: [], viewerHasDecisions: false }
              : { decisionId: "real-decision", shortId: "1234abcd", createdAt: 1 },
          ),
        );
      });
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      f.env.PRIM_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const prepared = (await f.run(["demo", "--agent", agent])).json;
      expect(prepared.stage).toBe("prepared");
      expect(JSON.stringify(prepared)).not.toContain("shared HTTP");
      const pending = await f.shell(prepared.nextAction);
      expect(pending.json.stage).toBe("pending");
      expect(pending.stderr).not.toContain("shared HTTP");
      expect(pending.stderr).not.toContain("YOUR MISSION");
      const started = await f.call(agent, prepared.nextAction);
      expect(started.json.stage).toBe("proposal");
      expect(started.stderr).toContain("scripted extraction");
      expect(started.stderr).toContain("YOUR MISSION: add order saving");
      expect(started.stderr.indexOf("YOUR MISSION")).toBeLessThan(
        started.stderr.indexOf("Sample ingestion"),
      );
      const sandbox = started.json.sandbox;
      const original = readFileSync(join(sandbox, "orders.ts"), "utf8");
      const confirmed = await f.call(agent, started.json.nextAction);
      expect(confirmed.stderr).toContain("WARNING — edit allowed");
      expect(confirmed.stderr).toContain("BLOCKED — file unchanged");
      expect(confirmed.json.evidence.block.after).toBe(original);
      expect(readFileSync(join(sandbox, "orders.ts"), "utf8")).toBe(original);
      expect(readFileSync(join(sandbox, "service.ts"), "utf8")).toContain("fetch(");
      expect(JSON.parse(readFileSync(join(sandbox, "decisions.json"), "utf8"))).toHaveLength(2);
      const retry = confirmed.json.retryAction;
      expect((await f.call(agent, retry)).json.stage).toBe("conflict");
      expect(readFileSync(join(sandbox, "orders.ts"), "utf8")).toBe(original);
      const completed = await f.call(agent, confirmed.json.nextAction);
      expect(completed.json.stage).toBe("completed");
      expect(completed.json.evidence.correction.after).toContain("http.get");
      expect(completed.stderr).toContain("PASS");
      expect(existsSync(sandbox)).toBe(false);
      expect(completed.json.nextAction).toContain("--capture-excluded");
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
      expect(requests).toEqual([]);
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
    25_000,
  );

  it("rejects compound, stale and different-session acknowledgments; serializes duplicate hooks", async () => {
    const f = fixture();
    const { json: prepared } = await f.run(["demo", "--agent", "claude"]);
    await f.hook(
      "prim-hook",
      "claude_code",
      f.envelope("claude_code", `${prepared.nextAction}; echo other`),
    );
    expect((await f.shell(prepared.nextAction)).json.stage).toBe("pending");
    await Promise.all([
      f.hook("prim-hook", "claude_code", f.envelope("claude_code", prepared.nextAction)),
      f.hook("pre-tool-use", "claude_code", f.envelope("claude_code", prepared.nextAction)),
    ]);
    const path = f.statePath(prepared.runId);
    const state = JSON.parse(readFileSync(path, "utf8"));
    state.acknowledgment.at -= 60_000;
    writeFileSync(path, JSON.stringify(state));
    expect((await f.shell(prepared.nextAction)).json.stage).toBe("pending");
    const started = await f.call("claude_code", prepared.nextAction);
    const wrongSession = await f.call("claude_code", started.json.nextAction, "different-session");
    expect(wrongSession.json.stage).toBe("pending");
    expect(wrongSession.stderr).not.toContain("Persist orders");
    const confirmed = await f.call("claude_code", started.json.nextAction);
    expect(confirmed.json.stage).toBe("conflict");
    const repeated = await f.call("claude_code", started.json.nextAction);
    expect(repeated.json.evidence).toEqual(confirmed.json.evidence);
    await f.shell(confirmed.json.skipAction);
    expect(existsSync(started.json.sandbox)).toBe(false);
  });

  it("preserves foreign files and symlinks during cleanup and offers interrupted-run recovery", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    const started = (await f.call("codex", prepared.nextAction)).json;
    const next = (await f.run(["demo", "--agent", "codex"])).json;
    expect(next.recoverableRuns).toContainEqual({
      runId: prepared.runId,
      skipAction: started.skipAction,
    });
    const foreign = join(started.sandbox, "foreign.txt");
    writeFileSync(foreign, "keep");
    await expect(f.shell(started.skipAction)).rejects.toMatchObject({
      stderr: expect.stringContaining("retained"),
    });
    expect(readFileSync(foreign, "utf8")).toBe("keep");
    rmSync(foreign);
    rmSync(join(started.sandbox, "service.ts"));
    symlinkSync(join(f.repo, "real.ts"), join(started.sandbox, "service.ts"));
    await expect(f.shell(started.skipAction)).rejects.toMatchObject({
      stderr: expect.stringContaining("retained"),
    });
    expect(readFileSync(join(f.repo, "real.ts"), "utf8")).toBe("export const real = true;\n");
    rmSync(join(started.sandbox, "service.ts"));
    await f.shell(started.skipAction);
    expect(existsSync(started.sandbox)).toBe(false);
    expect((await f.run(["demo", "--agent", "codex"])).json.stage).toBe("prepared");
  });

  it("skips before starting without excluding the session, and rejects out-of-order choices", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "claude"])).json;
    await f.call("claude_code", prepared.skipAction);
    expect(existsSync(join(f.config, "demo", "excluded-sessions"))).toBe(false);
    const replay = (await f.run(["demo", "--agent", "claude"])).json;
    const invalid = replay.nextAction.replace("'start'", "'confirm'");
    await expect(f.call("claude_code", invalid)).rejects.toMatchObject({
      stderr: expect.stringContaining("start the demo before confirming"),
    });
    expect(JSON.parse(readFileSync(f.statePath(replay.runId), "utf8")).stage).toBe("prepared");
  });

  it("cleans still-owned files after a recoverable error without marking onboarding complete", async () => {
    const f = fixture();
    const prepared = (await f.run(["demo", "--agent", "codex"])).json;
    const started = (await f.call("codex", prepared.nextAction)).json;
    rmSync(join(started.sandbox, "orders.ts"));
    await expect(f.call("codex", started.nextAction)).rejects.toMatchObject({
      stderr: expect.stringContaining("ENOENT"),
    });
    expect(existsSync(started.sandbox)).toBe(false);
    expect(existsSync(join(f.config, "demo", "onboarding.json"))).toBe(false);
    expect(JSON.parse(readFileSync(f.statePath(prepared.runId), "utf8")).stage).toBe("prepared");
    const restarted = await f.call("codex", prepared.nextAction);
    expect(restarted.json.stage).toBe("proposal");
  });

  it("keeps independent runs separate and leaves real-work enforcement active", async () => {
    const f = fixture();
    const requests: string[] = [];
    const server = createServer((req, res) => {
      requests.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          protocolVersion: 3,
          verdict: "block",
          reasonCode: "high_confidence_contradiction",
          message: "real policy",
          conflicts: [],
          bypassed: [],
        }),
      );
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    f.env.PRIM_API_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const a = (await f.run(["demo", "--agent", "codex"])).json;
    const b = (await f.run(["demo", "--agent", "codex"])).json;
    const started = await Promise.all([
      f.call("codex", a.nextAction, "a"),
      f.call("codex", b.nextAction, "b"),
    ]);
    expect(started[0].json.sandbox).not.toBe(started[1].json.sandbox);
    await f.shell(started[0].json.skipAction);
    expect(existsSync(started[1].json.sandbox)).toBe(true);
    const realEdit = f.envelope("codex", "", "b");
    realEdit.tool_name = "apply_patch";
    realEdit.tool_input = {
      command:
        "*** Begin Patch\n*** Update File: real.ts\n@@\n-export const real = true;\n+export const real = false;\n*** End Patch",
    };
    const result = await f.hook("pre-tool-use", "codex", realEdit);
    expect(requests).toContain("/api/cli/decisions/conflict-check");
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
    const binding = JSON.parse(readFileSync(f.statePath(b.runId), "utf8")).binding;
    writeFileSync(join(f.config, "demo", "excluded-sessions", `${binding}.json`), "broken");
    const afterCorruption = await f.hook("pre-tool-use", "codex", realEdit);
    expect(JSON.parse(afterCorruption.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("runs from distribution-only files without starting network or background work", async () => {
    const f = fixture();
    const packed = join(f.root, "package");
    mkdirSync(packed);
    cpSync(resolve("dist"), join(packed, "dist"), { recursive: true });
    cpSync(resolve("package.json"), join(packed, "package.json"));
    // Normal dist uses external packages; emulate an installed package's resolution.
    symlinkSync(resolve("node_modules"), join(packed, "node_modules"), "dir");
    const preload = join(f.root, "forbid-background.cjs");
    const log = join(f.root, "side-effects");
    writeFileSync(
      preload,
      `
const fs = require("node:fs");
const cp = require("node:child_process");
const fail = () => { fs.appendFileSync(${JSON.stringify(log)}, "unexpected work\\n"); throw Error("unexpected background/network work"); };
globalThis.fetch = fail;
cp.spawn = fail;
require("node:http").request = fail;
require("node:https").request = fail;
require("node:module").syncBuiltinESMExports();
`,
    );
    const prepared = await f.run(
      ["demo", "--agent", "claude"],
      {
        NODE_OPTIONS: `--require=${preload}`,
        PRIM_UNATTENDED: "",
        NO_UPDATE_NOTIFIER: "",
      },
      join(packed, "dist", "index.js"),
    );
    expect(prepared.json.stage).toBe("prepared");
    expect(existsSync(log)).toBe(false);
    const started = await f.call("claude_code", prepared.json.nextAction);
    expect(started.json.stage).toBe("proposal");
    expect(readdirSync(started.json.sandbox)).toContain("decisions.json");
  });
});
