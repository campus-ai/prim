/**
 * Skill management commands for the prim CLI.
 *
 * prim skill install   — Install the prim skill block into a project rules file
 * prim skill uninstall — Remove the prim skill block
 * prim skill status    — Report whether the skill block is installed
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createPatch } from "diff";
import { printJson } from "../output.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKILL_BEGIN = "<!-- BEGIN PRIM SKILL v1 -->";
export const SKILL_END = "<!-- END PRIM SKILL v1 -->";

export const TARGET_CANDIDATES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".hermes.md",
  ".cursor/rules",
  ".windsurfrules",
  ".github/instructions/primitive.md",
];

const DEFAULT_TARGET = "CLAUDE.md";

// Each coding agent reads a different project rules file, so `--agent` selects
// the destination deterministically — no auto-detection, and no CLAUDE.md
// fallback for a non-Claude agent. (All three are also in TARGET_CANDIDATES.)
export const AGENT_TARGET = {
  claude: "CLAUDE.md",
  codex: "AGENTS.md",
  hermes: ".hermes.md",
} as const;

// User scope writes the rules block to each agent's machine-global rules file so
// every project inherits prim guidance — no per-repo `skill install`. Absolute
// and cwd-independent (mirrors the session installers' USER_SCOPE_PATH). Hermes
// honors HERMES_HOME like `prim hermes install` does.
export function userTargetFor(agent: string): string | null {
  if (agent === "claude") return join(homedir(), ".claude", "CLAUDE.md");
  if (agent === "codex") return join(homedir(), ".codex", "AGENTS.md");
  if (agent === "hermes") {
    return join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".hermes.md");
  }
  return null;
}

export function loadSkill(): string {
  // Walk up from this module looking for SKILL.md so dev (src/commands/) and
  // prod (bundled dist/) both resolve to the package's SKILL.md.
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const p = resolve(dir, "SKILL.md");
    if (existsSync(p)) return readFileSync(p, "utf-8");
    dir = dirname(dir);
  }
  throw new Error("SKILL.md not found in package");
}

export function detectTargets(cwd: string): string[] {
  return TARGET_CANDIDATES.filter((p) => existsSync(resolve(cwd, p)));
}

export function detectNewline(content: string): "\r\n" | "\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

export function composeBlock(skill: string, eol: "\r\n" | "\n"): string {
  const body = skill.replace(/\r?\n/g, eol);
  return `${SKILL_BEGIN}${eol}${body}${eol}${SKILL_END}`;
}

export function applyBlock(existing: string, block: string, eol: "\r\n" | "\n"): string {
  const b = existing.indexOf(SKILL_BEGIN);
  const e = existing.indexOf(SKILL_END);
  if (b !== -1 && e !== -1) {
    return existing.slice(0, b) + block + existing.slice(e + SKILL_END.length);
  }
  if (existing.length === 0) return `${block}${eol}`;
  const sep = existing.endsWith(eol) ? "" : eol;
  return `${existing}${sep}${block}${eol}`;
}

export function removeBlock(existing: string): string | null {
  const b = existing.indexOf(SKILL_BEGIN);
  const e = existing.indexOf(SKILL_END);
  if (b === -1 || e === -1) return null;
  const out = existing.slice(0, b) + existing.slice(e + SKILL_END.length);
  // Collapse a stray blank line introduced by a previous install.
  return out.replace(/(\r?\n){2,}$/, "$1");
}

function atomicWrite(target: string, content: string): void {
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, content);
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}

function resolveTarget(
  cwd: string,
  opts: { target?: string; agent?: string; scope?: string },
): string | null {
  // Precedence: an explicit path wins, then (at user scope) the agent's global
  // rules file, then the agent-mapped project file, then auto-detection. An
  // unknown --agent aborts rather than silently falling through to a CLAUDE.md
  // default.
  if (opts.scope && opts.scope !== "user" && opts.scope !== "project") {
    console.error(`Unknown --scope "${opts.scope}" (expected user or project)`);
    return null;
  }
  if (opts.target) return resolve(cwd, opts.target);
  if (opts.scope === "user") {
    // User scope is machine-global, so the target is absolute — never resolved
    // against cwd. It requires an explicit agent to know which rules file.
    if (!opts.agent) {
      console.error("--scope user requires --agent (claude, codex, or hermes)");
      return null;
    }
    const userTarget = userTargetFor(opts.agent);
    if (userTarget) return userTarget;
    console.error(`Unknown --agent "${opts.agent}" (expected claude, codex, or hermes)`);
    return null;
  }
  if (opts.agent) {
    const mapped = AGENT_TARGET[opts.agent as keyof typeof AGENT_TARGET];
    // Gate on the value TYPE, not truthiness: an inherited Object.prototype key
    // (toString, constructor, __proto__, …) would return a truthy non-string and
    // reach resolve() as a function — a crash. Only the three real string values
    // route; everything else (typos and prototype keys alike) aborts cleanly.
    if (typeof mapped === "string") return resolve(cwd, mapped);
    console.error(`Unknown --agent "${opts.agent}" (expected claude, codex, or hermes)`);
    return null;
  }
  const matches = detectTargets(cwd);
  if (matches.length === 0) return resolve(cwd, DEFAULT_TARGET);
  if (matches.length === 1) return resolve(cwd, matches[0]);
  console.error("Multiple rules files detected. Use --target to disambiguate:");
  for (const m of matches) console.error(`  ${m}`);
  return null;
}

export function runInstall(
  cwd: string,
  opts: { target?: string; agent?: string; scope?: string; dryRun?: boolean },
): number {
  const target = resolveTarget(cwd, opts);
  if (target === null) return 1;

  const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
  const eol = existing ? detectNewline(existing) : "\n";
  const block = composeBlock(loadSkill(), eol);
  const next = applyBlock(existing, block, eol);

  if (next === existing) {
    console.log("No changes — skill block already up to date.");
    return 0;
  }
  if (opts.dryRun) {
    process.stdout.write(createPatch(target, existing, next, "current", "proposed"));
    return 0;
  }
  atomicWrite(target, next);
  console.log(`Wrote ${Buffer.byteLength(next)} bytes to ${target}`);
  return 0;
}

export function runUninstall(
  cwd: string,
  opts: { target?: string; agent?: string; scope?: string },
): number {
  const target = resolveTarget(cwd, opts);
  if (target === null) return 1;
  if (!existsSync(target)) {
    console.log(`Skill block not present at ${target}`);
    return 0;
  }
  const existing = readFileSync(target, "utf-8");
  const next = removeBlock(existing);
  if (next === null) {
    console.log(`Skill block not present at ${target}`);
    return 0;
  }
  atomicWrite(target, next);
  console.log(`Removed skill block from ${target}`);
  return 0;
}

export function runStatus(
  cwd: string,
  opts: { target?: string; agent?: string; scope?: string; json?: boolean },
): number {
  const target = resolveTarget(cwd, opts);
  if (target === null) return 1;

  const fileExists = existsSync(target);
  let installed = false;
  if (fileExists) {
    const content = readFileSync(target, "utf-8");
    installed = content.includes(SKILL_BEGIN) && content.includes(SKILL_END);
  }

  if (opts.json) {
    printJson({ installed, target });
    return installed ? 0 : 1;
  }

  if (!fileExists) {
    console.log(`No rules file at ${target}`);
    return 1;
  }
  if (installed) {
    console.log(`PRIM SKILL v1 installed at ${target}`);
    return 0;
  }
  console.log(`No PRIM SKILL block at ${target}`);
  return 1;
}

export function registerSkillCommands(program: Command) {
  const skill = program
    .command("skill")
    .description("Manage the prim skill in your project rules file");

  skill
    .command("install")
    .description("Install the prim skill block into your project rules file")
    .option("--target <path>", "Path to the rules file (overrides auto-detection)")
    .option("--agent <agent>", "claude, codex, or hermes (selects the default rules file)")
    .option(
      "--scope <scope>",
      "project (default, a rules file in this repo) or user (the agent's global rules file)",
    )
    .option("--dry-run", "Print a unified diff without writing")
    .action((opts: { target?: string; agent?: string; scope?: string; dryRun?: boolean }) => {
      try {
        process.exit(runInstall(process.cwd(), opts));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(2);
      }
    });

  skill
    .command("uninstall")
    .description("Remove the prim skill block from your project rules file")
    .option("--target <path>", "Path to the rules file (overrides auto-detection)")
    .option("--agent <agent>", "claude, codex, or hermes (selects the default rules file)")
    .option(
      "--scope <scope>",
      "project (default, a rules file in this repo) or user (the agent's global rules file)",
    )
    .action((opts: { target?: string; agent?: string; scope?: string }) => {
      process.exit(runUninstall(process.cwd(), opts));
    });

  skill
    .command("status")
    .description("Report whether the prim skill block is installed")
    .option("--target <path>", "Path to the rules file (overrides auto-detection)")
    .option("--agent <agent>", "claude, codex, or hermes (selects the default rules file)")
    .option(
      "--scope <scope>",
      "project (default, a rules file in this repo) or user (the agent's global rules file)",
    )
    .option("--json", "Output as JSON")
    .action((opts: { target?: string; agent?: string; scope?: string; json?: boolean }) => {
      process.exit(runStatus(process.cwd(), opts));
    });
}
