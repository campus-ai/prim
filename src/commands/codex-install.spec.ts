/**
 * `prim codex install` coverage — pure apply helpers only.
 *
 * The fs-touching `performInstall` / `performUninstall` / `performStatus`
 * resolve `~/.codex/hooks.json` at module load, so they're exercised by the
 * live-disk smoke. Here we verify the Codex registration table composes
 * correctly through the shared merge engine reused from claude-install, now
 * emitting absolute, PATH-independent commands that still carry `--agent codex`.
 */

import { describe, expect, it } from "vitest";
import { commandMatchesBin, pinnedHookCommand } from "../lib/bin-path.js";
import type { ClaudeSettings } from "./claude-install.js";
import { applyInstall, applyUninstall, isGateInstalled, resolveScope } from "./codex-install.js";

const EMPTY: ClaudeSettings = {};

function commandsOn(settings: ClaudeSettings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((e) =>
    (e.hooks ?? []).map((h) => h.command ?? ""),
  );
}

function hasBin(settings: ClaudeSettings, event: string, bin: string): boolean {
  return commandsOn(settings, event).some((c) => commandMatchesBin(c, bin));
}

describe("codex applyInstall", () => {
  it("wires capture (prim-hook) on every Codex hook event", () => {
    const out = applyInstall(EMPTY);
    for (const event of [
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
    ]) {
      expect(hasBin(out, event, "prim-hook")).toBe(true);
    }
    expect(JSON.stringify(out.hooks)).not.toMatch(/@latest|command -v|node_modules\/\.bin/);
  });

  it("matches apply_patch and writes shim commands that keep --agent codex", () => {
    const out = applyInstall(EMPTY);
    const preGate = out.hooks?.PreToolUse?.find((e) => e.matcher === "apply_patch");
    const postIngest = out.hooks?.PostToolUse?.find((e) => e.matcher === "apply_patch|Bash");
    expect(preGate?.hooks?.[0].command).toBe(
      pinnedHookCommand("prim-pre-tool-use", "--agent codex"),
    );
    expect(postIngest?.hooks?.[0].command).toBe(
      pinnedHookCommand("prim-post-tool-use", "--agent codex"),
    );
    // The shim, not the old bare form.
    expect(preGate?.hooks?.[0].command).not.toBe("prim-pre-tool-use --agent codex");
  });

  it("carries two entries on PreToolUse (capture * + gate apply_patch)", () => {
    const out = applyInstall(EMPTY);
    expect(out.hooks?.PreToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("*");
    expect(commandMatchesBin(out.hooks?.PreToolUse?.[0].hooks?.[0].command, "prim-hook")).toBe(
      true,
    );
    expect(out.hooks?.PreToolUse?.[1].matcher).toBe("apply_patch");
  });

  it("registers prim-session-start on SessionStart alongside capture", () => {
    const out = applyInstall(EMPTY);
    const cmds = commandsOn(out, "SessionStart");
    expect(cmds).toHaveLength(2);
    expect(commandMatchesBin(cmds[0], "prim-hook")).toBe(true);
    expect(commandMatchesBin(cmds[1], "prim-session-start")).toBe(true);
    expect(cmds[1]).toBe(pinnedHookCommand("prim-session-start", "--agent codex"));
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

  it("upgrades a legacy bare-name Codex install in place", () => {
    const legacy: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "apply_patch",
            hooks: [{ type: "command", command: "prim-pre-tool-use --agent codex" }],
          },
        ],
      },
    };
    const out = applyInstall(legacy);
    const gateEntries = (out.hooks?.PreToolUse ?? []).filter((e) => e.matcher === "apply_patch");
    expect(gateEntries).toHaveLength(1);
    expect(gateEntries[0].hooks?.[0].command).toBe(
      pinnedHookCommand("prim-pre-tool-use", "--agent codex"),
    );
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

describe("resolveScope", () => {
  it("defaults to project when no --scope is given", () => {
    expect(resolveScope(undefined)).toBe("project");
  });

  it("honors an explicit project scope", () => {
    expect(resolveScope("project")).toBe("project");
  });

  it("honors an explicit user (machine-global) scope", () => {
    expect(resolveScope("user")).toBe("user");
  });
});
