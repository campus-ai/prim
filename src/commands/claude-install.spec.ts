/**
 * `prim claude install|uninstall` coverage — pure merge helpers.
 *
 * Exercises applyInstall / applyUninstall / isGateInstalled. Commands are now
 * written as absolute, PATH-independent invocations, so assertions match on bin
 * IDENTITY (commandMatchesBin) rather than literal strings — which also pins
 * the migration behavior: a legacy bare-name install is recognized, upgraded in
 * place on re-install, and stripped on uninstall. The fs-touching perform*
 * wrappers (atomic write, scope resolution) are covered by a release smoke.
 */

import { describe, expect, it } from "vitest";
import { commandMatchesBin, hookShimCommand } from "../lib/bin-path.js";
import {
  type ClaudeSettings,
  applyInstall,
  applyUninstall,
  isGateInstalled,
} from "./claude-install.js";

const CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStop",
];

function commandsFor(settings: ClaudeSettings, event: string): string[] {
  return (settings.hooks?.[event] ?? []).flatMap((e) =>
    (e.hooks ?? []).map((h) => h.command ?? ""),
  );
}

function hasBin(settings: ClaudeSettings, event: string, bin: string): boolean {
  return commandsFor(settings, event).some((c) => commandMatchesBin(c, bin));
}

const EMPTY: ClaudeSettings = {};

const EXISTING_OTHER: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/other" }] },
    ],
  },
};

// A hand-merged entry where a non-prim command is co-located in the same
// hooks[] array as a (legacy bare-name) prim command — a legal Claude Code
// shape that must survive install/uninstall (the hook-granularity invariant).
const COLOCATED: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          { type: "command", command: "/usr/local/bin/other" },
          { type: "command", command: "prim-hook" },
        ],
      },
    ],
  },
};

// A complete prior install in the legacy bare-name form (pre-absolute-path).
const LEGACY_BARE: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      { matcher: "*", hooks: [{ type: "command", command: "prim-hook" }] },
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: "prim-pre-tool-use" }],
      },
    ],
  },
};

describe("applyInstall", () => {
  it("registers capture (prim-hook) on every hook event at matcher *", () => {
    const out = applyInstall(EMPTY);
    for (const event of CAPTURE_EVENTS) {
      expect(hasBin(out, event, "prim-hook")).toBe(true);
      const captureEntry = out.hooks?.[event]?.find((e) =>
        e.hooks?.some((h) => commandMatchesBin(h.command, "prim-hook")),
      );
      expect(captureEntry?.matcher).toBe("*");
    }
  });

  it("writes the gate as a resolution shim (PATH -> local -> npx), not a bare name", () => {
    const out = applyInstall(EMPTY);
    const gateEntry = out.hooks?.PreToolUse?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-pre-tool-use")),
    );
    expect(gateEntry?.matcher).toBe("Edit|Write|MultiEdit");
    expect(gateEntry?.hooks?.[0].command).toBe(hookShimCommand("prim-pre-tool-use"));
    expect(gateEntry?.hooks?.[0].command).not.toBe("prim-pre-tool-use");
  });

  it("puts BOTH prim binaries on PreToolUse as separate entries", () => {
    const out = applyInstall(EMPTY);
    expect(commandsFor(out, "PreToolUse")).toHaveLength(2);
    expect(hasBin(out, "PreToolUse", "prim-hook")).toBe(true);
    expect(hasBin(out, "PreToolUse", "prim-pre-tool-use")).toBe(true);
  });

  it("preserves unrelated matchers when adding prim entries", () => {
    const out = applyInstall(EXISTING_OTHER);
    expect(commandsFor(out, "PreToolUse")).toContain("/usr/local/bin/other");
    expect(hasBin(out, "PreToolUse", "prim-pre-tool-use")).toBe(true);
    expect(hasBin(out, "PreToolUse", "prim-hook")).toBe(true);
  });

  it("is idempotent — re-installing onto already-installed settings is a no-op", () => {
    const once = applyInstall(EMPTY);
    const twice = applyInstall(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it("upgrades a legacy bare-name install to the absolute form in place", () => {
    const out = applyInstall(LEGACY_BARE);
    const gateEntries = (out.hooks?.PreToolUse ?? []).filter((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-pre-tool-use")),
    );
    // Upgraded, not duplicated: exactly one gate entry, now the shim form.
    expect(gateEntries).toHaveLength(1);
    expect(gateEntries[0].hooks?.[0].command).toBe(hookShimCommand("prim-pre-tool-use"));
    expect(hasBin(out, "PreToolUse", "prim-hook")).toBe(true);
  });

  it("replaces a drifted gate matcher when --force is set", () => {
    const drifted: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: "prim-pre-tool-use" }] },
        ],
      },
    };
    const out = applyInstall(drifted, { force: true });
    const gateEntries = (out.hooks?.PreToolUse ?? []).filter((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-pre-tool-use")),
    );
    expect(gateEntries).toHaveLength(1);
    expect(gateEntries[0].matcher).toBe("Edit|Write|MultiEdit");
  });

  it("leaves top-level non-hooks keys untouched", () => {
    const withExtras: ClaudeSettings = { model: "opus", hooks: {} };
    const out = applyInstall(withExtras);
    expect((out as { model?: unknown }).model).toBe("opus");
  });

  it("preserves a co-located non-prim command when normalizing a drifted prim entry", () => {
    const out = applyInstall(COLOCATED);
    expect(commandsFor(out, "PreToolUse")).toContain("/usr/local/bin/other");
    expect(hasBin(out, "PreToolUse", "prim-hook")).toBe(true);
    expect(hasBin(out, "PreToolUse", "prim-pre-tool-use")).toBe(true);
  });
});

