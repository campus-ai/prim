import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "./atomic-file.js";
import { binFile } from "./bin-path.js";
import { withFileLock } from "./file-lock.js";
import {
  type MachineCredential,
  acquireMachineCredential,
  cachedMachineCredential,
  environmentCredentials,
} from "./machine-credentials.js";
import { MachineAuthError, machineApiUrl, machineRecord } from "./machine-protocol.js";
import { primConfigDirectory } from "./paths.js";
import { readBoundedJson } from "./workos-connect.js";

const MAX_RESPONSE_BYTES = 96 * 1024;
const IDLE_MS = 5 * 60_000;
type Descriptor = { port: number; nonce: string; pid: number };
type Environment = { clientId: string; clientSecret: string; generation: string };

function descriptorPath(directory: string, generation: string): string {
  return join(directory, `machine_broker_${generation}.json`);
}
function readDescriptor(path: string): Descriptor | undefined {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.size > 1024 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    )
      return undefined;
    const data = JSON.parse(readFileSync(path, "utf8")) as Descriptor;
    return Number.isInteger(data.port) &&
      data.port > 0 &&
      data.port <= 65535 &&
      /^[a-f0-9]{64}$/u.test(data.nonce) &&
      Number.isInteger(data.pid)
      ? data
      : undefined;
  } catch {
    return undefined;
  }
}
function signature(secret: string, nonce: string, body: string): string {
  return createHmac("sha256", secret).update(`${nonce}\0${body}`).digest("hex");
}
function matches(left: string, right: unknown): boolean {
  return (
    typeof right === "string" &&
    /^[a-f0-9]{64}$/u.test(right) &&
    timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"))
  );
}
function tokenHash(token: string | undefined): string | undefined {
  return token ? createHash("sha256").update(token).digest("hex") : undefined;
}

async function brokerRequest(
  descriptor: Descriptor,
  environment: Environment,
  options: { force?: boolean; observedToken?: string; signal: AbortSignal },
): Promise<MachineCredential> {
  const body = JSON.stringify({
    generation: environment.generation,
    force: options.force === true,
    observedTokenHash: tokenHash(options.observedToken),
    timestamp: Date.now(),
  });
  const response = await fetch(`http://127.0.0.1:${descriptor.port}/credential`, {
    method: "POST",
    body,
    redirect: "error",
    signal: options.signal,
    headers: {
      "Content-Type": "application/json",
      "X-Prim-Proof": signature(environment.clientSecret, descriptor.nonce, body),
    },
  });
  const envelope = machineRecord(await readBoundedJson(response, MAX_RESPONSE_BYTES));
  if (
    typeof envelope.body !== "string" ||
    !matches(signature(environment.clientSecret, descriptor.nonce, envelope.body), envelope.proof)
  )
    throw new MachineAuthError(
      "broker_unavailable",
      "Machine credential broker could not be authenticated. Retry the command.",
    );
  const data = machineRecord(JSON.parse(envelope.body));
  if (data.error) {
    const error = machineRecord(data.error);
    throw new MachineAuthError(
      String(error.code),
      String(error.message),
      error.terminal === true,
      typeof error.retryAt === "number" ? error.retryAt : undefined,
    );
  }
  const credential = data.credential as MachineCredential;
  if (
    credential?.generation !== environment.generation ||
    credential.clientId !== environment.clientId ||
    credential.storage !== "environment"
  )
    throw new MachineAuthError(
      "identity_changed",
      "Machine identity changed; restart the operation.",
    );
  return credential;
}

