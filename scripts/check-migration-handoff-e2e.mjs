/** Process E2E: shipped CLIs and real files; native authority is a synthetic Unix RPC fixture. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYAML } from "yaml";

const { values } = parseArgs({
  options: {
    "native-cli": { type: "string" },
    "native-runtime": { type: "string" },
    "husky-only": { type: "boolean", default: false },
    report: { type: "string" },
  },
});
assert.ok(
  values["native-cli"] && values["native-runtime"],
  "Pass --native-cli and --native-runtime",
);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeCLI = await realpath(resolve(values["native-cli"]));
const nativeRuntime = await realpath(resolve(values["native-runtime"]));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const legacyCLI = join(repo, "dist/index.js");
const legacyCLIHash = digest(await readFile(legacyCLI));
const pins = {
  cli: digest(await readFile(nativeCLI)),
  runtime: digest(await readFile(nativeRuntime)),
};
const root = await mkdtemp(join(await realpath(tmpdir()), "mh-e2e-"));
await chmod(root, 0o700);
const children = new Set();
const sockets = new Set();
const heldReplies = [];
const reports = [];
const refusals = [];
const forbidden = "synthetic-private-credential-sentinel";
const authority = {
  authenticated: true,
  organizationBindingVersion: 3,
  captureAuthorityKind: "workos_m2m",
  organizationId: "org_fixture",
  workosOrganizationId: "org_workos_fixture",
  principal: {
    kind: "machine",
    machineId: "machine_fixture",
    clientId: "client_fixture",
    authorizedUserId: "user_fixture",
  },
};
const state = {
  stopped: false,
  epoch: randomUUID(),
  pending: 0,
  quarantined: 0,
  authority,
  methods: [],
  hold: null,
  held: false,
};
const socketPath = join(root, "rpc.sock");
const server = createServer((socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => {});
  let input = "";
  socket.on("data", (chunk) => {
    input += chunk;
    if (!input.includes("\n")) return;
    const request = JSON.parse(input.slice(0, input.indexOf("\n")));
    state.methods.push(request.method);
    const status = () => ({
      stopped: state.stopped,
      outboxPending: state.pending,
      outboxQuarantined: state.quarantined,
      runtimeEpoch: state.epoch,
    });
    let result;
    let error;
    switch (request.method) {
      case "hello":
        result = { protocolVersion: 1, backendContractVersion: 9, capabilities: ["explicit_quit"] };
        break;
      case "status": {
        if (state.hold) {
          try {
            const record = JSON.parse(
              readFileSync(join(state.hold.directory, "transaction.json"), "utf8"),
            );
            if (record.state === state.hold.phase && record.completed < state.hold.boundary)
              state.hold.armed = true;
            if (
              state.hold.armed &&
              record.state === state.hold.phase &&
              record.completed >= state.hold.boundary
            ) {
              state.held = true;
              heldReplies.push({ socket, request, result: status() });
              return; // An actual RPC waits here; the parent kills only its own handoff process.
            }
          } catch {
            /* The transaction has not reached this boundary. */
          }
        }
        result = status();
        break;
      }
      case "auth.verify":
        if (state.stopped)
          error = { code: "stopped", message: "Start before verifying sign-in", retryable: false };
        else result = { state: "authenticated", organizationBindingVersion: 3, refreshed: false };
        break;
      case "auth.status":
        result = {
          authenticated: true,
          state: "authenticated",
          siteUrl: "https://fixture.invalid",
          authority: state.authority,
        };
        break;
      case "quit":
        state.stopped = !state.rejectQuit;
        result = status();
        break;
      default:
        error = { code: "fixture_method_not_supported", message: request.method, retryable: false };
    }
    socket.end(
      `${JSON.stringify({ version: 1, id: request.id, ok: !error, ...(error ? { error } : { result }) })}\n`,
    );
  });
});
await new Promise((done) => server.listen(socketPath, done));
await chmod(socketPath, 0o600);

