/**
 * Hook management commands for the prim CLI.
 *
 * prim hooks install   — Install the prim git hooks (pre-commit + post-commit)
 * prim hooks uninstall — Remove the prim git hooks
 *
 * Two scopes:
 *   project (default) — writes into this repo's .git/hooks (or .husky). Per-repo.
 *   user (--scope user) — installs ONCE at user level via a global
 *     `core.hooksPath`, so every repo captures commits with no per-repo setup.
 *
 * User-scope caveats (git's own precedence rules):
 *   - A repo with its OWN local `core.hooksPath` (e.g. husky v9 sets
 *     `.husky/_`) overrides the global one, so prim's global hook won't fire
 *     there — run per-repo `prim hooks install` in those repos.
 *   - If a global `core.hooksPath` already points elsewhere, prim appends its
 *     block into that dir instead of hijacking the pointer.
 *   - A system-level `core.hooksPath` is not overridden without --force.
 *   - Requires git ≥ 2.9.
 */

import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type Command, Option } from "commander";

type HookSpec = { hookName: string; binName: string };

const PRE_COMMIT: HookSpec = { hookName: "pre-commit", binName: "prim-pre-commit" };
const POST_COMMIT: HookSpec = { hookName: "post-commit", binName: "prim-post-commit" };
// Pre-commit first: install order is asserted by hooks.spec.ts (calls[0]).
const HOOKS: HookSpec[] = [PRE_COMMIT, POST_COMMIT];

function blockMarkers(spec: HookSpec): { start: string; end: string } {
  return {
    start: `# >>> prim ${spec.hookName} hook >>>`,
    end: `# <<< prim ${spec.hookName} hook <<<`,
  };
}

// Back-compat exports: the pre-commit markers, asserted against in tests.
export const PRIM_BLOCK_START = blockMarkers(PRE_COMMIT).start;
export const PRIM_BLOCK_END = blockMarkers(PRE_COMMIT).end;

// The shell that resolves and runs a prim hook bin — PATH, local
// node_modules, then npx — never failing the commit (`|| true`).
function hookShim(binName: string): string {
  return `if command -v ${binName} >/dev/null 2>&1; then
  ${binName}
elif [ -f "./node_modules/.bin/${binName}" ]; then
  ./node_modules/.bin/${binName}
else
  npx --yes -p @primitive.ai/prim ${binName} 2>/dev/null || true
fi`;
}

function dotGitScript(spec: HookSpec): string {
  return `#!/bin/sh
# prim ${spec.hookName} hook — installed by: prim hooks install

${hookShim(spec.binName)}
`;
}

function huskyBlock(spec: HookSpec): string {
  const { start, end } = blockMarkers(spec);
  return `${start}
${hookShim(spec.binName)}
${end}`;
}

function getGitRoot(): string {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();
}

export function detectHusky(gitRoot: string): boolean {
  const huskyDir = resolve(gitRoot, ".husky");
  if (!existsSync(huskyDir)) return false;

  if (existsSync(resolve(huskyDir, "_"))) return true;
  if (existsSync(resolve(huskyDir, "pre-commit"))) return true;

  const pkgPath = resolve(gitRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (/husky/i.test(scripts.prepare ?? "") || /husky/i.test(scripts.postinstall ?? "")) {
        return true;
      }
    } catch {
      // Malformed package.json — treat as no Husky
    }
  }

  return false;
}

export function containsPrimHook(content: string, binName: string = PRE_COMMIT.binName): boolean {
  return content.includes(binName);
}

export async function askConfirmation(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export function installToHusky(gitRoot: string, spec: HookSpec = PRE_COMMIT): void {
  const hookPath = resolve(gitRoot, ".husky", spec.hookName);

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing, spec.binName)) {
      console.log(`Prim ${spec.hookName} hook is already installed in .husky/${spec.hookName}.`);
      return;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(hookPath, `${existing}${separator}${huskyBlock(spec)}\n`, {
      mode: 0o755,
    });
    console.log(`Appended prim hook block to .husky/${spec.hookName}.`);
  } else {
    writeFileSync(hookPath, `#!/bin/sh\n\n${huskyBlock(spec)}\n`, {
      mode: 0o755,
    });
    console.log(`Created .husky/${spec.hookName} with prim hook block.`);
  }
}

export function installToDotGit(gitRoot: string, spec: HookSpec = PRE_COMMIT): void {
  const hooksDir = resolve(gitRoot, ".git", "hooks");
  const hookPath = resolve(hooksDir, spec.hookName);

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing, spec.binName)) {
      console.log(`Prim ${spec.hookName} hook is already installed at ${hookPath}.`);
      return;
    }
    console.log(`A ${spec.hookName} hook already exists at ${hookPath}.`);
    console.log("To replace it, run: prim hooks uninstall && prim hooks install");
    return;
  }

  writeFileSync(hookPath, dotGitScript(spec), { mode: 0o755 });
  console.log(`Installed ${spec.hookName} hook at ${hookPath}`);
}

// ---------------------------------------------------------------------------
// User scope — a global core.hooksPath that captures commits in every repo.
// ---------------------------------------------------------------------------

