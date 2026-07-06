/**
 * `bin-path` coverage — bin resolution for spawning + the settings.json shim.
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
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  binFile,
  commandMatchesBin,
  detachedHookShimCommand,
  hookShimCommand,
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

describe("hookShimCommand", () => {
  it("emits a PATH -> node_modules -> npx@latest resolution ladder", () => {
    const cmd = hookShimCommand("prim-hook");
    expect(cmd).toContain("command -v prim-hook >/dev/null 2>&1");
    expect(cmd).toContain('elif [ -f "./node_modules/.bin/prim-hook" ]');
    expect(cmd).toContain("npx --yes -p @primitive.ai/prim@latest prim-hook");
    // No stdio/exit suppression — the hook's STDOUT + exit code must pass through.
    expect(cmd).not.toContain("|| true");
    expect(cmd).not.toContain("2>/dev/null; ");
  });

  it("threads args through every branch (codex, statusline)", () => {
    const codex = hookShimCommand("prim-hook", "--agent codex");
    expect(codex).toContain("then prim-hook --agent codex;");
    expect(codex).toContain("./node_modules/.bin/prim-hook --agent codex;");
    expect(codex).toContain("@primitive.ai/prim@latest prim-hook --agent codex;");

    const status = hookShimCommand("prim", "statusline");
    expect(status).toContain("command -v prim >/dev/null 2>&1");
    expect(status).toContain("then prim statusline;");
  });

  it("prepends a branch-0 cache read that execs the cached bin directly", () => {
    const cmd = hookShimCommand("prim-hook");
    // Mirrors binCacheDir() in bin-cache.ts (a drift guard lives there too).
    expect(cmd).toContain('d="${XDG_CACHE_HOME:-$HOME/.cache}/prim/bin";');
    // Kill switch and the default 24h backstop TTL, both read in-shell.
    expect(cmd).toContain('[ "${PRIM_BIN_CACHE:-1}" != "0" ]');
    expect(cmd).toContain('-mmin "-${PRIM_BIN_CACHE_TTL_MIN:-1440}"');
    // Marks the hit so the warmer skips (no mtime bump → TTL can expire), and
    // `exec` preserves stdio/exit AND prevents falling through to the ladder.
    expect(cmd).toContain('export PRIM_BIN_CACHE_HIT=1; exec "$n" "$p";');
    // Existence guard catches an npx-GC'd cached target → fail open to ladder.
    expect(cmd).toContain('[ -x "$n" ] && [ -f "$p" ]');
  });

  it("threads args onto the cached exec (codex, statusline)", () => {
    expect(hookShimCommand("prim-hook", "--agent codex")).toContain(
      'exec "$n" "$p" --agent codex;',
    );
    expect(hookShimCommand("prim", "statusline")).toContain('exec "$n" "$p" statusline;');
  });

  it("omits branch-0 entirely when cacheRead is false", () => {
    const cmd = hookShimCommand("prim-hook", "", { cacheRead: false });
    expect(cmd).not.toContain("PRIM_BIN_CACHE");
    expect(cmd.startsWith("if command -v prim-hook")).toBe(true);
  });
});

describe("detachedHookShimCommand", () => {
  it("embeds the bare-ladder shim verbatim inside the detached template", () => {
    // Detached uses cacheRead:false — branch-0's `exec` is for the sync hooks,
    // and this keeps the delicate wrapper byte-identical to its pre-cache form.
    const cmd = detachedHookShimCommand("prim-hook");
    expect(cmd).toContain(`| { ${hookShimCommand("prim-hook", "", { cacheRead: false })}; }`);
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
    expect(cmd).toContain(
      `| { ${hookShimCommand("prim-hook", "--agent codex", { cacheRead: false })}; }`,
    );
  });

  it.skipIf(process.platform === "win32")(
    "exits immediately and still delivers the payload to the detached bin",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "prim-detach-"));
      const outFile = join(dir, "out.json");
      try {
        // Stub prim-hook: sleep past the timing budget, then persist stdin.
        // Write-then-rename so the exists-poll below never observes the file
        // in its exists-but-empty window between open() and cat's write.
        writeFileSync(
          join(dir, "prim-hook"),
          `#!/bin/sh\nsleep 1\ncat > "$STUB_OUT.tmp" && mv "$STUB_OUT.tmp" "$STUB_OUT"\n`,
        );
        chmodSync(join(dir, "prim-hook"), 0o755);
        const payload = '{"hook_event_name":"SessionEnd","session_id":"s-1","cwd":"/tmp"}';
        const started = performance.now();
        // spawnSync blocks on pipe EOF as well as exit, so the elapsed budget
        // alone regression-guards the redirect placement: without the
        // outermost /dev/null redirects it blocks for the stub's full sleep.
        const res = spawnSync("sh", ["-c", detachedHookShimCommand("prim-hook")], {
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
  const primHookLadder =
    "if command -v prim-hook >/dev/null 2>&1; then prim-hook; " +
    'elif [ -f "./node_modules/.bin/prim-hook" ]; then ./node_modules/.bin/prim-hook; ' +
    "else npx --yes -p @primitive.ai/prim@latest prim-hook; fi";

  it("pins the cache-enabled synchronous shim byte-for-byte", () => {
    expect(hookShimCommand("prim-hook")).toBe(
      'd="${XDG_CACHE_HOME:-$HOME/.cache}/prim/bin"; if [ "${PRIM_BIN_CACHE:-1}" != "0" ] && ' +
        '[ -f "$d/prim-hook" ] && [ -f "$d/node" ] && ' +
        '[ -n "$(find "$d/prim-hook" -mmin "-${PRIM_BIN_CACHE_TTL_MIN:-1440}" 2>/dev/null)" ]; ' +
        'then n=$(cat "$d/node"); p=$(cat "$d/prim-hook"); ' +
        'if [ -x "$n" ] && [ -f "$p" ]; then export PRIM_BIN_CACHE_HIT=1; exec "$n" "$p"; fi; fi; ' +
        "if command -v prim-hook >/dev/null 2>&1; then prim-hook; " +
        'elif [ -f "./node_modules/.bin/prim-hook" ]; then ./node_modules/.bin/prim-hook; ' +
        "else npx --yes -p @primitive.ai/prim@latest prim-hook; fi",
    );
  });

  it("pins the bare-ladder (cacheRead:false) shim byte-for-byte", () => {
    // SessionStart and the detached wrapper emit exactly this — unchanged from
    // the pre-cache form, so those registrations are not a settings.json churn.
    expect(hookShimCommand("prim-hook", "", { cacheRead: false })).toBe(primHookLadder);
  });

  it("pins the detached wrapper byte-for-byte", () => {
    expect(detachedHookShimCommand("prim-hook")).toBe(
      "payload=$(cat); { trap '' HUP; " +
        "export npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=10000 " +
        "npm_config_fetch_retry_maxtimeout=10000 npm_config_fetch_timeout=60000; " +
        `printf '%s' "$payload" | { ` +
        "if command -v prim-hook >/dev/null 2>&1; then prim-hook; " +
        'elif [ -f "./node_modules/.bin/prim-hook" ]; then ./node_modules/.bin/prim-hook; ' +
        "else npx --yes -p @primitive.ai/prim@latest prim-hook; fi" +
        "; }; } </dev/null >/dev/null 2>&1 &",
    );
  });
});

describe("commandMatchesBin", () => {
  it("matches the legacy bare form, with or without args", () => {
    expect(commandMatchesBin("prim-hook", "prim-hook")).toBe(true);
    expect(commandMatchesBin("prim-hook --agent codex", "prim-hook")).toBe(true);
  });

  it("matches the current shim form", () => {
    expect(commandMatchesBin(hookShimCommand("prim-hook"), "prim-hook")).toBe(true);
    expect(commandMatchesBin(hookShimCommand("prim-hook", "--agent codex"), "prim-hook")).toBe(
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
    expect(commandMatchesBin(hookShimCommand("prim-post-tool-use"), "prim-pre-tool-use")).toBe(
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

describe("branch-0 cache read (behavioral)", () => {
  // A fake "node" recording how it was invoked — stands in for the cached
  // runtime the shim execs. $1 is the cached bin entry the shim hands it.
  function writeFakeNode(dir: string): string {
    const p = join(dir, "fake-node.sh");
    writeFileSync(p, '#!/bin/sh\nprintf "cache-hit:%s:%s" "$PRIM_BIN_CACHE_HIT" "$1"\n');
    chmodSync(p, 0o755);
    return p;
  }

  // A fake prim-hook on PATH answers the ladder's `command -v` branch, proving
  // the shim fell through branch-0 to the resolution ladder.
  function writeLadderBin(dir: string): string {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    const onPath = join(binDir, "prim-hook");
    writeFileSync(onPath, '#!/bin/sh\nprintf "ladder"\n');
    chmodSync(onPath, 0o755);
    return binDir;
  }

  function seedCache(dir: string): string {
    const cacheDir = join(dir, "prim", "bin");
    mkdirSync(cacheDir, { recursive: true });
    const target = join(dir, "entry.js");
    writeFileSync(target, "// cached entry\n");
    writeFileSync(join(cacheDir, "node"), writeFakeNode(dir));
    writeFileSync(join(cacheDir, "prim-hook"), target);
    return target;
  }

  // Scrub the cache-control knobs from the inherited env so an ambient export
  // (e.g. a developer's PRIM_BIN_CACHE=0) can't unhermetically flip these
  // spawns; overrides re-add any the test sets deliberately.
  function spawnEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const e = { ...process.env };
    // biome-ignore lint/performance/noDelete: env hermeticity requires actual removal
    delete e.PRIM_BIN_CACHE;
    // biome-ignore lint/performance/noDelete: env hermeticity requires actual removal
    delete e.PRIM_BIN_CACHE_HIT;
    // biome-ignore lint/performance/noDelete: env hermeticity requires actual removal
    delete e.PRIM_BIN_CACHE_TTL_MIN;
    return { ...e, ...overrides };
  }

  it.skipIf(process.platform === "win32")("execs the cached bin directly on a fresh hit", () => {
    const dir = mkdtempSync(join(tmpdir(), "prim-cache-"));
    try {
      const target = seedCache(dir);
      const res = spawnSync("sh", ["-c", hookShimCommand("prim-hook")], {
        env: spawnEnv({ XDG_CACHE_HOME: dir }),
        encoding: "utf-8",
      });
      // `exec` replaced the shell with fake-node (PRIM_BIN_CACHE_HIT exported);
      // the ladder never ran.
      expect(res.stdout).toBe(`cache-hit:1:${target}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "falls through to the ladder when the entry is older than TTL",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "prim-cache-"));
      try {
        seedCache(dir);
        // Age the entry two days past the 24h default TTL.
        const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
        utimesSync(join(dir, "prim", "bin", "prim-hook"), old, old);
        const binDir = writeLadderBin(dir);
        const res = spawnSync("sh", ["-c", hookShimCommand("prim-hook")], {
          env: spawnEnv({ XDG_CACHE_HOME: dir, PATH: `${binDir}:${process.env.PATH}` }),
          encoding: "utf-8",
        });
        expect(res.stdout).toBe("ladder");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores the cache under the PRIM_BIN_CACHE=0 kill switch",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "prim-cache-"));
      try {
        seedCache(dir);
        const binDir = writeLadderBin(dir);
        const res = spawnSync("sh", ["-c", hookShimCommand("prim-hook")], {
          env: spawnEnv({
            XDG_CACHE_HOME: dir,
            PRIM_BIN_CACHE: "0",
            PATH: `${binDir}:${process.env.PATH}`,
          }),
          encoding: "utf-8",
        });
        expect(res.stdout).toBe("ladder");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
