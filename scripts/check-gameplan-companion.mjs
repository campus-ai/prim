#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  process.stderr.write("Usage: check-gameplan-companion.mjs <canonical-skill-directory>\n");
  process.exit(2);
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["SKILL.md", "scripts/activate.mjs", "claude-hooks.json"];
const mismatches = [];
for (const file of files) {
  try {
    const canonical = readFileSync(join(source, file));
    const bundled = readFileSync(join(packageRoot, "assets", "primitive-gameplan", file));
    if (!canonical.equals(bundled)) mismatches.push(file);
  } catch (error) {
    mismatches.push(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

process.stdout.write(`${JSON.stringify({ checked: files, match: mismatches.length === 0 })}\n`);
if (mismatches.length > 0) {
  process.stderr.write(`Primitive gameplan assets drifted: ${mismatches.join(", ")}\n`);
  process.exitCode = 1;
}