// Prim owns this dir (distinct from git's own ~/.config/git/hooks). Mirrors the
// ~/.config/prim convention used everywhere else; deliberately NOT XDG-aware,
// since prim doesn't honor XDG_CONFIG_HOME anywhere.
export const PRIM_GIT_HOOKS_DIR = join(homedir(), ".config", "prim", "git-hooks");

// git stores core.hooksPath verbatim (a leading ~ is expanded by git at runtime,
// not by us), so normalize before any filesystem use or equality check.
function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function isOurHooksDir(value: string): boolean {
  return value !== "" && expandTilde(value) === PRIM_GIT_HOOKS_DIR;
}

// Read core.hooksPath at a specific level only. NEVER a bare `--get`: inside a
// husky repo that would read the repo-local `.husky/_` and we'd corrupt it.
function gitConfigGet(level: "--global" | "--system"): string {
  try {
    return execFileSync("git", ["config", level, "--get", "core.hooksPath"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // Unset (exit 1) or no such config file — treat as empty.
    return "";
  }
}

// A standalone global hook: run prim (fail-soft on every branch — this fires in
// EVERY repo, so it must never break a commit), then chain to the repo's own
// hook so a global core.hooksPath doesn't silently disable it. --git-common-dir
// is NOT core.hooksPath-aware, so the chained path is always the repo's real
// .git/hooks — never this script (no recursion). --git-path hooks/… IS
// core.hooksPath-aware and would self-reference, so it must not be used.
function globalHookScript(spec: HookSpec): string {
  // pre-commit may legitimately block the commit — propagate the repo hook's
  // exit; post-commit runs after the commit and cannot block, so ignore it.
  const chainExit = spec.hookName === "pre-commit" ? "|| exit $?" : "|| true";
  return `#!/bin/sh
# prim global ${spec.hookName} hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
if command -v ${spec.binName} >/dev/null 2>&1; then ${spec.binName} || true
elif [ -f "./node_modules/.bin/${spec.binName}" ]; then ./node_modules/.bin/${spec.binName} || true
else npx --yes -p @primitive.ai/prim ${spec.binName} 2>/dev/null || true
fi
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/${spec.hookName}"
if [ -x "$repo_hook" ] && ! grep -q '${spec.binName}' "$repo_hook" 2>/dev/null; then
  "$repo_hook" "$@" ${chainExit}
fi
exit 0
`;
}

function writeOwnHooks(): void {
  if (!existsSync(PRIM_GIT_HOOKS_DIR)) {
    mkdirSync(PRIM_GIT_HOOKS_DIR, { recursive: true });
  }
  for (const spec of HOOKS) {
    writeFileSync(resolve(PRIM_GIT_HOOKS_DIR, spec.hookName), globalHookScript(spec), {
      mode: 0o755,
    });
  }
}

// Append prim's marker-delimited block into a hook file we don't own (an
// existing global core.hooksPath dir). Idempotent — same machinery as the husky
// path. No chain tail: git already runs only this dir, so the file's other
// contents are the repo owner's, left in place.
function appendPrimBlock(hookPath: string, spec: HookSpec): void {
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing, spec.binName)) return;
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(hookPath, `${existing}${separator}${huskyBlock(spec)}\n`, { mode: 0o755 });
  } else {
    writeFileSync(hookPath, `#!/bin/sh\n\n${huskyBlock(spec)}\n`, { mode: 0o755 });
  }
}

function stripPrimBlock(hookPath: string, spec: HookSpec): void {
  if (!existsSync(hookPath)) return;
  const existing = readFileSync(hookPath, "utf-8");
  const { start, end } = blockMarkers(spec);
  const s = existing.indexOf(start);
  const e = existing.indexOf(end);
  if (s === -1 || e === -1) return;
  const out = (existing.slice(0, s) + existing.slice(e + end.length)).replace(/\n{2,}$/, "\n");
  writeFileSync(hookPath, out, { mode: 0o755 });
}

// Install prim's git hooks at USER scope via a global core.hooksPath. Coexists
// with an existing global hooksPath (appends into it) rather than clobbering.
export function installGlobalHooks(opts: { force?: boolean } = {}): void {
  const global = gitConfigGet("--global");
  if (global === "") {
    const system = gitConfigGet("--system");
    if (system !== "" && !isOurHooksDir(system) && !opts.force) {
      console.error(
        `[prim] system core.hooksPath is set to ${system}; a --global set would override it. Skipping — re-run with --force to override, or run per-repo \`prim hooks install\`.`,
      );
      return;
    }
    writeOwnHooks();
    execFileSync("git", ["config", "--global", "core.hooksPath", PRIM_GIT_HOOKS_DIR]);
    console.log(`Installed prim global git hooks; set core.hooksPath to ${PRIM_GIT_HOOKS_DIR}`);
    return;
  }
  if (isOurHooksDir(global)) {
    writeOwnHooks(); // idempotent refresh of the scripts
    console.log(`Prim global git hooks already active (${PRIM_GIT_HOOKS_DIR}); refreshed scripts.`);
    return;
  }
  // Coexist: a global core.hooksPath already points elsewhere — append prim's
  // block into that dir and leave the pointer untouched.
  const dir = expandTilde(global);
  for (const spec of HOOKS) {
    appendPrimBlock(resolve(dir, spec.hookName), spec);
  }
  console.log(
    `Appended prim hooks into existing core.hooksPath dir ${global} (pointer unchanged).`,
  );
}

