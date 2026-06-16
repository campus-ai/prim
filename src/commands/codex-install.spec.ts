/**
 * `prim codex install` coverage — pure apply helpers only.
 *
 * The fs-touching `performInstall` / `performUninstall` / `performStatus`
 * resolve `~/.codex/hooks.json` at module load, so they're exercised by the
 * live-disk smoke. Here we verify the Codex registration table composes
 * correctly through the shared merge engine reused from claude-install.
 */

import { describe, expect, it } from "vitest";
import type { ClaudeSettings } from "./claude-install.js";
import { applyInstall, applyUninstall, isGateInstalled } from "./codex-install.js";

const EMPTY: ClaudeSettings = {};
const CAPTURE = "prim-hook --agent codex";
const GATE = "prim-pre-tool-use --agent codex";

function commandsOn(settings: ClaudeSettings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((e) =>
    (e.hooks ?? []).map((h) => h.command ?? ""),
  );
}

describe("codex applyInstall", () => {
  it("wires capture (prim-hook --agent codex) on every Codex hook event", () => {
    const out = applyInstall(EMPTY);
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
    ]) {
      expect(commandsOn(out, event)).toContain(CAPTURE);
    }
  });

  it("matches apply_patch (not Edit|Write|MultiEdit) on the gate + ingest hooks", () => {
    const out = applyInstall(EMPTY);
    const preGate = out.hooks?.PreToolUse?.find((e) => e.matcher === "apply_patch");
    const postIngest = out.hooks?.PostToolUse?.find((e) => e.matcher === "apply_patch");
    expect(preGate?.hooks?.[0].command).toBe(GATE);
    expect(postIngest?.hooks?.[0].command).toBe("prim-post-tool-use --agent codex");
  });

  it("carries two entries on PreToolUse (capture * + gate apply_patch)", () => {
    const out = applyInstall(EMPTY);
    expect(out.hooks?.PreToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("*");
    expect(out.hooks?.PreToolUse?.[0].hooks?.[0].command).toBe(CAPTURE);
    expect(out.hooks?.PreToolUse?.[1].matcher).toBe("apply_patch");
  });

  it("registers prim-session-start on SessionStart alongside capture", () => {
    const out = applyInstall(EMPTY);
    expect(commandsOn(out, "SessionStart")).toEqual([CAPTURE, "prim-session-start --agent codex"]);
  });

  it("does NOT register SessionEnd (Codex has no such event) or a statusLine", () => {
    const out = applyInstall(EMPTY);
    expect(out.hooks?.SessionEnd).toBeUndefined();
    expect(out.statusLine).toBeUndefined();
  });

  it("preserves unrelated hooks already in the config", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/x" }] },
        ],
      },
    };
    const out = applyInstall(existing);
    expect(out.hooks?.PreToolUse).toHaveLength(3);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("Bash");
  });

  it("is idempotent — re-install onto a full config is a no-op", () => {
    const once = applyInstall(EMPTY);
    const twice = applyInstall(once);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });
});

describe("isGateInstalled", () => {
  it("is false on empty, true after install, false after uninstall", () => {
    expect(isGateInstalled(EMPTY)).toBe(false);
    const installed = applyInstall(EMPTY);
    expect(isGateInstalled(installed)).toBe(true);
    expect(isGateInstalled(applyUninstall(installed))).toBe(false);
  });
});

describe("codex applyUninstall", () => {
  it("removes every prim command but keeps foreign hooks", () => {
    const existing: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/x" }] },
        ],
      },
    };
    const out = applyUninstall(applyInstall(existing));
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("Bash");
    expect(out.hooks?.PostToolUse).toBeUndefined();
    expect(out.hooks?.SessionStart).toBeUndefined();
  });
});
