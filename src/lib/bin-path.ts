/**
 * Resolve and invoke prim bins without depending on a global install.
 *
 * Two consumers, two needs:
 *
 *   - The daemon: `prim daemon start` must spawn the long-lived
 *     `prim-daemon-server`. binFile() self-locates it by absolute path from the
 *     running code (import.meta.url), so the spawn works whether `daemon start`
 *     ran via `npx` (resolves into the npx cache for the daemon's lifetime) or a
 *     real install — PATH-independent, no second npx resolution.
 *
 *   - The session hooks: `prim claude|codex install` writes a per-event command
 *     into settings.json. There is no global install to point at, so it writes a
 *     resolution SHIM — PATH → local node_modules → `npx --yes @latest` — the
 *     same ladder the git hooks already use (hooks.ts:hookShim). It resolves
 *     with zero package management and always reaches `@latest` on the npx path.
 *
 * commandMatchesBin() recognizes a written command — legacy bare name, the
 * synchronous shim, or the detached wrapper (both shim forms carry the
 * `command -v <bin>` token) — so install/uninstall can identify, upgrade, and
 * strip prim's own entries across all three forms.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_NAME = "@primitive.ai/prim";
const ROOT_WALK_LIMIT = 6;
// The npx fallback pins @latest so an un-installed host always resolves the
// newest CLI; the PATH / node_modules branches are taken first when present.
const NPX_FALLBACK = `npx --yes -p ${PKG_NAME}@latest`;

type PackageManifest = { name?: string; bin?: Record<string, string> };

let resolvedRoot: { dir: string; bin: Record<string, string> } | null | undefined;

/**
 * Walk up from this module's location to the prim package root — the nearest
 * ancestor whose package.json `name` is the prim package. Works from the
 * bundled `dist/` layout, an npx cache, AND the `src/` layout under vitest.
 * Cached after the first resolution.
 */
