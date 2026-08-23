import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { describe, expect, it } from "vitest";
import { stageRuntime } from "./daemon/launchd.js";
import type { DaemonPrincipal } from "./daemon/principal.js";

type ChildResult = { code: number | null; stdout: string; stderr: string };
type RunningChild = {
  kill: () => void;
  exited: Promise<number | null>;
  stderr: () => string;
};

const TEST_ISSUER = "https://issuer.test";

function testJwt(subject: string, organizationId: string, generation: string): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(
      JSON.stringify({ iss: TEST_ISSUER, sub: subject, org_id: organizationId, generation }),
    ).toString("base64url"),
    "signature",
  ].join(".");
}

function daemonCaller(token: string, subject: string, organizationId: string): DaemonPrincipal {
  return {
    principalId: createHash("sha256").update(`${TEST_ISSUER}\0${subject}`).digest("hex"),
    organizationId,
    credentialFingerprint: createHash("sha256").update(token).digest("hex"),
  };
}

function runClientProcess(moduleUrl: string, home: string, apiUrl: string): Promise<ChildResult> {
  const source = `
    import { getClient } from ${JSON.stringify(moduleUrl)};
    const result = await getClient().get("/api/cli/protected");
    process.stdout.write(JSON.stringify(result));
  `;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PRIM_CONFIG_DIR: join(home, ".config", "prim"),
    PRIM_API_URL: apiUrl,
  };
  env.PRIM_TOKEN = undefined;

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
      cwd: home,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("client subprocess timed out"));
    }, 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function eventually(
  predicate: () => boolean,
  failure: () => string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function eventuallyValue<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  failure: () => string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const value = await read();
    if (predicate(value)) return value;
    if (Date.now() >= deadline) throw new Error(failure());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function runDaemonProcess(moduleUrl: string, home: string, apiUrl: string): RunningChild {
  const source = `
    const nativeSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (handler, delay, ...args) =>
      nativeSetTimeout(handler, delay === 60000 ? 20 : delay, ...args);
    await import(${JSON.stringify(moduleUrl)});
  `;
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PRIM_CONFIG_DIR: join(home, ".config", "prim"),
    PRIM_API_URL: apiUrl,
    PRIM_RUNTIME_VERSION: "test",
  };
  env.PRIM_TOKEN = undefined;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: home,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  return {
    kill: () => child.kill("SIGTERM"),
    exited,
    stderr: () => stderr,
  };
}

