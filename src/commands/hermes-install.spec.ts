import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { packageVersion } from "../lib/bin-path.js";
import {
  type HooksMap,
  SHIM_SCRIPT,
  applyInstall,
  applyUninstall,
  isCaptureInstalled,
  isGateInstalled,
  mergeKeepsYamlValid,
  mergePreservesHermesSemantics,
  performInstall,
  readHooks,
  spliceHooks,
  stripBin,
} from "./hermes-install.js";

const userHook = { command: "/home/u/.hermes/agent-hooks/format.sh" };
const originalHermesHome = process.env.HERMES_HOME;
let testHome: string | undefined;

afterEach(() => {
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = undefined;
  if (originalHermesHome === undefined) {
    // biome-ignore lint/performance/noDelete: env teardown requires actual removal
    delete process.env.HERMES_HOME;
  } else {
    process.env.HERMES_HOME = originalHermesHome;
  }
});

describe("applyInstall", () => {
  it("pins every hook entrypoint to this package and an exact-version fallback", () => {
    for (const path of [
      "prim-hook.js",
      "pre-tool-use.js",
      "post-tool-use.js",
      "session-start.js",
      "session-end.js",
    ]) {
      expect(SHIM_SCRIPT).toContain(path);
    }
    expect(SHIM_SCRIPT).toContain(`@primitive.ai/prim@${packageVersion()}`);
    expect(SHIM_SCRIPT).toMatch(/\[ -x '.+node' \] && \[ -f '.+prim-hook\.js' \]/);
    expect(SHIM_SCRIPT).not.toMatch(/@latest|command -v|node_modules\/\.bin/);
  });

  it("registers the gate, ingest, capture, and session hooks under --agent hermes", () => {
    const hooks = applyInstall({}, false);
    expect(isGateInstalled(hooks)).toBe(true);
    expect(isCaptureInstalled(hooks)).toBe(true);
    const gate = hooks.pre_tool_call.find((e) => e.matcher === "write_file|patch");
    expect(gate?.command).toContain("prim-pre-tool-use");
    expect(gate?.command).toContain("--agent hermes");
    expect(hooks.on_session_start.some((e) => e.command.includes("prim-session-start"))).toBe(true);
    expect(hooks.on_session_end.some((e) => e.command.includes("prim-session-end"))).toBe(true);
    expect(hooks.post_approval_response).toEqual([
      expect.objectContaining({
        command: expect.stringContaining("prim-post-tool-use --agent hermes"),
      }),
    ]);
    expect(hooks.post_approval_response[0]).not.toHaveProperty("matcher");
    // Capture rides pre_tool_call alongside the gate (two entries on that event).
    expect(hooks.pre_tool_call.some((e) => e.command.includes('prim-shim.sh" prim-hook '))).toBe(
      true,
    );
  });

  it("registers the conflict gate with the spec-mandated timeout: 10 (and no timeout on ingest)", () => {
    const hooks = applyInstall({}, false);
    expect(hooks.pre_tool_call.find((e) => e.matcher === "write_file|patch")?.timeout).toBe(10);
    expect(
      hooks.post_tool_call.find((e) => e.matcher === "write_file|patch")?.timeout,
    ).toBeUndefined();
  });

  it("double-quotes the shim path so a spaced HERMES_HOME shlex-splits to one token", () => {
    const prev = process.env.HERMES_HOME;
    process.env.HERMES_HOME = "/tmp/a b/.hermes";
    try {
      const hooks = applyInstall({}, false);
      const capture = hooks.pre_tool_call.find((e) => e.command.includes("prim-hook"));
      expect(capture?.command).toBe(
        '"/tmp/a b/.hermes/agent-hooks/prim-shim.sh" prim-hook --agent hermes',
      );
      // detection still recognizes the quoted form, so uninstall fully strips it
      expect(applyUninstall(hooks).pre_tool_call).toBeUndefined();
    } finally {
      process.env.HERMES_HOME = prev;
    }
  });

  it("is idempotent", () => {
    const once = applyInstall({}, false);
    expect(applyInstall(once, false)).toEqual(once);
  });

  it("preserves a user's non-prim hook under a shared event", () => {
    const hooks = applyInstall({ pre_tool_call: [userHook] }, false);
    expect(hooks.pre_tool_call).toContainEqual(userHook);
    expect(isGateInstalled(hooks)).toBe(true);
  });

  it("replaces a drifted prim entry under --force without duplicating it", () => {
    const drifted: HooksMap = {
      pre_tool_call: [
        {
          matcher: "write_file|patch",
          command: "/old/agent-hooks/prim-shim.sh prim-pre-tool-use --agent hermes",
        },
      ],
    };
    const hooks = applyInstall(drifted, true);
    const gates = hooks.pre_tool_call.filter((e) => e.command.includes("prim-pre-tool-use"));
    expect(gates).toHaveLength(1);
  });
});