function locateRoot(): { dir: string; bin: Record<string, string> } | null {
  if (resolvedRoot !== undefined) {
    return resolvedRoot;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PackageManifest;
        if (manifest.name === PKG_NAME && manifest.bin) {
          resolvedRoot = { dir, bin: manifest.bin };
          return resolvedRoot;
        }
      } catch {
        // unreadable / unparseable manifest — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  resolvedRoot = null;
  return resolvedRoot;
}

/** Absolute path to a published bin's entry file, or null if unresolvable. */
export function binFile(bin: string): string | null {
  const root = locateRoot();
  const rel = root?.bin[bin];
  if (!root || !rel) {
    return null;
  }
  return isAbsolute(rel) ? rel : join(root.dir, rel);
}

/**
 * A self-resolving shell command for a settings.json hook: try the bin on PATH,
 * then a local `node_modules/.bin`, then `npx --yes @latest`. Mirrors the
 * git-hook resolver (hooks.ts:hookShim) but — unlike it — adds no
 * `2>/dev/null || true`: a Claude Code / Codex hook's STDOUT (e.g. the gate's
 * permissionDecision) and exit code are load-bearing and must pass through.
 * That holds for the gate and statusline (stdout), post-tool-use (its stderr
 * verdict footer is a deliberate human signal), and session-start (its stdout
 * injects additionalContext under codex) — which is why they stay synchronous;
 * a hook whose output nothing consumes can use detachedHookShimCommand()
 * below instead.
 *   hookShimCommand("prim-hook")                 // capture
 *   hookShimCommand("prim-hook", "--agent codex")// codex capture
 *   hookShimCommand("prim", "statusline")        // statusline
 */
export function hookShimCommand(bin: string, args = ""): string {
  const invoke = (cmd: string): string => (args ? `${cmd} ${args}` : cmd);
  return (
    `if command -v ${bin} >/dev/null 2>&1; then ${invoke(bin)}; ` +
    `elif [ -f "./node_modules/.bin/${bin}" ]; then ${invoke(`./node_modules/.bin/${bin}`)}; ` +
    `else ${invoke(`${NPX_FALLBACK} ${bin}`)}; fi`
  );
}

/**
 * A fire-and-forget variant of hookShimCommand() for hooks whose output
 * nothing consumes: capture stdin, then run the shim in a detached background
 * job so the hook process exits in milliseconds. Claude Code cancels hooks
 * still running at session teardown ("SessionEnd hook … failed: Hook
 * cancelled" — older versions allowed ~1.5s regardless of configured timeout,
 * and interrupt-style exits cancel outright), and the shim's npx fallback
 * alone takes seconds on an un-installed host. Detached, the hook completes
 * before teardown has anything to cancel, and the capture still lands.
 *
 * Why not Claude Code's native `async: true` hook field (shipped Jan 2026):
 * async hooks still enforce the configured timeout, so a slow npx resolution
 * can still be killed mid-capture — the exact loss this wrapper removes;
 * whether an in-flight async hook survives session teardown at all is
 * undocumented; the field requires a Claude Code new enough to know it,
 * while this template works on every version back to the ~1.5s-cap era; and
 * Codex/Hermes have no equivalent, so the shell shape is needed for parity
 * anyway (see TODO(codex-hermes-parity)). Revisit if async hooks gain a
 * documented teardown-survival guarantee.
 *
 * Every piece of the template is load-bearing:
 *   - `payload=$(cat)` drains stdin BEFORE backgrounding — POSIX gives a
 *     backgrounded job /dev/null stdin, which would silently drop the
 *     envelope — and `printf '%s'` (a builtin: no exec, no ARG_MAX) re-feeds
 *     it without interpreting `%` or `\`.
 *   - The redirections and `&` sit on the OUTERMOST brace group so the whole
 *     detached tree inherits /dev/null stdio at fork. If any process in it
 *     inherited the hook's stdout/stderr pipes, Claude Code would keep
 *     waiting for pipe EOF and the detach would silently not detach. The
 *     `</dev/null` must never move onto the inner group — there it would
 *     override the payload pipe.
 *   - `trap '' HUP` shields the PATH and node_modules branches from
 *     terminal-close SIGHUP: sh fork+execs the bin directly there, and
 *     SIG_IGN inherits through exec (nohup would cover only one simple
 *     command and force an inner `sh -c` re-quoting layer). It does NOT
 *     shield the npx branch: npx is a Node process, and Node/libuv resets
 *     every spawned child's signal dispositions to SIG_DFL, so on an
 *     un-installed host the resolved bin runs with DEFAULT signal handling
 *     for the whole seconds-wide resolution window — and macOS ships no
 *     setsid(1) to re-session it. Accepted: the artifact at risk is one
 *     telemetry move (anything already journaled re-drains via flushIfNeeded
 *     and server-side moveId dedup), and prim-hook re-detaches the flush via
 *     Node's `detached: true` (a real new session), which is immune.
 *   - The `npm_config_fetch_*` exports bound the npx branch's runtime: on
 *     npm's defaults a hung registry connection holds the (invisible)
 *     detached job open for ~15 minutes (300s fetch-timeout × 3 attempts +
 *     backoff); 60s × 3 attempts + a 10s-capped backoff keeps it under ~4.
 *     They ride the environment, so they are inert on the PATH and
 *     node_modules branches. A sleep-and-kill watchdog was rejected:
 *     `kill $!` reaches only the inner subshell, orphaning the very npm/node
 *     grandchildren it means to reap.
 *   - The embedded shim keeps its `command -v <bin> ` token, so
 *     commandMatchesBin() recognizes the detached form unchanged.
 *
 * Detached stderr is discarded, so PRIM_HOOK_DEBUG cannot surface failures
 * here — debug by piping an envelope into the inner shim by hand.
 */
// TODO(codex-hermes-parity): only the Claude Code SessionEnd registrations use
// this wrapper today.
//   - Codex (commands/codex-install.ts): same hooks.json shape and shell
//     execution, so its registrations could adopt this wrapper verbatim via a
//     detached sibling of makeRegistration. Codex fires no SessionEnd —
//     Stop/SubagentStop are its terminal capture events — and its gate/
//     post-tool-use entries must stay synchronous (stdout/exit code are the
//     answer).
//   - Hermes (commands/hermes-install.ts): hooks are exec'd with shell=False
//     (shlex.split), so an inline sh string would be treated as a literal
//     program name. The detach must live inside the installed shim script
//     instead: teach ~/.hermes/agent-hooks/prim-shim.sh a mode flag (e.g.
//     `prim-shim.sh --detach <bin> …`) doing the payload=$(cat) capture +
//     trap '' HUP + background + /dev/null redirect around its existing
//     PATH → local → npx resolution, then point the on_session_end
//     registrations at it. Its gate's `timeout: 10` stays.
export function detachedHookShimCommand(bin: string, args = ""): string {
  return `payload=$(cat); { trap '' HUP; export npm_config_fetch_retries=2 npm_config_fetch_retry_maxtimeout=10000 npm_config_fetch_timeout=60000; printf '%s' "$payload" | { ${hookShimCommand(bin, args)}; }; } </dev/null >/dev/null 2>&1 &`;
}

/**
 * Does `command` invoke `bin`, in either the legacy bare form ("prim-hook",
 * "prim-hook --agent codex") or the current resolution shim? Matched on the
 * `command -v <bin>` token the shim always carries — the seam that lets a plain
 * re-install recognize and upgrade an older install, and uninstall strip it.
 * The five hook bin names are mutually non-substring, so the token never
 * cross-matches a sibling.
 */
export function commandMatchesBin(command: string | undefined, bin: string): boolean {
  if (!command) {
    return false;
  }
  const c = command.trim();
  // Legacy bare form, with or without trailing args.
  if (c === bin || c.startsWith(`${bin} `)) {
    return true;
  }
  // Resolution shim — keyed on its `command -v <bin> ` probe.
  return c.includes(`command -v ${bin} `);
}
