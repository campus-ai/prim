import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { request as httpRequest, createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
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
let networkExchanges = 0;
let heartbeats = 0;
let tokenStatus = 200;
let daemon;
let api;
let provider;
let proxy;
let injectedApi;
// Set while the stand-in proxy plays an "OAuth 2.0 client credentials" network
// secret: it attaches the token to API requests, which this models by handing
// them to a face of the API that needs none.
let injecting = false;
const injectedPaths = [];
const tunnels = [];
let proxyConnections = 0;
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
      // Network-secret mode: the proxy (absent here) would add HTTP Basic, and
      // the body must carry no credential at all.
      if (body === "grant_type=client_credentials") networkExchanges++;
      else assert.ok(new URLSearchParams(body).get("client_secret")?.startsWith(secret));
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
  const serveApi = (viaInjectingProxy) => (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/m2m/config")) {
      res.end(JSON.stringify({ protocol_version: 1, issuer, audience: "client_environment" }));
      return;
    }
    if (viaInjectingProxy) {
      // The proxy attaches the token after the request leaves the VM; what
      // prim itself sent must carry none.
      assert.equal(req.headers.authorization, undefined, "prim must send no credential");
      injectedPaths.push(req.url);
    } else if (!req.headers.authorization?.startsWith("Bearer ")) {
      res.writeHead(401).end("{}");
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
  };
  api = httpServer(serveApi(false));
  api.listen(0, "127.0.0.1");
  await once(api, "listening");
  injectedApi = httpServer(serveApi(true));
  injectedApi.listen(0, "127.0.0.1");
  await once(injectedApi, "listening");
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
  // Stands in for the cloud environment's proxy: it records each request and
  // passes it on. The real one adds the client secret on the way. A client
  // may open a CONNECT tunnel, or hand a plain-HTTP request over whole with
  // the full URL on its request line; both are a request "through the proxy".
  proxy = httpServer((request, response) => {
    let target;
    try {
      target = new URL(request.url);
    } catch {
      tunnels.push(`unroutable ${request.method} ${request.url}`);
      response.writeHead(400).end();
      return;
    }
    tunnels.push(target.host);
    const { "proxy-connection": _hop, "proxy-authorization": _auth, ...headers } = request.headers;
    const upstream = httpRequest(
      {
        host: target.hostname,
        port: target.port || 80,
        method: request.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (answer) => {
        response.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      tunnels.push(`${target.host} upstream ${error.code ?? error.message}`);
      response.writeHead(502).end();
    });
    request.pipe(upstream);
  });
  proxy.on("connection", () => proxyConnections++);
  proxy.on("connect", (request, socket, head) => {
    tunnels.push(request.url);
    const [host, requested] = request.url.split(":");
    const port =
      injecting && Number(requested) === api.address().port
        ? injectedApi.address().port
        : Number(requested);
    const upstream = connect(port, host, () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", (error) => {
      tunnels.push(`${request.url} upstream ${error.code ?? error.message}`);
      socket.destroy();
    });
    socket.on("error", () => upstream.destroy());
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const {
    PRIM_M2M_CLIENT_SECRET: _secret,
    NODE_USE_ENV_PROXY: _routed,
    NODE_OPTIONS: _options,
    http_proxy: _http,
    https_proxy: _https,
    no_proxy: _no,
    ...networkEnv
  } = env;
  const networkStatus = async () => {
    const result = await promisify(execFile)(
      process.execPath,
      [join(copied, "dist/index.js"), "auth", "status", "--json"],
      {
        // As in a cloud VM whose variables name no Node proxy setting: a
        // proxy is configured, and nothing tells the caller's Node to use it.
        env: {
          ...networkEnv,
          PRIM_M2M_CLIENT_AUTH: "network-secret",
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: "",
        },
        timeout: 15000,
      },
    );
    return JSON.parse(result.stdout);
  };
  // A failing status exits non-zero; keep its answer so the assertion can say
  // what the broker reached.
  const networkStatuses = await Promise.all(
    Array.from({ length: 4 }, () =>
      networkStatus().catch((error) => ({ failed: error.stdout || String(error) })),
    ),
  );
  assert.ok(
    networkStatuses.every((value) => value.status === "valid"),
    `network-secret status through the proxy: ${JSON.stringify(networkStatuses)}; proxy connections ${proxyConnections}, requests ${JSON.stringify(tunnels)}; credential-free exchanges ${networkExchanges}; brokers ${JSON.stringify((await readdir(config)).filter((name) => name.startsWith("machine_broker_")))}`,
  );
  assert.equal(networkExchanges, 1, "network-secret processes must share one broker exchange");
  assert.ok(
    tunnels.includes(`127.0.0.1:${provider.address().port}`),
    "the broker must send its token request through the environment's proxy by itself",
  );
  reports.push("network-secret broker routes its token request through the proxy unaided");
  const keys = (await readdir(config)).filter((name) => name.endsWith(".key"));
  assert.equal(keys.length, 1, "network-secret processes must agree on one broker key");
  reports.push("network-secret processes share one key and one credential-free exchange");
  // Network-token mode: the proxy holds the token as well. Prim requests none,
  // and every API request reaches the API only through the broker and the
  // proxy; a request prim made directly would arrive without a token (401).
  injecting = true;
  const exchangesBeforeTokenMode = exchanges;
  const tokenModeEnv = {
    ...networkEnv,
    PRIM_M2M_CLIENT_AUTH: "network-token",
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "",
  };
  const tokenModeStatus = async () =>
    JSON.parse(
      (
        await promisify(execFile)(
          process.execPath,
          [join(copied, "dist/index.js"), "auth", "status", "--json"],
          { env: tokenModeEnv, timeout: 15000 },
        )
      ).stdout,
    );
  const tokenModeStatuses = await Promise.all(Array.from({ length: 4 }, () => tokenModeStatus()));
  assert.ok(
    tokenModeStatuses.every(
      (value) => value.status === "valid" && value.machineId === "machine_runtime",
    ),
    `network-token status must verify through the proxy: ${JSON.stringify(tokenModeStatuses[0])}`,
  );
  assert.equal(exchanges, exchangesBeforeTokenMode, "network-token mode must request no token");
  assert.ok(
    injectedPaths.filter((path) => path.endsWith("/auth/status")).length >= 2,
    "the broker's identity check and the command's own must both pass through the proxy",
  );
  const readsBefore = injectedPaths.length;
  const read = await promisify(execFile)(
    process.execPath,
    [join(copied, "dist/index.js"), "decisions", "recent"],
    { env: tokenModeEnv, timeout: 15000 },
  );
  assert.ok(injectedPaths.length > readsBefore, "an API read must pass through the proxy");
  assert.ok(!read.stdout.includes("Bearer") && !read.stderr.includes("Bearer"));
  injecting = false;
  reports.push("network-token mode requests no token and reaches the API only through the proxy");
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
  proxy?.closeAllConnections();
  proxy?.close();
  injectedApi?.closeAllConnections();
  injectedApi?.close();
  await delay(100);
  await rm(root, { recursive: true, force: true });
}