describe("applyUninstall", () => {
  it("strips every prim hook, drops emptied events, and keeps non-prim", () => {
    const installed = applyInstall({ pre_tool_call: [userHook] }, false);
    const after = applyUninstall(installed);
    expect(isGateInstalled(after)).toBe(false);
    expect(isCaptureInstalled(after)).toBe(false);
    expect(after.pre_tool_call).toEqual([userHook]);
    expect(after.on_session_start).toBeUndefined();
  });
});

describe("readHooks", () => {
  it("reads the hooks map, ignoring malformed entries and non-list events", () => {
    const doc = parseDocument(
      [
        "model:",
        "  default: gpt-4",
        "hooks:",
        "  pre_tool_call:",
        "    - command: /x/agent-hooks/prim-shim.sh prim-pre-tool-use --agent hermes",
        "      matcher: write_file|patch",
        "    - notcommand: nope",
        "  bad: not-a-list",
      ].join("\n"),
    );
    const hooks = readHooks(doc);
    expect(hooks.pre_tool_call).toHaveLength(1);
    expect(hooks.bad).toBeUndefined();
  });

  it("preserves foreign top-level keys when the hooks node is rewritten", () => {
    const doc = parseDocument("model:\n  default: gpt-4\nhooks: {}\n");
    doc.set("hooks", applyInstall(readHooks(doc), false));
    const out = doc.toString();
    expect(out).toContain("model:");
    expect(out).toContain("default: gpt-4");
    expect(out).toContain("write_file|patch");
  });
});

describe("stripBin", () => {
  it("removes only entries that route through the bin", () => {
    const list = [{ command: "/x/agent-hooks/prim-shim.sh prim-hook --agent hermes" }, userHook];
    expect(stripBin(list, "prim-hook")).toEqual([userHook]);
  });
});

