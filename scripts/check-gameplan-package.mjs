#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }),
);
const files = new Set(packed[0].files.map((entry) => entry.path));
for (const asset of [
  "assets/primitive-gameplan/SKILL.md",
  "assets/primitive-gameplan/scripts/activate.mjs",
  "assets/primitive-gameplan/claude-hooks.json",
]) {
  assert.ok(files.has(asset), `npm package is missing ${asset}`);
}
process.stdout.write(`${JSON.stringify({ packageAssets: "pass" })}\n`);
