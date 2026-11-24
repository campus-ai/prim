import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
/**
 * `prim claude install|uninstall` coverage — pure merge helpers.
 *
 * Exercises applyInstall / applyUninstall / isGateInstalled. Commands are now
 * written as stable, PATH-independent invocations, so assertions match on bin
 * IDENTITY (commandMatchesBin) rather than literal strings — which also pins
 * the migration behavior: a legacy bare-name install is recognized, upgraded in
 * place on re-install, and stripped on uninstall. The fs-touching perform*
 * wrappers (atomic write, scope resolution) are covered by a release smoke.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { commandMatchesBin, detachedHookShimCommand, stableHookCommand } from "../lib/bin-path.js";
import {
  type ClaudeSettings,
  PRIM_AUTOMODE_TRUST,
  PRIM_PERMISSION_RULE,
  applyAutoModeTrust,
  applyInstall,
  applyRepositoryDeclaration,
  applyUninstall,
  deferToProjectInstall,
  feedbackInstalled,
  hasCompleteHookRegistration,
  isGateInstalled,
  projectSettingsAfterInstall,
  projectSettingsAfterUninstall,
  removeRepositoryDeclaration,
  resolveScope,
  statuslineState,
  userStatuslineBlocksProjectInstall,
  usesProjectDeferral,
} from "./claude-install.js";

const CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
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

// Historical settings fixture only. Product code no longer generates this
// PATH/local/@latest ladder, but reinstall and uninstall must still recognize
// commands already written by an older CLI.
function legacyHookShimCommand(bin: string): string {
  return `if command -v ${bin} >/dev/null 2>&1; then ${bin}; elif [ -f "./node_modules/.bin/${bin}" ]; then ./node_modules/.bin/${bin}; else npx --yes -p @primitive.ai/prim@latest ${bin}; fi`;
}

/**
 * A faithful model of Claude Code's Bash allow-rule matcher, per
 * code.claude.com/docs/en/permissions: a trailing ` *` or `:*` enforces a word
 * boundary (the prefix must be followed by a space or end-of-string), while a
 * bare trailing `*` has no boundary. We encode it here so the pre-auth rule's
 * coverage of BOTH doc invocation forms is an executable regression guard — not
 * a claim in a comment — and so a future "tidy" back to a boundary form fails
 * loudly instead of silently dropping onboarding coverage.
 */
function bashRuleMatches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) {
    return false;
  }
  if (inner.endsWith(":*") || inner.endsWith(" *")) {
    const prefix = inner.slice(0, -2);
    return (
      command.startsWith(prefix) &&
      (command.length === prefix.length || command[prefix.length] === " ")
    );
  }
  if (inner.endsWith("*")) {
    return command.startsWith(inner.slice(0, -1));
  }
  return command === inner;
}