function daemonRequest(
  socketPath: string,
  method: string,
  params: Record<string, unknown> = {},
  caller?: DaemonPrincipal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let response = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error(`daemon request timed out: ${method}`));
    }, 2_000);
    socket.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method, params, ...(caller ? { caller } : {}) })}\n`);
    });
    socket.on("data", (chunk) => {
      response += chunk.toString();
      const newline = response.indexOf("\n");
      if (newline === -1) return;
      clearTimeout(timeout);
      socket.destroy();
      const parsed = JSON.parse(response.slice(0, newline)) as {
        ok: boolean;
        result?: Record<string, unknown>;
        error?: string;
      };
      if (!(parsed.ok && parsed.result)) {
        reject(new Error(parsed.error ?? `daemon request failed: ${method}`));
        return;
      }
      resolve(parsed.result);
    });
  });
}

function rawStatuslineRequest(socketPath: string, chunks: Buffer[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const response: Buffer[] = [];
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(Buffer.concat(response));
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      finish(new Error("raw statusline request timed out"));
    }, 3_000);
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => response.push(Buffer.from(chunk)));
    socket.once("end", () => finish());
    socket.once("connect", () => {
      let index = 0;
      const writeNext = (): void => {
        const chunk = chunks[index++];
        if (!chunk) return;
        socket.write(chunk, () => setImmediate(writeNext));
      };
      writeNext();
    });
  });
}

function statuslineRequest(cwd: string, apiUrl = ""): Buffer {
  return Buffer.from(`prim-statusline-v1\0${cwd}\0${apiUrl}\0`);
}

describe("cross-process browser credential rotation", () => {
  it("lets two real processes share one rotation and both use the winner access token", async () => {
    const home = mkdtempSync(join(tmpdir(), "prim-client-processes-"));
    const config = join(home, ".config", "prim");
    const bundleDir = join(home, "bundle");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "token"), "expired-access\n");
    writeFileSync(join(config, "refresh_token"), "generation-one\n");
    writeFileSync(join(config, "token_expires_at"), "0\n");

    let refreshCalls = 0;
    const protectedAuthorizations: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      if (request.method === "POST" && request.url === "/mcp/broker/refresh") {
        refreshCalls += 1;
        request.resume();
        setTimeout(() => {
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(
            JSON.stringify({
              access_token: "winner-access",
              refresh_token: "generation-two",
              expires_in: 300,
            }),
          );
        }, 200);
        return;
      }
      if (request.method === "GET" && request.url === "/api/cli/protected") {
        const authorization = request.headers.authorization;
        protectedAuthorizations.push(authorization);
        const accepted = authorization === "Bearer winner-access";
        response.writeHead(accepted ? 200 : 401, { "Content-Type": "application/json" });
        response.end(JSON.stringify(accepted ? { authenticated: true } : { error: "rejected" }));
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });

    try {
      const port = await listen(server);
      await build({
        entry: [join(process.cwd(), "src/client.ts")],
        format: ["esm"],
        outDir: bundleDir,
        platform: "node",
        target: "node20",
        splitting: false,
        clean: true,
        silent: true,
      });
      const moduleUrl = pathToFileURL(join(bundleDir, "client.js")).href;
      const apiUrl = `http://127.0.0.1:${String(port)}`;

      const results = await Promise.all([
        runClientProcess(moduleUrl, home, apiUrl),
        runClientProcess(moduleUrl, home, apiUrl),
      ]);

      expect(results.map(({ code }) => code)).toEqual([0, 0]);
      expect(results.map(({ stdout }) => JSON.parse(stdout))).toEqual([
        { authenticated: true },
        { authenticated: true },
      ]);
      expect(results.map(({ stderr }) => stderr)).toEqual(["", ""]);
      expect(refreshCalls).toBe(1);
      expect(protectedAuthorizations).toEqual(["Bearer winner-access", "Bearer winner-access"]);
      expect(readFileSync(join(config, "token"), "utf8").trim()).toBe("winner-access");
      expect(readFileSync(join(config, "refresh_token"), "utf8").trim()).toBe("generation-two");
      expect(Number(readFileSync(join(config, "token_expires_at"), "utf8"))).toBeGreaterThan(
        Date.now(),
      );
    } finally {
      if (server.listening) await close(server);
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("daemon terminal-auth lifecycle", () => {
  it("holds without network replay and automatically resumes after fresh login", async () => {
    const home = mkdtempSync(join(tmpdir(), "prim-daemon-reauth-"));
    const config = join(home, ".config", "prim");
    const bundleDir = join(home, "bundle");
    const socketPath = join(config, "sock");
    mkdirSync(config, { recursive: true });
    writeFileSync(join(config, "token"), "ended-access\n");
    writeFileSync(join(config, "refresh_token"), "ended-refresh\n");
    writeFileSync(join(config, "token_expires_at"), `${Date.now() + 300_000}\n`);
    writeFileSync(
      join(config, "refresh_terminal"),
      `${createHash("sha256").update("ended-refresh").digest("hex")}\n`,
    );

    let networkCalls = 0;
    const authorizations: Array<string | undefined> = [];
    const requestUrls: string[] = [];
    const server = createServer((request, response) => {
      networkCalls += 1;
      authorizations.push(request.headers.authorization);
      requestUrls.push(request.url ?? "");
      if (request.method === "POST" && request.url === "/api/cli/presence/heartbeat") {
        request.resume();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({ accepted: true, lastHeartbeatAt: Date.now(), onlineCount: 1 }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/cli/moves/ingest") {
        request.resume();
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            accepted: 1,
            acknowledged: 1,
            disposition: "persisted",
            verdictFooter: null,
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/api/cli/auth/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            authenticated: true,
            organizationBindingVersion: 1,
            captureAuthorityKind: "workos",
            organizationId: "org_local",
            workosOrganizationId: "org_workos",
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/api/cli/decisions/recent?limit=100&since=24h"
      ) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            decisions: [
              {
                id: "cached-decision",
                intent: "Read Decisions from the daemon cache",
                userId: "user-kasey",
                authorName: "Kasey",
                authorIsSelf: false,
                classifiedAt: 1_000,
                status: "active",
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    let daemon: RunningChild | undefined;

    try {
      const port = await listen(server);
      const pendingDir = join(config, "moves", `127.0.0.1_${String(port)}`, "org_local");
      const pendingPath = join(
        pendingDir,
        `journal.ndjson.flushing.${String(Date.now())}.99999999`,
      );
      mkdirSync(pendingDir, { recursive: true });
      writeFileSync(
        pendingPath,
        `${JSON.stringify({
          moveId: "held-move",
          capturedAt: Date.now(),
          sessionId: "held-session",
          eventType: "UserPromptSubmit",
          payload: { prompt: "deliver after login" },
        })}\n`,
      );
      await build({
        entry: [join(process.cwd(), "src/daemon/server.ts")],
        format: ["esm"],
        outDir: bundleDir,
        platform: "node",
        target: "node20",
        splitting: false,
        clean: true,
        silent: true,
      });
      const moduleUrl = pathToFileURL(join(bundleDir, "server.js")).href;
      daemon = runDaemonProcess(moduleUrl, home, `http://127.0.0.1:${String(port)}`);
      await eventually(
        () => existsSync(socketPath),
        () => `daemon socket did not appear: ${daemon?.stderr() ?? ""}`,
      );
      expect(statSync(config).mode & 0o777).toBe(0o700);
      expect(statSync(socketPath).mode & 0o777).toBe(0o600);

      const held = await daemonRequest(socketPath, "status_snapshot");
      expect(held.needsReauth).toBe(true);
      await daemonRequest(socketPath, "session_start", { sessionId: "held-session" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(networkCalls).toBe(0);
      expect(
        daemon
          .stderr()
          .split("\n")
          .filter((line) => line.includes("authentication ended")),
      ).toHaveLength(1);

      writeFileSync(join(config, "refresh_token"), "fresh-refresh\n");
      writeFileSync(join(config, "token_expires_at"), `${Date.now() + 300_000}\n`);
      writeFileSync(join(config, "token"), "fresh-access\n");
      unlinkSync(join(config, "refresh_terminal"));

      await eventually(
        () => requestUrls.includes("/api/cli/moves/ingest") && readdirSync(pendingDir).length === 0,
        () => `daemon did not resume: ${daemon?.stderr() ?? ""}`,
      );
      const resumed = await daemonRequest(socketPath, "status_snapshot");
      expect(resumed.needsReauth).toBe(false);
      expect(requestUrls).toContain("/api/cli/presence/heartbeat");
      expect(requestUrls).toContain("/api/cli/moves/ingest");
      expect(authorizations.every((value) => value === "Bearer fresh-access")).toBe(true);
      expect(existsSync(pendingPath)).toBe(false);
      expect(daemon.stderr()).toContain("re-authentication detected");
    } finally {
      if (daemon) {
        daemon.kill();
        await daemon.exited;
      }
      if (server.listening) await close(server);
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("daemon raw statusline socket", () => {
  it("serves fragmented and concurrent raw clients without changing JSON RPC", async () => {
    const home = mkdtempSync(join(tmpdir(), "prim-daemon-statusline-"));
    const config = join(home, ".config", "prim");
    const bundleDir = join(home, "bundle");
    const socketPath = join(config, "sock");
    const activeRepo = join(home, "active repo");
    const inactiveRepo = join(home, "inactive");
    const otherEnvRepo = join(home, "other-env");
    const tokenA = testJwt("user-a", "org-a", "1");
    const tokenB = testJwt("user-b", "org-b", "1");
    const callerA = daemonCaller(tokenA, "user-a", "org-a");
    const callerB = daemonCaller(tokenB, "user-b", "org-b");
    for (const repo of [activeRepo, inactiveRepo, otherEnvRepo]) {
      mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "--quiet"], { cwd: repo });
    }
    execFileSync("git", ["config", "--local", "prim.active", "true"], { cwd: activeRepo });
    execFileSync("git", ["config", "--local", "prim.repoSyncId", "repoSyncActive"], {
      cwd: activeRepo,
    });
    execFileSync("git", ["config", "--local", "prim.repoBindingState", "connected"], {
      cwd: activeRepo,
    });
    execFileSync("git", ["config", "--local", "prim.active", "false"], { cwd: inactiveRepo });
    execFileSync("git", ["config", "--local", "prim.active", "true"], { cwd: otherEnvRepo });
    execFileSync("git", ["config", "--local", "prim.repoSyncId", "repoSyncOther"], {
      cwd: otherEnvRepo,
    });
    execFileSync("git", ["config", "--local", "prim.repoBindingState", "connected"], {
      cwd: otherEnvRepo,
    });
    writeFileSync(join(otherEnvRepo, ".env"), "PRIM_API_URL=https://other.example.test\n");
    mkdirSync(config, { recursive: true });
    chmodSync(config, 0o777);
    writeFileSync(join(config, "token"), `${tokenB}\n`);

    const server = createServer((request, response) => {
      request.resume();
      if (request.method === "POST" && request.url === "/api/cli/presence/heartbeat") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            accepted: true,
            lastHeartbeatAt: Date.now(),
            onlineCount: 2,
            onlineNames: ["Kasey"],
            onlineTeammates: [
              {
                name: "Kasey",
                area: "auth",
                decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
              },
            ],
          }),
        );
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/api/cli/decisions/recent?limit=100&since=24h"
      ) {
        const decisionId =
          request.headers.authorization === `Bearer ${tokenA}`
            ? "cached-decision-a"
            : "cached-decision-b";
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            decisions: [
              {
                id: decisionId,
                intent: "Read Decisions from the daemon cache",
                userId: "user-kasey",
                authorName: "Kasey",
                authorIsSelf: false,
                classifiedAt: 1_000,
                status: "active",
              },
            ],
          }),
        );
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
    });
    let daemon: RunningChild | undefined;

    try {
      const port = await listen(server);
      const apiUrl = `http://127.0.0.1:${String(port)}`;
      await build({
        entry: [join(process.cwd(), "src/daemon/server.ts")],
        format: ["esm"],
        outDir: bundleDir,
        platform: "node",
        target: "node20",
        splitting: false,
        clean: true,
        silent: true,
      });
      const moduleUrl = pathToFileURL(join(bundleDir, "server.js")).href;
      daemon = runDaemonProcess(moduleUrl, home, apiUrl);
      await eventually(
        () => existsSync(socketPath),
        () => `daemon socket did not appear: ${daemon?.stderr() ?? ""}`,
      );
      await eventually(
        () => {
          try {
            const health = JSON.parse(readFileSync(join(config, "daemon-health.json"), "utf8")) as {
              healthy?: boolean;
            };
            return health.healthy === true;
          } catch {
            return false;
          }
        },
        () => `daemon did not become healthy: ${daemon?.stderr() ?? ""}`,
      );

      await expect(daemonRequest(socketPath, "ping")).resolves.toEqual({ pong: true });

      await expect(
        daemonRequest(socketPath, "decision_digest_snapshot", { callerEnv: apiUrl }),
      ).rejects.toThrow("principal or organization mismatch");
      await expect(
        daemonRequest(socketPath, "decision_digest_snapshot", { callerEnv: apiUrl }, callerA),
      ).rejects.toThrow("principal or organization mismatch");

      const digestSnapshot = await eventuallyValue(
        async () =>
          await daemonRequest(
            socketPath,
            "decision_digest_snapshot",
            { callerEnv: apiUrl },
            callerB,
          ),
        (value) => Array.isArray(value.decisions) && value.decisions.length === 1,
        () => `daemon Decision cache did not warm: ${daemon?.stderr() ?? ""}`,
      );
      expect(digestSnapshot).toMatchObject({
        decisions: [{ id: "cached-decision-b" }],
        cachedAt: expect.any(Number),
      });

      const raw = statuslineRequest(activeRepo, apiUrl);
      const fragmented = await rawStatuslineRequest(
        socketPath,
        Array.from(raw, (byte) => Buffer.from([byte])),
      );
      const linkedTeammate =
        "\x1b]8;;https://app.getprimitive.ai/decisions/kasey-decision\x07" +
        "\x1b[34;4mKasey - auth\x1b[0m\x1b]8;;\x07";
      const expected = `primitive test (daemon: live, Decision ingestion enabled · team: ${linkedTeammate})`;
      expect(fragmented.toString()).toBe(expected);

      if (process.platform === "darwin") {
        const runtime = stageRuntime({
          homeDir: home,
          env: { XDG_DATA_HOME: join(home, "data") },
          daemonSource: join(bundleDir, "server.js"),
          nodePath: process.execPath,
          version: "test",
        });
        expect(
          execFileSync(runtime.paths.statuslineLauncher, [], {
            cwd: activeRepo,
            encoding: "utf8",
            env: { ...process.env, PRIM_API_URL: apiUrl },
          }),
        ).toBe(expected);
        expect(
          execFileSync(runtime.paths.statuslineLauncher, [], {
            cwd: inactiveRepo,
            encoding: "utf8",
            env: { ...process.env, PRIM_API_URL: apiUrl },
          }),
        ).toBe(
          `primitive test (daemon: live, Decision ingestion disabled · team: ${linkedTeammate})`,
        );
        const mismatchedEnv = { ...process.env };
        mismatchedEnv.PRIM_API_URL = undefined;
        expect(
          execFileSync(runtime.paths.statuslineLauncher, [], {
            cwd: otherEnvRepo,
            encoding: "utf8",
            env: mismatchedEnv,
          }),
        ).toBe("primitive test (daemon: live, Decision ingestion enabled · presence: other env)");
      }

      const concurrent = await Promise.all(
        Array.from({ length: 23 }, () => rawStatuslineRequest(socketPath, [raw])),
      );
      expect(concurrent.every((response) => response.toString() === expected)).toBe(true);

      expect(
        (
          await rawStatuslineRequest(socketPath, [statuslineRequest(inactiveRepo, apiUrl)])
        ).toString(),
      ).toBe(
        `primitive test (daemon: live, Decision ingestion disabled · team: ${linkedTeammate})`,
      );
      expect(
        (await rawStatuslineRequest(socketPath, [statuslineRequest(otherEnvRepo)])).toString(),
      ).toBe("primitive test (daemon: live, Decision ingestion enabled · presence: other env)");
      expect(
        (
          await rawStatuslineRequest(socketPath, [statuslineRequest(otherEnvRepo, apiUrl)])
        ).toString(),
      ).toBe(expected);

      execFileSync("git", ["config", "--local", "prim.active", "false"], { cwd: activeRepo });
      expect((await rawStatuslineRequest(socketPath, [raw])).toString()).toBe(expected);
      await expect(daemonRequest(socketPath, "statusline_invalidate")).resolves.toEqual({
        ack: true,
      });
      expect((await rawStatuslineRequest(socketPath, [raw])).toString()).toContain(
        "Decision ingestion disabled",
      );
      execFileSync("git", ["config", "--local", "prim.active", "true"], { cwd: activeRepo });
      await daemonRequest(socketPath, "session_start", { sessionId: "cache-reset" });
      expect((await rawStatuslineRequest(socketPath, [raw])).toString()).toBe(expected);

      execFileSync("git", ["config", "--local", "prim.repoBindingState", "unbound"], {
        cwd: activeRepo,
      });
      await expect(daemonRequest(socketPath, "statusline_invalidate")).resolves.toEqual({
        ack: true,
      });
      const unboundStatus = (await rawStatuslineRequest(socketPath, [raw])).toString();
      expect(unboundStatus).toContain("repository: unbound (enforcement not evaluating)");
      expect(unboundStatus).not.toContain("repoSyncActive");
      execFileSync("git", ["config", "--local", "prim.repoBindingState", "connected"], {
        cwd: activeRepo,
      });
      await daemonRequest(socketPath, "statusline_invalidate");
      expect((await rawStatuslineRequest(socketPath, [raw])).toString()).toBe(expected);

      const relative = statuslineRequest("relative/path", apiUrl);
      await expect(rawStatuslineRequest(socketPath, [relative])).resolves.toEqual(Buffer.alloc(0));
      const oversized = Buffer.concat([
        Buffer.from("prim-statusline-v1\0/"),
        Buffer.alloc(65_536, "x"),
      ]);
      await expect(rawStatuslineRequest(socketPath, [oversized])).resolves.toEqual(Buffer.alloc(0));

      // Rotate from org B to org A. The first org-A read may see only the
      // warming sentinel; it must never see the retained org-B page.
      writeFileSync(join(config, "token"), `${tokenA}\n`);
      const afterRotation = await daemonRequest(
        socketPath,
        "decision_digest_snapshot",
        { callerEnv: apiUrl },
        callerA,
      );
      expect(afterRotation).not.toMatchObject({ decisions: [{ id: "cached-decision-b" }] });
      const rotatedDigest = await eventuallyValue(
        async () =>
          await daemonRequest(
            socketPath,
            "decision_digest_snapshot",
            { callerEnv: apiUrl },
            callerA,
          ),
        (value) =>
          Array.isArray(value.decisions) &&
          (value.decisions as Array<{ id?: string }>).some(
            (decision) => decision.id === "cached-decision-a",
          ),
        () => `daemon Decision cache did not re-key: ${daemon?.stderr() ?? ""}`,
      );
      expect(rotatedDigest).toMatchObject({ decisions: [{ id: "cached-decision-a" }] });

      // The JSON protocol has its own byte budget and a bad client cannot
      // wedge the listener for subsequent calls.
      await expect(
        rawStatuslineRequest(socketPath, [Buffer.alloc(64 * 1024 + 1, "x")]),
      ).resolves.toEqual(Buffer.alloc(0));
      await expect(daemonRequest(socketPath, "ping")).resolves.toEqual({ pong: true });
    } finally {
      if (daemon) {
        daemon.kill();
        await daemon.exited;
      }
      if (server.listening) await close(server);
      rmSync(home, { recursive: true, force: true });
    }
  }, 25_000);
});
