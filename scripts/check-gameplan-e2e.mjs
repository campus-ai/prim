#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(packageRoot, "dist", "index.js");
const scratch = mkdtempSync(join(tmpdir(), "prim-gameplan-e2e-"));
const repo = join(scratch, "repo");
const worktree = join(scratch, "linked-worktree");
const codexHome = join(scratch, "codex-home");
const env = {
  ...process.env,
  HOME: scratch,
  CODEX_HOME: codexHome,
  CI: "1",
  PRIM_NON_INTERACTIVE: "1",
};

function run(args, cwd = worktree) {
  return spawnSync(process.execPath, [cli, "gameplan", ...args], {
    cwd,
    env,
    encoding: "utf8",
  });
}

function expectSuccess(result, label) {
  assert.equal(result.status, 0, `${label}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
}

try {
  execFileSync("git", ["clone", "--quiet", "--local", packageRoot, repo], { stdio: "pipe" });
  execFileSync("git", ["-C", repo, "worktree", "add", "--quiet", "--detach", worktree, "HEAD"], {
    stdio: "pipe",
  });
  mkdirSync(codexHome, { recursive: true });
  const hooksPath = join(codexHome, "hooks.json");
  const foreign = {
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "echo foreign" }] }] },
  };
  writeFileSync(hooksPath, `${JSON.stringify(foreign)}\n`);
  const agentsPath = join(worktree, "AGENTS.md");
  writeFileSync(agentsPath, "Existing rules.\n");

  const missingPublicSkill = run(["install", "--agent", "codex"]);
  assert.notEqual(missingPublicSkill.status, 0);
  assert.match(missingPublicSkill.stderr, /cannot find \$write-gameplan/iu);

  const publicSkillPath = join(worktree, ".agents", "skills", "write-gameplan", "SKILL.md");
  mkdirSync(dirname(publicSkillPath), { recursive: true });
  writeFileSync(
    publicSkillPath,
    "---\nname: write-gameplan\ndescription: Public skill stub\n---\n",
  );
  const overridePath = join(worktree, "AGENTS.override.md");
  writeFileSync(overridePath, "Override rules.\n");
  const shadowed = run(["install"]);
  assert.notEqual(shadowed.status, 0);
  assert.match(shadowed.stderr, /AGENTS\.override\.md shadows AGENTS\.md/u);
  unlinkSync(overridePath);

  const installed = expectSuccess(run(["install", "--agent", "codex"]), "install");
  assert.equal(installed.installed, true);
  assert.equal(realpathSync(installed.root), realpathSync(worktree));
  const firstAgents = readFileSync(agentsPath, "utf8");
  const firstHooks = readFileSync(hooksPath, "utf8");
  assert.match(firstAgents, /Existing rules\./u);
  assert.match(firstAgents, /BEGIN PRIMITIVE GAMEPLAN/u);
  assert.match(firstHooks, /echo foreign/u);

  expectSuccess(run(["install", "--agent", "codex"]), "repeat install");
  assert.equal(readFileSync(agentsPath, "utf8"), firstAgents);
  assert.equal(readFileSync(hooksPath, "utf8"), firstHooks);
  const status = expectSuccess(run(["status"]), "status");
  assert.equal(status.installed, true);
  assert.equal(realpathSync(status.publicSkill), realpathSync(publicSkillPath));

  const hook = JSON.parse(firstHooks).hooks.UserPromptSubmit.find((entry) =>
    entry.hooks.some((item) => item.command.includes("prim-gameplan-hook-v1")),
  ).hooks[0].command;
  const prompted = spawnSync("sh", ["-c", hook], {
    cwd: worktree,
    env,
    input: JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      prompt: "$write-gameplan example",
    }),
    encoding: "utf8",
  });
  assert.equal(prompted.status, 0, prompted.stderr);
  assert.match(
    JSON.parse(prompted.stdout).hookSpecificOutput.additionalContext,
    /Primitive companion/u,
  );
  const unrelated = spawnSync("sh", ["-c", hook], {
    cwd: worktree,
    env,
    input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "unrelated" }),
    encoding: "utf8",
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.stdout, "");

  const companionPath = join(worktree, ".agents", "skills", "primitive-gameplan", "SKILL.md");
  const companion = readFileSync(companionPath, "utf8");
  writeFileSync(companionPath, `${companion}\nmodified\n`);
  const refused = run(["install", "--agent", "codex"]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Refusing modified companion file/u);
  writeFileSync(companionPath, companion);

  const uninstalled = expectSuccess(run(["uninstall"]), "uninstall");
  assert.equal(uninstalled.uninstalled, true);
  assert.equal(uninstalled.sharedUserHookRetained, true);
  assert.equal(readFileSync(agentsPath, "utf8"), "Existing rules.\n");
  assert.match(readFileSync(hooksPath, "utf8"), /prim-gameplan-hook-v1/u);
  expectSuccess(run(["install"]), "reinstall");
  expectSuccess(run(["uninstall", "--remove-user-hook"]), "remove shared hook");
  const finalHooks = readFileSync(hooksPath, "utf8");
  assert.match(finalHooks, /echo foreign/u);
  assert.doesNotMatch(finalHooks, /prim-gameplan-hook-v1/u);
  process.stdout.write(`${JSON.stringify({ e2e: "pass", worktree: true })}\n`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
