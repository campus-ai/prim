import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

const root = await mkdtemp(join(tmpdir(), "prim-m2m-runtime-"));
const config = join(root, "config");
const source = join(root, "installation");
const copied = join(root, "copied");
const secret = "synthetic-machine-secret";
const clientId = "client_runtime";
let exchanges = 0;
let heartbeats = 0;
let tokenStatus = 200;
let daemon;
let api;
let provider;
const pids = new Set();
const reports = [];
try {
  await mkdir(config, { mode: 0o700 });
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(root, "key.pem"),
      "-out",
      join(root, "cert.pem"),
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  provider = httpsServer(
    { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
    async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      assert.equal(req.url, "/oauth2/token");
      assert.ok(new URLSearchParams(body).get("client_secret")?.startsWith(secret));
      exchanges++;
      if (tokenStatus !== 200) {
        res.writeHead(tokenStatus, { "Retry-After": "120" });
        res.end("{}");
        return;
      }
      const claims = {
        iss: issuer,
        aud: "client_environment",
        sub: clientId,
        client_id: clientId,
        org_id: "org_runtime",
        exp: Math.floor(Date.now() / 1000) + 3600,
      };
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.fixture-${exchanges}`,
          token_type: "bearer",
          expires_in: 3600,
        }),
      );
    },
  );
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const issuer = `https://127.0.0.1:${provider.address().port}`;
  api = httpServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/m2m/config")) {
      res.end(JSON.stringify({ protocol_version: 1, issuer, audience: "client_environment" }));
      return;
    }
    if (req.url.endsWith("/auth/status")) {
      res.end(
        JSON.stringify({
          authenticated: true,
          captureAuthorityKind: "workos_m2m",
          organizationBindingVersion: 2,
          organizationId: "organization_runtime",
          workosOrganizationId: "org_runtime",
          principal: {
            kind: "machine",
            machineId: "machine_runtime",
            clientId,
            displayName: "Runtime fixture",
            scopes: ["cli:read", "cli:presence", "cli:capture"],
          },
        }),
      );
      return;
    }
    if (req.url.includes("presence/heartbeat")) {
      assert.ok(req.headers.authorization?.startsWith("Bearer "));
      heartbeats++;
      res.end(JSON.stringify({ accepted: true, onlineCount: 1, onlineNames: [] }));
      return;
    }
    res.end(JSON.stringify({ decisions: [], hasMore: false }));
  });
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  await mkdir(source);
  await cp(resolve("dist/hook-runtime"), join(source, "dist"), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "@primitive.ai/prim",
      type: "module",
      version: "0.0.1",
      bin: { prim: "dist/index.js", "prim-daemon-server": "dist/daemon/server.js" },
    }),
  );
  await cp(source, copied, { recursive: true });
  await rm(source, { recursive: true });
  const env = {
    ...process.env,
    PRIM_TOKEN: "",
    PRIM_CONFIG_DIR: config,
    PRIM_API_URL: `http://127.0.0.1:${api.address().port}`,
    PRIM_M2M_CLIENT_ID: clientId,
    PRIM_M2M_CLIENT_SECRET: secret,
    NODE_EXTRA_CA_CERTS: join(root, "cert.pem"),
    NO_UPDATE_NOTIFIER: "1",
    CI: "1",
  };
  const status = async (overrides = {}) => {
    const result = await promisify(execFile)(
      process.execPath,
      [join(copied, "dist/index.js"), "auth", "status", "--json"],
      { env: { ...env, ...overrides }, timeout: 15000 },
    );
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret));
    return JSON.parse(result.stdout);
  };
  const statuses = await Promise.all(Array.from({ length: 6 }, () => status()));
  assert.ok(statuses.every((value) => value.status === "valid"));
  assert.equal(exchanges, 1, "fresh processes must share the broker's token");
  reports.push(
    "concurrent processes share one exchange",
    "copied runtime survives original removal",
  );
  const startDaemon = async () => {
    daemon = spawn(
      process.execPath,
      [join(copied, "dist/index.js"), "daemon", "start", "--foreground"],
      { env, stdio: "ignore" },
    );
    pids.add(daemon.pid);
    for (let i = 0; i < 100 && heartbeats === 0; i++) await delay(50);
    assert.ok(heartbeats > 0, "environment-inheriting daemon must authenticate a heartbeat");
  };
  await startDaemon();
  daemon.kill();
  await once(daemon, "exit");
  heartbeats = 0;
  await startDaemon();
  assert.equal(exchanges, 1, "daemon restart must reuse the shared token");
  reports.push("daemon inherits machine identity and survives restart");
  daemon.kill();
  await once(daemon, "exit");
  daemon = undefined;
  await status({ PRIM_M2M_CLIENT_SECRET: `${secret}-rotated` });
  assert.equal(exchanges, 2, "secret rotation must use a new broker generation");
  reports.push("secret rotation invalidates the token cache");
  tokenStatus = 429;
  const limited = { PRIM_M2M_CLIENT_SECRET: `${secret}-limited` };
  await status(limited).catch(() => undefined);
  const afterRateLimit = exchanges;
  await status(limited).catch(() => undefined);
  assert.equal(exchanges, afterRateLimit, "fresh processes must honor shared Retry-After");
  reports.push("rate-limit cooldown survives fresh processes");
  for (const name of await readdir(config)) {
    const path = join(config, name);
    if (name.startsWith("machine_broker_")) pids.add(JSON.parse(await readFile(path, "utf8")).pid);
    if (name.endsWith(".json")) {
      const contents = await readFile(path, "utf8");
      assert.ok(
        !contents.includes(secret) &&
          !contents.includes("accessToken") &&
          !contents.includes("header."),
        `${name} persisted credentials`,
      );
    }
  }
  reports.push("no injected secrets or tokens persisted");
  process.stdout.write(`${JSON.stringify({ passed: true, cases: reports })}\n`);
} finally {
  daemon?.kill();
  for (const name of await readdir(config).catch(() => [])) {
    if (name.startsWith("machine_broker_")) {
      const descriptor = JSON.parse(await readFile(join(config, name), "utf8"));
      pids.add(descriptor.pid);
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  api?.closeAllConnections();
  api?.close();
  provider?.closeAllConnections();
  provider?.close();
  await delay(100);
  await rm(root, { recursive: true, force: true });
}
