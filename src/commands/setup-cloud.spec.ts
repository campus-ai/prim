import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CloudSetupDependencies,
  prepareCloudImage,
  setupCloudSession,
  setupDetectedCloudSession,
} from "./setup-cloud.js";
import { registerSetupCommand } from "./setup.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function repo(committedInstall: boolean, origin = "https://github.com/campus-ai/prim.git"): string {
  const root = tempDir("prim-cloud-repo-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
  if (committedInstall) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command: "prim-hook" }] }] } }),
    );
  }
  return root;
}

function harness(overrides: Partial<CloudSetupDependencies> = {}) {
  const calls: string[][] = [];
  const notes: string[] = [];
  const exit = vi.fn();
  const deps: CloudSetupDependencies = {
    run: (args) => {
      calls.push(args);
      return { code: 0, stdout: "{}" };
    },
    note: (message) => notes.push(message),
    exit,
    parseAuthStatus: () => "valid",
    stage: vi.fn(),
    installUserHooks: vi.fn(),
    markPrepared: vi.fn(),
    developerInstall: () => false,
    userHooksComplete: () => true,
    platform: "linux",
    env: {
      CLAUDE_CODE_REMOTE: "true",
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "secret",
      PRIM_CONFIG_DIR: tempDir("prim-cloud-config-"),
    },
    ...overrides,
  };
  // Never the real config directory: preparing clears and writes its marker.
  deps.env = { PRIM_CONFIG_DIR: tempDir("prim-cloud-config-"), ...deps.env };
  return { deps, calls, notes, exit };
}

