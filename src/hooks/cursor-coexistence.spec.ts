import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyCursorInstall } from "../commands/cursor-install.js";
import { shouldSuppressImportedCursorHandler } from "./cursor-coexistence.js";

const originalCursorConfig = process.env.CURSOR_CONFIG_DIR;

afterEach(() => {
  if (originalCursorConfig === undefined) Reflect.deleteProperty(process.env, "CURSOR_CONFIG_DIR");
  else process.env.CURSOR_CONFIG_DIR = originalCursorConfig;
});

describe("Cursor imported-hook coexistence", () => {
  it("suppresses only with Cursor evidence and an exact native peer", () => {
    const config = mkdtempSync(join(tmpdir(), "prim-cursor-config-"));
    const repository = mkdtempSync(join(tmpdir(), "prim-cursor-repo-"));
    execFileSync("git", ["init", "-q", repository]);
    process.env.CURSOR_CONFIG_DIR = config;
    mkdirSync(config, { recursive: true });
    writeFileSync(
      join(config, "hooks.json"),
      `${JSON.stringify(applyCursorInstall({}, "user"), null, 2)}\n`,
    );
    const envelope = {
      cursor_version: "3.19.19",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      hook_event_name: "preToolUse",
      workspace_roots: [repository],
    };
    expect(shouldSuppressImportedCursorHandler(envelope, "prim-pre-tool-use")).toBe(true);
    expect(shouldSuppressImportedCursorHandler(envelope, "prim-session-end")).toBe(false);
    expect(
      shouldSuppressImportedCursorHandler({ ...envelope, cursor_version: undefined }, "prim-hook"),
    ).toBe(false);
  });
});
