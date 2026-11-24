import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWriteFile } from "./atomic-file.js";
import { binFile } from "./bin-path.js";
import { withFileLock } from "./file-lock.js";
import { loopbackFetch } from "./loopback-fetch.js";
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
const MAX_CREDENTIAL_REQUEST_BYTES = 2048;
// A forwarded API request wraps a whole ingest upload (at most 4 MiB) as a
// JSON string, and its answer wraps a management response (at most 2 MiB).
const MAX_FORWARD_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_API_RESPONSE_BYTES = 8 * 1024 * 1024;
// The answer travels as JSON inside the signed envelope's JSON string, so a
// quote-heavy body grows up to fourfold on the wire.
const MAX_FORWARD_RESPONSE_BYTES = 36 * 1024 * 1024;
// A forwarded request and its answer are signed apart from a credential
// request and from each other, so neither can stand in for another.
const FORWARD_REQUEST_PROOF = "forward-request";
const FORWARD_ANSWER_PROOF = "forward-answer";
const FORWARD_TIMEOUT_MS = 30_000;
const FORWARD_METHODS = ["GET", "POST", "DELETE"];
const IDLE_MS = 5 * 60_000;
type Descriptor = { port: number; nonce: string; pid: number };
type Environment = {
  clientId: string;
  clientSecret: string;
  generation: string;
  secretInjection?: "network";
  tokenInjection?: "network";
};
export type BrokerApiRequest = {
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

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
function signature(secret: string, nonce: string, body: string, purpose?: string): string {
  return createHmac("sha256", secret)
    .update(purpose ? `${nonce}\0${purpose}\0${body}` : `${nonce}\0${body}`)
    .digest("hex");
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
  const response = await loopbackFetch(`http://127.0.0.1:${descriptor.port}/credential`, {
    method: "POST",
    body,
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

/**
 * The broker's own environment. With a network secret, the cloud
 * environment's proxy adds the client secret to the token request (or, in
 * network-token mode, the token to every API request), and Node sends
 * requests through that proxy only when told to at startup. The broker is
 * the one process that makes those requests, so it is told here; no other
 * process in the VM needs the setting, and the broker's "experimental"
 * warning for it goes nowhere (its output is discarded).
 */
export function brokerEnvironment(options: {
  directory: string;
  apiUrl: string;
  environment: Pick<Environment, "secretInjection" | "tokenInjection">;
  env: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const routed = options.environment.secretInjection || options.environment.tokenInjection;
  return {
    ...options.env,
    PRIM_API_URL: options.apiUrl,
    PRIM_CONFIG_DIR: options.directory,
    ...(routed ? { NODE_USE_ENV_PROXY: "1" } : {}),
  };
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
  const descriptor = await ensureBroker(options);
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

/** The running broker for this generation, started here if none answers. */
async function ensureBroker(options: {
  directory: string;
  apiUrl: string;
  environment: Environment;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<Descriptor> {
  const path = descriptorPath(options.directory, options.environment.generation);
  return withFileLock(
    join(options.directory, "machine-broker.lock"),
    async () => {
      const current = readDescriptor(path);
      if (current) {
        try {
          // Probe only; do not exchange while holding the broker startup lock.
          const response = await loopbackFetch(`http://127.0.0.1:${current.port}/health`, {
            signal: AbortSignal.any([options.signal, AbortSignal.timeout(500)]),
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
          env: brokerEnvironment(options),
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
}

async function forwardOnce(
  descriptor: Descriptor,
  environment: Environment,
  request: BrokerApiRequest,
  signal: AbortSignal,
): Promise<Response> {
  const body = JSON.stringify({
    generation: environment.generation,
    timestamp: Date.now(),
    method: request.method,
    path: request.path,
    headers: request.headers ?? {},
    ...(request.body === undefined ? {} : { body: request.body }),
  });
  const response = await loopbackFetch(`http://127.0.0.1:${descriptor.port}/forward`, {
    method: "POST",
    body,
    signal,
    headers: {
      "Content-Type": "application/json",
      "X-Prim-Proof": signature(
        environment.clientSecret,
        descriptor.nonce,
        body,
        FORWARD_REQUEST_PROOF,
      ),
    },
  });
  const envelope = machineRecord(await readBoundedJson(response, MAX_FORWARD_RESPONSE_BYTES));
  if (
    typeof envelope.body !== "string" ||
    !matches(
      signature(environment.clientSecret, descriptor.nonce, envelope.body, FORWARD_ANSWER_PROOF),
      envelope.proof,
    )
  )
    throw new MachineAuthError(
      "broker_unavailable",
      "Machine credential broker could not be authenticated. Retry the command.",
    );
  const data = machineRecord(JSON.parse(envelope.body));
  if (data.error) {
    const error = machineRecord(data.error);
    throw new MachineAuthError(String(error.code), String(error.message), error.terminal === true);
  }
  const status = data.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599)
    throw new MachineAuthError("broker_unavailable", "Machine credential broker answered oddly.");
  const headers = new Headers();
  for (const [name, value] of Object.entries(machineRecord(data.headers ?? {})))
    if (typeof value === "string") headers.set(name, value);
  const text = typeof data.body === "string" ? data.body : "";
  return new Response([204, 205, 304].includes(status) ? null : text, { status, headers });
}

/**
 * Send one API request through the broker, for credentials whose token the
 * cloud environment's proxy attaches: only the broker's requests pass through
 * that proxy. The caller holds the same owner-only key as for credentials.
 */
export async function forwardBrokerRequest(options: {
  directory: string;
  apiUrl: string;
  environment: Environment;
  env: NodeJS.ProcessEnv;
  request: BrokerApiRequest;
  signal: AbortSignal;
}): Promise<Response> {
  const path = descriptorPath(options.directory, options.environment.generation);
  const unavailable = () =>
    new MachineAuthError(
      "broker_unavailable",
      "Machine credential broker is unavailable. Retry the command.",
    );
  const existing = readDescriptor(path);
  if (existing) {
    try {
      return await forwardOnce(existing, options.environment, options.request, options.signal);
    } catch (error) {
      options.signal.throwIfAborted();
      if (error instanceof MachineAuthError) throw error;
      // Only a broker that never took the request may be replaced and asked
      // again: once it has, the API may already have acted on it.
      if ((error as NodeJS.ErrnoException).code !== "ECONNREFUSED") throw unavailable();
    }
  }
  const descriptor = await ensureBroker(options);
  try {
    return await forwardOnce(descriptor, options.environment, options.request, options.signal);
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof MachineAuthError) throw error;
    throw unavailable();
  }
}

/** Only what prim's own API client sends; never a credential header. */
function forwardableHeaders(value: unknown): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return headers;
  for (const [name, content] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (
      typeof content === "string" &&
      content.length <= 256 &&
      !/[\p{Cc}]/u.test(content) &&
      (lower === "content-type" || /^x-prim-[a-z0-9-]+$/u.test(lower))
    )
      headers[name] = content;
  }
  return headers;
}

/**
 * The broker's half of a forwarded request: send it to the API origin this
 * broker was started for, with no Authorization header (the proxy attaches
 * the token), and return the answer as data. Runs only in the broker.
 */
export async function forwardToApi(
  apiUrl: string,
  data: Record<string, unknown>,
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  const refuse = (message: string) => ({
    error: { code: "invalid_request", message, terminal: false },
  });
  if (typeof data.method !== "string" || !FORWARD_METHODS.includes(data.method))
    return refuse("The forwarded request's method is not allowed.");
  if (data.body !== undefined && typeof data.body !== "string")
    return refuse("The forwarded request's body is not text.");
  let target: URL;
  try {
    if (typeof data.path !== "string" || !data.path.startsWith("/")) throw new Error("path");
    target = new URL(data.path, `${apiUrl}/`);
    // `//host/…` and friends resolve off the API origin; never follow them.
    if (target.origin !== apiUrl || target.username || target.password) throw new Error("origin");
  } catch {
    return refuse("The forwarded request does not target the configured API.");
  }
  try {
    const answer = await fetchImpl(target, {
      method: data.method,
      headers: forwardableHeaders(data.headers),
      body: data.method === "GET" ? undefined : (data.body as string | undefined),
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(FORWARD_TIMEOUT_MS)]),
    });
    const headers: Record<string, string> = {};
    for (const name of ["content-type", "retry-after"]) {
      const value = answer.headers.get(name);
      if (value) headers[name] = value;
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    if (answer.body)
      for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) {
        received += chunk.length;
        // Stop reading rather than hold an answer of any size in memory.
        if (received > MAX_API_RESPONSE_BYTES)
          return {
            error: {
              code: "invalid_response",
              message: "The API answered with more than prim accepts.",
              terminal: false,
            },
          };
        chunks.push(chunk);
      }
    return { status: answer.status, headers, body: Buffer.concat(chunks).toString("utf8") };
  } catch (error) {
    // Never the failure's own text: a proxy may put anything in it.
    const timedOut = error instanceof Error && error.name === "TimeoutError";
    return {
      error: {
        code: timedOut ? "request_timeout" : "authentication_unavailable",
        message: timedOut
          ? "Primitive did not answer through the cloud environment's proxy in time. The request may or may not have been applied."
          : "The request to Primitive through the cloud environment's proxy failed. Check the connection and retry.",
        terminal: false,
      },
    };
  }
}

/** The broker's answer to a credential request: the credential, or why not. */
async function credentialResult(
  apiUrl: string,
  data: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const current = cachedMachineCredential();
    const force =
      data.force === true &&
      (!current || data.observedTokenHash === tokenHash(current.accessToken));
    const credential = await acquireMachineCredential(
      { force, signal },
      { localEnvironment: true },
    );
    if (!credential || credential.apiUrl !== apiUrl) throw new Error("Missing machine identity");
    return { credential };
  } catch (error) {
    return {
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
}

/**
 * The broker's loopback server. Every request must prove knowledge of the
 * peers' key over the nonce and its exact body, name this generation, and be
 * recent, before the broker does anything on its behalf.
 */
export function createBrokerServer(options: {
  environment: Environment;
  apiUrl: string;
  nonce: string;
  /** Called for each authenticated request, to keep an idle broker alive. */
  onRequest?: () => void;
}): Server {
  const { environment, apiUrl, nonce } = options;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "GET" && request.url === "/health") {
      response.end(nonce);
      return;
    }
    // Forwarding exists only where the proxy attaches the token; elsewhere
    // callers hold a token and make their own requests.
    const forwarding = request.url === "/forward" && environment.tokenInjection === "network";
    if (request.method !== "POST" || (request.url !== "/credential" && !forwarding)) {
      response.writeHead(404).end();
      return;
    }
    const limit = forwarding ? MAX_FORWARD_REQUEST_BYTES : MAX_CREDENTIAL_REQUEST_BYTES;
    try {
      const chunks: Buffer[] = [];
      let received = 0;
      for await (const chunk of request) {
        received += (chunk as Buffer).length;
        if (received > limit) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(chunk as Buffer);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const proof = signature(
        environment.clientSecret,
        nonce,
        raw,
        forwarding ? FORWARD_REQUEST_PROOF : undefined,
      );
      if (!matches(proof, request.headers["x-prim-proof"])) {
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
      options.onRequest?.();
      const controller = new AbortController();
      response.once("close", () => {
        if (!response.writableFinished) controller.abort();
      });
      const result = forwarding
        ? await forwardToApi(apiUrl, data, controller.signal)
        : await credentialResult(apiUrl, data, controller.signal);
      const body = JSON.stringify(result);
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          body,
          proof: signature(
            environment.clientSecret,
            nonce,
            body,
            forwarding ? FORWARD_ANSWER_PROOF : undefined,
          ),
        }),
      );
    } catch {
      response.writeHead(400).end();
    }
  });
  server.maxConnections = 64;
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  return server;
}

/** Entry mode of the already-packaged, immutable daemon bundle. */
export async function startMachineBroker(): Promise<void> {
  const environment = environmentCredentials({});
  if (!environment) throw new Error("Machine broker requires injected credentials");
  const directory = primConfigDirectory();
  const apiUrl = machineApiUrl(process.env.PRIM_API_URL || "https://api.getprimitive.ai");
  const path = descriptorPath(directory, environment.generation);
  const nonce = randomBytes(32).toString("hex");
  const server = createBrokerServer({
    environment,
    apiUrl,
    nonce,
    onRequest: () => idle.refresh(),
  });
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
