import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const { values } = parseArgs({
  options: { "server-dir": { type: "string" }, cli: { type: "string" } },
});
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const golden = readJson(join(root, "contracts/seed-metadata-presentation.golden.json"));
const sharedFixturePath = join(root, "contracts/seed-metadata-v1.fixtures.json");
const shared = readJson(sharedFixturePath);
const cache = join(root, "node_modules", ".cache");
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(join(cache, "prim-seed-metadata-golden-"));
const oldTimezone = process.env.TZ;
const oldNoColor = process.env.NO_COLOR;
const realNow = Date.now;
let serverCompatibilityCases = 0;
let cliCommands = 0;

function showResponse(row) {
  return {
    decision: {
      ...row,
      alternatives: [],
      intentKind: "change",
      confidence: "high",
      supersededBy: null,
    },
    files: [],
    flags: [],
    dependsOn: [],
    dependents: [],
    scope: {
      location: { repository: false, directories: [], globs: [], branches: [] },
      time: {},
      users: [],
    },
    truncated: false,
  };
}

try {
  execFileSync(
    "pnpm",
    [
      "--ignore-workspace",
      "exec",
      "tsup",
      "src/decisions/metadata.ts",
      "src/decisions/recent.ts",
      "src/decisions/show.ts",
      "src/decisions/cascade-renderer.ts",
      "src/contract/cli-http-v1.ts",
      "--format",
      "esm",
      "--out-dir",
      output,
    ],
    { cwd: root, stdio: "pipe" },
  );
  const load = (name) => import(pathToFileURL(join(output, name)).href);
  const { decisionMakerName, formatDecidedAt, formatRecentDecisionDate } =
    await load("decisions/metadata.js");
  const { formatRecentHuman, formatRecentRow, formatRecentJson } =
    await load("decisions/recent.js");
  const { formatShowHuman, formatShowJson } = await load("decisions/show.js");
  const { renderCascade } = await load("decisions/cascade-renderer.js");
  const { cliHttpV1Validators } = await load("contract/cli-http-v1.js");
  process.env.NO_COLOR = "1";
  Date.now = () => golden.now;

  for (const timezone of golden.timezones) {
    process.env.TZ = timezone;
    for (const fixture of shared.cases) {
      const row = fixture.expected.feed;
      const before = JSON.stringify(row);
      const label = `shared ${fixture.name} in ${timezone}`;
      assert.equal(decisionMakerName(row), fixture.expected.projection.authorName, label);
      assert.equal(formatDecidedAt(row), fixture.expected.cliDateLabel, label);
      if (row.producerKind === "seed") {
        assert.ok(formatRecentRow(row).includes(fixture.expected.cliDateLabel), label);
        assert.ok(formatRecentRow(row).includes(fixture.expected.projection.authorName), label);
        assert.ok(!formatRecentRow(row).includes("Your "), label);
      }
      assert.equal(JSON.stringify(row), before, `${label}: ordering metadata unchanged`);
    }
    for (const fixture of golden.cases) {
      const { row, expected } = fixture;
      const label = `${fixture.name} in ${timezone}`;
      const recent = { decisions: [row], viewerHasDecisions: true };
      const show = showResponse(row);
      const before = JSON.stringify({ recent, show });
      assert.equal(decisionMakerName(row), expected.maker, label);
      assert.equal(formatDecidedAt(row), expected.decided, label);
      assert.equal(formatRecentRow(row), expected.recent, label);
      assert.equal(
        formatRecentHuman(recent),
        `[prim] recent · 1 decision(s)\n${expected.recent}`,
        label,
      );
      assert.equal(formatShowHuman(show), expected.show, label);
      assert.ok(!formatRecentRow(row).includes("Your "), label);
      assert.deepEqual(JSON.parse(formatRecentJson(recent)), recent, label);
      assert.deepEqual(JSON.parse(formatShowJson(show)), show, label);
      assert.equal(JSON.stringify({ recent, show }), before, `${label}: raw responses unchanged`);
      assert.equal(cliHttpV1Validators.DecisionsRecentResponse(recent), true, label);
      assert.equal(cliHttpV1Validators.DecisionDetailResponse(show), true, label);
      const cascade = {
        decision: row,
        fanOut: 0,
        upstream: { files: [], contexts: [] },
        downstream: [],
        trigger: null,
        truncated: false,
      };
      assert.ok(renderCascade(cascade).includes(`${expected.maker} · ${expected.decided}`), label);
      assert.equal(cliHttpV1Validators.DecisionCascadeResponse(cascade), true, label);
    }
  }

  // Older non-seed responses preserve local-clock presentation for today and
  // expose a calendar date otherwise, including around the local midnight edge.
  const live = { authorName: "Ada", producerKind: "cli", classifiedAt: 1793748600000 };
  for (const [timezone, expected] of [
    ["UTC", "2026-11-03"],
    ["America/New_York", "2026-11-03"],
    ["Pacific/Honolulu", "2026-11-03"],
    ["Pacific/Kiritimati", "2026-11-04"],
  ]) {
    process.env.TZ = timezone;
    assert.equal(formatRecentDecisionDate(live, golden.now), expected, timezone);
  }
  process.env.TZ = "UTC";
  assert.equal(
    formatRecentDecisionDate({ ...live, classifiedAt: golden.now }, golden.now),
    "12:00",
  );
  assert.equal(formatDecidedAt(live), "2026-11-03T23:30:00.000Z");
  assert.equal(decisionMakerName(live), "Ada");

  // This immutable baseline survives contracts:update. Always exercise it in CI,
  // with either the current vendored server contract or an explicitly supplied one.
  const baselineDir = join(root, "contracts/compatibility/pre-seed-metadata");
  const provenance = readJson(join(baselineDir, "provenance.json"));
  assert.equal(provenance.sourceCommit, "2438a817a4da09eaaa991ece0cf70b67e90cba73");
  for (const [name, artifact] of Object.entries(provenance.artifacts)) {
    const bytes = readFileSync(join(baselineDir, name));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, name);
  }
  const old = await import(pathToFileURL(join(baselineDir, "validators.mjs")).href);
  const olderValidators = {
    DecisionsRecentResponse: old.isDecisionsRecentResponseStructure,
    DecisionDetailResponse: old.isDecisionDetailResponse,
    DecisionCascadeResponse: old.isDecisionCascadeResponse,
  };
  const contractDir = values["server-dir"]
    ? resolve(values["server-dir"], "contracts")
    : join(root, "contracts");
  if (values["server-dir"]) {
    assert.equal(
      readFileSync(sharedFixturePath, "utf8"),
      readFileSync(join(contractDir, "seed-metadata-v1.fixtures.json"), "utf8"),
      "shared seed metadata fixtures must match the server bytes",
    );
  }
  const schema = readJson(join(contractDir, "cli-http-v1.schema.json"));
  const serverFixtures = readJson(join(contractDir, "cli-http-v1.fixtures.json"));
  const previousFixtures = readJson(join(baselineDir, "fixtures.json"));
  const ajv = new Ajv2020({ strict: false });
  ajv.addSchema(schema);
  for (const fixture of serverFixtures.cases) {
    if (fixture.valid && olderValidators[fixture.definition]) {
      assert.equal(
        olderValidators[fixture.definition](fixture.value),
        true,
        `pinned old CLI accepts new server: ${fixture.name}`,
      );
      serverCompatibilityCases += 1;
    }
  }
  for (const fixture of previousFixtures.cases) {
    if (fixture.valid && olderValidators[fixture.definition]) {
      const validate = ajv.getSchema(`${schema.$id}#/$defs/${fixture.definition}`);
      assert.equal(
        validate(fixture.value),
        true,
        `new server accepts old response: ${fixture.name}`,
      );
      assert.equal(
        cliHttpV1Validators[fixture.definition](fixture.value),
        true,
        `new CLI accepts old server: ${fixture.name}`,
      );
      serverCompatibilityCases += 1;
    }
  }
  assert.ok(serverCompatibilityCases > 0, "compatibility cases must run without --server-dir");

  if (values.cli) {
    let response;
    const requestedPaths = [];
    const server = createServer((request, reply) => {
      requestedPaths.push(request.url);
      reply.writeHead(200, { "content-type": "application/json" });
      reply.end(JSON.stringify(response));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    const site = `http://127.0.0.1:${server.address().port}`;
    const environment = {
      ...process.env,
      PRIM_API_URL: site,
      PRIM_TOKEN: "seed-metadata-e2e-synthetic-token",
      PRIM_CONFIG_DIR: join(output, "config"),
      PRIM_SETUP_DAEMON_DRAINS: "1",
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
      NO_COLOR: "1",
      TZ: "Pacific/Honolulu",
    };
    const run = (args) =>
      new Promise((done, reject) => {
        const child = spawn(process.execPath, [resolve(values.cli), ...args], {
          cwd: output,
          env: environment,
          timeout: 15_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (bytes) => {
          stdout += bytes;
        });
        child.stderr.on("data", (bytes) => {
          stderr += bytes;
        });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`CLI exited ${code}: ${stderr}`));
          else done({ stdout, stderr });
        });
      });
    try {
      for (const fixture of golden.cases) {
        response = showResponse(fixture.row);
        const show = await run(["decisions", "show", fixture.row.id]);
        assert.deepEqual(JSON.parse(show.stdout), response, `${fixture.name}: show stdout`);
        assert.equal(show.stderr.trimEnd(), fixture.expected.show, `${fixture.name}: show stderr`);
        response = { decisions: [fixture.row], viewerHasDecisions: true };
        const recent = await run(["decisions", "recent"]);
        assert.deepEqual(JSON.parse(recent.stdout), response, `${fixture.name}: recent stdout`);
        assert.equal(
          recent.stderr.trimEnd(),
          `[prim] recent · 1 decision(s)\n${fixture.expected.recent}`,
          `${fixture.name}: recent stderr`,
        );
        cliCommands += 2;
      }
      assert.equal(requestedPaths.length, cliCommands);
      assert.ok(requestedPaths.every((path) => path.startsWith("/api/cli/decisions/")));
    } finally {
      await new Promise((done, reject) =>
        server.close((error) => (error ? reject(error) : done())),
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify({ goldenCases: golden.cases.length, sharedCases: shared.cases.length, timezones: golden.timezones.length, serverCompatibilityCases, cliCommands, rawJsonPreserved: true })}\n`,
  );
} finally {
  Date.now = realNow;
  if (oldTimezone === undefined) Reflect.deleteProperty(process.env, "TZ");
  else process.env.TZ = oldTimezone;
  if (oldNoColor === undefined) Reflect.deleteProperty(process.env, "NO_COLOR");
  else process.env.NO_COLOR = oldNoColor;
  rmSync(output, { recursive: true, force: true });
}
