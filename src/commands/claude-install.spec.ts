/**
 * `prim claude install` coverage — pure helpers only.
 *
 * The fs-touching `performInstall` / `performUninstall` / `performStatus`
 * are covered by the live-disk smoke documented in
 * cli-ux-m3-results.md.
 */

import { describe, expect, it } from "vitest";
import {
  type ClaudeSettings,
  applyInstall,
  applyInstallHookSurface,
  applyInstallStatusLine,
  applyUninstall,
  applyUninstallHookSurface,
  applyUninstallStatusLine,
  isFullyInstalled,
  isInstalled,
} from "./claude-install.js";

const EMPTY: ClaudeSettings = {};

const EXISTING_OTHER: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [{ type: "command", command: "/usr/local/bin/some-other-hook" }],
      },
    ],
  },
};

const EXISTING_PRIM: ClaudeSettings = {
  hooks: {
    PreToolUse: [
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: "prim-pre-tool-use" }],
      },
    ],
  },
};

describe("applyInstall", () => {
  it("creates the hooks structure from scratch when settings is empty", () => {
    const out = applyInstall(EMPTY);
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse?.[0].hooks?.[0].command).toBe("prim-pre-tool-use");
  });

  it("preserves unrelated matchers when adding the prim entry", () => {
    const out = applyInstall(EXISTING_OTHER);
    expect(out.hooks?.PreToolUse).toHaveLength(2);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("Bash");
    expect(out.hooks?.PreToolUse?.[1].matcher).toBe("Edit|Write|MultiEdit");
  });

  it("is idempotent — re-installing onto already-canonical settings is a no-op", () => {
    const out = applyInstall(EXISTING_PRIM);
    expect(JSON.stringify(out)).toBe(JSON.stringify(EXISTING_PRIM));
  });

  it("replaces an existing prim entry when --force is true", () => {
    const drifted: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: "prim-pre-tool-use" }],
          },
        ],
      },
    };
    const out = applyInstall(drifted, { force: true });
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("Edit|Write|MultiEdit");
  });

  it("leaves top-level non-hooks keys untouched", () => {
    const withExtras: ClaudeSettings = {
      env: { CUSTOM: "value" } as unknown as ClaudeSettings["env"],
      hooks: {},
    };
    const out = applyInstall(withExtras);
    expect((out as { env?: unknown }).env).toEqual({ CUSTOM: "value" });
  });
});

describe("applyUninstall", () => {
  it("removes the prim entry while preserving unrelated matchers", () => {
    const both: ClaudeSettings = {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "/usr/local/bin/other" }],
          },
          {
            matcher: "Edit|Write|MultiEdit",
            hooks: [{ type: "command", command: "prim-pre-tool-use" }],
          },
        ],
      },
    };
    const out = applyUninstall(both);
    expect(out.hooks?.PreToolUse).toHaveLength(1);
    expect(out.hooks?.PreToolUse?.[0].matcher).toBe("Bash");
  });

  it("sets PreToolUse to undefined when removing the only entry", () => {
    const out = applyUninstall(EXISTING_PRIM);
    expect(out.hooks?.PreToolUse).toBeUndefined();
  });

  it("is a no-op when no prim entry exists", () => {
    const out = applyUninstall(EXISTING_OTHER);
    expect(JSON.stringify(out)).toBe(JSON.stringify(EXISTING_OTHER));
  });
});

describe("isInstalled", () => {
  it("returns true when a prim PreToolUse entry exists", () => {
    expect(isInstalled(EXISTING_PRIM)).toBe(true);
  });

  it("returns false when only unrelated entries exist", () => {
    expect(isInstalled(EXISTING_OTHER)).toBe(false);
  });

  it("returns false for the empty settings object", () => {
    expect(isInstalled(EMPTY)).toBe(false);
  });
});

describe("applyInstallHookSurface (M6 generic)", () => {
  it("creates a SessionStart entry without a matcher", () => {
    const out = applyInstallHookSurface(EMPTY, {
      eventName: "SessionStart",
      command: "prim-session-start",
    });
    expect(out.hooks?.SessionStart).toHaveLength(1);
    expect(out.hooks?.SessionStart?.[0].matcher).toBeUndefined();
    expect(out.hooks?.SessionStart?.[0].hooks?.[0].command).toBe("prim-session-start");
  });

  it("creates a PostToolUse entry with the Edit|Write|MultiEdit matcher", () => {
    const out = applyInstallHookSurface(EMPTY, {
      eventName: "PostToolUse",
      command: "prim-post-tool-use",
      matcher: "Edit|Write|MultiEdit",
    });
    expect(out.hooks?.PostToolUse?.[0].matcher).toBe("Edit|Write|MultiEdit");
  });

  it("is idempotent on a re-install of the same surface", () => {
    const once = applyInstallHookSurface(EMPTY, {
      eventName: "SessionEnd",
      command: "prim-session-end",
    });
    const twice = applyInstallHookSurface(once, {
      eventName: "SessionEnd",
      command: "prim-session-end",
    });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it("preserves unrelated SessionStart entries", () => {
    const otherSession: ClaudeSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "/usr/local/bin/other-start" }],
          },
        ],
      },
    };
    const out = applyInstallHookSurface(otherSession, {
      eventName: "SessionStart",
      command: "prim-session-start",
    });
    expect(out.hooks?.SessionStart).toHaveLength(2);
    expect(out.hooks?.SessionStart?.[0].hooks?.[0].command).toBe("/usr/local/bin/other-start");
    expect(out.hooks?.SessionStart?.[1].hooks?.[0].command).toBe("prim-session-start");
  });
});