export function uninstallGlobalHooks(): void {
  const global = gitConfigGet("--global");
  if (isOurHooksDir(global)) {
    for (const spec of HOOKS) {
      const p = resolve(PRIM_GIT_HOOKS_DIR, spec.hookName);
      if (existsSync(p)) unlinkSync(p);
    }
    // Only unset because the value is still ours (avoids the exit-5-on-absent
    // and multivar footguns of a blind --unset).
    execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"]);
    console.log("Removed prim global git hooks and unset core.hooksPath.");
    return;
  }
  if (global !== "") {
    const dir = expandTilde(global);
    for (const spec of HOOKS) {
      stripPrimBlock(resolve(dir, spec.hookName), spec);
    }
    console.log(`Removed the prim block from ${global} (left the dir and core.hooksPath intact).`);
    return;
  }
  console.log("No prim global git hooks found.");
}

// Install every prim git hook (pre-commit + post-commit) to the chosen
// destination, pre-commit first so its write is calls[0] in tests.
function installHooks(gitRoot: string, target: "husky" | "git-hooks"): void {
  for (const spec of HOOKS) {
    if (target === "husky") {
      installToHusky(gitRoot, spec);
    } else {
      installToDotGit(gitRoot, spec);
    }
  }
}

export function registerHooksCommands(program: Command) {
  const hooks = program.command("hooks").description("Manage git hooks");

  hooks
    .command("install")
    .description(
      "Install the prim git hooks — pre-commit + post-commit (auto-detects Husky; use --target to override)",
    )
    .addOption(
      new Option("--target <where>", "install destination; bypasses Husky detection").choices([
        "husky",
        "git-hooks",
      ]),
    )
    .addOption(
      new Option(
        "--scope <scope>",
        "project (default, this repo) or user (a global core.hooksPath capturing every repo)",
      ).choices(["project", "user"]),
    )
    .option("--force", "with --scope user, override a system-level core.hooksPath")
    .action(
      async (
        opts: { target?: "husky" | "git-hooks"; scope?: "project" | "user"; force?: boolean },
        command: Command,
      ) => {
        // User scope is repo-agnostic — a global core.hooksPath, no gitRoot and
        // no --target (husky/git-hooks are per-repo concepts).
        if (opts.scope === "user") {
          installGlobalHooks({ force: opts.force });
          return;
        }
        const globals = command.optsWithGlobals();
        const nonInteractive = Boolean(
          globals.nonInteractive || process.env.CI || process.env.PRIM_NON_INTERACTIVE,
        );
        const gitRoot = getGitRoot();

        if (opts.target === "husky") return installHooks(gitRoot, "husky");
        if (opts.target === "git-hooks") return installHooks(gitRoot, "git-hooks");

        if (detectHusky(gitRoot)) {
          if (globals.yes) return installHooks(gitRoot, "husky");
          if (nonInteractive) {
            throw new Error(
              "--non-interactive set, refusing to prompt for Husky-hook installation. Pass --yes to confirm or --target=git-hooks to choose.",
            );
          }
          if (!process.stdin.isTTY) {
            console.error(
              "Note: Husky detected but stdin is not a TTY — falling back to .git/hooks. Pass --yes for Husky or --non-interactive to fail fast.",
            );
          } else if (
            await askConfirmation(
              "Husky detected. Install prim hooks into .husky/ instead of .git/hooks/?",
            )
          ) {
            return installHooks(gitRoot, "husky");
          } else {
            console.log("Falling back to .git/hooks install.");
          }
        }

        installHooks(gitRoot, "git-hooks");
      },
    );

  hooks
    .command("uninstall")
    .description(
      "Remove the prim git hooks (.git/hooks, or the global core.hooksPath with --scope user)",
    )
    .addOption(
      new Option(
        "--scope <scope>",
        "project (default, this repo) or user (global core.hooksPath)",
      ).choices(["project", "user"]),
    )
    .action((opts: { scope?: "project" | "user" }) => {
      if (opts.scope === "user") {
        uninstallGlobalHooks();
        return;
      }
      const gitRoot = getGitRoot();
      for (const spec of HOOKS) {
        const hookPath = resolve(gitRoot, ".git", "hooks", spec.hookName);
        if (!existsSync(hookPath)) {
          console.log(`No ${spec.hookName} hook found.`);
          continue;
        }
        if (containsPrimHook(readFileSync(hookPath, "utf-8"), spec.binName)) {
          unlinkSync(hookPath);
          console.log(`Removed ${spec.hookName} hook at ${hookPath}`);
        } else {
          console.log(`Left ${spec.hookName} hook at ${hookPath} untouched (not a prim hook).`);
        }
      }
    });
}