describe("applyUninstall", () => {
  it("strips BOTH prim binaries from every event", () => {
    const installed = applyInstall(EMPTY);
    const out = applyUninstall(installed);
    for (const event of CAPTURE_EVENTS) {
      expect(hasBin(out, event, "prim-hook")).toBe(false);
      expect(hasBin(out, event, "prim-pre-tool-use")).toBe(false);
    }
  });

  it("strips a legacy bare-name install too", () => {
    const out = applyUninstall(LEGACY_BARE);
    expect(out.hooks?.PreToolUse).toBeUndefined();
  });

  it("preserves unrelated matchers while removing prim entries", () => {
    const installed = applyInstall(EXISTING_OTHER);
    const out = applyUninstall(installed);
    expect(commandsFor(out, "PreToolUse")).toEqual(["/usr/local/bin/other"]);
  });

  it("drops an event key entirely once its last prim entry is gone", () => {
    const installed = applyInstall(EMPTY);
    const out = applyUninstall(installed);
    expect(out.hooks?.SessionStart).toBeUndefined();
  });

  it("is a no-op when no prim entry exists", () => {
    const out = applyUninstall(EXISTING_OTHER);
    expect(JSON.stringify(out)).toBe(JSON.stringify(EXISTING_OTHER));
  });

  it("strips a prim hook co-located with a non-prim command without dropping the sibling", () => {
    const out = applyUninstall(COLOCATED);
    expect(commandsFor(out, "PreToolUse")).toEqual(["/usr/local/bin/other"]);
  });
});

describe("isGateInstalled", () => {
  it("is true when the gate is present", () => {
    expect(isGateInstalled(applyInstall(EMPTY))).toBe(true);
  });

  it("is false when only capture is present (gate is the install signal)", () => {
    const captureOnly: ClaudeSettings = {
      hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "prim-hook" }] }] },
    };
    expect(isGateInstalled(captureOnly)).toBe(false);
  });

  it("is false for empty settings", () => {
    expect(isGateInstalled(EMPTY)).toBe(false);
  });
});

describe("post-tool-use, session hooks, statusline install", () => {
  it("registers the post-tool-use ingest hook on PostToolUse at the edit matcher", () => {
    const out = applyInstall(EMPTY);
    const entry = out.hooks?.PostToolUse?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-post-tool-use")),
    );
    expect(entry?.matcher).toBe("Edit|Write|MultiEdit");
  });

  it("registers the session hooks on SessionStart / SessionEnd", () => {
    const out = applyInstall(EMPTY);
    expect(hasBin(out, "SessionStart", "prim-session-start")).toBe(true);
    expect(hasBin(out, "SessionEnd", "prim-session-end")).toBe(true);
  });

  it("installs the prim statusLine (shim) with a refresh interval when the slot is empty", () => {
    const out = applyInstall(EMPTY);
    expect(out.statusLine?.type).toBe("command");
    expect(out.statusLine?.refreshInterval).toBe(5);
    expect(out.statusLine?.command).toBe(hookShimCommand("prim", "statusline"));
    expect(out.statusLine?.command).toContain("@primitive.ai/prim");
  });

  it("upgrades an older (bare) prim statusLine that predates the refresh interval", () => {
    const old: ClaudeSettings = {
      statusLine: { type: "command", command: "prim statusline" },
    };
    const out = applyInstall(old);
    expect(out.statusLine?.refreshInterval).toBe(5);
    expect(out.statusLine?.command).toBe(hookShimCommand("prim", "statusline"));
  });

  it("never clobbers a user-defined statusLine", () => {
    const userStatusLine: ClaudeSettings = {
      statusLine: { type: "command", command: "my-custom-statusline" },
    };
    const out = applyInstall(userStatusLine);
    expect(out.statusLine).toEqual({ type: "command", command: "my-custom-statusline" });
  });

  it("uninstall strips every prim hook binary and the prim statusLine", () => {
    const out = applyUninstall(applyInstall(EMPTY));
    for (const event of CAPTURE_EVENTS) {
      expect(hasBin(out, event, "prim-post-tool-use")).toBe(false);
      expect(hasBin(out, event, "prim-session-start")).toBe(false);
      expect(hasBin(out, event, "prim-session-end")).toBe(false);
    }
    expect(out.statusLine).toBeUndefined();
  });

  it("uninstall leaves a user-defined statusLine intact", () => {
    const installed = applyInstall({
      statusLine: { type: "command", command: "my-custom-statusline" },
    });
    const out = applyUninstall(installed);
    expect(out.statusLine).toEqual({ type: "command", command: "my-custom-statusline" });
  });
});
