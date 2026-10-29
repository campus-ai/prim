import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname;
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(join(cache, "prim-identity-golden-"));
try {
  execFileSync(
    "pnpm",
    ["exec", "tsup", "src/decisions/identity.ts", "--format", "esm", "--out-dir", output],
    { cwd: root, stdio: "pipe" },
  );
  const { publicDecisionResponse } = await import(pathToFileURL(join(output, "identity.js")).href);
  const internal = "j57b04m7f2z3xv647yxxkcdzy17h6k2z";
  const golden = {
    decision: {
      id: "dec_0123abcd",
      shortId: "0123abcd",
      intent: "Keep the public identity stable",
    },
    userId: "user_internal_id",
    webUrl: "https://app.getprimitive.ai/decisions/dec_0123abcd",
    rationale: "See dec_0123abcd",
    continueCursor: internal,
  };
  assert.deepEqual(
    publicDecisionResponse({
      ...golden,
      decision: { ...golden.decision, id: internal },
      webUrl: `https://app.getprimitive.ai/decisions/${internal}`,
      rationale: `See ${internal}`,
    }),
    golden,
  );
  assert.deepEqual(publicDecisionResponse(golden), golden);
  assert.deepEqual(publicDecisionResponse({ decisionId: "0123abcd", shortId: "0123abcd" }), {
    decisionId: "dec_0123abcd",
    shortId: "0123abcd",
  });
  assert.deepEqual(publicDecisionResponse({ decisionId: internal, decisionShortId: "0123abcd" }), {
    decisionId: "dec_0123abcd",
    decisionShortId: "0123abcd",
  });
  assert.throws(() => publicDecisionResponse({ decisionId: internal }), {
    message: "Decision identity unavailable; update Primitive and retry",
  });
  process.stdout.write(`${JSON.stringify({ goldenCases: 5, internalDecisionIdPrinted: false })}\n`);
} finally {
  rmSync(output, { recursive: true, force: true });
}