describe("applyUninstallHookSurface (M6 generic)", () => {
  it("removes a SessionEnd entry while keeping unrelated matchers", () => {
    const installed: ClaudeSettings = {
      hooks: {
        SessionEnd: [
          {
            hooks: [{ type: "command", command: "/usr/local/bin/other" }],
          },
          {
            hooks: [{ type: "command", command: "prim-session-end" }],
          },
        ],
      },
    };
    const out = applyUninstallHookSurface(installed, {
      eventName: "SessionEnd",
      command: "prim-session-end",
    });
    expect(out.hooks?.SessionEnd).toHaveLength(1);
    expect(out.hooks?.SessionEnd?.[0].hooks?.[0].command).toBe("/usr/local/bin/other");
  });

  it("clears the event key when removing the last entry", () => {
    const justPrim: ClaudeSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [{ type: "command", command: "prim-session-start" }],
          },
        ],
      },
    };
    const out = applyUninstallHookSurface(justPrim, {
      eventName: "SessionStart",
      command: "prim-session-start",
    });
    expect(out.hooks?.SessionStart).toBeUndefined();
  });
});

describe("applyInstallStatusLine + applyUninstallStatusLine", () => {
  it("installs the canonical statusLine config when no statusLine exists", () => {
    const out = applyInstallStatusLine(EMPTY);
    expect(out.statusLine?.command).toBe("prim statusline");
    expect(out.statusLine?.type).toBe("command");
    expect(out.statusLine?.padding).toBe(1);
  });

  it("does not overwrite a user-defined non-prim statusLine without --force", () => {
    const custom: ClaudeSettings = {
      statusLine: { type: "command", command: "custom-statusline" },
    };
    const out = applyInstallStatusLine(custom);
    expect(out.statusLine?.command).toBe("custom-statusline");
  });

  it("does overwrite a user-defined statusLine when --force is true", () => {
    const custom: ClaudeSettings = {
      statusLine: { type: "command", command: "custom-statusline" },
    };
    const out = applyInstallStatusLine(custom, { force: true });
    expect(out.statusLine?.command).toBe("prim statusline");
  });

  it("is idempotent on the canonical prim statusLine", () => {
    const prim = applyInstallStatusLine(EMPTY);
    const twice = applyInstallStatusLine(prim);
    expect(JSON.stringify(prim)).toBe(JSON.stringify(twice));
  });

  it("uninstalls only the prim statusLine, not user-defined ones", () => {
    const custom: ClaudeSettings = {
      statusLine: { type: "command", command: "custom-statusline" },
    };
    const out = applyUninstallStatusLine(custom);
    expect(out.statusLine?.command).toBe("custom-statusline");
  });

  it("clears the statusLine when removing the prim entry", () => {
    const prim = applyInstallStatusLine(EMPTY);
    const out = applyUninstallStatusLine(prim);
    expect(out.statusLine).toBeUndefined();
  });
});

describe("isFullyInstalled", () => {
  it("is false on empty settings", () => {
    expect(isFullyInstalled(EMPTY)).toBe(false);
  });

  it("is false when only PreToolUse is wired", () => {
    expect(isFullyInstalled(EXISTING_PRIM)).toBe(false);
  });

  it("is true after a full M6 install", () => {
    let s = applyInstall(EMPTY);
    s = applyInstallHookSurface(s, {
      eventName: "PostToolUse",
      command: "prim-post-tool-use",
      matcher: "Edit|Write|MultiEdit",
    });
    s = applyInstallHookSurface(s, {
      eventName: "SessionStart",
      command: "prim-session-start",
    });
    s = applyInstallHookSurface(s, {
      eventName: "SessionEnd",
      command: "prim-session-end",
    });
    s = applyInstallStatusLine(s);
    expect(isFullyInstalled(s)).toBe(true);
  });
});
