import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHmac } from "node:crypto";
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
let cloudApi;
// Set while the stand-in proxy plays an "OAuth 2.0 client credentials" network
// secret: it attaches the token to API requests, which this models by handing
// them to a face of the API that needs none.
let injecting = false;
const injectedPaths = [];
const cloudRequests = [];
// Hosts the stand-in proxy refuses, as the real one does a host that is not
// under the environment's Allowed domains, and what it has open to each.
const refused = new Set();
const openTunnels = new Set();
// The local port of each connection the proxy itself opened.
const proxyPeers = new Set();
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
      "subjectAltName=DNS:localhost,IP:127.0.0.1,DNS:api.prim.invalid,DNS:signin.prim.invalid",
    ],
    { stdio: "ignore" },
  );
  provider = httpsServer(
    { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
    async (req, res) => {
      // A reachability probe: any answer says the host can be reached.
      if (req.method === "GET") {
        res.writeHead(404).end();
        return;
      }
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
        // The name the client reached it by: the address, or the name only
        // the stand-in proxy resolves.
        iss: `https://${req.headers.host}`,
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
  // `face` is one way of reaching the API: the sign-in service it names, and
  // a record of what arrived there and from which local port.
  const serveApi = (viaInjectingProxy, face) => (req, res) => {
    face?.requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      peer: req.socket.remotePort,
    });
    res.setHeader("Content-Type", "application/json");
    if (req.url.endsWith("/m2m/config")) {
      res.end(
        JSON.stringify({
          protocol_version: 1,
          issuer: face?.issuer ?? issuer,
          audience: "client_environment",
        }),
      );
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
  // The API as a Claude Code cloud VM sees it: under a name its own DNS does
  // not resolve, which only the stand-in proxy reaches.
  cloudApi = httpsServer(
    { key: await readFile(join(root, "key.pem")), cert: await readFile(join(root, "cert.pem")) },
    serveApi(false, {
      issuer: `https://signin.prim.invalid:${provider.address().port}`,
      requests: cloudRequests,
    }),
  );
  cloudApi.listen(0, "127.0.0.1");
  await once(cloudApi, "listening");
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
  // While it plays a token-attaching secret, the proxy hands API requests to
  // the face of the API that needs no token, whichever way they arrive.
  const proxiedPort = (requested) =>
    injecting && Number(requested) === api.address().port
      ? injectedApi.address().port
      : Number(requested);
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
    const port = proxiedPort(target.port || 80);
    const { "proxy-connection": _hop, "proxy-authorization": _auth, ...headers } = request.headers;
    const upstream = httpRequest(
      {
        host: target.hostname,
        port,
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
    const [host, requested] = request.url.split(":");
    if (refused.has(host)) {
      tunnels.push(`refused ${request.url}`);
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    tunnels.push(request.url);
    const port = proxiedPort(requested);
    // Names under prim.invalid exist only here, as an allowed host does only
    // at the real proxy once a session's own DNS has gone stale.
    const upstream = connect(port, host.endsWith(".prim.invalid") ? "127.0.0.1" : host, () => {
      proxyPeers.add(upstream.localPort);
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const tunnel = { host, socket };
    openTunnels.add(tunnel);
    socket.on("close", () => {
      openTunnels.delete(tunnel);
      upstream.destroy();
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
  // A Claude Code cloud session with the secret in its variables. Such a VM's
  // own DNS resolves only the hosts allowed when the session was created,
  // while its proxy follows the allowlist as it is edited: here the API and
  // the sign-in service have names only the stand-in proxy resolves. Prim
  // must reach both through the proxy alone, token included.
  const cloudSecret = `${secret}-cloud`;
  const cloudApiHost = `api.prim.invalid:${cloudApi.address().port}`;
  const cloudSignInHost = `signin.prim.invalid:${provider.address().port}`;
  await mkdir(join(root, "home"));
  const cloudEnv = {
    ...networkEnv,
    HOME: join(root, "home"),
    PRIM_API_URL: `https://${cloudApiHost}`,
    PRIM_M2M_CLIENT_SECRET: cloudSecret,
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    NO_PROXY: "",
  };
  const cloudRun = (args, extra = {}) =>
    promisify(execFile)(process.execPath, [join(copied, "dist/index.js"), ...args], {
      env: { ...cloudEnv, ...extra },
      timeout: 15000,
    });
  const cloudStatus = async (extra) => {
    // A failing status exits non-zero and still prints its answer.
    const result = await cloudRun(["auth", "status", "--json"], extra).catch((error) => error);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(secret));
    return JSON.parse(result.stdout);
  };
  const brokerDescriptors = async () =>
    (await readdir(config)).filter((name) => name.startsWith("machine_broker_"));
  // Control: outside a cloud session prim connects by itself, and cannot.
  const unrouted = await cloudStatus({});
  assert.equal(
    unrouted.status,
    "unreachable",
    `a direct connection must not resolve the cloud API's name: ${JSON.stringify(unrouted)}`,
  );
  assert.deepEqual(cloudRequests, [], "nothing reaches the cloud API without the proxy");
  const unroutedBrokers = await brokerDescriptors();
  // As `prim setup --cloud` does: the failure above left a cooldown behind.
  for (const name of await readdir(config))
    if (name.startsWith("machine_retry_")) await rm(join(config, name));
  const exchangesBeforeCloud = exchanges;
  const inSession = { CLAUDE_CODE_REMOTE: "true" };
  const cloudStatuses = await Promise.all(Array.from({ length: 4 }, () => cloudStatus(inSession)));
  assert.ok(
    cloudStatuses.every(
      (value) => value.status === "valid" && value.machineId === "machine_runtime",
    ),
    `cloud status through the proxy: ${JSON.stringify(cloudStatuses)}; requests ${JSON.stringify(tunnels)}`,
  );
  assert.equal(exchanges, exchangesBeforeCloud + 1, "cloud processes share one routed exchange");
  const routedBrokers = (await brokerDescriptors()).filter(
    (name) => !unroutedBrokers.includes(name),
  );
  assert.equal(
    routedBrokers.length,
    1,
    "a cloud session must start its own broker, never reuse one started without routing",
  );
  assert.ok(
    tunnels.includes(cloudSignInHost) && tunnels.includes(cloudApiHost),
    `the token exchange and the API requests must travel through the proxy: ${JSON.stringify(tunnels)}`,
  );
  await cloudRun(["decisions", "recent"], inSession);
  const authenticated = cloudRequests.filter(({ url }) => !url.endsWith("/m2m/config"));
  assert.ok(
    authenticated.filter(({ url }) => url.endsWith("/auth/status")).length >= 2,
    "the broker's identity check and the command's own must both reach the API",
  );
  assert.ok(
    authenticated.some(({ url }) => url.includes("/decisions")),
    `a forwarded API read must reach the API: ${JSON.stringify(authenticated.map(({ url }) => url))}`,
  );
  assert.ok(
    authenticated.every(({ authorization }) => authorization?.startsWith("Bearer header.")),
    "the API must receive prim's bearer token on every forwarded request",
  );
  assert.ok(
    cloudRequests.every(({ peer }) => proxyPeers.has(peer)),
    "no prim process may connect to the API except through the proxy",
  );
  reports.push(
    "cloud session with the secret in variables exchanges and forwards only through the proxy",
  );
  // Loopback stays off the proxy even in a VM that routes every Node process.
  const routedBroker = JSON.parse(await readFile(join(config, routedBrokers[0]), "utf8"));
  const everywhere = await cloudStatus({ ...inSession, NODE_USE_ENV_PROXY: "1" });
  assert.equal(everywhere.status, "valid", JSON.stringify(everywhere));
  assert.ok(
    !tunnels.some((entry) => entry.includes(`:${routedBroker.port}`)),
    "a caller must reach the broker over loopback, never through the proxy",
  );
  reports.push("cloud callers reach the broker over loopback whatever NO_PROXY says");
  // What the broker can reach is what prim can reach: ask it as the session
  // diagnosis does, then take hosts off the stand-in proxy's allowlist.
  const proof = (purpose, text) =>
    createHmac("sha256", cloudSecret)
      .update(`${routedBroker.nonce}\0${purpose}\0${text}`)
      .digest("hex");
  const brokerProbe = async () => {
    const body = JSON.stringify({
      generation: routedBrokers[0].slice("machine_broker_".length, -".json".length),
      timestamp: Date.now(),
    });
    const response = await fetch(`http://127.0.0.1:${routedBroker.port}/probe`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "X-Prim-Proof": proof("probe-request", body) },
    });
    const envelope = await response.json();
    assert.equal(envelope.proof, proof("probe-answer", envelope.body), "the answer is signed");
    return JSON.parse(envelope.body);
  };
  const refuse = async (host) => {
    refused.add(host);
    // The proxy drops what it had open to a host it no longer allows.
    for (const tunnel of openTunnels) if (tunnel.host === host) tunnel.socket.destroy();
    await delay(200);
  };
  const signIn = (result) => ({ host: "signin.prim.invalid", result });
  assert.deepEqual(await brokerProbe(), { api: "ok", signIn: signIn("ok") });
  await refuse("signin.prim.invalid");
  assert.deepEqual(await brokerProbe(), { api: "ok", signIn: signIn("blocked") });
  await refuse("api.prim.invalid");
  assert.deepEqual(await brokerProbe(), { api: "blocked" });
  refused.clear();
  reports.push(
    "the broker reports a host the proxy allows as reachable and one it refuses as blocked",
  );
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
  cloudApi?.closeAllConnections();
  cloudApi?.close();
  await delay(100);
  await rm(root, { recursive: true, force: true });
}
