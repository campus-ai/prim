import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let cli = join(repo, "dist/index.js");
const require = createRequire(import.meta.url);
const { build } = require(
  require.resolve("esbuild", { paths: [dirname(require.resolve("tsup"))] }),
);
const root = await mkdtemp(join(tmpdir(), "prim-maintenance-e2e-"));
const cacheRoot = join(repo, "node_modules", ".cache");
await mkdir(cacheRoot, { recursive: true });
const compiled = await mkdtemp(join(cacheRoot, "maintenance-"));
const driver = join(compiled, "driver.mjs");
const children = new Set();
const reports = [];
let requests = 0;
let pending = [];
let holdIngest = false;
const api = createServer(async (req, res) => {
  requests++;
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/api/cli/auth/status") {
    res.end(
      JSON.stringify({
        authenticated: true,
        organizationBindingVersion: 1,
        captureAuthorityKind: "service_token",
        organizationId: "org_fixture",
        workosOrganizationId: "org_workos",
      }),
    );
  } else if (req.url === "/api/cli/moves/ingest") {
    const ack = () =>
      res.end(
        JSON.stringify({ disposition: "persisted", acknowledged: JSON.parse(body).batch.length }),
      );
    if (holdIngest) pending.push(ack);
    else ack();
  } else {
    res.writeHead(404);
    res.end("{}");
  }
});
await new Promise((done) => api.listen(0, "127.0.0.1", done));
const apiUrl = `http://127.0.0.1:${api.address().port}`;
const slug = apiUrl
  .replace(/^https?:\/\//, "")
  .replace(/[^a-zA-Z0-9._-]/g, "_")
  .toLowerCase();

async function profile(name) {
  const config = join(root, name);
  await mkdir(config, { mode: 0o700 });
  return config;
}
function launch(config, args, fixture = false) {
  // Whitelist environment: never inherit real Prim authority, HOME, or agent settings.
  const child = spawn(process.execPath, [fixture ? driver : cli, ...args], {
    cwd: root,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: root,
      PRIM_CONFIG_DIR: config,
      PRIM_API_URL: apiUrl,
      PRIM_TOKEN: "synthetic-maintenance-token",
      CI: "1",
      NO_UPDATE_NOTIFIER: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
  const done = once(child, "close").then(([code, signal]) => {
    clearTimeout(timer);
    children.delete(child);
    assert.equal(signal, null, `subprocess interrupted: ${stderr}`);
    return {
      code,
      stdout,
      stderr,
      json: stdout.trim() ? JSON.parse(stdout.trim().split("\n").at(-1)) : null,
    };
  });
  return { child, done, output: () => stdout };
}
async function run(config, args, expected = 0, fixture = false) {
  const result = await launch(config, args, fixture).done;
  assert.equal(result.code, expected, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  assert.ok(!result.stdout.includes("synthetic-maintenance-token"));
  return result.json;
}
async function waitUntil(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "process handshake timed out");
    await delay(10);
  }
}
async function write(config, path, bytes = "") {
  const target = join(config, path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, bytes, { mode: 0o600 });
  return target;
}
const command = (name, ...args) => ["migration", name, ...args];
try {
  await build({
    entryPoints: [join(repo, "scripts/fixtures/migration-maintenance-driver.mjs")],
    bundle: true,
    platform: "node",
    format: "esm",
    packages: "external",
    outfile: driver,
    logLevel: "silent",
  });
  if (process.argv[2] === "--staged") {
    const runtimeConfig = await profile("staged-runtime");
    const { version } = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
    const staged = await run(
      runtimeConfig,
      ["stage", join(repo, "dist/hook-runtime"), version],
      0,
      true,
    );
    cli = join(staged.releaseDir, "dist/index.js");
  }
  const config = await profile("basic");
  await write(config, "token", "retained-credential-sentinel");
  const before = requests;
  assert.equal((await run(config, command("status"))).ready, false);
  const pause = await run(config, command("pause"));
  assert.equal(pause.protocolVersion, 1);
  assert.equal(pause.ready, true);
  assert.equal(pause.scope, "cooperative-runtime-only");
  assert.equal(pause.legacySessionsMustBeClosed, true);
  assert.equal((await run(config, command("pause"))).maintenanceId, pause.maintenanceId);
  assert.equal(requests, before, "maintenance inspection must not run startup network work");
  await run(config, command("ready", "--id", "0".repeat(32)), 1);
  await run(config, ["append"], 1, true);
  await run(config, ["flush"], 1, true);
  assert.equal((await run(config, command("ready", "--id", pause.maintenanceId))).ready, true);
  const transaction = launch(config, ["transaction", pause.maintenanceId], true);
  await waitUntil(() => transaction.output().includes('"held":true'));
  const resume = launch(config, command("resume", "--id", pause.maintenanceId));
  await delay(120);
  assert.ok(
    await readFile(join(config, "migration-maintenance.json")),
    "resume must contend with handoff transaction",
  );
  transaction.child.stdin.write("release\n");
  assert.equal((await transaction.done).code, 0);
  assert.equal((await resume.done).code, 0);
  assert.equal(await readFile(join(config, "token"), "utf8"), "retained-credential-sentinel");
  reports.push(
    "durable identity, blocked writers/drains, offline status, transaction/resume exclusion, retained credentials",
  );

  const live = await profile("live");
  const holder = launch(live, ["hold"], true);
  await waitUntil(() => holder.output().includes('"held":true'));
  const blocked = await run(live, command("pause", "--timeout-ms", "0"), 1);
  assert.equal(blocked.activeLeases, 1);
  assert.equal(blocked.quiescent, false);
  await run(live, command("resume", "--id", blocked.maintenanceId), 1);
  holder.child.stdin.write("release\n");
  assert.equal((await holder.done).code, 0);
  assert.equal((await run(live, command("ready", "--id", blocked.maintenanceId))).ready, true);
  await run(live, command("resume", "--id", blocked.maintenanceId));
  const dead = launch(live, ["hold"], true);
  await waitUntil(() => dead.output().includes('"held":true'));
  // Expected kill: observe separately, replacing the normal successful-process assertion.
  const killed = dead.done.catch(() => undefined);
  dead.child.kill("SIGKILL");
  await killed;
  assert.equal((await run(live, command("pause"))).ready, true);
  reports.push("live operation blocks pause/resume; dead process lease reclaimed");

  const direct = await profile("direct");
  holdIngest = true;
  const deliveries = [launch(direct, ["deliver"], true), launch(direct, ["deliver"], true)];
  await waitUntil(() => pending.length === 2);
  const directPause = await run(direct, command("pause", "--timeout-ms", "0"), 1);
  assert.equal(
    directPause.activeLeases,
    2,
    "direct uploads must overlap without a full-request global lock",
  );
  const journal = join(direct, "moves", slug, "org_fixture", "journal.ndjson");
  assert.equal((await readFile(journal, "utf8")).trim().split("\n").length, 2);
  for (const ack of pending) ack();
  pending = [];
  holdIngest = false;
  for (const delivery of deliveries) assert.equal((await delivery.done).code, 0);
  assert.equal((await run(direct, command("status"))).quiescent, true);
  const foreign = await write(
    direct,
    "moves/other-api/_unbound/journal.ndjson",
    "retained-payload\n",
  );
  const partial = await run(direct, command("drain", "--id", directPause.maintenanceId), 1);
  assert.equal(partial.drain.flushed, 2);
  assert.equal(partial.ready, false);
  assert.equal(await readFile(foreign, "utf8"), "retained-payload\n");
  await rm(join(direct, "moves", "other-api"), { recursive: true });
  assert.equal(
    (await run(direct, command("ready", "--id", directPause.maintenanceId))).ready,
    true,
  );
  await run(direct, command("resume", "--id", directPause.maintenanceId));
  assert.equal((await run(direct, ["wrong-id"], 0, true)).rejected, true);
  reports.push(
    "overlapping real HTTP uploads remain admitted through ACK; explicit drain preserves foreign API/unbound queue",
  );

  const inventory = await profile("inventory");
  const ip = await run(inventory, command("pause"));
  for (const [path, body, reason] of [
    ["moves/api/org/journal.ndjson", "payload\n", "pending_journal"],
    ["moves/api/org/journal.ndjson.flushing.123", "", "retained_rotation"],
    ["moves/api/dead-letter/bad.ndjson", "", "quarantined_data"],
    ["moves/api/org/unknown", "", "unrecognized_or_retained_data"],
    ["moves/journal.ndjson", "legacy\n", "pending_journal"],
  ]) {
    const file = await write(inventory, path, body);
    const status = await run(inventory, command("ready", "--id", ip.maintenanceId), 1);
    assert.ok(status.blockers.some((row) => row.reason === reason));
    assert.ok(!JSON.stringify(status).includes("payload"));
    await rm(file);
  }
  await symlink(join(root, "missing"), join(inventory, "migration-activity"));
  await run(inventory, command("status"), 1);
  await rm(join(inventory, "migration-activity"));
  await write(inventory, "migration-activity/00000000000000000000000000000001.json", "{}");
  await run(inventory, command("status"), 1);
  await rm(join(inventory, "migration-activity"), { recursive: true });
  await symlink(join(root, "missing"), join(inventory, "moves", "link"));
  const linked = await run(inventory, command("ready", "--id", ip.maintenanceId), 1);
  assert.equal(linked.inventoryComplete, false);
  await rm(join(inventory, "moves", "link"));
  await write(inventory, "moves/a/b/c/d/e/f/journal.ndjson");
  assert.equal((await run(inventory, command("status"))).inventoryComplete, false);
  await rm(join(inventory, "moves", "a"), { recursive: true });
  await chmod(inventory, 0o777);
  await run(inventory, command("status"), 1);
  await chmod(inventory, 0o700);
  assert.equal((await run(inventory, command("ready", "--id", ip.maintenanceId))).ready, true);
  reports.push(
    "retained rotations/quarantine/unknown/unpartitioned data and malformed/symlink/deep/insecure control state fail closed",
  );

  // A very old lease owned by a live/reused PID must never be expired by age.
  const oldLease = await write(
    inventory,
    "migration-activity/00000000000000000000000000000002.json",
    JSON.stringify({
      version: 1,
      id: "00000000000000000000000000000002",
      createdAt: 1,
      pid: process.pid,
      kind: "append",
    }),
  );
  assert.equal((await run(inventory, command("status"))).activeLeases, 1);
  await rm(oldLease);
  const hugePid = await write(
    inventory,
    "migration-activity/00000000000000000000000000000003.json",
    JSON.stringify({
      version: 1,
      id: "00000000000000000000000000000003",
      createdAt: 1,
      pid: Number.MAX_SAFE_INTEGER,
      kind: "append",
    }),
  );
  await run(inventory, command("status"), 1);
  assert.ok(await readFile(hugePid), "malformed PID must not be reaped as a dead process");
  await rm(hugePid);
  const statePath = join(inventory, "migration-maintenance.json");
  const originalState = await readFile(statePath);
  await writeFile(statePath, "sensitive-invalid-json-sentinel");
  const malformed = await run(inventory, command("status"), 1);
  assert.ok(!JSON.stringify(malformed).includes("sensitive-invalid-json-sentinel"));
  await writeFile(statePath, "x".repeat(4097));
  await run(inventory, command("status"), 1);
  await writeFile(statePath, originalState);
  const boundDir = join(inventory, "moves", "bound");
  await mkdir(boundDir, { mode: 0o700 });
  for (let i = 0; i < 4097; i++) await writeFile(join(boundDir, String(i)), "", { mode: 0o600 });
  assert.equal((await run(inventory, command("status"))).inventoryComplete, false);
  await rm(boundDir, { recursive: true });
  reports.push(
    "live PID reuse stays blocked; oversized/malformed records redact content; whole-tree inventory bound enforced",
  );

  const reserved = await profile("reserved");
  const reservedPause = await run(reserved, command("pause"));
  const transactionDir = await profile("transaction");
  const reserving = launch(
    reserved,
    ["reserve", reservedPause.maintenanceId, transactionDir],
    true,
  );
  await waitUntil(() => reserving.output().includes('"held":true'));
  const crashed = reserving.done.catch(() => undefined);
  reserving.child.kill("SIGKILL");
  await crashed;
  const reservedStatus = await run(reserved, command("status"));
  assert.equal(reservedStatus.handoffReserved, true);
  await run(reserved, command("resume", "--id", reservedPause.maintenanceId), 1);
  await run(reserved, ["release", reservedPause.maintenanceId, transactionDir], 0, true);
  await run(reserved, command("resume", "--id", reservedPause.maintenanceId));
  reports.push(
    "durable handoff reservation blocks resume after coordinator SIGKILL until guarded release",
  );

  const nested = await profile("nested");
  const nestedWriter = launch(nested, ["nested"], true);
  await waitUntil(() => nestedWriter.output().includes('"held":true'));
  const nestedPause = await run(nested, command("pause", "--timeout-ms", "0"), 1);
  nestedWriter.child.stdin.write("release\n");
  const nestedResult = await nestedWriter.done;
  assert.equal(nestedResult.code, 1);
  assert.equal(nestedResult.json.error, "MaintenancePausedError");
  assert.match(nestedResult.stderr, /no new capture was acknowledged/);
  assert.equal(
    (await run(nested, command("ready", "--id", nestedPause.maintenanceId))).ready,
    true,
  );
  const flushLock = await write(
    nested,
    ".flush.lock/owner.json",
    JSON.stringify({ pid: process.pid, nonce: "held", createdAt: Date.now() }),
  );
  const skipped = await run(nested, command("drain", "--id", nestedPause.maintenanceId), 1);
  assert.equal(skipped.drain.skipped, true);
  await rm(dirname(flushLock), { recursive: true });
  reports.push(
    "nested append refuses without false capture ACK; contended empty drain cannot certify handoff",
  );

  const throughput = await profile("throughput");
  const start = performance.now();
  const captures = await Promise.all(
    Array.from({ length: 4 }, () => run(throughput, ["append", "25"], 0, true)),
  );
  assert.equal(captures.length, 4);
  const elapsedMs = Math.round(performance.now() - start);
  const capturedPath = join(throughput, "moves", slug, "org_fixture", "journal.ndjson");
  assert.equal((await readFile(capturedPath, "utf8")).trim().split("\n").length, 100);
  assert.equal((await readdir(join(throughput, "migration-activity"))).length, 0);
  process.stdout.write(
    `${JSON.stringify({ status: "pass", reports, concurrentCaptures: 100, elapsedMs, latencyQualification: "not-qualified" })}\n`,
  );
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const ack of pending) ack();
  api.closeAllConnections();
  await new Promise((done) => api.close(done));
  await rm(root, { recursive: true, force: true });
  await rm(compiled, { recursive: true, force: true });
}
