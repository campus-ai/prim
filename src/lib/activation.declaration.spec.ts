import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declaresInactive,
  explicitlyActive,
  isRepoActiveForCapture,
  markActivationExplicit,
  markActivationImplicit,
  repoActiveFlag,
  withdrawImplicitActivation,
} from "./activation.js";

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A real repository whose `.claude/settings.json` holds `settings`, if given. */
function repo(settings?: unknown): string {
  const root = tempDir("prim-opt-out-");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), JSON.stringify(settings));
  }
  return root;
}

const git = (root: string, ...args: string[]) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });

const OPT_OUT = { env: { PRIM_ACTIVE: "false" } };
const PROJECT_INSTALL = { hooks: { SessionStart: [{ hooks: [{ command: "prim-hook" }] }] } };

beforeEach(() => {
  // A host-wide prim.active must not decide these.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("declaresInactive (the repository's committed opt-out)", () => {
  it("reads PRIM_ACTIVE=false from the checkout's own .claude/settings.json", () => {
    expect(declaresInactive(repo(OPT_OUT))).toBe(true);
    expect(declaresInactive(repo({ env: { PRIM_ACTIVE: " false\n" } }))).toBe(true);
  });

  it.each([
    ["no settings file", undefined],
    ["no declaration", { env: { OTHER: "false" } }],
    ["a true declaration", { env: { PRIM_ACTIVE: "true" } }],
    ["a boolean, which Claude Code's env block cannot carry", { env: { PRIM_ACTIVE: false } }],
    ["another spelling", { env: { PRIM_ACTIVE: "off" } }],
    ["a declaration outside env", { PRIM_ACTIVE: "false" }],
  ])("is false for %s", (_name, settings) => {
    expect(declaresInactive(repo(settings))).toBe(false);
  });

  it("never reads the declaration from the process environment", () => {
    // Claude Code exports a settings env block to its whole process tree, so
    // an environment value would speak for every checkout the session touches.
    vi.stubEnv("PRIM_ACTIVE", "false");
    expect(declaresInactive(repo())).toBe(false);
    expect(declaresInactive(repo({ env: { PRIM_ACTIVE: "true" } }))).toBe(false);
  });

  it("does not follow a symlinked settings file into another checkout", () => {
    const other = repo(OPT_OUT);
    const root = repo();
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(other, ".claude", "settings.json"), join(root, ".claude", "settings.json"));
    expect(declaresInactive(root)).toBe(false);
  });

  it("still reads the opt-out from a settings file that is not valid JSON", () => {
    // The opt-ins it cancels need no valid JSON, so neither may the opt-out.
    const conflicted = repo();
    mkdirSync(join(conflicted, ".claude"));
    writeFileSync(
      join(conflicted, ".claude", "settings.json"),
      '{\n<<<<<<< HEAD\n  "env": { "PRIM_ACTIVE": "false" },\n=======\n>>>>>>> theirs\n  "hooks": {}\n}\n',
    );
    expect(declaresInactive(conflicted)).toBe(true);

    const trailingComma = repo();
    mkdirSync(join(trailingComma, ".claude"));
    writeFileSync(
      join(trailingComma, ".claude", "settings.json"),
      '{ "env": { "PRIM_ACTIVE" : "false", } }',
    );
    expect(declaresInactive(trailingComma)).toBe(true);
  });

  it("reads a valid settings file exactly, wherever else the words appear", () => {
    // Valid JSON is parsed; only an unparseable file falls back to its text.
    expect(declaresInactive(repo({ notes: { PRIM_ACTIVE: "false" } }))).toBe(false);
    expect(declaresInactive(repo({ env: { PRIM_ACTIVE: "true" }, PRIM_ACTIVE: "false" }))).toBe(
      false,
    );
  });

  it("is false outside a repository", () => {
    const outside = tempDir("prim-opt-out-plain-");
    mkdirSync(join(outside, ".claude"));
    writeFileSync(join(outside, ".claude", "settings.json"), JSON.stringify(OPT_OUT));
    expect(declaresInactive(outside)).toBe(false);
  });
});