/** Only descriptors and cooldown metadata are persisted. Secrets and tokens stay in memory. */
export async function acquireBrokerCredential(options: {
  directory: string;
  apiUrl: string;
  environment: Environment;
  env: NodeJS.ProcessEnv;
  force?: boolean;
  observedToken?: string;
  signal: AbortSignal;
}): Promise<MachineCredential> {
  const path = descriptorPath(options.directory, options.environment.generation);
  const existing = readDescriptor(path);
  if (existing) {
    try {
      return await brokerRequest(existing, options.environment, options);
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof MachineAuthError) throw error;
    }
  }
  const descriptor = await withFileLock(
    join(options.directory, "machine-broker.lock"),
    async () => {
      const current = readDescriptor(path);
      if (current) {
        try {
          // Probe only; do not exchange while holding the broker startup lock.
          const response = await fetch(`http://127.0.0.1:${current.port}/health`, {
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(500)]),
            redirect: "error",
          });
          if (response.ok && (await response.text()) === current.nonce) return current;
        } catch {
          options.signal.throwIfAborted();
        }
      }
      const bundled = fileURLToPath(import.meta.url);
      const entry =
        basename(bundled) === "prim-daemon-server" ? bundled : binFile("prim-daemon-server");
      if (!entry)
        throw new MachineAuthError(
          "broker_unavailable",
          "Reinstall Prim to restore its machine credential broker.",
        );
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [entry, "--machine-token-broker"], {
          detached: true,
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          windowsHide: true,
          env: { ...options.env, PRIM_API_URL: options.apiUrl, PRIM_CONFIG_DIR: options.directory },
        });
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          options.signal.removeEventListener("abort", abort);
          if (error) child.kill();
          if (child.connected) child.disconnect();
          child.unref();
          error ? reject(error) : resolve();
        };
        const abort = () =>
          finish(
            new MachineAuthError(
              "broker_unavailable",
              "Machine credential broker startup was cancelled.",
            ),
          );
        options.signal.addEventListener("abort", abort, { once: true });
        child.once("error", () =>
          finish(
            new MachineAuthError(
              "broker_unavailable",
              "Machine credential broker could not start.",
            ),
          ),
        );
        child.once("exit", () =>
          finish(
            new MachineAuthError(
              "broker_unavailable",
              "Machine credential broker exited during startup.",
            ),
          ),
        );
        child.once("message", (message) => {
          if (message === "ready") finish();
        });
        if (options.signal.aborted) abort();
      });
      const started = readDescriptor(path);
      if (!started)
        throw new MachineAuthError(
          "broker_unavailable",
          "Machine credential broker did not become ready.",
        );
      return started;
    },
    { signal: options.signal },
  );
  try {
    return await brokerRequest(descriptor, options.environment, options);
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof MachineAuthError) throw error;
    throw new MachineAuthError(
      "broker_unavailable",
      "Machine credential broker is unavailable. Retry the command.",
    );
  }
}

/** Entry mode of the already-packaged, immutable daemon bundle. */
export async function startMachineBroker(): Promise<void> {
  const environment = environmentCredentials({});
  if (!environment) throw new Error("Machine broker requires injected credentials");
  const directory = primConfigDirectory();
  const apiUrl = machineApiUrl(process.env.PRIM_API_URL || "https://api.getprimitive.ai");
  const path = descriptorPath(directory, environment.generation);
  const nonce = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      response.end(nonce);
      return;
    }
    if (request.method !== "POST" || request.url !== "/credential") {
      response.writeHead(404).end();
      return;
    }
    let raw = "";
    try {
      for await (const chunk of request) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 2048) {
          response.writeHead(413).end();
          return;
        }
      }
      if (
        !matches(signature(environment.clientSecret, nonce, raw), request.headers["x-prim-proof"])
      ) {
        response.writeHead(403).end();
        return;
      }
      const data = machineRecord(JSON.parse(raw));
      if (
        data.generation !== environment.generation ||
        typeof data.timestamp !== "number" ||
        Math.abs(Date.now() - data.timestamp) > 30_000
      ) {
        response.writeHead(403).end();
        return;
      }
      idle.refresh();
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      let result: unknown;
      try {
        const current = cachedMachineCredential();
        const force =
          data.force === true &&
          (!current || data.observedTokenHash === tokenHash(current.accessToken));
        const credential = await acquireMachineCredential(
          { force, signal: controller.signal },
          { localEnvironment: true },
        );
        if (!credential || credential.apiUrl !== apiUrl)
          throw new Error("Missing machine identity");
        result = { credential };
      } catch (error) {
        result = {
          error:
            error instanceof MachineAuthError
              ? {
                  code: error.code,
                  message: error.message,
                  terminal: error.terminal,
                  retryAt: error.retryAt,
                }
              : {
                  code: "broker_unavailable",
                  message: "Machine authentication is temporarily unavailable.",
                  terminal: false,
                },
        };
      }
      const body = JSON.stringify(result);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({ body, proof: signature(environment.clientSecret, nonce, body) }),
      );
    } catch {
      response.writeHead(400).end();
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  const close = () => {
    clearTimeout(idle);
    server.closeAllConnections();
    server.close();
    if (readDescriptor(path)?.nonce === nonce) rmSync(path, { force: true });
  };
  const idle = setTimeout(close, IDLE_MS);
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid broker address");
  atomicWriteFile(path, JSON.stringify({ port: address.port, pid: process.pid, nonce }), {
    mode: 0o600,
  });
  process.send?.("ready");
}