let printed: unknown[];
beforeEach(() => {
  printed = [];
  vi.spyOn(console, "log").mockImplementation((value: string) => {
    printed.push(JSON.parse(value));
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prepareCloudImage", () => {
  it("wires user-scope prim and marks the environment prepared, without auth or a repository", () => {
    const { deps, calls, exit } = harness({ env: {} });
    prepareCloudImage(deps);
    expect(deps.stage).toHaveBeenCalledOnce();
    expect(deps.installUserHooks).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      ["claude", "preauth", "--scope", "user"],
      ["skill", "install", "--agent", "claude", "--scope", "user"],
      ["daemon", "stop"],
    ]);
    expect(deps.markPrepared).toHaveBeenCalledExactlyOnceWith("image");
    expect(printed).toEqual([
      {
        ok: true,
        cloud: "prepare",
        results: {
          runtime: "ok",
          userHooks: "ok",
          preauth: "ok",
          skill: "ok",
          daemon: "ok",
          prepared: "ok",
        },
        failed: [],
        remedies: [],
        instructions:
          "The cloud environment is prepared; sessions started from it load prim's hooks.",
      },
    ]);
    expect(exit).not.toHaveBeenCalled();
  });

  it("refuses to rewrite a Linux developer's own user-scope install", () => {
    const { deps, calls, exit } = harness({ env: {}, developerInstall: () => true });
    prepareCloudImage(deps);
    expect(deps.installUserHooks).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("still activates when only the skill or allow-rule step failed", () => {
    const { deps, exit } = harness({
      run: (args) => ({ code: args[0] === "skill" ? 1 : 0, stdout: "{}" }),
    });
    prepareCloudImage(deps);
    expect(deps.markPrepared).toHaveBeenCalledOnce();
    expect(printed[0]).toMatchObject({ ok: false, failed: ["skill"] });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("clears an earlier run's opt-in before a failing re-run", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "1\n");
    const { deps } = harness({
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: configDir },
      installUserHooks: () => {
        throw new Error("settings unreadable");
      },
    });
    prepareCloudImage(deps);
    expect(existsSync(join(configDir, "cloud-prepared"))).toBe(false);
  });

  it("does not mark an environment prepared when wiring failed", () => {
    const { deps, exit } = harness({
      installUserHooks: () => {
        throw new Error("settings unreadable");
      },
    });
    prepareCloudImage(deps);
    expect(deps.markPrepared).not.toHaveBeenCalled();
    expect(printed[0]).toMatchObject({ ok: false, failed: ["userHooks"] });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("is the image's prepare in a setup script, even where the VM already says cloud", () => {
    // The setup script runs before Claude Code launches: no CLAUDECODE.
    const { deps, exit } = harness({ env: { CLAUDE_CODE_REMOTE: "true" } });
    prepareCloudImage(deps);
    expect(deps.markPrepared).toHaveBeenCalledExactlyOnceWith("image");
    expect(printed[0]).toMatchObject({ ok: true, results: { prepared: "ok" } });
    expect(exit).not.toHaveBeenCalled();
  });

  it("run inside a session, wires only this VM and says the image is still unprepared", () => {
    const { deps, notes, exit } = harness({
      env: {
        CLAUDE_CODE_REMOTE: "true",
        CLAUDECODE: "1",
        PRIM_CONFIG_DIR: tempDir("prim-cloud-config-"),
      },
    });
    prepareCloudImage(deps);
    expect(deps.installUserHooks).toHaveBeenCalledOnce();
    expect(deps.markPrepared).toHaveBeenCalledExactlyOnceWith("session");
    expect(printed[0]).toMatchObject({
      ok: false,
      cloud: "prepare",
      results: { userHooks: "ok", prepared: "ok", image: "missing" },
      failed: ["image"],
      remedies: [expect.stringMatching(/not prepared by this run.*setup script/u)],
      instructions: expect.stringContaining("Cloud setup is incomplete"),
    });
    expect(notes.join("\n")).toContain("inside a running Claude Code session");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("cannot turn hooks pending from an in-session setup back into a prepared report", () => {
    const configDir = tempDir("prim-cloud-config-");
    const env = {
      CLAUDE_CODE_REMOTE: "true",
      CLAUDECODE: "1",
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "secret",
      PRIM_CONFIG_DIR: configDir,
    };
    // Real marker writes, so each run sees what the one before left behind.
    setupDetectedCloudSession(harness({ cwd: repo(false), env, markPrepared: undefined }).deps);
    expect(readFileSync(join(configDir, "cloud-prepared"), "utf8")).toBe("1 session\n");

    prepareCloudImage(harness({ env, markPrepared: undefined }).deps);
    expect(readFileSync(join(configDir, "cloud-prepared"), "utf8")).toBe("1 session\n");
    expect(printed[1]).toMatchObject({ ok: false, results: { image: "missing" } });

    setupCloudSession(harness({ cwd: repo(false), env, markPrepared: undefined }).deps);
    expect(printed[2]).toMatchObject({
      ok: false,
      results: { session: "missing" },
      remedies: [expect.stringContaining("add `prim setup --cloud --prepare`")],
    });
  });

  it("run inside a session on an unprepared VM, never records the image's origin", () => {
    const configDir = tempDir("prim-cloud-config-");
    const env = { CLAUDE_CODE_REMOTE: "true", CLAUDECODE: "1", PRIM_CONFIG_DIR: configDir };
    prepareCloudImage(harness({ env, markPrepared: undefined }).deps);
    expect(readFileSync(join(configDir, "cloud-prepared"), "utf8")).toBe("1 session\n");
  });

  it("re-run inside a session the image prepared, leaves its live hooks reported as live", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "1\n");
    const env = { CLAUDE_CODE_REMOTE: "true", CLAUDECODE: "1", PRIM_CONFIG_DIR: configDir };
    const { deps, exit } = harness({ env, markPrepared: undefined });
    prepareCloudImage(deps);
    expect(readFileSync(join(configDir, "cloud-prepared"), "utf8")).toBe("1\n");
    expect(printed[0]).toMatchObject({ ok: true, failed: [] });
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not trust an image marker whose user-scope hooks are gone", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "1\n");
    const env = { CLAUDE_CODE_REMOTE: "true", CLAUDECODE: "1", PRIM_CONFIG_DIR: configDir };
    const { deps } = harness({ env, markPrepared: undefined, userHooksComplete: () => false });
    prepareCloudImage(deps);
    expect(readFileSync(join(configDir, "cloud-prepared"), "utf8")).toBe("1 session\n");
    expect(printed[0]).toMatchObject({ ok: false, failed: ["image"] });
  });

  it("does not add the image remedy when the in-session wiring itself failed", () => {
    const { deps } = harness({
      env: { CLAUDE_CODE_REMOTE: "true", CLAUDECODE: "1" },
      installUserHooks: () => {
        throw new Error("settings unreadable");
      },
    });
    prepareCloudImage(deps);
    expect(printed[0]).toMatchObject({ ok: false, failed: ["userHooks"] });
  });

  it("refuses on a developer's machine, where it would disable the daemon", () => {
    const { deps, calls, exit } = harness({ env: {}, platform: "darwin" });
    prepareCloudImage(deps);
    expect(deps.stage).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(printed[0]).toMatchObject({ ok: false, failed: ["cloud"] });
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("reports a staging failure and exits incomplete", () => {
    const { deps, exit } = harness({
      stage: () => {
        throw new Error("disk full");
      },
    });
    prepareCloudImage(deps);
    expect(printed[0]).toMatchObject({ ok: false, failed: ["runtime"] });
    expect(deps.markPrepared).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("setupCloudSession", () => {
  it("verifies credentials, then wires git hooks and activates without touching tracked files", () => {
    const root = repo(true);
    const { deps, calls, exit } = harness({ cwd: root });
    setupCloudSession(deps);
    expect(calls).toEqual([
      ["auth", "status", "--json"],
      ["daemon", "stop"],
      ["hooks", "install"],
      ["enable", "--non-interactive"],
    ]);
    expect(printed[0]).toMatchObject({ ok: true, cloud: "session", failed: [] });
    expect(exit).not.toHaveBeenCalled();
  });

  it("refuses outside a Claude Code cloud session without touching the daemon", () => {
    const { deps, calls, notes, exit } = harness({
      cwd: repo(true),
      env: {
        PRIM_M2M_CLIENT_ID: "client_cloud",
        PRIM_M2M_CLIENT_SECRET: "secret",
        PRIM_CONFIG_DIR: tempDir("prim-cloud-config-"),
      },
    });
    setupCloudSession(deps);
    expect(calls).toEqual([]);
    expect(notes.join("\n")).toContain("not a Claude Code cloud session");
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("names the committed declaration when the checkout has no identity", () => {
    const { deps, calls, notes, exit } = harness({ cwd: repo(true, "") });
    setupCloudSession(deps);
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(notes.join("\n")).toContain("records PRIM_REPOSITORY in .claude/settings.json");
    expect(printed[0]).toMatchObject({ ok: false, results: { repository: "missing" } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("does not suggest a declaration when origin is a non-GitHub remote", () => {
    const { deps, notes } = harness({
      cwd: repo(true, "https://gitlab.example.com/team/prim.git"),
    });
    setupCloudSession(deps);
    expect(notes.join("\n")).toContain("not a GitHub repository");
    expect(notes.join("\n")).not.toContain("PRIM_REPOSITORY");
  });

  it("names the environment variables when credentials are missing", () => {
    const { deps, calls, notes, exit } = harness({
      cwd: repo(true),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: tempDir("prim-cloud-config-") },
    });
    setupCloudSession(deps);
    expect(calls).toEqual([]);
    expect(notes.join("\n")).toContain("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET");
    expect(notes.join("\n")).toContain("--new-installation");
    expect(printed[0]).toMatchObject({ ok: false, results: { credentials: "missing" } });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("passes the credential's own guidance through instead of advising revocation", () => {
    const { deps, notes } = harness({
      cwd: repo(true),
      parseAuthStatus: () => "invalid",
      run: (args) => ({
        code: args[0] === "auth" ? 1 : 0,
        stdout: JSON.stringify({
          recoveryDetail: "Set NODE_USE_ENV_PROXY=1 in the cloud environment's variables.",
        }),
      }),
    });
    setupCloudSession(deps);
    const text = notes.join("\n");
    expect(text).toContain(
      "credentials · Set NODE_USE_ENV_PROXY=1 in the cloud environment's variables;",
    );
    expect(text.indexOf("NODE_USE_ENV_PROXY")).toBeLessThan(text.indexOf("revoke"));
  });

  it("names the allowed domains when Primitive is unreachable", () => {
    const { deps, calls, notes, exit } = harness({
      cwd: repo(true),
      parseAuthStatus: () => "unreachable",
    });
    setupCloudSession(deps);
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(notes.join("\n")).toContain("signin.getprimitive.ai");
    expect(notes.join("\n")).toContain("Allowed domains");
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("still activates but reports a repository without committed prim hooks", () => {
    const { deps, calls, notes, exit } = harness({ cwd: repo(false) });
    setupCloudSession(deps);
    expect(calls.at(-1)).toEqual(["enable", "--non-interactive"]);
    expect(notes.join("\n")).toContain("prim setup --cloud --prepare");
    expect(notes.join("\n")).toContain("prim claude install --scope project");
    expect(printed[0]).toMatchObject({ ok: false, failed: ["session"] });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("accepts a prepared environment in place of a committed install", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "now\n");
    const { deps, exit } = harness({
      cwd: repo(false),
      env: {
        CLAUDE_CODE_REMOTE: "true",
        PRIM_M2M_CLIENT_ID: "client_cloud",
        PRIM_M2M_CLIENT_SECRET: "secret",
        PRIM_CONFIG_DIR: configDir,
      },
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({ ok: true, results: { session: "ok" } });
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not trust the marker once the user-scope hooks are gone", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "1\n");
    const { deps } = harness({
      cwd: repo(false),
      userHooksComplete: () => false,
      env: {
        CLAUDE_CODE_REMOTE: "true",
        PRIM_M2M_CLIENT_ID: "client_cloud",
        PRIM_M2M_CLIENT_SECRET: "secret",
        PRIM_CONFIG_DIR: configDir,
      },
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({ results: { session: "missing" } });
  });

  it("fails a failed activation", () => {
    const { deps, exit } = harness({
      cwd: repo(true),
      run: (args) => ({ code: args[0] === "enable" ? 1 : 0, stdout: "{}" }),
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({ ok: false, failed: ["enable"] });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("prim setup --cloud flags", () => {
  async function setup(args: string[]) {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      exit,
      note: () => {},
      run: (runArgs) => {
        calls.push(runArgs);
        return { code: 0, stdout: "{}" };
      },
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await program.parseAsync(["setup", ...args], { from: "user" });
    return { calls, exit };
  }

  it.each([
    [["--prepare"]],
    [["--cloud", "--agent", "codex"]],
    [["--cloud", "--scope", "project"]],
    [["--cloud", "--global-hooks-path"]],
    [["--cloud", "--migrate"]],
  ])("rejects %j as a usage error before any step runs", async (args) => {
    // Inside a cloud session, so only the flag check can stop it.
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    try {
      const { calls, exit } = await setup(args);
      expect(exit).toHaveBeenCalledWith(2);
      expect(calls).toEqual([]);
      expect(printed).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([[["--agent", "codex"]], [["--scope", "project"]], [["--migrate"]]])(
    "rejects plain setup %j inside a cloud session as it would with --cloud",
    async (args) => {
      vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
      try {
        const { calls, exit } = await setup(args);
        expect(exit).toHaveBeenCalledWith(2);
        expect(calls).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("runs cloud setup for plain `prim setup` inside a cloud session", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CONFIG_DIR", tempDir("prim-cloud-config-"));
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    try {
      const { calls } = await setup([]);
      expect(calls.flat()).not.toContain("login");
      expect(calls.some((args) => args[0] === "auth" && args[1] === "status")).toBe(true);
      expect(printed.at(-1)).toMatchObject({ cloud: "session", instructions: expect.any(String) });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes the cloud path instead of signing in or starting the daemon", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CONFIG_DIR", tempDir("prim-cloud-config-"));
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    try {
      const { calls } = await setup(["--cloud", "--agent", "claude"]);
      expect(calls[0]).toEqual(["auth", "status", "--json"]);
      expect(calls.flat()).not.toContain("login");
      expect(printed.at(-1)).toMatchObject({ cloud: "session" });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("setupDetectedCloudSession (plain `prim setup` in a cloud session)", () => {
  it("prepares an unprepared VM, sets up the session, and says the hooks are not live yet", () => {
    const { deps, calls, exit } = harness({ cwd: repo(false) });
    setupDetectedCloudSession(deps);
    expect(deps.installUserHooks).toHaveBeenCalledOnce();
    expect(calls.map((args) => args.slice(0, 2).join(" "))).toEqual([
      "claude preauth",
      "skill install",
      "daemon stop",
      "auth status",
      "hooks install",
      "enable --non-interactive",
    ]);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toMatchObject({
      ok: false,
      cloud: "session",
      results: { userHooks: "ok", prepared: "ok", session: "missing", enable: "ok" },
      remedies: [expect.stringContaining("add `prim setup --cloud --prepare`")],
      instructions: expect.stringContaining("before continuing"),
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("keeps reporting pending hooks when setup runs again in the same session", () => {
    const configDir = tempDir("prim-cloud-config-");
    const env = {
      CLAUDE_CODE_REMOTE: "true",
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "secret",
      PRIM_CONFIG_DIR: configDir,
    };
    // The real marker write, so the second run sees what the first left behind.
    const first = harness({ cwd: repo(false), env, markPrepared: undefined });
    setupDetectedCloudSession(first.deps);
    const second = harness({ cwd: repo(false), env, markPrepared: undefined });
    setupDetectedCloudSession(second.deps);
    expect(second.deps.installUserHooks).not.toHaveBeenCalled();
    expect(printed[1]).toMatchObject({
      ok: false,
      results: { session: "missing" },
      remedies: [expect.stringContaining("add `prim setup --cloud --prepare`")],
    });
    setupCloudSession(harness({ cwd: repo(false), env, markPrepared: undefined }).deps);
    expect(printed[2]).toMatchObject({ results: { session: "missing" } });
  });

  it("accepts a fixed PRIM_TOKEN in place of machine credentials", () => {
    const { deps, calls } = harness({
      cwd: repo(true),
      env: {
        CLAUDE_CODE_REMOTE: "true",
        PRIM_TOKEN: "token",
        PRIM_CONFIG_DIR: tempDir("prim-cloud-config-"),
      },
    });
    setupCloudSession(deps);
    expect(calls[0]).toEqual(["auth", "status", "--json"]);
    expect(printed[0]).toMatchObject({ results: { credentials: "ok" } });
  });

  it("accepts a stored sign-in in place of machine credentials, as SessionStart does", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "token"), "stored\n", { mode: 0o600 });
    const { deps, calls } = harness({
      cwd: repo(true),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: configDir },
    });
    setupCloudSession(deps);
    expect(calls[0]).toEqual(["auth", "status", "--json"]);
    expect(printed[0]).toMatchObject({ ok: true, results: { credentials: "ok" } });
  });

  it("does not accept a sign-in that can only enroll, which a cloud session cannot do", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "token"), "stored\n", { mode: 0o600 });
    const { deps, calls, exit } = harness({
      cwd: repo(true),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: configDir },
      run: (args) => {
        calls.push(args);
        return {
          code: 0,
          stdout: JSON.stringify({ status: "valid", enrollmentRequired: true }),
        };
      },
    });
    setupCloudSession(deps);
    // Stops at credentials: nothing is wired or enabled on a sign-in that
    // authorizes nothing here.
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(printed[0]).toMatchObject({
      ok: false,
      results: { credentials: "failed" },
      remedies: [expect.stringMatching(/can only enroll.*PRIM_M2M_CLIENT_ID/u)],
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("points a rejected sign-in at cloud credentials, not at an installation to revoke", () => {
    const configDir = tempDir("prim-cloud-config-");
    writeFileSync(join(configDir, "token"), "stored\n", { mode: 0o600 });
    const { deps, notes } = harness({
      cwd: repo(true),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: configDir },
      parseAuthStatus: () => "invalid",
    });
    setupCloudSession(deps);
    const text = notes.join("\n");
    expect(text).toContain("the sign-in was rejected: set PRIM_M2M_CLIENT_ID");
    expect(text).not.toContain("Developer installations");
  });

  it("does not claim the hooks will load when preparing failed", () => {
    const { deps } = harness({
      cwd: repo(false),
      stage: () => {
        throw new Error("disk full");
      },
    });
    setupDetectedCloudSession(deps);
    const report = printed[0] as { remedies: string[] };
    expect(report.remedies.join("\n")).not.toContain("loads them only when it next starts");
    expect(report.remedies.join("\n")).toContain("disk full");
  });

  it("only sets up the session when the repository commits prim's install", () => {
    const { deps, calls } = harness({ cwd: repo(true) });
    setupDetectedCloudSession(deps);
    expect(deps.installUserHooks).not.toHaveBeenCalled();
    expect(calls[0]).toEqual(["auth", "status", "--json"]);
  });
});

describe("agent contract in cloud setup output", () => {
  it("tells the agent to continue the task after a complete session", () => {
    const { deps } = harness({ cwd: repo(true) });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({
      ok: true,
      remedies: [],
      instructions: expect.stringContaining("continue their task"),
    });
  });

  it("lists each remedy and forbids browser sign-in when incomplete", () => {
    const { deps } = harness({
      cwd: repo(false),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: tempDir("prim-cloud-config-") },
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({
      ok: false,
      remedies: [expect.stringContaining("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET")],
      instructions: expect.stringContaining("do not run prim auth login"),
    });
  });

  it("names a failed child step as a remedy", () => {
    const { deps } = harness({
      cwd: repo(true),
      run: (args) => ({ code: args[0] === "enable" ? 1 : 0, stdout: "{}" }),
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({
      remedies: [
        expect.stringContaining("activate this repo · failed; run `prim enable --non-interactive`"),
      ],
    });
  });

  it("keeps the contract when it refuses outside a cloud session", () => {
    const { deps } = harness({ cwd: repo(true), env: {} });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({
      ok: false,
      remedies: [expect.stringContaining("not a Claude Code cloud session")],
      instructions: expect.any(String),
    });
  });
});
