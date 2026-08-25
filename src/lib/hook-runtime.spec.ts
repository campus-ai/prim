import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomicFile from "./atomic-file.js";
import { stableHookCommand } from "./bin-path.js";
import {
  HOOK_RUNTIME_ENTRIES,
  STABLE_HOOK_LAUNCHER_CONTENT,
  hookRuntimePaths,
  removeHookRuntime,
  stageHookRuntime,
} from "./hook-runtime.js";

const roots: string[] = [];

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function sourceRuntime(root: string, label: string): string {
  const source = join(root, `source-${label}`);
  for (const [bin, target] of Object.entries(HOOK_RUNTIME_ENTRIES)) {
    const relative = target.replace(/^dist\//u, "");
    const path = join(source, relative);
    mkdirSync(dirname(path), { recursive: true });
    const body =
      bin === "prim-hook"
        ? `import { readFileSync } from "node:fs"; process.stdout.write(${JSON.stringify(
            label,
          )} + ":" + process.argv.slice(2).join(",") + ":" + readFileSync(0, "utf8"));\n`
        : `process.stdout.write(${JSON.stringify(`${label}:${bin}`)});\n`;
    writeFileSync(path, body);
  }
  return source;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("stageHookRuntime", () => {
  it("flushes every staged release entry before publishing its selector", () => {
    const root = temporaryRoot("prim-hook-runtime-durability-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const paths = hookRuntimePaths({ env });
    const syncFile = vi.spyOn(atomicFile, "syncFile");
    const realSyncDirectory = atomicFile.syncDirectory;
    const syncDirectory = vi.spyOn(atomicFile, "syncDirectory").mockImplementation((path) => {
      if (path === paths.releasesDir) expect(existsSync(paths.current)).toBe(false);
      realSyncDirectory(path);
    });

    const staged = stageHookRuntime({
      sourceDir: sourceRuntime(root, "durable"),
      version: "1.0.0",
      nodePath: process.execPath,
      env,
    });

    const stagedFileSyncs = syncFile.mock.calls.filter(([path]) => path.includes("/.stage-"));
    expect(stagedFileSyncs).toHaveLength(Object.keys(HOOK_RUNTIME_ENTRIES).length + 3);
    const stagedDirectorySyncs = syncDirectory.mock.calls
      .map(([path], index) => ({ path, index }))
      .filter(({ path }) => path.includes("/.stage-"));
    expect(stagedDirectorySyncs.length).toBeGreaterThan(0);

    const releaseParentSync = syncDirectory.mock.calls.findIndex(
      ([path]) => path === staged.paths.releasesDir,
    );
    expect(releaseParentSync).toBeGreaterThan(
      Math.max(...stagedDirectorySyncs.map(({ index }) => index)),
    );
    expect(existsSync(staged.paths.current)).toBe(true);
  });

  it("atomically selects immutable exact bytes behind one stable command", () => {
    const root = temporaryRoot("prim-hook-runtime-");
    const config = join(root, "config");
    const firstSource = sourceRuntime(root, "first");
    const secondSource = sourceRuntime(root, "second");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: config };
    const command = stableHookCommand("prim-hook", "--agent codex");

    const first = stageHookRuntime({
      sourceDir: firstSource,
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    expect(first.changed).toBe(true);
    expect(readFileSync(first.paths.launcher, "utf8")).toBe(STABLE_HOOK_LAUNCHER_CONTENT);
    expect(statSync(first.paths.configDir).mode & 0o777).toBe(0o700);
    expect(statSync(first.paths.launcher).mode & 0o777).toBe(0o700);
    expect(statSync(first.paths.current).mode & 0o777).toBe(0o600);

    const run = (input: string) =>
      spawnSync("/bin/sh", ["-c", command], { env, input, encoding: "utf8" });
    expect(run("payload")).toMatchObject({
      status: 0,
      stdout: "first:--agent,codex:payload",
    });

    // The immutable copy, not the source package path, is the selected code.
    writeFileSync(join(firstSource, "hooks", "prim-hook.js"), 'process.stdout.write("tampered");');
    expect(run("payload").stdout).toBe("first:--agent,codex:payload");

    const second = stageHookRuntime({
      sourceDir: secondSource,
      version: "1.2.4",
      nodePath: process.execPath,
      env,
    });
    expect(second.changed).toBe(true);
    expect(second.releaseDir).not.toBe(first.releaseDir);
    expect(stableHookCommand("prim-hook", "--agent codex")).toBe(command);
    expect(run("next").stdout).toBe("second:--agent,codex:next");
    expect(
      stageHookRuntime({
        sourceDir: secondSource,
        version: "1.2.4",
        nodePath: process.execPath,
        env,
      }).changed,
    ).toBe(false);
  });

  it("retains a valid higher selected runtime and refuses to downgrade through corruption", () => {
    const root = temporaryRoot("prim-hook-monotonic-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const olderSource = sourceRuntime(root, "older");
    const newerSource = sourceRuntime(root, "newer");
    const older = stageHookRuntime({
      sourceDir: olderSource,
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    const newer = stageHookRuntime({
      sourceDir: newerSource,
      version: "1.2.4",
      nodePath: process.execPath,
      env,
    });

    const retained = stageHookRuntime({
      sourceDir: olderSource,
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    expect(retained.changed).toBe(false);
    expect(retained.releaseDir).toBe(newer.releaseDir);
    expect(retained.manifest.version).toBe("1.2.4");
    expect(readFileSync(retained.paths.current, "utf8")).toBe(`${basename(newer.releaseDir)}\n`);
    expect(retained.releaseDir).not.toBe(older.releaseDir);

    writeFileSync(join(newer.releaseDir, "manifest.json"), '{"version":"not-semver"}\n');
    expect(() =>
      stageHookRuntime({
        sourceDir: olderSource,
        version: "1.2.3",
        nodePath: process.execPath,
        env,
      }),
    ).toThrow("immutable release is corrupt");
    expect(readFileSync(retained.paths.current, "utf8")).toBe(`${basename(newer.releaseDir)}\n`);
  });

  it("serializes a stale installer behind a concurrently selected newer runtime", async () => {
    const root = temporaryRoot("prim-hook-concurrent-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const olderSource = sourceRuntime(root, "older");
    const newerSource = sourceRuntime(root, "newer");
    const older = stageHookRuntime({
      sourceDir: olderSource,
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    const newer = stageHookRuntime({
      sourceDir: newerSource,
      version: "1.2.4",
      nodePath: process.execPath,
      env,
    });
    writeFileSync(older.paths.current, `${basename(older.releaseDir)}\n`);

    const worker = new Worker(
      `
        const { parentPort, workerData } = require("node:worker_threads");
        const { mkdirSync, renameSync, rmSync, writeFileSync } = require("node:fs");
        const { join } = require("node:path");
        mkdirSync(workerData.lockDir, { mode: 0o700 });
        writeFileSync(join(workerData.lockDir, "owner.json"), JSON.stringify({
          pid: process.pid,
          nonce: "concurrent-newer",
          createdAt: Date.now(),
        }) + "\\n", { mode: 0o600 });
        parentPort.postMessage("locked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        const temporary = workerData.current + ".newer.tmp";
        writeFileSync(temporary, workerData.newerName + "\\n", { mode: 0o600 });
        renameSync(temporary, workerData.current);
        rmSync(workerData.lockDir, { recursive: true, force: true });
        parentPort.postMessage("released");
      `,
      {
        eval: true,
        workerData: {
          lockDir: older.paths.selectionLock,
          current: older.paths.current,
          newerName: basename(newer.releaseDir),
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("message", (message) => {
        if (message === "locked") resolve();
      });
    });

    const startedAt = Date.now();
    const retained = stageHookRuntime({
      sourceDir: olderSource,
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(50);
    expect(retained.manifest.version).toBe("1.2.4");
    expect(readFileSync(retained.paths.current, "utf8")).toBe(`${basename(newer.releaseDir)}\n`);
    await worker.terminate();
  });

  it("bounds exact release history while retaining the selected runtime and predecessors", () => {
    const root = temporaryRoot("prim-hook-retention-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const unknown = join(env.PRIM_CONFIG_DIR, "hook-runtime", "releases", "release-unknown");
    let previousReleaseDir = "";
    let selected = stageHookRuntime({
      sourceDir: sourceRuntime(root, "release-0"),
      version: "1.0.0",
      nodePath: process.execPath,
      env,
    });
    mkdirSync(unknown, { recursive: true });
    for (let index = 1; index <= 12; index += 1) {
      for (const name of readdirSync(selected.paths.releasesDir)) {
        const candidate = join(selected.paths.releasesDir, name);
        if (statSync(candidate).isDirectory() && /^release-[0-9a-f]{64}$/u.test(name)) {
          utimesSync(candidate, 1, 1);
        }
      }
      previousReleaseDir = selected.releaseDir;
      selected = stageHookRuntime({
        sourceDir: sourceRuntime(root, `release-${index}`),
        version: `1.0.${index}`,
        nodePath: process.execPath,
        env,
      });
    }
    const exactReleases = readdirSync(selected.paths.releasesDir).filter((name) =>
      /^release-[0-9a-f]{64}$/u.test(name),
    );
    expect(exactReleases.length).toBeLessThanOrEqual(8);
    expect(existsSync(selected.releaseDir)).toBe(true);
    expect(existsSync(previousReleaseDir)).toBe(true);
    expect(existsSync(unknown)).toBe(true);
  });

  it("refuses admission instead of deleting a recent snapshotted release", () => {
    const root = temporaryRoot("prim-hook-retention-grace-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    let selected = stageHookRuntime({
      sourceDir: sourceRuntime(root, "recent-0"),
      version: "2.0.0",
      nodePath: process.execPath,
      env,
    });
    for (let index = 1; index < 8; index += 1) {
      selected = stageHookRuntime({
        sourceDir: sourceRuntime(root, `recent-${index}`),
        version: `2.0.${index}`,
        nodePath: process.execPath,
        env,
      });
    }
    const selectedName = readFileSync(selected.paths.current, "utf8");
    expect(() =>
      stageHookRuntime({
        sourceDir: sourceRuntime(root, "recent-overflow"),
        version: "2.0.8",
        nodePath: process.execPath,
        env,
      }),
    ).toThrow("release retention is full while recent runtimes are protected");
    expect(readFileSync(selected.paths.current, "utf8")).toBe(selectedName);
    expect(readdirSync(selected.paths.releasesDir)).toHaveLength(8);
  });

  it("mirrors default and absolute XDG config-root resolution without changing command bytes", () => {
    const root = temporaryRoot("prim-hook-roots-");
    const source = sourceRuntime(root, "rooted");
    const command = stableHookCommand("prim-hook");
    const cases = [
      { env: { HOME: join(root, "home-default") } },
      { env: { HOME: join(root, "home-xdg"), XDG_CONFIG_HOME: join(root, "xdg") } },
    ];
    for (const { env } of cases) {
      stageHookRuntime({
        sourceDir: source,
        version: "1.0.0",
        nodePath: process.execPath,
        env,
        homeDir: env.HOME,
      });
      const result = spawnSync("/bin/sh", ["-c", command], {
        env,
        input: "x",
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("rooted::x");
    }
  });

  it("fails closed on an unknown bin and a malformed release selector", () => {
    const root = temporaryRoot("prim-hook-invalid-");
    const source = sourceRuntime(root, "valid");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: source,
      version: "1.0.0",
      nodePath: process.execPath,
      env,
    });
    expect(spawnSync("/bin/sh", ["-c", stableHookCommand("prim-unknown")], { env }).status).toBe(
      64,
    );
    writeFileSync(staged.paths.current, "../../outside\n");
    expect(spawnSync("/bin/sh", ["-c", stableHookCommand("prim-hook")], { env }).status).toBe(69);
    expect(() =>
      stageHookRuntime({
        sourceDir: source,
        version: "1.0.1",
        nodePath: process.execPath,
        env,
      }),
    ).toThrow("selected release is malformed");
  });

  it("refuses to reuse a corrupt content-addressed release", () => {
    const root = temporaryRoot("prim-hook-corrupt-");
    const source = sourceRuntime(root, "valid");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: source,
      version: "1.0.0",
      nodePath: process.execPath,
      env,
    });
    chmodSync(join(staged.releaseDir, "dist", "hooks", "prim-hook.js"), 0o600);
    writeFileSync(join(staged.releaseDir, "dist", "hooks", "prim-hook.js"), "corrupt");
    expect(() =>
      stageHookRuntime({
        sourceDir: source,
        version: "1.0.0",
        nodePath: process.execPath,
        env,
      }),
    ).toThrow("immutable release is corrupt");
  });

  it("binds the exact Node executable into the immutable release", () => {
    const root = temporaryRoot("prim-hook-node-");
    const source = sourceRuntime(root, "valid");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: source,
      version: "1.0.0",
      nodePath: process.execPath,
      env,
    });
    writeFileSync(join(staged.releaseDir, "node"), "/bin/false\n");
    expect(() =>
      stageHookRuntime({
        sourceDir: source,
        version: "1.0.0",
        nodePath: process.execPath,
        env,
      }),
    ).toThrow("immutable release is corrupt");
  });

  it("keeps path derivation aligned with primConfigDirectory", () => {
    const root = temporaryRoot("prim-hook-path-");
    const paths = hookRuntimePaths({ env: { PRIM_CONFIG_DIR: root }, homeDir: "/ignored" });
    expect(paths.configDir).toBe(root);
    expect(paths.launcher).toBe(join(root, "prim-hook-launcher-v1"));
    expect(paths.current).toBe(join(root, "hook-runtime", "current"));
    expect(() => hookRuntimePaths({ env: {} })).toThrow("HOME is not an absolute path");
    expect(() => hookRuntimePaths({ env: { HOME: "relative" } })).toThrow(
      "HOME is not an absolute path",
    );
  });
});

describe("removeHookRuntime", () => {
  it("removes only a fully recognized staged runtime", () => {
    const root = temporaryRoot("prim-hook-runtime-uninstall-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: sourceRuntime(root, "owned"),
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });

    expect(removeHookRuntime({ env }).changed).toBe(true);
    expect(existsSync(staged.paths.launcher)).toBe(false);
    expect(existsSync(staged.paths.runtimeDir)).toBe(false);
    expect(removeHookRuntime({ env }).changed).toBe(false);
  });

  it("retains the entire runtime when an entry has ambiguous ownership", () => {
    const root = temporaryRoot("prim-hook-runtime-uninstall-ambiguous-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: sourceRuntime(root, "owned"),
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    writeFileSync(join(staged.paths.runtimeDir, "foreign.txt"), "keep me\n");

    expect(() => removeHookRuntime({ env })).toThrow("unrecognized entries");
    expect(existsSync(staged.paths.launcher)).toBe(true);
    expect(existsSync(staged.paths.runtimeDir)).toBe(true);
  });

  it("retains a valid launcher when the runtime path is a dangling symlink", () => {
    const root = temporaryRoot("prim-hook-runtime-uninstall-dangling-");
    const env = { HOME: join(root, "home"), PRIM_CONFIG_DIR: join(root, "config") };
    const staged = stageHookRuntime({
      sourceDir: sourceRuntime(root, "owned"),
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    rmSync(staged.paths.runtimeDir, { recursive: true, force: true });
    symlinkSync(join(root, "missing-runtime"), staged.paths.runtimeDir);

    expect(() => removeHookRuntime({ env })).toThrow("non-directory hook runtime");
    expect(existsSync(staged.paths.launcher)).toBe(true);
    expect(lstatSync(staged.paths.runtimeDir).isSymbolicLink()).toBe(true);
  });
});
