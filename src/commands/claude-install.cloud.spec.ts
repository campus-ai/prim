import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hook-runtime.js")>()),
  stageHookRuntime: () => undefined,
}));

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "prim-cloud-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("PRIM_CONFIG_DIR", join(home, ".config", "prim"));
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const load = async () => {
  const install = await import("./claude-install.js");
  const prepared = await import("../lib/cloud-prepared.js");
  const settings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  return { ...install, ...prepared, settings };
};

describe("cloud user-scope install lifecycle", () => {
  it("keeps the project deferral through a plain user-scope reinstall", async () => {
    const m = await load();
    m.performCloudUserInstall();
    expect(m.cloudUserInstallComplete()).toBe(true);
    expect(m.hasDeveloperUserInstall()).toBe(false);
    m.performInstall("user", false);
    m.performInstall("user", true);
    expect(m.usesProjectDeferral(m.settings())).toBe(true);
    expect(m.settings().statusLine).toBeUndefined();
    expect(m.cloudUserInstallComplete()).toBe(true);
  });

  it("recognizes a developer's own user-scope install", async () => {
    const m = await load();
    expect(m.hasDeveloperUserInstall()).toBe(false);
    m.performInstall("user", false);
    expect(m.hasDeveloperUserInstall()).toBe(true);
    expect(m.usesProjectDeferral(m.settings())).toBe(false);
  });

  it("treats prim's statusline alone as a developer's install", async () => {
    const m = await load();
    mkdirSync(join(home, ".claude"), { recursive: true });
    const statusLine = m.applyInstall({}, { installStatusline: true }).statusLine;
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ statusLine }));
    expect(m.hasDeveloperUserInstall()).toBe(true);
  });

  it("reports unreadable settings as neither installed nor complete", async () => {
    const m = await load();
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(join(home, ".claude", "settings.json"), "{ not json");
    expect(m.hasDeveloperUserInstall()).toBe(false);
    expect(m.cloudUserInstallComplete()).toBe(false);
  });

  it("drops the environment's opt-in with prim's user-scope hooks", async () => {
    const m = await load();
    m.performCloudUserInstall();
    m.markCloudPrepared();
    expect(existsSync(m.cloudPreparedPath())).toBe(true);
    m.performUninstall("user");
    expect(existsSync(m.cloudPreparedPath())).toBe(false);
    expect(m.cloudUserInstallComplete()).toBe(false);
  });
});
