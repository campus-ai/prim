import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(join(cache, "prim-approval-copy-"));

try {
  const build = spawnSync(
    "pnpm",
    [
      "exec",
      "tsup",
      "src/hooks/approval-copy.ts",
      "src/hooks/preflight-v3.ts",
      "src/hooks/pre-tool-use-scoring.ts",
      "--format",
      "esm",
      "--out-dir",
      output,
    ],
    { cwd: root, encoding: "utf8" },
  );
  if (build.status !== 0) throw new Error(`${build.stdout}\n${build.stderr}`);

  const { editPreview } = await import(pathToFileURL(join(output, "approval-copy.js")).href);
  const { resultForPreflight } = await import(pathToFileURL(join(output, "preflight-v3.js")).href);
  const { buildHookOutput } = await import(
    pathToFileURL(join(output, "pre-tool-use-scoring.js")).href
  );

  const preview = editPreview(
    "Edit",
    {
      old_string: "export const retryPolicy = 'durable';",
      new_string: "export const retryPolicy = 'memory';",
    },
    ["src/retry.ts"],
  );
  const response = (conflicts, evaluationCoverage) => ({
    protocolVersion: 3,
    verdict: "ask",
    reasonCode: "high_confidence_contradiction",
    message: "The proposed change conflicts with an active governing Decision.",
    checkId: "check-1",
    conflicts,
    bypassed: [],
    ...(evaluationCoverage ? { evaluationCoverage } : {}),
  });
  const prompt = (value, edit = preview) =>
    buildHookOutput("ask", [resultForPreflight(value, edit)]).hookSpecificOutput;

  const one = prompt(
    response([{ decisionId: "decision-1", shortId: "12345678", title: "Keep retries durable" }]),
  );
  assert.equal(
    one.permissionDecisionReason,
    [
      "Edit “src/retry.ts”:",
      "Current text: “export const retryPolicy = 'durable';”",
      "Proposed replacement: “export const retryPolicy = 'memory';”",
      "Primitive found a conflict with an existing decision.",
      "Decision dec_12345678: “Keep retries durable”.",
      "Approve runs this edit once; it does not change these decisions.",
    ].join("\n"),
  );
  assert.match(one.additionalContext, /prim reconcile dec_12345678/u);
  assert.doesNotMatch(one.permissionDecisionReason, /prim reconcile|--outcome/u);

  const many = prompt(
    response(
      [
        { decisionId: "decision-1", title: "Keep retries durable" },
        { decisionId: "decision-2", title: "Do not discard queued work" },
      ],
      { status: "partial", selectionOmissions: [{}], evidenceOmissions: [{}] },
    ),
  );
  assert.match(many.permissionDecisionReason, /Decision decision-1: “Keep retries durable”/u);
  assert.match(many.permissionDecisionReason, /Decision decision-2: “Do not discard queued work”/u);
  assert.match(
    many.permissionDecisionReason,
    /Some potentially applicable decisions were not fully checked/u,
  );
  assert.doesNotMatch(many.permissionDecisionReason, /prim reconcile/u);

  const unavailableCoverage = prompt(
    response([], { status: "unavailable", selectionOmissions: [], evidenceOmissions: [] }),
  );
  assert.match(
    unavailableCoverage.permissionDecisionReason,
    /Some potentially applicable decisions were not fully checked/u,
  );

  const missing = prompt(response([{ decisionId: "decision-3" }]));
  assert.match(
    missing.permissionDecisionReason,
    /Decision decision-3: details unavailable; inspect it before approving/u,
  );

  const unsafePreview = editPreview(
    "Edit",
    {
      old_string: `\u001b[31m${"a".repeat(500)}`,
      new_string: "Bearer abcdefghijklmnopqrstuvwxyz1234567890",
    },
    ["src/retry.ts"],
  );
  const unsafe = prompt(
    response([{ decisionId: "decision-4", title: "Keep\nretries\u202edurable" }]),
    unsafePreview,
  );
  assert.ok(unsafe.permissionDecisionReason.length < 700);
  assert.ok(!unsafe.permissionDecisionReason.includes("\u001b"));
  assert.ok(!unsafe.permissionDecisionReason.includes("\u202e"));
  assert.doesNotMatch(unsafe.permissionDecisionReason, /abcdefghijklmnopqrstuvwxyz1234567890/u);
  assert.match(unsafe.permissionDecisionReason, /<REDACTED:bearer-token>/u);
  for (const card of [one, many, unavailableCoverage, missing, unsafe]) {
    assert.doesNotMatch(card.permissionDecisionReason, /prim reconcile|--outcome/u);
  }

  const compatible = buildHookOutput("allow", [
    resultForPreflight({ ...response([]), verdict: "allow", message: "Compatible." }, preview),
  ]);
  assert.equal(compatible.hookSpecificOutput.permissionDecision, "allow");
  assert.equal(compatible.hookSpecificOutput.permissionDecisionReason, undefined);
} finally {
  rmSync(output, { recursive: true, force: true });
}
