/**
 * Hook management commands for the prim CLI.
 *
 * prim hooks install   — Install the prim git hooks (pre-commit + post-commit)
 * prim hooks uninstall — Remove the prim git hooks
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
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
    .action(async (opts: { target?: "husky" | "git-hooks" }, command: Command) => {
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
    });

  hooks
    .command("uninstall")
    .description("Remove the prim git hooks (.git/hooks)")
    .action(() => {
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
