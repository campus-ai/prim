import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { removeDaemonRuntime, stageRuntime } from "../daemon/launchd.js";
import { HOOK_RUNTIME_ENTRIES, removeHookRuntime, stageHookRuntime } from "../lib/hook-runtime.js";
import { registerUninstallCommand } from "./uninstall.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function hookSource(root: string): string {
  const source = join(root, "hook-source");
  for (const target of Object.values(HOOK_RUNTIME_ENTRIES)) {
    const path = join(source, target.replace(/^dist\//u, ""));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "export {};\n");
  }
  return source;
}

function successfulOutput(args: string[]): string {
  if (args[0] === "daemon") {
    return JSON.stringify({ stopped: false, wasRunning: false, absent: true, verified: true });
  }
  if (args[0] === "claude") {
    return JSON.stringify({ gate: false, capture: false, feedback: false, statusline: false });
  }
  if (args[0] === "codex" || args[0] === "hermes") {
    return JSON.stringify({ gate: false, capture: false });
  }
  return "";
}

describe("prim uninstall filesystem composition", () => {
  it("contracts recognized runtimes while preserving credentials and pending journals", async () => {
    const root = mkdtempSync(join(tmpdir(), "prim-uninstall-integration-"));
    roots.push(root);
    const homeDir = join(root, "home");
    const configDir = join(root, "config");
    const dataHome = join(root, "data");
    const env = { HOME: homeDir, PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: dataHome };
    const hook = stageHookRuntime({
      sourceDir: hookSource(root),
      version: "1.2.3",
      nodePath: process.execPath,
      env,
    });
    const daemonSource = join(root, "daemon.js");
    writeFileSync(daemonSource, "export {};\n");
    const nodePath = join(root, "node");
    writeFileSync(nodePath, "#!/bin/sh\n");
    chmodSync(nodePath, 0o700);
    const daemon = stageRuntime({
      daemonSource,
      nodePath,
      version: "1.2.3",
      homeDir,
      env,
    });
    const tokenPath = join(configDir, "token");
    const journalPath = join(configDir, "moves", "org", "journal.ndjson");
    mkdirSync(dirname(journalPath), { recursive: true });
    writeFileSync(tokenPath, "credential\n");
    writeFileSync(journalPath, '{"pending":true}\n');

    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => false,
      run: (args) => ({ code: 0, stdout: successfulOutput(args), stderr: "" }),
      removeRuntimes: async () => ({
        hookRuntimeChanged: removeHookRuntime({ env }).changed,
        daemonRuntimeChanged: (
          await removeDaemonRuntime({ homeDir, env, uid: 501, label: "ai.getprimitive.test" })
        ).changed,
      }),
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(existsSync(hook.paths.runtimeDir)).toBe(false);
    expect(existsSync(daemon.paths.runtimeDir)).toBe(false);
    expect(readFileSync(tokenPath, "utf8")).toBe("credential\n");
    expect(readFileSync(journalPath, "utf8")).toBe('{"pending":true}\n');
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: true,
      preserved: ["credentials", "pending journals", "repository bindings", "agent skill guidance"],
    });
    expect(exit).toHaveBeenCalledWith(0);
  });
});
