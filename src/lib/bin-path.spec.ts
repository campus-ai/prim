/**
 * `bin-path` coverage — bin resolution and exact-version runtime commands.
 *
 * Runs against the `src/` layout (no build needed): locateRoot walks up to the
 * repo's own package.json, so binFile returns paths under the real `dist/` tree
 * as declared in the `bin` map — including the stem mismatches a naive
 * `name + ".js"` would get wrong.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binFile,
  commandMatchesBin,
  detachedHookShimCommand,
  hookCommandResolution,
  hookCommandResolutions,
  packageVersion,
  pinnedHookCommand,
  pinnedNpxArgs,
  pinnedNpxCommand,
  stableHookCommand,
} from "./bin-path.js";

describe("binFile", () => {
  it("resolves the daemon server to an absolute dist path", () => {
    const file = binFile("prim-daemon-server");
    expect(file).not.toBeNull();
    expect(isAbsolute(file as string)).toBe(true);
    expect(file).toMatch(/\/dist\/daemon\/server\.js$/);
  });

  it("honors the bin-map stem mismatches (bin name != filename)", () => {
    expect(binFile("prim-pre-tool-use")).toMatch(/\/dist\/hooks\/pre-tool-use\.js$/);
    expect(binFile("prim-hook")).toMatch(/\/dist\/hooks\/prim-hook\.js$/);
  });

  it("returns null for an unknown bin", () => {
    expect(binFile("prim-nonesuch")).toBeNull();
  });
});

describe("pinned npx runtime", () => {
  it("centralizes the exact package, lifecycle-script guard, and argv", () => {
    expect(pinnedNpxArgs("prim", ["daemon", "ensure"], { preferOnline: true })).toEqual([
      "--yes",
      "--ignore-scripts",
      "--prefer-online",
      "-p",
      `@primitive.ai/prim@${packageVersion()}`,
      "prim",
      "daemon",
      "ensure",
    ]);
    expect(pinnedNpxCommand("prim-post-commit")).toBe(
      `npx --yes --ignore-scripts -p @primitive.ai/prim@${packageVersion()} prim-post-commit`,
    );
    expect(pinnedNpxCommand("prim-post-commit")).not.toContain("@latest");
  });

  it("keeps every generated unattended fallback exact-version and script-free", () => {
    const commands = [
      pinnedNpxCommand("prim-post-commit"),
      pinnedNpxCommand("prim-post-rewrite"),
      pinnedHookCommand("prim-pre-tool-use", "--agent codex"),
    ];
    for (const command of commands) {
      expect(command).toContain(`@primitive.ai/prim@${packageVersion()}`);
      expect(command).toContain("--ignore-scripts");
      expect(command).not.toContain("@latest");
    }
    expect(detachedHookShimCommand("prim-hook", "--agent codex")).not.toMatch(
      /@latest|\bnpx\b|command -v|node_modules/u,
    );
  });
});

describe("pinnedHookCommand", () => {
  it("uses this package entrypoint with an exact-version npx fallback", () => {
    const command = pinnedHookCommand("prim-pre-tool-use", "--agent codex");
    expect(command).toContain("dist/hooks/pre-tool-use.js");
    expect(command).toContain(`@primitive.ai/prim@${packageVersion()}`);
    expect(command).not.toContain("@latest");
    expect(command).toContain("--ignore-scripts");
    expect(command).not.toContain("command -v prim-pre-tool-use");
    expect(command).toMatch(/\[ -x '.+node' \] && \[ -f '.+pre-tool-use\.js' \]/);
    expect(command).toContain("--agent codex");
    expect(commandMatchesBin(command, "prim-pre-tool-use")).toBe(true);
  });
});

describe("stableHookCommand", () => {
  // Frozen from the #242 reader. This is deliberately not imported from
  // product code: the regression proves old-reader -> new-writer compatibility.
  const legacyCommandMatchesBin = (command: string, bin: string): boolean => {
    const c = command.trim();
    if (c === bin || c.startsWith(`${bin} `)) return true;
    const exactBin = new RegExp(
      `(?:^|\\s)${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|;|$)`,
    );
    return (
      c.includes(`command -v ${bin} `) || (c.includes("-p @primitive.ai/prim@") && exactBin.test(c))
    );
  };

  it("is byte-stable and contains no machine, version, PATH, or lifecycle-script resolver", () => {
    const command = stableHookCommand("prim-pre-tool-use", "--agent codex");
    expect(command).toContain("/bin/sh -c");
    expect(command).toContain("prim-hook-launcher-v1");
    expect(command).toContain("prim-pre-tool-use --agent codex");
    expect(command).not.toContain(process.execPath);
    expect(command).not.toContain(packageVersion());
    expect(command).not.toMatch(/\bnpx\b|@latest|command -v|node_modules|ignore-scripts/u);
    expect(commandMatchesBin(command, "prim-pre-tool-use")).toBe(true);
  });

  it("remains removable by the frozen #242 reader during a rolling upgrade", () => {
    for (const bin of [
      "prim-hook",
      "prim-pre-tool-use",
      "prim-post-tool-use",
      "prim-session-start",
      "prim-session-end",
      "prim-statusline",
    ]) {
      expect(legacyCommandMatchesBin(stableHookCommand(bin), bin)).toBe(true);
    }
  });

  it("rejects shell metacharacters in the closed installer-owned argv", () => {
    expect(() => stableHookCommand("prim-hook; touch /tmp/nope")).toThrow(
      "invalid stable hook command",
    );
    expect(() => stableHookCommand("prim-hook", "--agent codex; false")).toThrow(
      "invalid stable hook command",
    );
  });

  it("fails closed without a canonical absolute config root", () => {
    const command = stableHookCommand("prim-hook");
    expect(spawnSync("/bin/sh", ["-c", command], { env: {} }).status).toBe(78);
    expect(spawnSync("/bin/sh", ["-c", command], { env: { HOME: "relative" } }).status).toBe(78);
    expect(spawnSync("/bin/sh", ["-c", command], { env: { HOME: "/home/../other" } }).status).toBe(
      78,
    );
  });

  it("matches the Node resolver for whitespace and noncanonical overrides", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-stable-root-"));
    try {
      const home = join(root, "home");
      const config = join(home, ".config", "prim");
      const launcher = join(config, "prim-hook-launcher-v1");
      mkdirSync(config, { recursive: true });
      writeFileSync(launcher, "#!/bin/sh\nprintf fallback\n", { mode: 0o700 });
      const result = spawnSync("/bin/sh", ["-c", stableHookCommand("prim-hook")], {
        env: {
          HOME: home,
          PRIM_CONFIG_DIR: ` ${join(root, "explicit")} `,
          XDG_CONFIG_HOME: `${join(root, "xdg")}/../other`,
        },
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("fallback");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("detachedHookShimCommand", () => {
  it("embeds the pinned launcher inside the detached template", () => {
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).toContain(`| { ${stableHookCommand("prim-hook")}; }`);
    expect(cmd).not.toContain("@latest");
  });

  it("captures stdin before backgrounding and pipes it back", () => {
    // A plain backgrounded chain gets /dev/null stdin (POSIX) and would
    // silently drop the envelope — the capture-then-pipe is load-bearing.
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd.startsWith("payload=$(cat); ")).toBe(true);
    expect(cmd).toContain(`printf '%s' "$payload" |`);
  });

  it("puts the redirections and & on the outermost group", () => {
    // If anything in the detached tree inherited the hook's stdout/stderr
    // pipes, Claude Code would wait for pipe EOF and the detach would
    // silently not detach.
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd.endsWith("} </dev/null >/dev/null 2>&1 &")).toBe(true);
  });

  it("ignores SIGHUP on the exec'd branches and stays a single line", () => {
    // SIG_IGN survives fork+exec (PATH / node_modules branches) but NOT the
    // npx branch — Node/libuv resets spawned children to SIG_DFL. See the
    // docblock's accepted-residual note.
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).toContain("trap '' HUP;");
    expect(cmd).not.toContain("\n");
  });

  it("never performs a package-manager or PATH lookup in the detached branch", () => {
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).not.toMatch(/\bnpx\b|npm_config_|command -v|node_modules/u);
  });

  it("threads args through the embedded shim", () => {
    const cmd = detachedHookShimCommand("prim-hook", "--agent codex");
    expect(cmd).toContain(`| { ${stableHookCommand("prim-hook", "--agent codex")}; }`);
  });

  it.skipIf(process.platform === "win32")(
    "exits immediately and still delivers the payload to the detached bin",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "prim-detach-"));
      const outFile = join(dir, "out.json");
      try {
        // Stub the stable launcher: sleep, then persist stdin.
        // Write-then-rename so the exists-poll below never observes the file
        // in its exists-but-empty window between open() and cat's write.
        writeFileSync(
          join(dir, "prim-hook-launcher-v1"),
          `#!/bin/sh\n/bin/sleep 1\n/bin/cat > "$STUB_OUT.tmp" && /bin/mv "$STUB_OUT.tmp" "$STUB_OUT"\n`,
        );
        chmodSync(join(dir, "prim-hook-launcher-v1"), 0o755);
        const payload = '{"hook_event_name":"SessionEnd","session_id":"s-1","cwd":"/tmp"}';
        const started = performance.now();
        // spawnSync blocks on pipe EOF as well as exit, so the elapsed budget
        // alone regression-guards the redirect placement: without the
        // outermost /dev/null redirects it blocks for the stub's full sleep.
        const res = spawnSync("sh", ["-c", detachedHookShimCommand("prim-hook")], {
          input: payload,
          env: { ...process.env, PRIM_CONFIG_DIR: dir, STUB_OUT: outFile },
          timeout: 5000,
        });
        const elapsed = performance.now() - started;
        expect(res.status).toBe(0);
        expect(elapsed).toBeLessThan(750);
        const deadline = Date.now() + 5000;
        while (!existsSync(outFile) && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(readFileSync(outFile, "utf-8")).toBe(payload);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("canonical command strings (golden)", () => {
  // These pin the EXACT bytes each generator writes into settings.json.
  // ensureRegistration keys idempotence on full-string equality, so ANY
  // change to either template — however harmless it looks — is a
  // settings.json migration: every installed entry becomes non-canonical and
  // is rewritten on the next install, and any older CLI re-running install
  // rewrites it back (form ping-pong in a committed project file). The
  // fragment tests above explain WHY each piece exists; these goldens make
  // changing the bytes a deliberate act.
  it("pins the detached wrapper byte-for-byte", () => {
    expect(detachedHookShimCommand("prim-hook")).toBe(
      `payload=$(cat); { trap '' HUP; printf '%s' "$payload" | { ${stableHookCommand("prim-hook")}; }; } </dev/null >/dev/null 2>&1 &`,
    );
  });
});

describe("commandMatchesBin", () => {
  it("matches the legacy bare form, with or without args", () => {
    expect(commandMatchesBin("prim-hook", "prim-hook")).toBe(true);
    expect(commandMatchesBin("prim-hook --agent codex", "prim-hook")).toBe(true);
  });

  it("matches a legacy ladder already written to settings", () => {
    const legacy =
      "if command -v prim-hook >/dev/null 2>&1; then prim-hook; " +
      "else npx --yes -p @primitive.ai/prim@latest prim-hook; fi";
    expect(commandMatchesBin(legacy, "prim-hook")).toBe(true);
  });

  it("matches the current exact-version pinned form", () => {
    expect(commandMatchesBin(pinnedHookCommand("prim-hook"), "prim-hook")).toBe(true);
    expect(commandMatchesBin(pinnedHookCommand("prim-hook", "--agent codex"), "prim-hook")).toBe(
      true,
    );
  });

  it("matches the stable launcher form", () => {
    expect(commandMatchesBin(stableHookCommand("prim-hook"), "prim-hook")).toBe(true);
    expect(commandMatchesBin(stableHookCommand("prim-hook", "--agent codex"), "prim-hook")).toBe(
      true,
    );
  });

  it("matches the detached form", () => {
    expect(commandMatchesBin(detachedHookShimCommand("prim-hook"), "prim-hook")).toBe(true);
    expect(commandMatchesBin(detachedHookShimCommand("prim-session-end"), "prim-session-end")).toBe(
      true,
    );
  });

  it("does not cross-match a sibling bin", () => {
    expect(commandMatchesBin(pinnedHookCommand("prim-post-tool-use"), "prim-pre-tool-use")).toBe(
      false,
    );
    expect(commandMatchesBin("prim-post-tool-use", "prim-pre-tool-use")).toBe(false);
    // Diverging bin names can never collide on the `command -v <bin> ` token…
    expect(
      commandMatchesBin(detachedHookShimCommand("prim-session-end"), "prim-session-start"),
    ).toBe(false);
    // …and the token's trailing space is what keeps "prim" (the statusline
    // bin, a true prefix of every hook bin) from cross-matching a hook shim.
    expect(commandMatchesBin(detachedHookShimCommand("prim-hook"), "prim")).toBe(false);
  });

  it("does not match a foreign command or undefined", () => {
    expect(commandMatchesBin("/usr/local/bin/other", "prim-hook")).toBe(false);
    expect(commandMatchesBin(undefined, "prim-hook")).toBe(false);
  });
});

describe("hookCommandResolution", () => {
  it("distinguishes stable launchers, exact script-free npx fallbacks, and bare PATH hooks", () => {
    expect(hookCommandResolution(stableHookCommand("prim-hook"), "prim-hook")).toEqual({
      kind: "stable_launcher",
    });
    expect(hookCommandResolution(pinnedHookCommand("prim-hook"), "prim-hook")).toEqual({
      kind: "exact_npx_fallback",
      version: packageVersion(),
    });
    expect(hookCommandResolution("prim-hook --agent codex", "prim-hook")).toEqual({
      kind: "legacy_path",
    });
    expect(
      hookCommandResolution(
        "if command -v prim-hook >/dev/null 2>&1; then prim-hook; else npx --yes -p @primitive.ai/prim@latest prim-hook; fi",
        "prim-hook",
      ),
    ).toEqual({ kind: "legacy_path" });
    expect(
      hookCommandResolution(
        `npx --yes --ignore-scripts -p @primitive.ai/prim@${packageVersion()} sh -c evil; prim-hook`,
        "prim-hook",
      ),
    ).toEqual({ kind: "legacy_path" });
  });

  it("collects only recognized Primitive commands", () => {
    expect(
      hookCommandResolutions(
        [stableHookCommand("prim-hook"), pinnedHookCommand("prim-pre-tool-use"), "other"],
        ["prim-hook", "prim-pre-tool-use"],
      ),
    ).toEqual([
      { kind: "stable_launcher" },
      { kind: "exact_npx_fallback", version: packageVersion() },
    ]);
  });
});
