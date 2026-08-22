/**
 * `bin-path` coverage — bin resolution and exact-version runtime commands.
 *
 * Runs against the `src/` layout (no build needed): locateRoot walks up to the
 * repo's own package.json, so binFile returns paths under the real `dist/` tree
 * as declared in the `bin` map — including the stem mismatches a naive
 * `name + ".js"` would get wrong.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binFile,
  commandMatchesBin,
  detachedHookShimCommand,
  packageVersion,
  pinnedHookCommand,
  pinnedNpxArgs,
  pinnedNpxCommand,
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
      detachedHookShimCommand("prim-hook", "--agent codex"),
    ];
    for (const command of commands) {
      expect(command).toContain(`@primitive.ai/prim@${packageVersion()}`);
      expect(command).toContain("--ignore-scripts");
      expect(command).not.toContain("@latest");
    }
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

describe("detachedHookShimCommand", () => {
  it("embeds the pinned launcher inside the detached template", () => {
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).toContain(`| { ${pinnedHookCommand("prim-hook")}; }`);
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

  it("bounds the npx branch with a self-coherent npm fetch tuple", () => {
    // Without these, a hung registry holds the invisible detached job open
    // for ~15 minutes on npm's defaults. They must sit INSIDE the
    // backgrounded group (they only concern the detached chain) and before
    // the payload pipe so the exports reach the npx branch's environment.
    // mintimeout must be pinned alongside maxtimeout: env overrides npmrc
    // per-key, so a host npmrc with fetch-retry-mintimeout > 10s would
    // otherwise yield min > max and npm throws before any network attempt.
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).toContain(
      "trap '' HUP; export npm_config_fetch_retries=2 " +
        "npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=10000 " +
        "npm_config_fetch_timeout=60000; printf",
    );
  });

  it("threads args through the embedded shim", () => {
    const cmd = detachedHookShimCommand("prim-hook", "--agent codex");
    expect(cmd).toContain(`| { ${pinnedHookCommand("prim-hook", "--agent codex")}; }`);
  });

  it.skipIf(process.platform === "win32")(
    "exits immediately and still delivers the payload to the detached bin",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "prim-detach-"));
      const outFile = join(dir, "out.json");
      try {
        // Stub the exact-version npx fallback: sleep, then persist stdin.
        // Write-then-rename so the exists-poll below never observes the file
        // in its exists-but-empty window between open() and cat's write.
        writeFileSync(
          join(dir, "npx"),
          `#!/bin/sh\nsleep 1\ncat > "$STUB_OUT.tmp" && mv "$STUB_OUT.tmp" "$STUB_OUT"\n`,
        );
        chmodSync(join(dir, "npx"), 0o755);
        const payload = '{"hook_event_name":"SessionEnd","session_id":"s-1","cwd":"/tmp"}';
        const started = performance.now();
        // spawnSync blocks on pipe EOF as well as exit, so the elapsed budget
        // alone regression-guards the redirect placement: without the
        // outermost /dev/null redirects it blocks for the stub's full sleep.
        const res = spawnSync("sh", ["-c", detachedHookShimCommand("prim-nonesuch")], {
          input: payload,
          env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_OUT: outFile },
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
      `payload=$(cat); { trap '' HUP; export npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=10000 npm_config_fetch_timeout=60000; printf '%s' "$payload" | { ${pinnedHookCommand("prim-hook")}; }; } </dev/null >/dev/null 2>&1 &`,
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