// The two invocation forms our docs use.
const SETUP_FORM = "npx --yes @primitive.ai/prim@latest auth status --json";
const SKILL_FORM = "npx --yes @primitive.ai/prim auth status --json";

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
    const commands = [
      ...CAPTURE_EVENTS.flatMap((event) => commandsFor(out, event)),
      out.statusLine?.command ?? "",
    ];
    expect(commands.join("\n")).not.toMatch(/@latest|command -v|node_modules\/\.bin/);
  });

  it("writes the gate as a resolution shim (PATH -> local -> npx), not a bare name", () => {
    const out = applyInstall(EMPTY);
    const gateEntry = out.hooks?.PreToolUse?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-pre-tool-use")),
    );
    expect(gateEntry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
    expect(gateEntry?.hooks?.[0].command).toBe(stableHookCommand("prim-pre-tool-use"));
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
    expect(gateEntries[0].hooks?.[0].command).toBe(stableHookCommand("prim-pre-tool-use"));
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
    expect(gateEntries[0].matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
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

describe("permissions pre-authorization", () => {
  const EMPTY: ClaudeSettings = {};

  it("install adds the scoped prim allow-rule", () => {
    const out = applyInstall(EMPTY);
    expect(out.permissions?.allow).toContain(PRIM_PERMISSION_RULE);
  });

  it("is idempotent — re-installing does not duplicate the rule", () => {
    const once = applyInstall(EMPTY);
    const twice = applyInstall(once);
    const count = (twice.permissions?.allow ?? []).filter((r) => r === PRIM_PERMISSION_RULE).length;
    expect(count).toBe(1);
  });

  it("preserves the user's existing allow entries and other permission keys", () => {
    const existing: ClaudeSettings = {
      permissions: { allow: ["Bash(ls:*)"], deny: ["Bash(rm:*)"] },
    };
    const out = applyInstall(existing);
    expect(out.permissions?.allow).toEqual(["Bash(ls:*)", PRIM_PERMISSION_RULE]);
    expect(out.permissions?.deny).toEqual(["Bash(rm:*)"]);
  });

  it("uninstall removes the rule and drops an emptied permissions object", () => {
    const out = applyUninstall(applyInstall(EMPTY));
    expect(out.permissions).toBeUndefined();
  });

  it("uninstall keeps the user's other allow entries while removing ours", () => {
    const installed = applyInstall({ permissions: { allow: ["Bash(ls:*)"] } });
    const out = applyUninstall(installed);
    expect(out.permissions?.allow).toEqual(["Bash(ls:*)"]);
  });

  // Earlier releases pinned @latest; re-installing must upgrade it to the
  // broader prefix, and uninstall must clear it regardless of which form is on
  // disk — otherwise a stale @latest rule lingers forever.
  const LEGACY_RULE = "Bash(npx --yes @primitive.ai/prim@latest:*)";

  it("is a true no-op when the canonical rule is present but not last (no reorder churn)", () => {
    // A user appended their own allow entry after a prior prim install, so our
    // rule is no longer last; re-installing must not reorder/rewrite it.
    const settings: ClaudeSettings = {
      permissions: { allow: [PRIM_PERMISSION_RULE, "Bash(ls:*)"] },
    };
    const out = applyInstall(settings);
    expect(out.permissions?.allow).toEqual([PRIM_PERMISSION_RULE, "Bash(ls:*)"]);
  });

  it("install upgrades a legacy @latest rule to the broadened prefix", () => {
    const out = applyInstall({ permissions: { allow: [LEGACY_RULE] } });
    expect(out.permissions?.allow).toContain(PRIM_PERMISSION_RULE);
    expect(out.permissions?.allow).not.toContain(LEGACY_RULE);
  });

  it("uninstall removes the legacy @latest rule too", () => {
    const out = applyUninstall({ permissions: { allow: [LEGACY_RULE] } });
    expect(out.permissions).toBeUndefined();
  });

  // The prior canonical rule was the boundary-suffixed bare form; it must also be
  // recognized as legacy and migrated to the boundary-free rule on re-install.
  const LEGACY_COLON_RULE = "Bash(npx --yes @primitive.ai/prim:*)";

  it("install upgrades the legacy bare `:*` rule to the boundary-free rule", () => {
    const out = applyInstall({ permissions: { allow: [LEGACY_COLON_RULE] } });
    expect(out.permissions?.allow).toContain(PRIM_PERMISSION_RULE);
    expect(out.permissions?.allow).not.toContain(LEGACY_COLON_RULE);
  });

  it("uninstall removes the legacy bare `:*` rule too", () => {
    const out = applyUninstall({ permissions: { allow: [LEGACY_COLON_RULE] } });
    expect(out.permissions).toBeUndefined();
  });
});

describe("PRIM_PERMISSION_RULE covers both doc invocation forms", () => {
  it("matches setup.md's @latest form AND SKILL.md's bare form", () => {
    expect(bashRuleMatches(PRIM_PERMISSION_RULE, SETUP_FORM)).toBe(true);
    expect(bashRuleMatches(PRIM_PERMISSION_RULE, SKILL_FORM)).toBe(true);
  });

  it("stays scoped — does not match an unrelated npx package", () => {
    expect(bashRuleMatches(PRIM_PERMISSION_RULE, "npx --yes some-other-pkg build")).toBe(false);
  });

  // The reason we abandoned each boundary-suffixed form: each silently missed one
  // of the two forms. These assertions document why the regression existed and
  // fail if anyone reintroduces a boundary form as canonical.
  it("the legacy bare `:*` form would miss setup.md's @latest invocation", () => {
    const legacyColon = "Bash(npx --yes @primitive.ai/prim:*)";
    expect(bashRuleMatches(legacyColon, SKILL_FORM)).toBe(true);
    expect(bashRuleMatches(legacyColon, SETUP_FORM)).toBe(false);
  });

  it("the legacy `@latest:*` form would miss the day-to-day bare invocation", () => {
    const legacyLatest = "Bash(npx --yes @primitive.ai/prim@latest:*)";
    expect(bashRuleMatches(legacyLatest, SETUP_FORM)).toBe(true);
    expect(bashRuleMatches(legacyLatest, SKILL_FORM)).toBe(false);
  });
});

describe("auto-mode trust (autoMode.environment)", () => {
  it("seeds $defaults when creating environment, so the built-ins aren't replaced", () => {
    // Per the auto-mode docs, setting environment without "$defaults" discards
    // Claude Code's built-in trusted environment — so we must seed it.
    const out = applyAutoModeTrust({});
    expect(out.autoMode?.environment).toEqual(["$defaults", PRIM_AUTOMODE_TRUST]);
  });

  it("is idempotent — re-applying does not duplicate the trust line", () => {
    const once = applyAutoModeTrust({});
    const twice = applyAutoModeTrust(once);
    expect(twice.autoMode?.environment).toEqual(["$defaults", PRIM_AUTOMODE_TRUST]);
  });

  it("appends to an existing environment without injecting a second $defaults or reordering", () => {
    const existing: ClaudeSettings = {
      autoMode: { environment: ["$defaults", "Trusted: github.com/acme"] },
    };
    const out = applyAutoModeTrust(existing);
    expect(out.autoMode?.environment).toEqual([
      "$defaults",
      "Trusted: github.com/acme",
      PRIM_AUTOMODE_TRUST,
    ]);
  });

  it("respects a user's $defaults-free environment (full ownership) — appends, never injects $defaults", () => {
    const existing: ClaudeSettings = { autoMode: { environment: ["Only my infra"] } };
    const out = applyAutoModeTrust(existing);
    expect(out.autoMode?.environment).toEqual(["Only my infra", PRIM_AUTOMODE_TRUST]);
  });

  it("preserves other autoMode keys when adding the trust line", () => {
    const existing: ClaudeSettings = { autoMode: { soft_deny: ["$defaults", "no prod deploys"] } };
    const out = applyAutoModeTrust(existing);
    expect(out.autoMode?.soft_deny).toEqual(["$defaults", "no prod deploys"]);
    expect(out.autoMode?.environment).toEqual(["$defaults", PRIM_AUTOMODE_TRUST]);
  });

  it("uninstall removes the trust line and the $defaults scaffold we seeded", () => {
    const out = applyUninstall(applyAutoModeTrust({}));
    expect(out.autoMode).toBeUndefined();
  });

  it("uninstall keeps the user's own environment entries (and their $defaults) while removing ours", () => {
    const installed = applyAutoModeTrust({
      autoMode: { environment: ["$defaults", "Trusted: github.com/acme"] },
    });
    const out = applyUninstall(installed);
    expect(out.autoMode?.environment).toEqual(["$defaults", "Trusted: github.com/acme"]);
  });

  it("uninstall keeps other autoMode keys while dropping our environment line", () => {
    const installed = applyAutoModeTrust({ autoMode: { soft_deny: ["no prod deploys"] } });
    const out = applyUninstall(installed);
    expect(out.autoMode?.environment).toBeUndefined();
    expect(out.autoMode?.soft_deny).toEqual(["no prod deploys"]);
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

describe("feedbackInstalled", () => {
  it("requires both existing synchronous feedback handlers", () => {
    const installed = applyInstall(EMPTY);
    expect(feedbackInstalled(installed)).toBe(true);
    expect(
      feedbackInstalled({
        ...installed,
        hooks: { ...installed.hooks, Stop: undefined },
      }),
    ).toBe(false);
    expect(
      feedbackInstalled({
        ...installed,
        hooks: { ...installed.hooks, SessionStart: undefined },
      }),
    ).toBe(false);
  });

  it("does not add a new binary or event registration", () => {
    const installed = applyInstall(EMPTY);
    expect(hasBin(installed, "Stop", "prim-hook")).toBe(true);
    expect(hasBin(installed, "SessionStart", "prim-session-start")).toBe(true);
    expect(JSON.stringify(installed)).not.toContain("prim-decision-feedback");
  });
});

describe("post-tool-use, session hooks, statusline install", () => {
  it("registers the post-tool-use ingest hook on PostToolUse at the edit matcher", () => {
    const out = applyInstall(EMPTY);
    const entry = out.hooks?.PostToolUse?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-post-tool-use")),
    );
    expect(entry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
  });

  it("registers capture and outcome ingest on PostToolUseFailure", () => {
    const out = applyInstall(EMPTY);
    expect(hasBin(out, "PostToolUseFailure", "prim-hook")).toBe(true);
    const entry = out.hooks?.PostToolUseFailure?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-post-tool-use")),
    );
    expect(entry?.matcher).toBe("Edit|Write|MultiEdit|NotebookEdit|Bash");
  });

  it("registers the session hooks on SessionStart / SessionEnd", () => {
    const out = applyInstall(EMPTY);
    expect(hasBin(out, "SessionStart", "prim-session-start")).toBe(true);
    expect(hasBin(out, "SessionEnd", "prim-session-end")).toBe(true);
  });

  it("pins SessionStart to this package and an exact-version fallback", () => {
    const out = applyInstall(EMPTY);
    const entry = out.hooks?.SessionStart?.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-session-start")),
    );
    expect(entry?.hooks?.[0].command).toBe(stableHookCommand("prim-session-start"));
  });

  it("installs the prim statusLine (shim) with a refresh interval when the slot is empty", () => {
    const out = applyInstall(EMPTY);
    expect(out.statusLine?.type).toBe("command");
    expect(out.statusLine?.refreshInterval).toBe(5);
    expect(out.statusLine?.command).toBe(stableHookCommand("prim-statusline"));
    expect(out.statusLine?.command).toContain("prim-hook-launcher-v1");
    expect(out.statusLine?.command).not.toMatch(/@latest|\bnpx\b|command -v/u);
    // Frozen #242 ownership check: package marker + `statusline`.
    expect(out.statusLine?.command).toContain("@primitive.ai/prim");
    expect(out.statusLine?.command).toContain("statusline");
  });

  it("can install and recognize the durable staged statusLine command", () => {
    const command = "'/Users/test/.local/share/prim/runtime/prim-statusline'";
    const out = applyInstall(EMPTY, { statuslineCommand: command });
    expect(out.statusLine?.command).toBe(command);
    expect(statuslineState(out)).toBe("primitive");
    expect(applyUninstall(out).statusLine).toBeUndefined();
  });

  it("recognizes and upgrades the older direct staged statusLine command", () => {
    const old: ClaudeSettings = {
      statusLine: {
        type: "command",
        command: "'/usr/bin/node' '/Users/test/.local/share/prim/runtime/current/prim-statusline'",
      },
    };
    const command = "'/Users/test/.local/share/prim/runtime/prim-statusline'";
    expect(applyInstall(old, { statuslineCommand: command }).statusLine?.command).toBe(command);
  });

  it("upgrades an older (bare) prim statusLine that predates the refresh interval", () => {
    const old: ClaudeSettings = {
      statusLine: { type: "command", command: "prim statusline" },
    };
    const out = applyInstall(old);
    expect(out.statusLine?.refreshInterval).toBe(5);
    expect(out.statusLine?.command).toBe(stableHookCommand("prim-statusline"));
  });

  it("never clobbers a user-defined statusLine", () => {
    const userStatusLine: ClaudeSettings = {
      statusLine: { type: "command", command: "my-custom-statusline" },
    };
    const out = applyInstall(userStatusLine);
    expect(out.statusLine).toEqual({ type: "command", command: "my-custom-statusline" });
    expect(statuslineState(out)).toBe("custom");
  });

  it("does not let a project Primitive statusLine shadow a custom user statusLine", () => {
    const user: ClaudeSettings = {
      statusLine: { type: "command", command: "my-global-statusline" },
    };
    expect(userStatuslineBlocksProjectInstall("project", user)).toBe(true);
    const priorProjectPrimitive = applyInstall(EMPTY);
    const out = applyInstall(priorProjectPrimitive, { installStatusline: false });
    expect(out.statusLine).toBeUndefined();
    expect(isGateInstalled(out)).toBe(true);
  });

  it("allows user-scope Primitive installation because a project custom line remains effective", () => {
    const user: ClaudeSettings = {
      statusLine: { type: "command", command: "my-global-statusline" },
    };
    expect(userStatuslineBlocksProjectInstall("user", user)).toBe(false);
  });

  it("reports primitive/custom/empty statusline ownership explicitly", () => {
    expect(statuslineState(applyInstall(EMPTY))).toBe("primitive");
    expect(
      statuslineState({ statusLine: { type: "command", command: "my-custom-statusline" } }),
    ).toBe("custom");
    expect(statuslineState(EMPTY)).toBe("empty");
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

describe("SessionEnd detached registrations", () => {
  it("writes BOTH SessionEnd entries in the detached form at matcher *", () => {
    const out = applyInstall(EMPTY);
    const entries = out.hooks?.SessionEnd ?? [];
    const capture = entries.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-hook")),
    );
    const sessionEnd = entries.find((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-session-end")),
    );
    expect(capture?.matcher).toBe("*");
    expect(capture?.hooks?.[0].command).toBe(detachedHookShimCommand("prim-hook"));
    expect(sessionEnd?.matcher).toBe("*");
    expect(sessionEnd?.hooks?.[0].command).toBe(detachedHookShimCommand("prim-session-end"));
  });

  it("keeps every non-SessionEnd capture event synchronous and pinned", () => {
    // Pins the SessionEnd-only scope: see TODO(detach-all-passive-capture).
    const out = applyInstall(EMPTY);
    for (const event of CAPTURE_EVENTS.filter((e) => e !== "SessionEnd")) {
      const commands = commandsFor(out, event).filter((c) => commandMatchesBin(c, "prim-hook"));
      expect(commands).toEqual([stableHookCommand("prim-hook")]);
      expect(commands[0]).not.toMatch(/^payload=/);
    }
  });

  it("upgrades a pre-detach synchronous SessionEnd install in place, touching nothing else", () => {
    const preDetach: ClaudeSettings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: legacyHookShimCommand("prim-hook") }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: legacyHookShimCommand("prim-session-end") }],
          },
        ],
        Stop: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: legacyHookShimCommand("prim-hook") }],
          },
        ],
      },
    };
    const out = applyInstall(preDetach);
    for (const bin of ["prim-hook", "prim-session-end"]) {
      const entries = (out.hooks?.SessionEnd ?? []).filter((e) =>
        e.hooks?.some((h) => commandMatchesBin(h.command, bin)),
      );
      // Upgraded, not duplicated: exactly one entry per bin, now detached.
      expect(entries).toHaveLength(1);
      expect(entries[0].hooks?.[0].command).toBe(detachedHookShimCommand(bin));
    }
    expect(commandsFor(out, "Stop")).toEqual([stableHookCommand("prim-hook")]);
  });

  it("heals a mixed canonical+stale SessionEnd state on a plain re-install", () => {
    // Reachable only via an external writer (e.g. a union-style git merge of
    // a committed settings.json written by two CLI versions): the canonical
    // detached entry coexists with a stale synchronous twin. The stale twin
    // double-fires capture AND still hits the teardown cancellation the
    // detached form exists to eliminate — a plain install must heal it, not
    // report "already present".
    const mixed: ClaudeSettings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "*",
            hooks: [{ type: "command", command: detachedHookShimCommand("prim-hook") }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: legacyHookShimCommand("prim-hook") }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: detachedHookShimCommand("prim-session-end") }],
          },
        ],
      },
    };
    const out = applyInstall(mixed);
    const captureEntries = (out.hooks?.SessionEnd ?? []).filter((e) =>
      e.hooks?.some((h) => commandMatchesBin(h.command, "prim-hook")),
    );
    expect(captureEntries).toHaveLength(1);
    expect(captureEntries[0].hooks?.[0].command).toBe(detachedHookShimCommand("prim-hook"));
  });

  it("uninstall strips the detached form without dropping a co-located sibling", () => {
    const installed: ClaudeSettings = {
      hooks: {
        SessionEnd: [
          {
            matcher: "*",
            hooks: [
              { type: "command", command: "/usr/local/bin/other" },
              { type: "command", command: detachedHookShimCommand("prim-hook") },
              { type: "command", command: detachedHookShimCommand("prim-session-end") },
            ],
          },
        ],
      },
    };
    const out = applyUninstall(installed);
    expect(commandsFor(out, "SessionEnd")).toEqual(["/usr/local/bin/other"]);
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

describe("repository declaration (PRIM_REPOSITORY)", () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function repo(origin?: string): string {
    const root = mkdtempSync(join(tmpdir(), "prim-declare-"));
    roots.push(root);
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    if (origin) execFileSync("git", ["remote", "add", "origin", origin], { cwd: root });
    return root;
  }

  it("records origin's repository alongside existing env without disturbing it", () => {
    const out = applyRepositoryDeclaration({ env: { FOO: "1" } }, "campus-ai/prim");
    expect(out.env).toEqual({ FOO: "1", PRIM_REPOSITORY: "campus-ai/prim" });
  });

  it("keeps an existing valid declaration, so a fork's origin cannot rewrite upstream's", () => {
    const declared: ClaudeSettings = { env: { PRIM_REPOSITORY: "campus-ai/prim" } };
    expect(applyRepositoryDeclaration(declared, "contributor/prim")).toBe(declared);
    expect(applyRepositoryDeclaration(declared, null)).toBe(declared);
  });

  it("lets --force correct a stale declaration", () => {
    const out = applyRepositoryDeclaration(
      { env: { PRIM_REPOSITORY: "old-owner/prim" } },
      "campus-ai/prim",
      true,
    );
    expect(out.env).toEqual({ PRIM_REPOSITORY: "campus-ai/prim" });
  });

  it("replaces an invalid existing declaration", () => {
    const out = applyRepositoryDeclaration(
      { env: { PRIM_REPOSITORY: "not a repo" } },
      "campus-ai/prim",
    );
    expect(out.env).toEqual({ PRIM_REPOSITORY: "campus-ai/prim" });
  });

  it("removes only the declaration install would write, dropping an emptied env", () => {
    expect(
      removeRepositoryDeclaration(
        { env: { FOO: "1", PRIM_REPOSITORY: "campus-ai/prim" } },
        "campus-ai/prim",
      ).env,
    ).toEqual({ FOO: "1" });
    expect(
      removeRepositoryDeclaration({ env: { PRIM_REPOSITORY: "campus-ai/prim" } }, "campus-ai/prim")
        .env,
    ).toBeUndefined();
    const handWritten: ClaudeSettings = { env: { PRIM_REPOSITORY: "other/name" } };
    expect(removeRepositoryDeclaration(handWritten, "campus-ai/prim")).toBe(handWritten);
    expect(removeRepositoryDeclaration(handWritten, null)).toBe(handWritten);
  });

  it("install declares the repository origin names, never one from the environment", () => {
    vi.stubEnv("PRIM_REPOSITORY", "env-owner/env-repo");
    expect(projectSettingsAfterInstall({}, repo("git@github.com:campus-ai/prim.git")).env).toEqual({
      PRIM_REPOSITORY: "campus-ai/prim",
    });
    expect(projectSettingsAfterInstall({}, repo()).env).toBeUndefined();
    expect(
      projectSettingsAfterInstall({}, repo("https://gitlab.example.com/t/p.git")).env,
    ).toBeUndefined();
  });

  it("install with --force corrects a stale declaration from origin", () => {
    const root = repo("https://github.com/campus-ai/prim.git");
    const stale: ClaudeSettings = { env: { PRIM_REPOSITORY: "old-owner/prim" } };
    expect(projectSettingsAfterInstall(stale, root).env).toEqual({
      PRIM_REPOSITORY: "old-owner/prim",
    });
    expect(projectSettingsAfterInstall(stale, root, true).env).toEqual({
      PRIM_REPOSITORY: "campus-ai/prim",
    });
  });

  it("uninstall removes the declaration origin would write and keeps any other", () => {
    const root = repo("https://github.com/campus-ai/prim.git");
    expect(
      projectSettingsAfterUninstall({ env: { PRIM_REPOSITORY: "campus-ai/prim" } }, root).env,
    ).toBeUndefined();
    expect(
      projectSettingsAfterUninstall({ env: { PRIM_REPOSITORY: "other/name" } }, root).env,
    ).toEqual({
      PRIM_REPOSITORY: "other/name",
    });
  });
});

describe("deferToProjectInstall (cloud user-scope hooks)", () => {
  const scratch: string[] = [];
  afterEach(() => {
    for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  function tempDir(prefix: string): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    return dir;
  }
  function project(content?: string): string {
    const dir = tempDir("prim-defer-");
    if (content !== undefined) {
      mkdirSync(join(dir, ".claude"));
      writeFileSync(join(dir, ".claude", "settings.json"), content);
    }
    return dir;
  }

  /** Run a hook command to completion, detached body included (`wait`). */
  function runHook(command: string, env: NodeJS.ProcessEnv): string {
    const marker = join(tempDir("prim-defer-out-"), "ran");
    execFileSync("/bin/sh", ["-c", `${command.replaceAll("MARKER", marker)}\nwait`], {
      env: { PATH: process.env.PATH, ...env },
      input: '{"payload":true}',
    });
    try {
      return readFileSync(marker, "utf8").trim();
    } catch {
      return "skipped";
    }
  }

  const sync = deferToProjectInstall('cat > "MARKER.in"; echo ran > MARKER', "prim-hook");
  const detached = deferToProjectInstall("payload=$(cat); { echo ran > MARKER; } &", "prim-hook");
  const committed = (bin: string) =>
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: `sh -c 'x' launcher ${bin}` }] }] } });

  it.each([
    ["no project settings", undefined, "ran"],
    ["project settings without prim", '{"hooks":{}}', "ran"],
    ["a prim permission rule only", '{"permissions":{"deny":["Bash(prim-hook*)"]}}', "ran"],
    ["only prim's launcher name", '{"statusLine":{"command":"prim-hook-launcher-v1 x"}}', "ran"],
    ["a committed install of another prim hook", committed("prim-pre-tool-use"), "ran"],
    ["a committed install of this hook", committed("prim-hook"), "skipped"],
  ])("with %s, both hook forms: %s", (_label, content, expected) => {
    const env = { CLAUDE_PROJECT_DIR: project(content), HOME: "/nonexistent-home" };
    expect(runHook(sync, env)).toBe(expected);
    expect(runHook(detached, env)).toBe(expected);
  });

  it("passes the hook payload through to the body", () => {
    const marker = join(tempDir("prim-defer-out-"), "ran");
    execFileSync("/bin/sh", ["-c", sync.replaceAll("MARKER", marker)], {
      env: { PATH: process.env.PATH, CLAUDE_PROJECT_DIR: project() },
      input: '{"payload":true}',
    });
    expect(readFileSync(`${marker}.in`, "utf8")).toBe('{"payload":true}');
  });

  it("runs when Claude Code provides no project directory", () => {
    expect(runHook(sync, {})).toBe("ran");
  });

  it.each([
    ["the same path", ""],
    ["a trailing slash", "/"],
    ["a dot segment", "/."],
  ])("never defers to the user-scope file itself when the project is $HOME (%s)", (_l, suffix) => {
    const home = project(committed("prim-hook"));
    expect(runHook(sync, { CLAUDE_PROJECT_DIR: `${home}${suffix}`, HOME: home })).toBe("ran");
  });

  it("keeps wrapped registrations recognizable as prim's own and complete", () => {
    const wrapped = applyInstall(EMPTY, {
      installStatusline: false,
      wrapCommand: deferToProjectInstall,
    });
    expect(usesProjectDeferral(wrapped)).toBe(true);
    expect(isGateInstalled(wrapped)).toBe(true);
    expect(feedbackInstalled(wrapped)).toBe(true);
    expect(hasCompleteHookRegistration(wrapped)).toBe(true);
    expect(wrapped.statusLine).toBeUndefined();
    const reinstalled = applyInstall(wrapped, {
      installStatusline: false,
      wrapCommand: deferToProjectInstall,
    });
    expect(reinstalled).toEqual(wrapped);
    expect(hasBin(applyUninstall(wrapped), "PreToolUse", "prim-pre-tool-use")).toBe(false);
    expect(usesProjectDeferral(applyInstall(EMPTY, {}))).toBe(false);
  });
});
