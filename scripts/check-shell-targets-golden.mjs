import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";

const cache = resolve("node_modules/.cache");
mkdirSync(cache, { recursive: true });
const root = mkdtempSync(join(cache, "shell-golden-"));
try {
  await build({
    entry: [
      "src/hooks/shell-targets.ts",
      "src/hooks/preflight-v3.ts",
      "src/hooks/pre-tool-use-scoring.ts",
    ],
    format: ["esm"],
    outDir: root,
    splitting: false,
    silent: true,
  });
  const { analyzeShellTargets } = await import(pathToFileURL(join(root, "shell-targets.js")));
  const { resolvePreflightTargets, proposalFor, proposalIsTruncated, resultForPreflight } =
    await import(pathToFileURL(join(root, "preflight-v3.js")));
  const { buildHookOutput, buildCodexOutput } = await import(
    pathToFileURL(join(root, "pre-tool-use-scoring.js"))
  );
  const fixtures = JSON.parse(readFileSync("contracts/shell-targets.golden.json", "utf8"));
  for (const { name, command, ...expected } of fixtures) {
    assert.deepEqual(analyzeShellTargets(command), expected, name);
  }
  const oversized = `python3 - <<'PY'\n${"#".repeat(65_536)}\nopen('a.ts', 'w')\nPY`;
  assert.deepEqual(analyzeShellTargets(oversized), {
    paths: [],
    coverage: "unverified",
    mutation: "present",
  });
  const repo = join(root, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet", repo]);
  symlinkSync(root, join(repo, "outside"));
  const targets = (command) =>
    resolvePreflightTargets({
      toolName: "Bash",
      toolInput: { command },
      agent: "claude_code",
      cwd: repo,
    });
  for (const path of ["../escape.ts", "/tmp/escape.ts", "outside/escape.ts"]) {
    assert.equal(targets(`python3 -c 'open("${path}", "w")'`).paths.length, 0, path);
  }
  const many = Array.from({ length: 33 }, (_, index) => `open('file-${index}.ts', 'w')`).join("\n");
  const bounded = targets(`python3 - <<'PY'\n${many}\nPY`);
  assert.equal(bounded.paths.length, 32);
  assert.equal(bounded.coverage, "unverified");
  const proposal = { command: `node -e '${"x".repeat(7000)}'` };
  assert.equal(Buffer.byteLength(proposalFor(proposal)), 6144);
  assert.equal(proposalIsTruncated(proposal), true);
  assert.equal(proposalIsTruncated({ command: "git status" }), false);
  const conflict = resultForPreflight(
    {
      protocolVersion: 3,
      verdict: "ask",
      reasonCode: "high_confidence_contradiction",
      message: "Conflict.",
      conflicts: [{ decisionId: "copy-policy", title: "Keep copy feedback transient" }],
      bypassed: [],
    },
    "Run a command affecting “a.ts”.",
    true,
  );
  const claude = buildHookOutput("ask", [conflict]);
  assert.equal(claude.hookSpecificOutput.permissionDecision, "ask");
  assert.match(claude.hookSpecificOutput.permissionDecisionReason, /shell proposal was truncated/);
  assert.match(claude.hookSpecificOutput.additionalContext, /shell proposal was truncated/);
  const codex = buildCodexOutput("ask", [conflict]);
  assert.equal(codex.hookSpecificOutput.permissionDecision, "deny");
  assert.match(codex.hookSpecificOutput.permissionDecisionReason, /shell proposal was truncated/);
  process.stdout.write(
    `${JSON.stringify({ status: "pass", goldenCases: fixtures.length, boundsAndCanonicalization: "pass" })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
