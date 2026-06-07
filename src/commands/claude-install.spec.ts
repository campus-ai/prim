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
  applyUninstall,
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