async function write(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`, {
    mode,
  });
  await chmod(path, mode);
}
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
function env(home, config) {
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    PRIM_CONFIG_DIR: config,
    PRIM_API_URL: "http://127.0.0.1:1",
    PRIM_TOKEN: forbidden,
    PRIM_UNINSTALL_ORCHESTRATOR: "1",
    CI: "1",
    NO_UPDATE_NOTIFIER: "1",
  };
}
function launch(fixture, args, binary = process.execPath) {
  const argv = binary === process.execPath ? [legacyCLI, ...args] : args;
  const child = spawn(binary, argv, {
    cwd: fixture.project,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
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
  const timer = setTimeout(() => child.kill("SIGKILL"), 90000);
  const done = once(child, "close").then(([code, signal]) => {
    clearTimeout(timer);
    children.delete(child);
    assert.ok(
      !stdout.includes(forbidden) && !stderr.includes(forbidden),
      "Private fixture material leaked to command output",
    );
    return { code, signal, stdout, stderr };
  });
  return { child, done };
}
async function command(fixture, args, expected = 0, binary = process.execPath) {
  const result = await launch(fixture, args, binary).done;
  assert.equal(result.signal, null, `Unexpected command signal: ${args.join(" ")}`);
  assert.equal(result.code, expected, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return result;
}
async function cli(fixture, args, expected = 0) {
  const result = await command(fixture, ["migration", ...args], expected);
  return JSON.parse(result.stdout);
}
async function waitUntil(check, label) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, `${label} timed out`);
    await delay(10);
  }
}
function globalHook(event, block) {
  const guard =
    event === "pre-commit"
      ? ""
      : ` && ! grep -Fq '# >>> prim ${event} hook '">>>" "$repo_hook" 2>/dev/null`;
  return `#!/bin/sh\n${block}\n# prim global ${event} hook (core.hooksPath) — managed by prim; do not edit.\n# Install/uninstall: prim hooks install|uninstall --scope user\n# Runs prim only where activated — 'prim enable' (this repo) or\n# 'git config --global prim.active true' (every repo). Chains to the repo's own\n# hook regardless, so inactive repos are unaffected.\ncommon_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0\nrepo_hook="$common_dir/hooks/${event}"\nif [ -x "$repo_hook" ] && ! grep -q 'prim-managed-hook' "$repo_hook" 2>/dev/null${guard}; then\n  "$repo_hook" "$@" ${event === "pre-commit" ? "|| exit $?" : "|| true"}\nfi\nexit 0\n`;
}
async function createFixture(index) {
  const home = join(root, `home-${index}`);
  const project = join(home, "repo");
  const config = join(home, ".config", "prim");
  await mkdir(project, { recursive: true, mode: 0o700 });
  await mkdir(config, { recursive: true, mode: 0o700 });
  const fixture = {
    home,
    project,
    config,
    env: env(home, config),
    originals: new Map(),
    targets: [],
  };
  await command(fixture, ["init", "--quiet", project], 0, "/usr/bin/git");
  await write(join(config, "token"), forbidden);
  const agents = ["claude", "codex", "cursor", "hermes"];
  const agentDirectories = Object.fromEntries(
    agents.map((agent) => [agent, join(home, `.${agent}`)]),
  );
  for (const agent of agents) {
    for (const scope of agent === "hermes" ? ["user"] : ["user", "project"]) {
      const file =
        agent === "claude" ? "settings.json" : agent === "hermes" ? "config.yaml" : "hooks.json";
      const path = join(
        scope === "user" ? agentDirectories[agent] : join(project, `.${agent}`),
        file,
      );
      const event =
        agent === "hermes" ? "pre_tool_call" : agent === "cursor" ? "preToolUse" : "PreToolUse";
      const legacy =
        agent === "claude" || agent === "codex"
          ? { matcher: "*", hooks: [{ type: "command", command: "prim legacy-fixture" }] }
          : { command: "prim legacy-fixture" };
      const other =
        agent === "claude" || agent === "codex"
          ? { matcher: "*", hooks: [{ type: "command", command: "echo unrelated-fixture" }] }
          : { command: "echo unrelated-fixture" };
      const value = { fixtureUnrelated: `${agent}-${scope}`, hooks: { [event]: [legacy, other] } };
      await write(path, value);
      fixture.targets.push({ kind: "host", agent, path, removeHooks: { [event]: [legacy] } });
    }
  }
  const footer = join(agentDirectories.cursor, "cli-config.json");
  const oldFooter = { type: "command", command: "prim legacy-statusline" };
  await write(footer, { fixtureUnrelated: "cursor-footer", statusLine: oldFooter });
  fixture.targets.push({
    kind: "host",
    agent: "cursor",
    path: footer,
    removeHooks: {},
    removeStatusLine: oldFooter,
  });
  const globalDir = join(config, "git-hooks");
  await command(fixture, ["config", "--global", "core.hooksPath", globalDir], 0, "/usr/bin/git");
  for (const event of ["pre-commit", "post-commit", "post-rewrite"]) {
    const block = (await command(fixture, ["hooks", "snippet", event])).stdout.trimEnd();
    assert.ok(block.startsWith(`# >>> prim ${event} hook >>>`), "Shipped legacy snippet changed");
    const local = join(project, ".git", "hooks", event);
    await write(local, `#!/bin/sh\n${block}\nprintf 'unrelated-fixture\\n' >&2\n`, 0o755);
    fixture.targets.push({ kind: "git", path: local, removeBlock: block });
    const global = join(globalDir, event);
    const script = globalHook(event, block);
    await write(global, script, 0o755);
    fixture.targets.push({
      kind: "git",
      path: global,
      removeBlock: block,
      global: true,
      reviewedFileSha256: digest(script),
    });
  }
  if (index === 2 || index >= 4) {
    const hook = fixture.targets.find((target) => target.kind === "git" && !target.global);
    const source = join(project, ".husky", "pre-commit");
    await write(
      source,
      `#!/bin/sh\n${hook.removeBlock}\nprintf 'unrelated-fixture\\n' >&2\n`,
      0o755,
    );
    await write(
      join(project, ".husky", "_", "pre-commit"),
      '#!/bin/sh\nexec "$(dirname "$0")/../pre-commit" "$@"\n',
      0o755,
    );
    await command(fixture, ["config", "core.hooksPath", ".husky/_"], 0, "/usr/bin/git");
    fixture.targets.push({ kind: "git", path: source, removeBlock: hook.removeBlock });
  }
  const profile = join(home, "native-profile.json");
  const nativeState = join(home, "native-state");
  await mkdir(nativeState, { mode: 0o700 });
  await write(profile, {
    siteURL: "https://fixture.invalid",
    stateDirectory: nativeState,
    socketPath,
  });
  const paused = await cli(fixture, ["pause"]);
  assert.equal(paused.ready, true);
  fixture.maintenanceId = paused.maintenanceId;
  fixture.spec = {
    version: 1,
    legacyConfigRoot: config,
    maintenanceId: paused.maintenanceId,
    home,
    projects: [project],
    agentDirectories,
    operator: {
      legacySessionsClosed: true,
      nativeSessionsClosed: true,
      scopeComplete: true,
      noConcurrentStart: true,
    },
    native: {
      cli: nativeCLI,
      cliSha256: pins.cli,
      runtime: nativeRuntime,
      runtimeSha256: pins.runtime,
      profile,
      siteURL: "https://fixture.invalid",
      expectedAuthority: authority,
    },
    targets: fixture.targets,
    redactions: [],
  };
  fixture.specPath = join(home, "handoff-spec.json");
  await write(fixture.specPath, fixture.spec);
  for (const target of fixture.targets)
    fixture.originals.set(target.path, {
      bytes: await readFile(target.path),
      mode: (await stat(target.path)).mode & 0o777,
    });
  fixture.transaction = join(home, "transaction");
  return fixture;
}
async function prepare(fixture, directory = fixture.transaction, expected = 0) {
  return cli(
    fixture,
    ["handoff", "prepare", "--spec", fixture.specPath, "--transaction", directory],
    expected,
  );
}
async function change(fixture, direction, expected = 0) {
  return cli(fixture, ["handoff", direction, "--transaction", fixture.transaction], expected);
}
function refusal(value, name, reason) {
  assert.match(value.message, reason, `${name} rejected for an unexpected reason`);
  refusals.push(name);
}
async function unchanged(fixture) {
  for (const [path, before] of fixture.originals) {
    assert.deepEqual(await readFile(path), before.bytes, `Rollback bytes differ: ${path}`);
    assert.equal((await stat(path)).mode & 0o777, before.mode, `Rollback mode differs: ${path}`);
    assert.equal(
      await exists(`${path}.primitive-native.json`),
      false,
      `Rollback retained receipt: ${path}`,
    );
  }
  assert.equal(await readFile(join(fixture.config, "token"), "utf8"), forbidden);
}
async function applied(fixture) {
  for (const target of fixture.targets) {
    const text = await readFile(target.path, "utf8");
    if (target.kind === "host") {
      const value = target.agent === "hermes" ? parseYAML(text) : JSON.parse(text);
      assert.ok(value.fixtureUnrelated, "Unrelated host setting lost");
      assert.ok(!text.includes("legacy-fixture") && !text.includes("legacy-statusline"));
      if (basename(target.path) !== "cli-config.json") {
        assert.ok(text.includes("unrelated-fixture"), "Unrelated host hook lost");
        assert.ok(
          await exists(`${target.path}.primitive-native.json`),
          "Native ownership receipt missing",
        );
      }
    } else {
      assert.ok(text.includes("# BEGIN PRIMITIVE NATIVE"));
      assert.ok(!text.includes("# >>> prim"));
      if (!target.global) assert.ok(text.includes("unrelated-fixture"), "Unrelated Git tail lost");
    }
  }
  assert.equal((await cli(fixture, ["status"])).handoffReserved, true);
  await cli(fixture, ["resume", "--id", fixture.maintenanceId], 1);
}
async function interruptBoundary(fixture, direction, boundary) {
  state.held = false;
  state.hold = {
    directory: fixture.transaction,
    phase: direction === "apply" ? "applying" : "rolling-back",
    boundary,
    armed: false,
  };
  const attempt = launch(fixture, [
    "migration",
    "handoff",
    direction,
    "--transaction",
    fixture.transaction,
  ]);
  await waitUntil(() => state.held, `${direction} boundary ${boundary}`);
  attempt.child.kill("SIGKILL");
  const result = await attempt.done;
  assert.equal(result.signal, "SIGKILL");
  state.hold = null;
  for (const socket of sockets) socket.destroy();
  heldReplies.length = 0;
  await cli(fixture, ["resume", "--id", fixture.maintenanceId], 1);
  assert.equal((await cli(fixture, ["status"])).handoffReserved, true);
}
async function lateMutation(fixture, count, mutate, name, reason) {
  state.held = false;
  state.hold = { directory: fixture.transaction, phase: "applying", boundary: count, armed: false };
  const attempt = launch(fixture, [
    "migration",
    "handoff",
    "apply",
    "--transaction",
    fixture.transaction,
  ]);
  await waitUntil(() => state.held, name);
  await mutate();
  state.hold = null;
  for (const { socket, request, result } of heldReplies.splice(0))
    socket.end(`${JSON.stringify({ version: 1, id: request.id, ok: true, result })}\n`);
  const result = await attempt.done;
  assert.equal(result.signal, null);
  assert.equal(result.code, 1, `${name} unexpectedly committed: ${result.stdout}`);
  refusal(JSON.parse(result.stdout), name, reason);
  assert.equal((await cli(fixture, ["status"])).handoffReserved, true);
}

