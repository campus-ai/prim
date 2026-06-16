/**
 * `prim claude install|uninstall` coverage — pure merge helpers.
 *
 * Exercises applyInstall / applyUninstall / isGateInstalled. The fs-touching
 * perform* wrappers (atomic write, scope resolution) are thin and covered by
 * a live-disk smoke during release.
 */

import { describe, expect, it } from "vitest";
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

const EMPTY: ClaudeSettings = {};

const EXISTING_OTHER: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      { matcher: "Bash", hooks: [{ type: "command", command: "/usr/local/bin/other" }] },
    ],
  },
};

// A hand-merged entry where a non-prim command is co-located in the same
// hooks[] array as a prim command — a legal Claude Code shape that must
// survive install/uninstall (the hook-granularity invariant).
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

describe("applyInstall", () => {
  it("registers capture (prim-hook) on every hook event at matcher *", () => {
    const out = applyInstall(EMPTY);
    for (const event of CAPTURE_EVENTS) {
      expect(commandsFor(out, event)).toContain("prim-hook");
      const captureEntry = out.hooks?.[event]?.find((e) =>
        e.hooks?.some((h) => h.command === "prim-hook"),
      );
      expect(captureEntry?.matcher).toBe("*");
    }
  });

  it("registers the gate (prim-pre-tool-use) on PreToolUse at the edit matcher", () => {
    const out = applyInstall(EMPTY);
    const gateEntry = out.hooks?.PreToolUse?.find((e) =>
      e.hooks?.some((h) => h.command === "prim-pre-tool-use"),
    );
    expect(gateEntry?.matcher).toBe("Edit|Write|MultiEdit");
  });

  it("puts BOTH prim binaries on PreToolUse as separate entries", () => {
    const out = applyInstall(EMPTY);
    expect(commandsFor(out, "PreToolUse").sort()).toEqual(["prim-hook", "prim-pre-tool-use"]);
  });

  it("preserves unrelated matchers when adding prim entries", () => {
    const out = applyInstall(EXISTING_OTHER);
    expect(commandsFor(out, "PreToolUse")).toContain("/usr/local/bin/other");
    expect(commandsFor(out, "PreToolUse")).toContain("prim-pre-tool-use");
    expect(commandsFor(out, "PreToolUse")).toContain("prim-hook");
  });

  it("is idempotent — re-installing onto already-installed settings is a no-op", () => {
    const once = applyInstall(EMPTY);
    const twice = applyInstall(once);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
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
      e.hooks?.some((h) => h.command === "prim-pre-tool-use"),
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
    const cmds = commandsFor(out, "PreToolUse");
    expect(cmds).toContain("/usr/local/bin/other");
    expect(cmds).toContain("prim-hook");
    expect(cmds).toContain("prim-pre-tool-use");
  });
});

describe("applyUninstall", () => {
  it("strips BOTH prim binaries from every event", () => {
    const installed = applyInstall(EMPTY);
    const out = applyUninstall(installed);
    for (const event of CAPTURE_EVENTS) {
      expect(commandsFor(out, event)).not.toContain("prim-hook");
      expect(commandsFor(out, event)).not.toContain("prim-pre-tool-use");
    }
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
      e.hooks?.some((h) => h.command === "prim-post-tool-use"),
    );
    expect(entry?.matcher).toBe("Edit|Write|MultiEdit");
  });

  it("registers the session hooks on SessionStart / SessionEnd", () => {
    const out = applyInstall(EMPTY);
    expect(commandsFor(out, "SessionStart")).toContain("prim-session-start");
    expect(commandsFor(out, "SessionEnd")).toContain("prim-session-end");
  });

  it("installs the prim statusLine with a refresh interval when the slot is empty", () => {
    const out = applyInstall(EMPTY);
    expect(out.statusLine).toEqual({
      type: "command",
      command: "prim statusline",
      refreshInterval: 5,
    });
  });

  it("upgrades an older prim statusLine that predates the refresh interval", () => {
    const old: ClaudeSettings = {
      statusLine: { type: "command", command: "prim statusline" },
    };
    const out = applyInstall(old);
    expect(out.statusLine?.refreshInterval).toBe(5);
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
      expect(commandsFor(out, event)).not.toContain("prim-post-tool-use");
      expect(commandsFor(out, event)).not.toContain("prim-session-start");
      expect(commandsFor(out, event)).not.toContain("prim-session-end");
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
