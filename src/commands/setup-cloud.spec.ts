import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forwardToApi } from "../lib/machine-broker.js";
import {
  MachineAuthError,
  discoverMachineConfiguration,
  exchangeMachineCredentials,
} from "../lib/machine-protocol.js";
import { recordProxyFailure, withMachineCooldown } from "../lib/machine-retry.js";
import { tunnelCheckedFetch } from "../lib/proxy-tunnel.js";
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
  // Whether a clone is active must not depend on the host's own prim.active.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
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

  it("leaves a repository that commits its opt-out off, and says so instead of enabling it", () => {
    const root = repo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    const { deps, calls, notes, exit } = harness({ cwd: root });
    setupCloudSession(deps);
    // Credentials are still verified; nothing is wired or activated.
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(printed[0]).toMatchObject({
      ok: true,
      optedOut: true,
      results: { credentials: "ok", repository: "ok" },
      failed: [],
      instructions: expect.stringContaining("opts out of Primitive"),
    });
    expect(notes.join("\n")).toContain("PRIM_ACTIVE=false");
    expect(exit).not.toHaveBeenCalled();
  });

  it("needs no repository identity from a repository that opts out", () => {
    const root = repo(false, "");
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    const { deps } = harness({ cwd: root });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({ ok: true, optedOut: true });
  });

  it("sets up a clone someone explicitly enabled despite the committed opt-out", () => {
    const root = repo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    execFileSync("git", ["config", "--local", "prim.active", "true"], { cwd: root });
    const { deps, calls } = harness({ cwd: root });
    setupCloudSession(deps);
    expect(calls.at(-1)).toEqual(["enable", "--non-interactive"]);
    expect(printed[0]).not.toHaveProperty("optedOut");
  });

  it("treats an activation prim itself wrote down as no one's explicit choice", () => {
    // An earlier session activated this clone implicitly; the opt-out came later.
    const root = repo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    execFileSync("git", ["config", "--local", "prim.active", "true"], { cwd: root });
    execFileSync("git", ["config", "--local", "prim.activeImplicit", "true"], { cwd: root });
    const { deps, calls } = harness({ cwd: root });
    setupCloudSession(deps);
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(printed[0]).toMatchObject({ ok: true, optedOut: true });
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
          recoveryDetail: "Check the cloud environment's network secret for signin.example.com.",
        }),
      }),
    });
    setupCloudSession(deps);
    const text = notes.join("\n");
    expect(text).toContain(
      "credentials · Check the cloud environment's network secret for signin.example.com;",
    );
    expect(text.indexOf("network secret")).toBeLessThan(text.indexOf("revoke"));
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
  it("prepares nothing in an unprepared VM for a repository that opts out", () => {
    const root = repo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    const { deps, calls, exit } = harness({ cwd: root });
    setupDetectedCloudSession(deps);
    // No user-scope hooks, allow-rule, skill, daemon change, or marker: the
    // VM stays as its environment's owner left it.
    expect(deps.stage).not.toHaveBeenCalled();
    expect(deps.installUserHooks).not.toHaveBeenCalled();
    expect(deps.markPrepared).not.toHaveBeenCalled();
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(printed[0]).toMatchObject({ ok: true, optedOut: true, failed: [] });
    expect(exit).not.toHaveBeenCalled();
  });

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
    expect(text).toContain(
      "the sign-in was rejected: give the cloud environment PRIM_M2M_CLIENT_ID",
    );
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
      remedies: [
        expect.stringContaining("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET"),
        expect.stringContaining("session hooks · none"),
      ],
      instructions: expect.stringContaining("do not run prim auth login"),
    });
  });

  it("reports every prerequisite it can judge in one pass, since each fix reaches only the next session", () => {
    // No credentials, no setup script, and a checkout that names no repository.
    vi.stubEnv("PRIM_API_URL", undefined);
    const { deps, calls } = harness({
      cwd: repo(false, ""),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: tempDir("prim-cloud-config-") },
    });
    setupCloudSession(deps);
    expect(calls).toEqual([]);
    expect(printed[0]).toMatchObject({
      ok: false,
      results: { credentials: "missing", repository: "missing", session: "missing" },
      failed: ["credentials", "repository", "session"],
      remedies: [
        expect.stringMatching(
          /^credentials · missing: .*the environment must also allow api\.getprimitive\.ai and signin\.getprimitive\.ai under Allowed domains \(blocked by default\)$/u,
        ),
        expect.stringContaining("does not identify its GitHub repository"),
        // Whether the image carries the hooks is judged without a repository.
        expect.stringContaining("session hooks · none: run `prim setup --cloud --prepare`"),
      ],
    });
  });

  it("judges nothing for a repository that opts out, whatever else is missing", () => {
    const root = repo(false);
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_ACTIVE: "false" } }),
    );
    const { deps } = harness({
      cwd: root,
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: tempDir("prim-cloud-config-") },
    });
    setupCloudSession(deps);
    expect(printed[0]).toMatchObject({ failed: ["credentials"] });
    expect((printed[0] as { results: Record<string, string> }).results.session).toBeUndefined();
  });

  it("relays a failure's own advice once, and never a pointer back at itself", () => {
    const blocked =
      "Machine authentication could not reach signin.staging.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited).";
    const cooling =
      "Machine authentication is cooling down after a temporary failure; in this Claude Code cloud session, run `prim setup --cloud` for the fix";
    for (const [recoveryDetail, relayed] of [
      // The host that failed is kept; it need not be the default one.
      [blocked, "could not reach signin.staging.example.com"],
      [cooling, "(Machine authentication is cooling down after a temporary failure)"],
    ] as const) {
      const { deps, notes } = harness({
        cwd: repo(true),
        parseAuthStatus: () => "unreachable",
        run: () => ({ code: 2, stdout: JSON.stringify({ recoveryDetail }) }),
      });
      setupCloudSession(deps);
      const line = notes.find((note) => note.startsWith("credentials ·")) ?? "";
      expect(line.match(/Allowed domains/gu)).toHaveLength(1);
      expect(line).not.toContain("run `prim setup --cloud`");
      expect(line).toContain(relayed);
    }
  });

  it("does not blame the network for a wait the sign-in service asked for", () => {
    const { deps, notes } = harness({
      cwd: repo(true),
      parseAuthStatus: () => "unreachable",
      run: () => ({
        code: 2,
        stdout: JSON.stringify({
          recoveryDetail: "The sign-in service asked prim to wait; retry in about 290s",
        }),
      }),
    });
    setupCloudSession(deps);
    expect(notes).toContain(
      "credentials · The sign-in service asked prim to wait; retry in about 290s",
    );
    expect(notes.join("\n")).not.toContain("Allowed domains");
  });

  it("gives a person's sign-in the link it can use, where a machine is sent home", () => {
    const { deps, notes } = harness({
      cwd: repo(true),
      env: { CLAUDE_CODE_REMOTE: "true", PRIM_TOKEN: "person-token" },
      run: (args) =>
        args[0] === "enable"
          ? {
              code: 1,
              stdout: JSON.stringify({
                bindingStatus: "unbound",
                repositoryFullName: "campus-ai/demo-app",
              }),
            }
          : { code: 0, stdout: "{}" },
    });
    setupCloudSession(deps);
    expect(notes).toContain(
      "repository · campus-ai/demo-app is not connected to Primitive: run `prim github connect --no-browser` and open the link it prints",
    );
  });

  it("offers no commit where there is no repository to commit to", () => {
    const { deps, notes } = harness({ cwd: tempDir("prim-cloud-norepo-") });
    setupCloudSession(deps);
    expect(notes).toContain(
      "session hooks · none: run `prim setup --cloud --prepare` in the environment's setup script",
    );
  });

  it("names the missing setup script alongside a rejected credential", () => {
    const { deps, calls } = harness({
      cwd: repo(false),
      parseAuthStatus: () => "invalid",
      run: (args) => {
        calls.push(args);
        return { code: 1, stdout: "{}" };
      },
    });
    setupCloudSession(deps);
    // Nothing is wired or activated on a credential the server rejects.
    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(printed[0]).toMatchObject({
      results: { credentials: "failed", session: "missing" },
      failed: ["credentials", "session"],
      remedies: [
        expect.stringContaining("credentials · rejected"),
        expect.stringContaining("session hooks · none: run `prim setup --cloud --prepare`"),
      ],
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

  it("names the fix for an unconnected repository, which no command in the session can make", () => {
    const { deps, notes } = harness({
      cwd: repo(true),
      run: (args) =>
        args[0] === "enable"
          ? {
              code: 1,
              stdout: JSON.stringify({
                active: false,
                bindingStatus: "unbound",
                repositoryFullName: "campus-ai/demo-app",
              }),
            }
          : { code: 0, stdout: "{}" },
    });
    setupCloudSession(deps);
    const remedy =
      "repository · campus-ai/demo-app is not connected to Primitive: run `prim github connect` in a clone of it on your own machine, then start a new cloud session";
    expect(notes).toContain(remedy);
    expect(printed[0]).toMatchObject({ ok: false, failed: ["enable"], remedies: [remedy] });
  });

  it("retries the credential check at once instead of reporting an earlier failure's cooldown", () => {
    const { deps } = harness({ cwd: repo(true) });
    const config = deps.env?.PRIM_CONFIG_DIR as string;
    const cooldown = join(config, `machine_retry_${"a".repeat(64)}.json`);
    writeFileSync(cooldown, JSON.stringify({ failures: 5, retryAt: Date.now() + 60_000 }));
    let cooldownAtCheck: boolean | undefined;
    deps.run = (args) => {
      if (args[0] === "auth") cooldownAtCheck = existsSync(cooldown);
      return { code: 0, stdout: "{}" };
    };
    setupCloudSession(deps);
    expect(cooldownAtCheck).toBe(false);
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

describe("each failure, as the command that met it says it and as `prim setup --cloud` relays it", () => {
  const API = "https://api.getprimitive.ai";
  const CLIENT = "client_cloud";
  const configuration = {
    issuer: "https://signin.getprimitive.ai",
    audience: "client_environment",
  };
  // A cloud session with its credentials in the variables, without and with a
  // proxy to send prim's requests through.
  const unrouted = {
    CLAUDE_CODE_REMOTE: "true",
    PRIM_M2M_CLIENT_ID: CLIENT,
    PRIM_M2M_CLIENT_SECRET: "secret",
  };
  const routed = { ...unrouted, HTTPS_PROXY: "http://127.0.0.1:3128" };
  const session = (env: Record<string, string>) => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  };
  afterEach(() => vi.unstubAllEnvs());

  /** The failure itself, from the code that raises it. */
  const failure = async (attempt: Promise<unknown>): Promise<MachineAuthError> => {
    const error = await attempt.then(
      () => undefined,
      (raised: unknown) => raised,
    );
    expect(error).toBeInstanceOf(MachineAuthError);
    return error as MachineAuthError;
  };
  /** Discovery through a stand-in proxy that answers every CONNECT with `answer`. */
  async function throughProxy(answer: number): Promise<MachineAuthError> {
    const proxy = createServer();
    proxy.on("connect", (_request, socket: Duplex) => {
      socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      return await failure(
        discoverMachineConfiguration(
          API,
          undefined,
          tunnelCheckedFetch({
            env: {
              NODE_USE_ENV_PROXY: "1",
              HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
            },
            fetch: (async () => new Response("unreached")) as typeof fetch,
          }),
        ),
      );
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }
  /** A request that never resolves the host, as a session's own stale DNS does. */
  const unresolved = (async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    });
  }) as typeof fetch;
  const tokenService = (status: number, headers: Record<string, string> = {}) =>
    (async () => new Response("{}", { status, headers })) as typeof fetch;

  /**
   * The line cloud setup prints for a failure, given what `auth status --json`
   * reports of it: a failure that ends the credential is invalid, any other
   * leaves Primitive unreachable.
   */
  function relayed(error: MachineAuthError, env: NodeJS.ProcessEnv, config = tempDir("prim-")) {
    const { deps, notes } = harness({
      cwd: repo(true),
      env: { ...env, PRIM_CONFIG_DIR: config },
      parseAuthStatus: () => (error.terminal ? "invalid" : "unreachable"),
      run: () => ({
        code: 1,
        stdout: JSON.stringify({ recoveryReason: error.code, recoveryDetail: error.message }),
      }),
    });
    setupCloudSession(deps);
    return notes.find((note) => note.startsWith("credentials ·"));
  }

  const BLOCKED =
    "Machine authentication could not reach api.getprimitive.ai. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited)";
  const IN_SESSION = "; the change takes effect in this session within about a minute";
  const BOTH = "; prim needs api.getprimitive.ai and signin.getprimitive.ai allowed";

  it("a blocked host, where prim's requests ride the proxy", async () => {
    session(routed);
    const error = await throughProxy(403);
    expect(error).toMatchObject({ code: "authentication_unavailable", terminal: false });
    expect(error.message).toBe(`${BLOCKED}${IN_SESSION}.`);
    expect(relayed(error, routed)).toBe(`credentials · ${BLOCKED}${IN_SESSION}${BOTH}`);
  });

  it("a blocked host, where prim connects by itself", async () => {
    session(unrouted);
    const error = await failure(discoverMachineConfiguration(API, undefined, unresolved));
    expect(error).toMatchObject({ code: "authentication_unavailable", terminal: false });
    // No promise about when the edit reaches this session: here it may not.
    expect(error.message).toBe(`${BLOCKED}.`);
    expect(relayed(error, unrouted)).toBe(`credentials · ${BLOCKED}${BOTH}`);
  });

  it("an outage of the proxy itself", async () => {
    session(routed);
    const error = await throughProxy(502);
    expect(error).toMatchObject({ code: "proxy_unavailable", terminal: false });
    expect(error.message).toBe(
      "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.",
    );
    // Relayed as it is: no domain to add, and nothing said twice.
    expect(relayed(error, routed)).toBe(
      "credentials · The cloud environment's proxy is failing (not the Allowed domains list); retry shortly",
    );
  });

  it("a request through the broker that fails for no reason the proxy gave", async () => {
    session(routed);
    const answer = (await forwardToApi(
      API,
      { method: "GET", path: "/api/cli/auth/status" },
      new AbortController().signal,
      (async () => {
        throw new TypeError("fetch failed", { cause: new Error("socket hang up") });
      }) as typeof fetch,
    )) as { error: { code: string; message: string } };
    const error = new MachineAuthError(answer.error.code, answer.error.message);
    expect(error.message).toBe(
      "The request to Primitive through the cloud environment's proxy failed. Check the connection and retry.",
    );
    // With nothing named, the whole remedy is given, with when it takes
    // effect: judged from the session cloud setup was given, not its own.
    vi.unstubAllEnvs();
    expect(relayed(error, routed)).toBe(
      `credentials · Primitive is unreachable from this environment: add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)${IN_SESSION} (The request to Primitive through the cloud environment's proxy failed. Check the connection and retry)`,
    );
  });

  it("a wait the sign-in service asked for", async () => {
    session(routed);
    const config = tempDir("prim-cloud-wait-");
    const exchange = () =>
      failure(
        withMachineCooldown(config, API, CLIENT, undefined, () =>
          exchangeMachineCredentials(
            configuration,
            CLIENT,
            "secret",
            undefined,
            tokenService(429, { "Retry-After": "120" }),
          ),
        ),
      );
    expect((await exchange()).message).toBe(
      "The machine token service is temporarily unavailable.",
    );
    // From then on every command is told it is a wait, and for how long.
    const waiting = await exchange();
    expect(waiting).toMatchObject({ code: "token_service_unavailable", terminal: false });
    expect(waiting.message).toMatch(
      /^The sign-in service asked prim to wait; retry in about (119|120)s$/u,
    );
    // Cloud setup neither forgets the wait nor blames the network for it.
    expect(relayed(waiting, routed, config)).toBe(`credentials · ${waiting.message}`);
    expect((await exchange()).message).toMatch(/^The sign-in service asked prim to wait/u);
  });

  it("prim's own cooldown after a failure", async () => {
    session(unrouted);
    const config = tempDir("prim-cloud-cooldown-");
    const discover = (fetchImpl: typeof fetch) =>
      withMachineCooldown(config, API, CLIENT, undefined, () =>
        discoverMachineConfiguration(API, undefined, fetchImpl),
      );
    expect((await failure(discover(unresolved))).message).toBe(`${BLOCKED}.`);
    const cooling = await failure(discover(unresolved));
    expect(cooling).toMatchObject({ code: "token_service_unavailable", terminal: false });
    expect(cooling.message).toBe(
      "Machine authentication is cooling down after a temporary failure; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
    );
    // Cloud setup forgets the cooldown before it checks, so it reports the
    // cause, or that the fix worked, and never points at itself.
    const { deps } = harness({ cwd: repo(true), env: { ...unrouted, PRIM_CONFIG_DIR: config } });
    let waitingAtCheck: string[] | undefined;
    deps.run = (args) => {
      if (args[0] === "auth") waitingAtCheck = readdirSync(config);
      return { code: 0, stdout: "{}" };
    };
    setupCloudSession(deps);
    expect(waitingAtCheck).toEqual([]);
    expect(relayed(cooling, unrouted)).toBe(
      "credentials · Primitive is unreachable from this environment: add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited) (Machine authentication is cooling down after a temporary failure)",
    );
  });

  it("a cooldown the proxy's failure started", async () => {
    session(routed);
    const config = tempDir("prim-cloud-proxy-");
    recordProxyFailure(config, API, CLIENT);
    const request = vi.fn(async () => "token");
    const cooling = await failure(withMachineCooldown(config, API, CLIENT, undefined, request));
    expect(cooling).toMatchObject({ code: "proxy_unavailable", terminal: false });
    expect(cooling.message).toBe(
      "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.",
    );
    expect(request).not.toHaveBeenCalled();
    // Cloud setup asks again at once: by the check, the wait is lifted, and
    // the count of failures kept, so a proxy still failing is waited out longer.
    const { deps } = harness({ cwd: repo(true), env: { ...routed, PRIM_CONFIG_DIR: config } });
    let stateAtCheck: unknown;
    deps.run = (args) => {
      if (args[0] === "auth")
        stateAtCheck = JSON.parse(readFileSync(join(config, readdirSync(config)[0] ?? ""), "utf8"));
      return { code: 0, stdout: "{}" };
    };
    setupCloudSession(deps);
    expect(stateAtCheck).toEqual({ failures: 1, retryAt: 0, proxy: true });
    expect(relayed(cooling, routed)).toBe(
      "credentials · The cloud environment's proxy is failing (not the Allowed domains list); retry shortly",
    );
  });

  it("credentials the sign-in service rejects", async () => {
    session(routed);
    const error = await failure(
      exchangeMachineCredentials(configuration, CLIENT, "secret", undefined, tokenService(401)),
    );
    expect(error).toMatchObject({ code: "machine_credentials_rejected", terminal: true });
    const REJECTED =
      "The cloud environment's credentials were rejected. To fix it, correct the credentials in the cloud environment's settings, or if the installation was revoked mint a replacement on your own machine with `prim auth enroll --new-installation \"Claude Code cloud\" --print-env`; then start a new cloud session";
    expect(error.message).toBe(`${REJECTED}.`);
    // Nothing about the network, and the replacement named once.
    expect(relayed(error, routed)).toBe(`credentials · ${REJECTED}`);
  });
});
