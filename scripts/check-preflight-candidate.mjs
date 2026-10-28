import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { build } from "tsup";

// Deliberately separate from contracts:check/provenance. This checks an explicit
// working-tree candidate without inventing a canonical source commit or lock.
const args = process.argv.slice(2);
assert.equal(
  args.length,
  2,
  "usage: node scripts/check-preflight-candidate.mjs --source <backend-root>",
);
assert.equal(args[0], "--source");
const source = resolve(args[1]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bytes = {
  schema: readFileSync(join(source, "contracts/cli-http-v1.schema.json")),
  fixtures: readFileSync(join(source, "contracts/cli-http-v1.fixtures.json")),
};
const schema = JSON.parse(bytes.schema);
const fixtures = JSON.parse(bytes.fixtures);
assert.equal(fixtures.contractId, schema.$id);
const ajv = new Ajv2020({ strict: false, allErrors: true });
ajv.addFormat("uri", { type: "string", validate: (value) => URL.canParse(value) });
ajv.addSchema(schema);
const requestStructure = ajv.compile({ $ref: `${schema.$id}#/$defs/PreflightRequestV3` });
const responseStructure = ajv.compile({ $ref: `${schema.$id}#/$defs/PreflightResponseV3` });
const temporary = mkdtempSync(join(tmpdir(), "prim-preflight-candidate-"));

try {
  const entry = join(temporary, "boundary.ts");
  writeFileSync(
    entry,
    [
      `export * from ${JSON.stringify(join(root, "src/hooks/preflight-v3.ts"))};`,
      `export * from ${JSON.stringify(join(root, "src/hooks/conflict-operation.ts"))};`,
      `export { isPreflightRequestV3 } from ${JSON.stringify(join(root, "src/contract/cli-http-v1.ts"))};`,
    ].join("\n"),
  );
  const require = createRequire(import.meta.url);
  const yaml = join(dirname(require.resolve("yaml/package.json")), "browser/index.js");
  await build({
    entry: [entry],
    outDir: temporary,
    format: ["esm"],
    splitting: false,
    noExternal: [/.*/],
    silent: true,
    config: false,
    esbuildOptions(options) {
      options.alias = { ...options.alias, yaml };
    },
    outExtension() {
      return { js: ".mjs" };
    },
  });
  const boundary = await import(pathToFileURL(join(temporary, "boundary.mjs")).href);
  let fixtureCount = 0;
  for (const fixture of fixtures.cases) {
    if (fixture.definition === "PreflightResponseV3") {
      assert.equal(responseStructure(fixture.value), fixture.valid, fixture.name);
      assert.equal(
        boundary.parsePreflightResponse(fixture.value) !== null,
        fixture.valid,
        fixture.name,
      );
    } else if (fixture.definition === "PreflightRequestV3") {
      const { toolName, toolInputDigest, enforcementCapabilities, ...legacy } = fixture.value;
      const { branch, ...withoutDegradableBranch } = fixture.value;
      // Existing refinements still enforce canonical paths and UTF8 proposal
      // limits; candidate schema checks the new additive request fields.
      assert.equal(
        Boolean(requestStructure(withoutDegradableBranch) && boundary.isPreflightRequestV3(legacy)),
        fixture.valid,
        fixture.name,
      );
    } else continue;
    fixtureCount++;
  }
  assert.ok(fixtureCount > 0);

  const base = {
    protocolVersion: 3,
    verdict: "allow",
    reasonCode: "golden",
    message: "Golden response",
    conflicts: [],
    bypassed: [],
  };
  const policy = (minimum) => ({
    mode: "strict",
    revision: 0,
    minimum,
    compatibility: "supported",
  });
  const verdictGoldens = [
    { verdict: "allow", expected: ["allow", "allow"] },
    { verdict: "warn", expected: ["warn", "warn"] },
    { verdict: "ask", expected: ["ask", "warn"] },
    { verdict: "block", expected: ["deny", "warn"] },
    { verdict: "block", policy: { ...policy("deny"), mode: "legacy" }, expected: ["deny", "warn"] },
    { verdict: "block", policy: policy("deny"), expected: ["deny", "deny"] },
    { verdict: "warn", policy: policy("deny"), expected: ["deny", "deny"] },
    { verdict: "ask", policy: policy("review"), expected: ["ask", "ask"], fallback: "deny" },
    { verdict: "warn", policy: policy("review"), expected: ["ask", "ask"], fallback: "deny" },
    { verdict: "block", policy: policy("review"), expected: ["deny", "deny"] },
    { verdict: "block", policy: policy("none"), expected: ["deny", "deny"] },
    { verdict: "ask", policy: policy("none"), expected: ["ask", "ask"], fallback: "deny" },
    { verdict: "allow", policy: policy("none"), expected: ["allow", "allow"] },
  ];
  let verdictCount = 0;
  for (const golden of verdictGoldens) {
    for (const [index, mode] of ["block", "warn"].entries()) {
      for (const native of [false, true]) {
        const expected = !native && golden.fallback ? golden.fallback : golden.expected[index];
        assert.equal(
          boundary.effectivePreflightVerdict(
            { ...base, verdict: golden.verdict, policy: golden.policy },
            mode,
            native,
          ),
          expected,
        );
        verdictCount++;
      }
    }
  }
  // Off/PRIM_BYPASS intentionally skip the request in the executable hook.
  // This matrix covers both modes that actually reach the protocol boundary.
  const strict = {
    ...base,
    verdict: "block",
    policy: policy("deny"),
    reviewUrl: "https://app.getprimitive.ai/reviews/check-1",
    operationId: "a".repeat(64),
  };
  const strictResult = boundary.resultForPreflight(strict);
  const guidance = strictResult.additionalContext;
  assert.ok(guidance.includes(strict.reviewUrl));
  assert.ok(guidance.includes(strict.operationId));
  assert.ok(!strictResult.reason.includes(strict.reviewUrl));
  assert.ok(!strictResult.reason.includes("prim reconcile"));
  assert.ok(!guidance.includes("prim reconcile"));
  assert.equal(boundary.parsePreflightResponse({ ...strict, operationId: "bad" }), null);
  assert.equal(
    boundary.parsePreflightResponse({ ...strict, reviewUrl: "javascript:alert(1)" }),
    null,
  );
  assert.equal(
    boundary.parsePreflightResponse({ ...strict, policy: { ...policy("deny"), minimum: "warn" } }),
    null,
  );
  assert.ok(boundary.parsePreflightResponse(base));

  const input = { z: [2, { b: true, a: "x" }], a: 1 };
  const reordered = { a: 1, z: [2, { a: "x", b: true }] };
  const canonical = '{"toolInput":{"a":1,"z":[2,{"a":"x","b":true}]},"toolName":"Write"}';
  const expectedDigest = createHash("sha256").update(canonical).digest("hex");
  assert.equal(boundary.toolInputDigest("Write", input), expectedDigest);
  assert.equal(boundary.toolInputDigest("Write", reordered), expectedDigest);
  assert.equal(boundary.proposalFor(input), boundary.proposalFor(reordered));
  assert.notEqual(boundary.toolInputDigest("Edit", input), expectedDigest);
  assert.notEqual(
    boundary.toolInputDigest("Write", { a: 1, z: [{ a: "x", b: true }, 2] }),
    expectedDigest,
  );
  const first = { file_path: "src/test.ts", content: `${"x".repeat(7000)}first` };
  const second = { ...first, content: `${"x".repeat(7000)}second` };
  assert.equal(boundary.proposalFor(first), boundary.proposalFor(second));
  assert.notEqual(
    boundary.toolInputDigest("Write", first),
    boundary.toolInputDigest("Write", second),
  );
  assert.ok(Buffer.byteLength(boundary.proposalFor({ content: "😀".repeat(3000) })) <= 6144);
  assert.throws(() => boundary.toolInputDigest("Write", { value: undefined }));
  process.stdout.write(
    `${JSON.stringify({ kind: "working_tree_candidate", canonicalProvenanceVerified: false, fixtureCount, verdictCount, fullInputDigestGoldens: "passed", sha256: Object.fromEntries(Object.entries(bytes).map(([key, value]) => [key, createHash("sha256").update(value).digest("hex")])) })}\n`,
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
