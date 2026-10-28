import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stableHookCommand } from "../lib/bin-path.js";
import {
  type CursorHooksSettings,
  applyCursorFooterInstall,
  applyCursorFooterUninstall,
  applyCursorInstall,
  applyCursorUninstall,
  cursorConfigDirectory,
  hasExactCursorHandler,
  isOwnedCursorHookCommand,
  readCursorHooks,
  resolveScope,
} from "./cursor-install.js";

describe("Cursor native hook configuration", () => {
  const jsoncUnsafe = (command: string): string =>
    command
      .replace('case "$1" in [/]* ', 'case "$1" in /*')
      .replace("*[/][/]*", "*//*")
      .replace("*[/].[/]*", "*/./*")
      .replace("*[/]..[/]*", "*/../*")
      .replace("*[/].", "*/.")
      .replace("*[/]..", "*/..")
      .replace("?*[/]", "?*/");

  it("installs the complete flat v1 lifecycle with a bounded mutation gate", () => {
    const output = applyCursorInstall({}, "project");
    expect(output.version).toBe(1);
    for (const event of [
      "sessionStart",
      "beforeSubmitPrompt",
      "preToolUse",
      "postToolUse",
      "postToolUseFailure",
      "afterAgentResponse",
      "subagentStop",
      "stop",
      "sessionEnd",
    ]) {
      expect(hasExactCursorHandler(output, event, "prim-hook", "project")).toBe(true);
    }
    expect(output.hooks?.preToolUse).toContainEqual({
      command: stableHookCommand(
        "prim-pre-tool-use",
        "--agent cursor --event preToolUse --scope project",
      ),
      matcher: "Write|Delete|Shell",
      timeout: 10,
    });
    expect(
      hasExactCursorHandler(output, "postToolUseFailure", "prim-post-tool-use", "project"),
    ).toBe(true);
  });

  it("preserves foreign top-level fields, event order, and edited commands", () => {
    const foreign = { command: "/usr/local/bin/foreign", matcher: "Shell", custom: true };
    const editedPrimitive = {
      command: `${stableHookCommand("prim-hook", "--agent cursor --event stop --scope project")} --edited`,
    };
    const settings: CursorHooksSettings = {
      custom: { retained: true },
      hooks: { stop: [foreign, editedPrimitive] },
    };
    const output = applyCursorInstall(settings, "project");
    expect(output.custom).toEqual({ retained: true });
    expect(output.hooks?.stop?.slice(0, 2)).toEqual([foreign, editedPrimitive]);
    expect(isOwnedCursorHookCommand(editedPrimitive.command)).toBe(false);
  });

  it("survives Cursor's JSONC comment stripping", () => {
    const settings = applyCursorInstall({}, "project");
    const serialized = JSON.stringify(settings);
    const stripped = serialized.replace(/\/\/.*$/gmu, "").replace(/\/\*[\s\S]*?\*\//gu, "");
    expect(JSON.parse(stripped)).toEqual(settings);
  });

  it("migrates the exact JSONC-unsafe registration without preserving duplicates", () => {
    const current = applyCursorInstall({}, "project");
    const legacy = {
      ...current,
      hooks: Object.fromEntries(
        Object.entries(current.hooks ?? {}).map(([event, entries]) => [
          event,
          entries.map((entry) => ({ ...entry, command: jsoncUnsafe(entry.command) })),
        ]),
      ),
    };
    expect(applyCursorInstall(legacy, "project")).toEqual(current);
    expect(applyCursorUninstall(legacy).hooks).toEqual({});
  });

  it("is idempotent and uninstalls only exact owned commands", () => {
    const foreign = { command: "/usr/local/bin/foreign" };
    const installed = applyCursorInstall({ hooks: { stop: [foreign] } }, "user");
    expect(applyCursorInstall(installed, "user")).toEqual(installed);
    const removed = applyCursorUninstall(installed);
    expect(removed.hooks).toEqual({ stop: [foreign] });
  });

  it("defaults to project and rejects unknown scopes", () => {
    expect(resolveScope(undefined)).toBe("project");
    expect(resolveScope("user")).toBe("user");
    expect(() => resolveScope("workspace")).toThrow(/unknown --scope/u);
  });

  it("rejects malformed and version-mismatched native configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-cursor-hooks-"));
    const path = join(root, "hooks.json");
    writeFileSync(path, "not json\n");
    expect(() => readCursorHooks(path)).toThrow(/invalid Cursor hooks JSON/u);
    writeFileSync(path, '{"version":2,"hooks":{}}\n');
    expect(() => readCursorHooks(path)).toThrow(/expected version 1/u);
    writeFileSync(path, '{"version":1,"hooks":{"stop":{}}}\n');
    expect(() => readCursorHooks(path)).toThrow(/hook list must contain objects/u);
  });

  it("installs and removes only the exact Primitive footer", () => {
    const custom = { theme: "dark", statusLine: { type: "command", command: "custom" } };
    expect(applyCursorFooterInstall(custom)).toEqual({
      config: custom,
      installed: false,
      preservedCustom: true,
    });
    expect(applyCursorFooterUninstall(custom)).toEqual({ config: custom, removed: false });

    const installed = applyCursorFooterInstall({ theme: "dark" });
    expect(installed).toMatchObject({ installed: true, preservedCustom: false });
    expect(installed.config.statusLine).toEqual({
      type: "command",
      command: stableHookCommand("prim-statusline"),
      updateIntervalMs: 1_000,
      timeoutMs: 2_000,
    });
    expect(applyCursorFooterUninstall(installed.config)).toEqual({
      config: { theme: "dark" },
      removed: true,
    });

    const legacyFooter = {
      theme: "dark",
      statusLine: {
        ...(installed.config.statusLine as Record<string, unknown>),
        command: jsoncUnsafe((installed.config.statusLine as Record<string, string>).command),
      },
    };
    expect(applyCursorFooterInstall(legacyFooter)).toEqual({
      config: installed.config,
      installed: true,
      preservedCustom: false,
    });
    expect(applyCursorFooterUninstall(legacyFooter)).toEqual({
      config: { theme: "dark" },
      removed: true,
    });
  });

  it("honors only absolute Cursor configuration overrides", () => {
    expect(
      cursorConfigDirectory({ CURSOR_CONFIG_DIR: "/custom/cursor" }, "/home/me", "darwin"),
    ).toBe("/custom/cursor");
    expect(cursorConfigDirectory({ CURSOR_CONFIG_DIR: "relative" }, "/home/me", "darwin")).toBe(
      "/home/me/.cursor",
    );
    expect(cursorConfigDirectory({ XDG_CONFIG_HOME: "/xdg" }, "/home/me", "linux")).toBe(
      "/xdg/cursor",
    );
  });
});