describe("spliceHooks (byte-preserving)", () => {
  // A hand-formatted config with a long single-line value that a document
  // re-serialize would re-wrap at 80 columns; trailing newline included.
  const userConfig = [
    "# my config",
    "model:",
    "  default: gpt-4",
    "  prompt: a deliberately long single-line system prompt that a document re-serialize would rewrap at eighty columns and churn the file",
    "",
  ].join("\n");

  it("appends the hooks block, leaving the rest of the file byte-for-byte", () => {
    const out = spliceHooks(userConfig, applyInstall({}, false));
    expect(out.startsWith(userConfig)).toBe(true);
    expect(out).toContain("hooks:");
    expect(out).toContain("write_file|patch");
  });

  it("round-trips to byte-identical when the hooks block is removed", () => {
    const installed = spliceHooks(userConfig, applyInstall({}, false));
    const removed = spliceHooks(installed, applyUninstall(applyInstall({}, false)));
    expect(removed).toBe(userConfig);
  });

  it("rewrites only the hooks region when a hooks block already exists mid-file", () => {
    const withHooks = [
      "a: 1",
      "hooks:",
      "  pre_tool_call:",
      "    - command: /old/x",
      "z: 2",
      "",
    ].join("\n");
    const out = spliceHooks(withHooks, applyInstall(readHooks(parseDocument(withHooks)), true));
    expect(out.startsWith("a: 1\n")).toBe(true);
    expect(out).toContain("z: 2");
    expect(out).toContain("prim-pre-tool-use");
  });

  it("does not corrupt the file when a column-0 comment sits inside the hooks block", () => {
    const cfg = [
      "model:",
      "  default: gpt-4",
      "hooks:",
      "  pre_tool_call:",
      "    - command: /my/own.sh",
      "# a stray column-0 comment inside the hooks mapping",
      "  post_tool_call:",
      "    - command: /my/post.sh",
      "telemetry: on",
      "",
    ].join("\n");
    const out = spliceHooks(cfg, applyInstall(readHooks(parseDocument(cfg)), false));
    // Valid YAML — no duplicate event key, no orphaned post-comment children.
    expect(parseDocument(out).errors).toHaveLength(0);
    // Foreign top-level keys on BOTH sides of the hooks block survive.
    expect(out).toContain("model:");
    expect(out).toContain("telemetry: on");
    // The user's own hooks under shared events survive.
    expect(out).toContain("/my/own.sh");
    expect(out).toContain("/my/post.sh");
  });

  it("preserves comments and malformed foreign entries inside the hooks block", () => {
    const cfg = [
      "model: gpt-4",
      "hooks:",
      "  # user-owned formatter event",
      "  pre_tool_call:",
      "    # keep this formatter",
      "    - command: /my/format.sh # inline formatter note",
      "    - notcommand: keep-this-too # unsupported but user-owned",
      "    # replace this managed entry without dropping nearby user data",
      "    - command: /old/agent-hooks/prim-shim.sh prim-pre-tool-use --agent hermes",
      "telemetry: on",
      "",
    ].join("\n");

    const desired = applyInstall(readHooks(parseDocument(cfg)), true);
    const out = spliceHooks(cfg, desired);

    expect(out).toContain("# user-owned formatter event");
    expect(out).toContain("# keep this formatter");
    expect(out).toContain("# inline formatter note");
    expect(out).toContain("notcommand: keep-this-too # unsupported but user-owned");
    expect(out).toContain("# replace this managed entry without dropping nearby user data");
    expect(out).toContain("telemetry: on");
    expect(readHooks(parseDocument(out))).toEqual(desired);
  });

  it("refuses to overwrite a user-owned non-list event", () => {
    const cfg = "hooks:\n  pre_tool_call: /my/custom-dispatcher.sh\n";
    const desired = applyInstall(readHooks(parseDocument(cfg)), false);
    expect(() => spliceHooks(cfg, desired)).toThrow("non-list event");
  });

  it("preserves user hook comments while removing managed entries", () => {
    const cfg = [
      "hooks:",
      "  pre_tool_call:",
      "    # user formatter survives uninstall",
      "    - command: /my/format.sh # keep inline note",
      "    - command: /old/agent-hooks/prim-shim.sh prim-pre-tool-use --agent hermes",
      "model: gpt-4",
      "",
    ].join("\n");
    const remaining = applyUninstall(readHooks(parseDocument(cfg)));
    const out = spliceHooks(cfg, remaining);

    expect(out).toContain("# user formatter survives uninstall");
    expect(out).toContain("# keep inline note");
    expect(out).toContain("/my/format.sh");
    expect(out).not.toContain("prim-pre-tool-use");
    expect(readHooks(parseDocument(out))).toEqual(remaining);
  });
});

describe("mergeKeepsYamlValid", () => {
  it("accepts a clean splice", () => {
    expect(mergeKeepsYamlValid("model: a\n", "model: a\nhooks:\n  x:\n    - command: y\n")).toBe(
      true,
    );
  });

  it("does not flag a pre-existing duplicate top-level key (PyYAML reads it last-wins)", () => {
    const dup = "model: a\nmodel: b\n";
    expect(mergeKeepsYamlValid(dup, `${dup}hooks:\n  x:\n    - command: y\n`)).toBe(true);
  });

  it("flags a splice that INTRODUCES a new duplicate key", () => {
    expect(
      mergeKeepsYamlValid(
        "hooks:\n  a:\n    - command: y\n",
        "hooks:\n  a:\n    - command: y\nhooks:\n  a:\n    - command: z\n",
      ),
    ).toBe(false);
  });
});

describe("mergePreservesHermesSemantics", () => {
  it("rejects valid YAML that silently omits a requested hook", () => {
    const before = "model: gpt-4\n";
    const expected = applyInstall({}, false);
    expect(mergeKeepsYamlValid(before, before)).toBe(true);
    expect(mergePreservesHermesSemantics(before, before, expected)).toBe(false);
  });
});

describe("performInstall", () => {
  it("atomically writes the config and executable shim without churning user comments", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-install-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    writeFileSync(
      config,
      "# user header\nmodel: gpt-4\nhooks:\n  pre_tool_call:\n    # formatter\n    - command: /my/format.sh\n",
    );

    const result = performInstall({ force: false, autoAccept: false });
    const written = readFileSync(config, "utf8");
    const shim = join(testHome, "agent-hooks", "prim-shim.sh");

    expect(result.changed).toBe(true);
    expect(written).toContain("# user header");
    expect(written).toContain("# formatter");
    expect(written).toContain("/my/format.sh");
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o777).toBe(0o755);
  });
});
