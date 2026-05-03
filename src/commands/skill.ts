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
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { createPatch } from "diff";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const SKILL_BEGIN = "<!-- BEGIN PRIM SKILL v1 -->";
export const SKILL_END = "<!-- END PRIM SKILL v1 -->";

export const TARGET_CANDIDATES = [
  "CLAUDE.md",
  ".cursor/rules",
  ".windsurfrules",
  ".github/instructions/primitive.md",
];

const DEFAULT_TARGET = "CLAUDE.md";

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

function resolveTarget(cwd: string, override?: string): string | null {
  if (override) return resolve(cwd, override);
  const matches = detectTargets(cwd);
  if (matches.length === 0) return resolve(cwd, DEFAULT_TARGET);
  if (matches.length === 1) return resolve(cwd, matches[0]);
  console.error("Multiple rules files detected. Use --target to disambiguate:");
  for (const m of matches) console.error(`  ${m}`);
  return null;
}

export function runInstall(cwd: string, opts: { target?: string; dryRun?: boolean }): number {
  const target = resolveTarget(cwd, opts.target);
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

export function runUninstall(cwd: string, opts: { target?: string }): number {
  const target = resolveTarget(cwd, opts.target);
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

export function runStatus(cwd: string, opts: { target?: string }): number {
  const target = resolveTarget(cwd, opts.target);
  if (target === null) return 1;
  if (!existsSync(target)) {
    console.log(`No rules file at ${target}`);
    return 1;
  }
  const content = readFileSync(target, "utf-8");
  if (content.includes(SKILL_BEGIN) && content.includes(SKILL_END)) {
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
    .option("--dry-run", "Print a unified diff without writing")
    .action((opts: { target?: string; dryRun?: boolean }) => {
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
    .action((opts: { target?: string }) => {
      process.exit(runUninstall(process.cwd(), opts));
    });

  skill
    .command("status")
    .description("Report whether the prim skill block is installed")
    .option("--target <path>", "Path to the rules file (overrides auto-detection)")
    .action((opts: { target?: string }) => {
      process.exit(runStatus(process.cwd(), opts));
    });
}