let succeeded = false;
try {
  for (const cycle of values["husky-only"] ? [4, 5] : [1, 2, 3, 4, 5]) {
    const fixture = await createFixture(cycle);
    state.stopped = false;
    state.epoch = randomUUID();
    state.authority = authority;
    if (cycle === 1) {
      const invalid = join(fixture.home, "invalid-spec.json");
      await write(invalid, `{"private":"${forbidden}"`);
      refusal(
        await cli(
          fixture,
          [
            "handoff",
            "prepare",
            "--spec",
            invalid,
            "--transaction",
            join(fixture.home, "reject-json"),
          ],
          1,
        ),
        "malformed-private-json-without-content-leak",
        /Malformed JSON/,
      );
      const global = fixture.targets.find((target) => target.kind === "git" && target.global);
      const previousHash = global.reviewedFileSha256;
      const custom = `${fixture.originals.get(global.path).bytes}echo unrelated-custom-tail\n`;
      await write(global.path, custom, 0o755);
      global.reviewedFileSha256 = digest(custom);
      await write(fixture.specPath, fixture.spec);
      refusal(
        await prepare(fixture, join(fixture.home, "reject-global-tail"), 1),
        "custom-global-hook-tail-retained",
        /Global chain replacement/,
      );
      assert.equal(await readFile(global.path, "utf8"), custom);
      await write(global.path, fixture.originals.get(global.path).bytes.toString("utf8"), 0o755);
      global.reviewedFileSha256 = previousHash;
      await write(fixture.specPath, fixture.spec);
      state.pending = 1;
      refusal(
        await prepare(fixture, join(fixture.home, "reject-pending"), 1),
        "native-pending-data",
        /pending or quarantined/,
      );
      state.pending = 0;
      state.quarantined = 1;
      refusal(
        await prepare(fixture, join(fixture.home, "reject-quarantine"), 1),
        "native-quarantined-data",
        /pending or quarantined/,
      );
      state.quarantined = 0;
      state.authority = { ...authority, organizationId: "org_other" };
      refusal(
        await prepare(fixture, join(fixture.home, "reject-authority"), 1),
        "changed-native-authority",
        /Protected native authority differs/,
      );
      state.authority = authority;
      state.rejectQuit = true;
      refusal(
        await prepare(fixture, join(fixture.home, "reject-unsettled-quit"), 1),
        "unsettled-native-quit",
        /Quit did not acknowledge/,
      );
      state.rejectQuit = false;
      await unchanged(fixture);
    }
    const prepared = await prepare(fixture);
    assert.equal(prepared.state, "prepared");
    assert.equal(state.stopped, true);
    await cli(fixture, ["resume", "--id", fixture.maintenanceId], 1);
    if (cycle === 1) {
      const first = fixture.targets[0].path;
      const external = `${(await readFile(first, "utf8")).trimEnd()}\n `;
      await write(first, external);
      refusal(
        await change(fixture, "apply", 1),
        "outside-config-edit-retained",
        /Outside edit retained/,
      );
      assert.equal(await readFile(first, "utf8"), external, "Outside edit overwritten");
      await write(first, fixture.originals.get(first).bytes.toString("utf8"));
      const nested = join(fixture.project, "new-workspace", ".prim", "redaction.json");
      await write(nested, { version: 1, rules: [] });
      refusal(
        await change(fixture, "apply", 1),
        "new-nested-privacy-rule",
        /redaction-go.json|privacy inventory changed/,
      );
      await rm(join(fixture.project, "new-workspace"), { recursive: true });
      const foreign = join(fixture.config, "moves", "foreign", "org", "journal.ndjson");
      await write(foreign, "retained-foreign-data\n");
      refusal(
        await change(fixture, "apply", 1),
        "foreign-legacy-queue-retained",
        /Maintenance is not quiescent and completely drained/,
      );
      assert.equal(await readFile(foreign, "utf8"), "retained-foreign-data\n");
      await rm(join(fixture.config, "moves"), { recursive: true });
    }
    const record = JSON.parse(
      await readFile(join(fixture.transaction, "transaction.json"), "utf8"),
    );
    if (cycle === 1) {
      const lock = `${fixture.targets[0].path}.primitive-lock`;
      for (const pid of [-1, Number.MAX_SAFE_INTEGER]) {
        await write(join(lock, "handoff-owner.json"), { id: record.id, pid });
        refusal(
          await change(fixture, "apply", 1),
          `malformed-lock-pid-${pid < 0 ? "negative" : "overflow"}`,
          /lock|owner|PID/i,
        );
        assert.equal(await exists(join(lock, "handoff-owner.json")), true);
        await rm(lock, { recursive: true });
      }
      const unknown = join(fixture.project, ".git", "hooks", "unexpected-hook");
      await lateMutation(
        fixture,
        record.entries.length,
        () => write(unknown, "#!/bin/sh\nprim unexpected-legacy-hook\n", 0o755),
        "late-unknown-git-hook",
        /inventory changed|Unreviewed Prim/,
      );
      await rm(unknown);
      const profile = fixture.spec.native.profile;
      const prior = await readFile(profile, "utf8");
      await lateMutation(
        fixture,
        record.entries.length,
        () => write(profile, `${prior} `),
        "late-profile-guard-edit",
        /inventory changed/,
      );
      await write(profile, prior);
    }
    if (cycle === 3)
      for (let boundary = 1; boundary <= record.entries.length; boundary++)
        await interruptBoundary(fixture, "apply", boundary);
    assert.equal((await change(fixture, "apply")).state, "applied");
    await applied(fixture);
    if (cycle >= 2) {
      state.epoch = randomUUID(); // A different owner process; no real runtime or credentials are involved.
      state.stopped = false;
    }
    if (cycle === 3)
      for (let boundary = 1; boundary <= record.entries.length; boundary++)
        await interruptBoundary(fixture, "rollback", boundary);
    assert.equal((await change(fixture, "rollback")).state, "rolled-back");
    await unchanged(fixture);
    assert.equal((await cli(fixture, ["status"])).handoffReserved, false);
    assert.equal((await cli(fixture, ["resume", "--id", fixture.maintenanceId])).paused, false);
    const finalStatus = await cli(fixture, [
      "handoff",
      "status",
      "--transaction",
      fixture.transaction,
    ]);
    assert.notEqual(
      finalStatus.legacyPaused,
      true,
      "Stored transaction status falsely claims a live pause",
    );
    reports.push({
      cycle,
      hostScopes: 7,
      cursorFooter: true,
      gitLocalEvents: 3,
      gitGlobalEvents: 3,
      huskySourceHooks: cycle === 2 || cycle >= 4 ? 1 : 0,
      integrationTargets: fixture.targets.length,
      transactionFiles: record.entries.length,
      interruptedBoundaries: cycle === 3 ? record.entries.length * 2 : 0,
      restartedOwnerRollback: cycle >= 2,
    });
    process.stderr.write(`[handoff-e2e] cycle ${cycle}/5 passed\n`);
  }
  assert.ok(!state.methods.includes("start"), "Coordinator must never start capture");
  assert.equal(
    digest(await readFile(legacyCLI)),
    legacyCLIHash,
    "Built legacy CLI changed during qualification",
  );
  const report = {
    status: "pass",
    qualification: "isolated-process-transaction",
    invocationMode: values["husky-only"]
      ? "additional-husky-cycles-4-and-5"
      : "full-five-cycle-suite",
    nativeAuthority: "synthetic-private-Unix-RPC-not-live-auth",
    nativeInstallers: "real-pinned-executables",
    legacyCLIHash,
    cliSha256: pins.cli,
    runtimeSha256: pins.runtime,
    cycles: reports,
    verifiedRefusals: refusals,
    authVerifyCalls: state.methods.filter((method) => method === "auth.verify").length,
    automaticStartCalls: 0,
    limitations: [
      "No Keychain, live authority, installed agent sessions or real native delivery were qualified",
      "RPC hold injection proves process interruption at target-file boundaries; it does not emulate physical power loss",
    ],
  };
  if (values.report) await write(resolve(values.report), report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  succeeded = true;
} catch (error) {
  if (values.report)
    await write(`${resolve(values.report)}.failure-${Date.now()}.json`, {
      status: "fail",
      qualification: "isolated-process-transaction",
      fixture: root,
      error: String(error.stack ?? error),
      completedCycles: reports,
    });
  process.stderr.write(
    `[handoff-e2e] failed: ${error.stack}\nSynthetic fixture retained at ${root}\n`,
  );
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGKILL");
  for (const socket of sockets) socket.destroy();
  await new Promise((done) => server.close(done));
  if (succeeded) await rm(root, { recursive: true, force: true });
}
