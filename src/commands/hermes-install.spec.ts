import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { stableHookCommand } from "../lib/bin-path.js";
import {
  type HooksMap,
  applyInstall,
  applyUninstall,
  hasAnyHookRegistration,
  hasCompleteHookRegistration,
  hookRuntimeResolutions,
  isCaptureInstalled,
  isGateInstalled,
  mergeKeepsYamlValid,
  mergePreservesHermesSemantics,
  performInstall,
  performUninstall,
  readHooks,
  spliceHooks,
  stripBin,
  writeHermesConfigSnapshot,
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
  it("keeps stable commands removable by the frozen pre-launcher Hermes reader", () => {
    const legacyReaderUsesBin = (command: string, bin: string): boolean =>
      new RegExp(`prim-shim\\.sh"?\\s+${bin}\\s`).test(command);
    for (const bin of [
      "prim-hook",
      "prim-pre-tool-use",
      "prim-post-tool-use",
      "prim-session-start",
      "prim-session-end",
    ]) {
      expect(legacyReaderUsesBin(stableHookCommand(bin, "--agent hermes"), bin)).toBe(true);
    }
  });

  it("routes every hook through the byte-stable owner-only launcher", () => {
    const hooks = applyInstall({}, false);
    for (const entries of Object.values(hooks)) {
      for (const entry of entries) {
        expect(entry.command).toContain("prim-hook-launcher-v1");
        expect(entry.command).not.toMatch(/@latest|command -v|node_modules\/\.bin|npx/);
      }
    }
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
    expect(
      hooks.pre_tool_call.some(
        (e) => e.command === stableHookCommand("prim-hook", "--agent hermes"),
      ),
    ).toBe(true);
  });

  it("registers the conflict gate with the spec-mandated timeout: 10 (and no timeout on ingest)", () => {
    const hooks = applyInstall({}, false);
    expect(hooks.pre_tool_call.find((e) => e.matcher === "write_file|patch")?.timeout).toBe(10);
    expect(
      hooks.post_tool_call.find((e) => e.matcher === "write_file|patch")?.timeout,
    ).toBeUndefined();
  });

  it("keeps command bytes independent of a spaced HERMES_HOME", () => {
    const prev = process.env.HERMES_HOME;
    process.env.HERMES_HOME = "/tmp/a b/.hermes";
    try {
      const hooks = applyInstall({}, false);
      const capture = hooks.pre_tool_call.find((e) => e.command.includes("prim-hook"));
      expect(capture?.command).toBe(stableHookCommand("prim-hook", "--agent hermes"));
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

  it("requires every lifecycle entry with its exact matcher and timeout", () => {
    const installed = applyInstall({}, false);
    expect(hasCompleteHookRegistration(installed)).toBe(true);

    const missingLifecycle = structuredClone(installed);
    missingLifecycle.on_session_end?.splice(1, 1);
    expect(hasAnyHookRegistration(missingLifecycle)).toBe(true);
    expect(hasCompleteHookRegistration(missingLifecycle)).toBe(false);

    const driftedTimeout = structuredClone(installed);
    const gate = driftedTimeout.pre_tool_call?.find((entry) =>
      entry.command.includes("prim-pre-tool-use"),
    );
    if (!gate) throw new Error("Expected Hermes gate registration");
    gate.timeout = 11;
    expect(hasCompleteHookRegistration(driftedTimeout)).toBe(false);

    process.env.HERMES_HOME = "/tmp/.hermes";
    const legacy = {
      pre_tool_call: [
        {
          command: '"/tmp/.hermes/agent-hooks/prim-shim.sh" prim-pre-tool-use --agent hermes',
        },
      ],
    };
    expect(hookRuntimeResolutions(legacy)).toContainEqual({ kind: "legacy_path" });
  });

  it("preserves a user's non-prim hook under a shared event", () => {
    const hooks = applyInstall({ pre_tool_call: [userHook] }, false);
    expect(hooks.pre_tool_call).toContainEqual(userHook);
    expect(isGateInstalled(hooks)).toBe(true);
  });

  it("keeps a foreign same-shape shim under --force and adds the owned entry", () => {
    const foreign: HooksMap = {
      pre_tool_call: [
        {
          matcher: "write_file|patch",
          command: "/home/u/tools/agent-hooks/prim-shim.sh prim-pre-tool-use --agent hermes",
        },
      ],
    };
    const hooks = applyInstall(foreign, true);
    const gates = hooks.pre_tool_call.filter((e) => e.command.includes("prim-pre-tool-use"));
    expect(gates).toHaveLength(2);
    expect(gates).toContainEqual(foreign.pre_tool_call[0]);
    expect(gates.some((entry) => entry.command !== foreign.pre_tool_call[0].command)).toBe(true);
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
    const owned = applyInstall({}, false).pre_tool_call.find((entry) =>
      entry.command.includes("prim-hook"),
    );
    expect(owned).toBeDefined();
    const list = [owned as { command: string }, userHook];
    expect(stripBin(list, "prim-hook")).toEqual([userHook]);
  });

  it("does not claim a user script that only shares the prim-shim filename", () => {
    const lookalike = { command: "/home/u/tools/prim-shim.sh prim-hook --agent hermes" };
    expect(stripBin([lookalike], "prim-hook")).toEqual([lookalike]);
  });

  it("does not claim a foreign shim with the exact agent-hooks path suffix", () => {
    const foreign = {
      command: "/home/u/tools/agent-hooks/prim-shim.sh prim-hook --agent hermes",
    };
    expect(stripBin([foreign], "prim-hook")).toEqual([foreign]);
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

  it("preserves anchors, aliases outside hooks, unknown fields, and event order", () => {
    const cfg = [
      "provider: &provider",
      '  model: "gpt-4"',
      "hooks:",
      "  custom_event: [] # user-owned empty event",
      "  pre_tool_call:",
      "    # anchored user formatter",
      "    - &formatter",
      '      command: "/my/format.sh"',
      '      custom: { style: "strict" } # unknown field',
      "formatter_copy: *formatter",
      "provider_copy: *provider",
      "",
    ].join("\n");

    const desired = applyInstall(readHooks(parseDocument(cfg)), false);
    const out = spliceHooks(cfg, desired);
    const parsed = parseDocument(out);
    const value = parsed.toJS() as Record<string, Record<string, unknown>>;

    expect(parsed.errors).toHaveLength(0);
    expect(out).toContain("custom_event: [] # user-owned empty event");
    expect(out).toContain("# anchored user formatter");
    expect(out).toContain("&formatter");
    expect(out).toContain("formatter_copy: *formatter");
    expect(out).toContain('custom: { style: "strict" } # unknown field');
    expect(out.indexOf("custom_event:")).toBeLessThan(out.indexOf("pre_tool_call:"));
    expect(out.indexOf("pre_tool_call:")).toBeLessThan(out.indexOf("on_session_start:"));
    expect(value.formatter_copy.command).toBe("/my/format.sh");
    expect(value.provider_copy.model).toBe("gpt-4");
  });

  it("preserves CRLF outside and inside the rewritten hooks block", () => {
    const cfg = "model: gpt-4\r\nhooks:\r\n  pre_tool_call:\r\n    - command: /my/hook.sh\r\n";
    const desired = applyInstall(readHooks(parseDocument(cfg)), false);
    const out = spliceHooks(cfg, desired);

    expect(out.replaceAll("\r\n", "")).not.toContain("\n");
    expect(out).toContain("model: gpt-4\r\nhooks:\r\n");
  });

  it("refuses to overwrite a user-owned non-list event", () => {
    const cfg = "hooks:\n  pre_tool_call: /my/custom-dispatcher.sh\n";
    const desired = applyInstall(readHooks(parseDocument(cfg)), false);
    expect(() => spliceHooks(cfg, desired)).toThrow("non-list event");
  });

  it("preserves user hook comments while removing managed entries", () => {
    const managed = applyInstall({}, false).pre_tool_call.find((entry) =>
      entry.command.includes("prim-pre-tool-use"),
    );
    expect(managed).toBeDefined();
    const cfg = [
      "hooks:",
      "  pre_tool_call:",
      "    # user formatter survives uninstall",
      "    - command: /my/format.sh # keep inline note",
      `    - command: ${JSON.stringify(managed?.command)}`,
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

  it("keeps comments attached to the next key when the managed hooks block is removed", () => {
    const managed = spliceHooks("", applyInstall({}, false));
    const cfg = `${managed}# telemetry belongs to the next key\ntelemetry: on\n`;
    const out = spliceHooks(cfg, applyUninstall(readHooks(parseDocument(cfg))));

    expect(out).toBe("# telemetry belongs to the next key\ntelemetry: on\n");
  });
});

describe("mergeKeepsYamlValid", () => {
  it("accepts a clean splice", () => {
    expect(mergeKeepsYamlValid("model: a\n", "model: a\nhooks:\n  x:\n    - command: y\n")).toBe(
      true,
    );
  });

  it("rejects a pre-existing duplicate top-level key instead of guessing last-wins semantics", () => {
    const dup = "model: a\nmodel: b\n";
    expect(mergeKeepsYamlValid(dup, `${dup}hooks:\n  x:\n    - command: y\n`)).toBe(false);
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
  it("atomically writes config, removes the legacy shim, and preserves user comments", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-install-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    const shim = join(testHome, "agent-hooks", "prim-shim.sh");
    writeFileSync(
      config,
      [
        "# user header",
        "model: gpt-4",
        "hooks:",
        "  pre_tool_call:",
        "    # formatter",
        "    - command: /my/format.sh",
        `    - command: '"${shim}" prim-pre-tool-use --agent hermes'`,
        "",
      ].join("\n"),
    );
    mkdirSync(join(testHome, "agent-hooks"));
    writeFileSync(shim, "legacy", { mode: 0o755 });

    let stageCalls = 0;
    const result = performInstall({
      force: false,
      autoAccept: false,
      stageRuntime: () => {
        stageCalls += 1;
      },
    });
    const written = readFileSync(config, "utf8");

    expect(result.changed).toBe(true);
    expect(written).toContain("# user header");
    expect(written).toContain("# formatter");
    expect(written).toContain("/my/format.sh");
    expect(written).toContain("prim-hook-launcher-v1");
    expect(written).not.toContain(`"${shim}" prim-pre-tool-use --agent hermes`);
    expect(stageCalls).toBe(1);
    expect(existsSync(shim)).toBe(false);
  });

  it("is byte-idempotent and preserves the existing config mode", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-install-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    writeFileSync(config, "# owned by user\nmodel: gpt-4\n");
    chmodSync(config, 0o640);

    const first = performInstall({
      force: false,
      autoAccept: false,
      stageRuntime: () => undefined,
    });
    const once = readFileSync(config, "utf8");
    const second = performInstall({
      force: false,
      autoAccept: false,
      stageRuntime: () => undefined,
    });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(readFileSync(config, "utf8")).toBe(once);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    expect(readdirSync(testHome).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("changes trust only when requested and preserves its inline comment and CRLF style", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-auto-accept-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    writeFileSync(config, "model: gpt-4\r\nhooks_auto_accept: false # user policy\r\n");

    const withoutFlag = performInstall({
      force: false,
      autoAccept: false,
      stageRuntime: () => undefined,
    });
    expect(withoutFlag.autoAccept).toBe(false);
    expect(readFileSync(config, "utf8")).toContain("hooks_auto_accept: false # user policy\r\n");

    const withFlag = performInstall({
      force: false,
      autoAccept: true,
      stageRuntime: () => undefined,
    });
    const written = readFileSync(config, "utf8");
    expect(withFlag.autoAccept).toBe(true);
    expect(written).toContain("hooks_auto_accept: true # user policy\r\n");
    expect(written.replaceAll("\r\n", "")).not.toContain("\n");
  });

  it.each([
    ["multi-document", "model: first\n---\nmodel: second\n", "found 2 documents"],
    ["malformed", "hooks:\n  pre_tool_call: [\n", "must be valid, single-document YAML"],
    [
      "alias inside hooks",
      "entries: &entries\n  - command: /my/hook.sh\nhooks:\n  pre_tool_call: *entries\n",
      "Hermes hook aliases are not supported",
    ],
  ])("leaves %s input and the shim untouched", (_name, raw, message) => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-invalid-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    const shim = join(testHome, "agent-hooks", "prim-shim.sh");
    writeFileSync(config, raw);

    expect(() =>
      performInstall({ force: false, autoAccept: false, stageRuntime: () => undefined }),
    ).toThrow(message);
    expect(readFileSync(config, "utf8")).toBe(raw);
    expect(existsSync(shim)).toBe(false);
  });
});

describe("Hermes config commit safety", () => {
  it("rejects an already-observed stale snapshot and cleans the temporary file", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-concurrent-"));
    const config = join(testHome, "config.yaml");
    const original = "model: original\n";
    writeFileSync(config, original);
    const desired = applyInstall({}, false);
    const after = spliceHooks(original, desired);
    const snapshot = {
      exists: true,
      mode: statSync(config).mode & 0o777,
      raw: original,
    };
    const concurrent = "# concurrent user edit\nmodel: newer\n";
    writeFileSync(config, concurrent);

    expect(() => writeHermesConfigSnapshot(config, snapshot, after, desired)).toThrow(
      "Hermes config changed during update",
    );
    expect(readFileSync(config, "utf8")).toBe(concurrent);
    expect(readdirSync(testHome)).toEqual(["config.yaml"]);
  });

  it("does not overwrite a concurrent permission change", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-concurrent-mode-"));
    const config = join(testHome, "config.yaml");
    const original = "model: original\n";
    writeFileSync(config, original);
    chmodSync(config, 0o600);
    const desired = applyInstall({}, false);
    const snapshot = { exists: true, mode: 0o600, raw: original };
    chmodSync(config, 0o640);

    expect(() =>
      writeHermesConfigSnapshot(config, snapshot, spliceHooks(original, desired), desired),
    ).toThrow("Hermes config changed during update");
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(statSync(config).mode & 0o777).toBe(0o640);
  });

  it("keeps the old target intact when flushed temporary content fails validation", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-partial-"));
    const config = join(testHome, "config.yaml");
    const original = "model: original\n";
    writeFileSync(config, original);
    const snapshot = {
      exists: true,
      mode: statSync(config).mode & 0o777,
      raw: original,
    };

    expect(() =>
      writeHermesConfigSnapshot(config, snapshot, "model: changed\n", applyInstall({}, false)),
    ).toThrow("merge would change unrelated Hermes config");
    expect(readFileSync(config, "utf8")).toBe(original);
    expect(readdirSync(testHome)).toEqual(["config.yaml"]);
  });
});

describe("performUninstall", () => {
  it("removes only owned entries and keeps empty events, lookalikes, comments, and trust policy", () => {
    testHome = mkdtempSync(join(tmpdir(), "prim-hermes-uninstall-"));
    process.env.HERMES_HOME = testHome;
    const config = join(testHome, "config.yaml");
    writeFileSync(
      config,
      [
        "hooks:",
        "  custom_event: [] # user-owned empty event",
        "  pre_tool_call:",
        "    # unrelated same-name shim",
        "    - command: /home/u/tools/agent-hooks/prim-shim.sh prim-hook --agent hermes",
        "hooks_auto_accept: true # user trust policy",
        "",
      ].join("\n"),
    );
    performInstall({ force: false, autoAccept: false, stageRuntime: () => undefined });
    const shim = join(testHome, "agent-hooks", "prim-shim.sh");
    expect(existsSync(shim)).toBe(false);

    const result = performUninstall();
    const written = readFileSync(config, "utf8");

    expect(result.changed).toBe(true);
    expect(result.gate).toBe(false);
    expect(result.capture).toBe(false);
    expect(written).toContain("custom_event: [] # user-owned empty event");
    expect(written).toContain("# unrelated same-name shim");
    expect(written).toContain("/home/u/tools/agent-hooks/prim-shim.sh prim-hook --agent hermes");
    expect(written).toContain("hooks_auto_accept: true # user trust policy");
    expect(written).not.toContain('/agent-hooks/prim-shim.sh" prim-');
    expect(existsSync(shim)).toBe(false);
  });
});
