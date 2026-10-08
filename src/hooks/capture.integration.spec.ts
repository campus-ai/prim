import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "pipe" });
}, 30000);
const temporary: string[] = [];

function fixture() {
  const temp = realpathSync(mkdtempSync(join(tmpdir(), "prim-capture-workflow-")));
  temporary.push(temp);
  const home = join(temp, "home");
  const config = join(temp, "config");
  const main = join(temp, "main");
  const sibling = join(temp, "sibling");
  for (const path of [home, main]) mkdirSync(path);
  const env = {
    ...process.env,
    HOME: home,
    PRIM_CONFIG_DIR: config,
    PRIM_TOKEN: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    PRIM_API_URL: "http://127.0.0.1:1",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git(main, "init", "-q");
  git(main, "config", "user.name", "Fixture");
  git(main, "config", "user.email", "fixture@example.test");
  // Fixture history only: no workspace code is committed by this workflow.
  git(main, "config", "commit.gpgsign", "false");
  git(main, "commit", "--allow-empty", "-qm", "fixture");
  git(main, "remote", "add", "origin", "https://github.com/owner/repo.git");
  git(main, "worktree", "add", "-qb", "sibling", sibling);
  git(main, "config", "prim.repoSyncId", "fixture_repo");
  git(main, "config", "prim.repoSyncRepository", "owner/repo");
  return { home, config, main, sibling, env, git };
}

function run(
  f: ReturnType<typeof fixture>,
  cwd: string,
  entry: string,
  args: string[],
  input?: object,
  allowedExitCodes = [0],
): Promise<string> {
  return new Promise((accept, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, entry.replace(/^src\//u, "dist/").replace(/\.ts$/u, ".js")), ...args],
      { cwd, env: f.env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code !== null && allowedExitCodes.includes(code)
        ? accept(stdout)
        : reject(new Error(`${entry}: ${code}: ${stderr}`)),
    );
    child.stdin.end(input ? JSON.stringify(input) : "");
  });
}

function journals(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory()
      ? journals(join(path, item.name))
      : item.name === "journal.ndjson"
        ? [join(path, item.name)]
        : [],
  );
}

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Codex capture workflows", () => {
  it("keeps an inactive repository silent at startup and capture", async () => {
    const f = fixture();
    for (const entry of ["session-start", "prim-hook"])
      await run(f, f.main, `src/hooks/${entry}.ts`, ["--agent", "codex"], {
        hook_event_name: "SessionStart",
        session_id: "inactive",
        cwd: f.main,
      });
    expect(existsSync(f.config)).toBe(false);
    expect(existsSync(join(f.main, ".git", "prim"))).toBe(false);
  });

  it("captures real prompts in both worktrees and attributes sibling edits to their target", async () => {
    const f = fixture();
    f.git(f.main, "config", "prim.active", "true");
    for (const cwd of [f.main, f.sibling]) {
      await run(f, cwd, "src/hooks/prim-hook.ts", ["--agent", "codex"], {
        hook_event_name: "UserPromptSubmit",
        session_id: cwd === f.main ? "main-session" : "sibling-session",
        cwd,
        prompt: "Use durable storage for retries in a later PR.",
      });
      const stamp = resolve(
        cwd,
        f.git(cwd, "rev-parse", "--git-path", "prim/conversation-captured/codex"),
      );
      expect(JSON.parse(readFileSync(stamp, "utf8")).at).toBeGreaterThan(0);
    }
    await run(f, f.main, "src/hooks/prim-hook.ts", ["--agent", "codex"], {
      hook_event_name: "PostToolUse",
      session_id: "main-session",
      cwd: f.main,
      tool_name: "apply_patch",
      tool_input: `*** Begin Patch\n*** Add File: ${join(f.sibling, "store.ts")}\n+export const durable = true;\n*** End Patch`,
    });
    const moves = journals(f.config).flatMap((path) =>
      readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    );
    expect(moves.filter((move) => move.eventType === "UserPromptSubmit")).toHaveLength(2);
    const edit = moves.find((move) => move.eventType === "PostToolUse");
    expect(edit.env.gitRoot).toBe(f.main);
    expect(edit.payload.primitive.fileRefs).toEqual([]);
    expect(edit.payload.primitive.targetCheckouts).toEqual([
      expect.objectContaining({
        gitRoot: f.sibling,
        repoSyncId: "fixture_repo",
        fileRefs: ["store.ts"],
      }),
    ]);
    expect(edit.payload.primitive.targetCheckouts[0].workspaceId).not.toBe(edit.env.workspaceId);
  });

  it("migrates project installation explicitly, preserves custom hooks, and distinguishes installation from execution", async () => {
    const f = fixture();
    mkdirSync(join(f.main, ".codex"));
    const project = join(f.main, ".codex", "hooks.json");
    writeFileSync(
      project,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: "command", command: "custom-start" }] }] },
      }),
    );
    await run(f, f.main, "src/index.ts", ["codex", "install", "--scope", "project"]);
    expect(readFileSync(project, "utf8")).toContain("prim-hook");
    await run(f, f.sibling, "src/index.ts", ["codex", "install"]);
    expect(readFileSync(join(f.home, ".codex", "hooks.json"), "utf8")).toContain("prim-hook");
    await run(f, f.main, "src/index.ts", ["codex", "uninstall", "--scope", "project"]);
    expect(readFileSync(project, "utf8")).toContain("custom-start");
    expect(readFileSync(project, "utf8")).not.toContain("prim-hook");
    expect(existsSync(join(f.main, ".git", "prim", "conversation-captured", "codex"))).toBe(false);
    const unverified = await run(f, f.main, "src/index.ts", ["doctor"], undefined, [0, 1, 2]);
    expect(unverified).toContain("conversation capture unverified; Codex trust unknown");
    f.git(f.main, "config", "prim.active", "true");
    await run(f, f.main, "src/hooks/prim-hook.ts", ["--agent", "codex"], {
      hook_event_name: "UserPromptSubmit",
      session_id: "doctor-execution",
      cwd: f.main,
      prompt: "Retain explicit choices.",
    });
    const observed = await run(f, f.main, "src/index.ts", ["doctor"], undefined, [0, 1, 2]);
    expect(observed).toContain("conversation capture observed");
    expect(observed).toContain("current trust unknown");
  });

  it("leaves targets in an unrelated clone unresolved", async () => {
    const f = fixture();
    f.git(f.main, "config", "prim.active", "true");
    const foreign = join(f.home, "unrelated");
    f.git(f.main, "clone", "-q", f.main, foreign);
    f.git(foreign, "remote", "set-url", "origin", "https://github.com/owner/repo.git");
    await run(f, f.main, "src/hooks/prim-hook.ts", ["--agent", "codex"], {
      hook_event_name: "PostToolUse",
      session_id: "foreign-target",
      cwd: f.main,
      tool_name: "apply_patch",
      tool_input: `*** Begin Patch\n*** Add File: ${join(foreign, "store.ts")}\n+export const durable = true;\n*** End Patch`,
    });
    const edit = journals(f.config)
      .flatMap((path) =>
        readFileSync(path, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line)),
      )
      .find((move) => move.eventType === "PostToolUse");
    expect(edit.payload.primitive.targetCheckouts).toBeUndefined();
    expect(edit.payload.primitive.fileRefsIncomplete).toBe(true);
  });

  it.each([401, 503])("reports HTTP %s through the actual preflight client", async (status) => {
    const f = fixture();
    f.git(f.main, "config", "prim.active", "true");
    const server = createServer((_request, response) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unavailable" }));
    });
    await new Promise<void>((accept) => server.listen(0, "127.0.0.1", accept));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No fixture listener");
    f.env.PRIM_API_URL = `http://127.0.0.1:${address.port}`;
    f.env.PRIM_TOKEN = "rejected-fixture-token";
    try {
      const output = JSON.parse(
        await run(f, f.main, "src/hooks/pre-tool-use.ts", ["--agent", "claude"], {
          hook_event_name: "PreToolUse",
          session_id: "preflight",
          tool_use_id: "edit-1",
          cwd: f.main,
          tool_name: "Edit",
          tool_input: {
            file_path: join(f.main, "store.ts"),
            old_string: "false",
            new_string: "true",
          },
        }),
      );
      expect(output.systemMessage).toContain(
        status === 401 ? "PRIM_TOKEN was rejected" : "enforcement service unavailable",
      );
      expect(output.systemMessage).toContain("change was not verified");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((accept) => server.close(() => accept()));
    }
  });
});