describe("isRepoActiveForCapture with a committed opt-out", () => {
  function preparedCloudSession(): void {
    const configDir = tempDir("prim-opt-out-config-");
    writeFileSync(join(configDir, "cloud-prepared"), "1\n");
    vi.stubEnv("PRIM_CONFIG_DIR", configDir);
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
  }

  it("keeps a prepared Claude Code cloud environment from activating the repository", () => {
    preparedCloudSession();
    expect(isRepoActiveForCapture(repo())).toBe(true);
    expect(isRepoActiveForCapture(repo(OPT_OUT))).toBe(false);
  });

  it("cancels a committed project install's implicit activation too", () => {
    expect(isRepoActiveForCapture(repo(PROJECT_INSTALL))).toBe(true);
    expect(isRepoActiveForCapture(repo({ ...PROJECT_INSTALL, ...OPT_OUT }))).toBe(false);
  });

  it("yields to an explicit prim enable in the clone", () => {
    preparedCloudSession();
    const root = repo(OPT_OUT);
    git(root, "config", "--local", "prim.active", "true");
    expect(isRepoActiveForCapture(root)).toBe(true);
  });

  it("leaves an explicit prim disable as it was", () => {
    preparedCloudSession();
    const root = repo(OPT_OUT);
    git(root, "config", "--local", "prim.active", "false");
    expect(isRepoActiveForCapture(root)).toBe(false);
  });
});

describe("an activation prim wrote down for an implicit opt-in", () => {
  // What SessionStart does where a project install or a prepared environment
  // makes a repository active: the shell git hooks read only git config.
  function materialized(settings?: unknown): string {
    const root = repo(settings);
    git(root, "config", "--local", "prim.active", "true");
    markActivationImplicit(root);
    return root;
  }

  it("is withdrawn once the repository commits its opt-out", () => {
    const root = materialized(PROJECT_INSTALL);
    expect(withdrawImplicitActivation(root)).toBe(false);
    expect(isRepoActiveForCapture(root)).toBe(true);

    // The maintainers commit the opt-out; this clone pulls it.
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ ...PROJECT_INSTALL, ...OPT_OUT }),
    );
    expect(withdrawImplicitActivation(root)).toBe(true);
    expect(repoActiveFlag(root)).toBeUndefined();
    expect(isRepoActiveForCapture(root)).toBe(false);
    // Nothing left to withdraw.
    expect(withdrawImplicitActivation(root)).toBe(false);
  });

  it("is never the user's own prim enable, which the opt-out leaves on", () => {
    const root = materialized(OPT_OUT);
    expect(explicitlyActive(root)).toBe(false);
    // `prim enable` in this clone makes the flag the user's.
    markActivationExplicit(root);
    expect(explicitlyActive(root)).toBe(true);
    expect(withdrawImplicitActivation(root)).toBe(false);
    expect(isRepoActiveForCapture(root)).toBe(true);
  });

  it("leaves a flag written before prim marked its own writes alone", () => {
    const root = repo(OPT_OUT);
    git(root, "config", "--local", "prim.active", "true");
    expect(explicitlyActive(root)).toBe(true);
    expect(withdrawImplicitActivation(root)).toBe(false);
    expect(isRepoActiveForCapture(root)).toBe(true);
  });

  it("does not touch a clone the user muted", () => {
    const root = repo(OPT_OUT);
    git(root, "config", "--local", "prim.active", "false");
    markActivationImplicit(root);
    expect(withdrawImplicitActivation(root)).toBe(false);
    expect(repoActiveFlag(root)).toBe("false");
  });
});

describe("a prim.active=true the user set for every repository", () => {
  it("wins over a repository's committed opt-out, like an enable in the clone", () => {
    const home = tempDir("prim-opt-out-global-");
    const globalConfig = join(home, "gitconfig");
    writeFileSync(globalConfig, "[prim]\n\tactive = true\n");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    const root = repo(OPT_OUT);
    expect(explicitlyActive(root)).toBe(true);
    expect(isRepoActiveForCapture(root)).toBe(true);
  });
});
