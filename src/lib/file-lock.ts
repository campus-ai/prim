import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_INIT_GRACE_MS = 2_000;
const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

interface FileLockOwner {
  pid: number;
  nonce: string;
  createdAt: number;
}

export interface FileLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  initGraceMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
  signal?: AbortSignal;
}

function ownerPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

function readOwner(lockDir: string): FileLockOwner | null {
  try {
    const owner = JSON.parse(readFileSync(ownerPath(lockDir), "utf8")) as Partial<FileLockOwner>;
    if (
      !Number.isInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.nonce !== "string" ||
      typeof owner.createdAt !== "number"
    ) {
      return null;
    }
    return owner as FileLockOwner;
  } catch {
    return null;
  }
}

function sameOwner(a: FileLockOwner | null, b: FileLockOwner): boolean {
  return a?.pid === b.pid && a.nonce === b.nonce && a.createdAt === b.createdAt;
}

function tryTakeLock(lockDir: string, now: number): FileLockOwner | null {
  try {
    mkdirSync(lockDir, { mode: DIRECTORY_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }

  const owner: FileLockOwner = {
    pid: process.pid,
    nonce: randomBytes(16).toString("hex"),
    createdAt: now,
  };
  try {
    writeFileSync(ownerPath(lockDir), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: FILE_MODE,
      flag: "wx",
    });
    return owner;
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function recoverStaleLock(
  lockDir: string,
  now: number,
  alive: (pid: number) => boolean,
  initGraceMs: number,
): boolean {
  const owner = readOwner(lockDir);
  if (owner) {
    if (alive(owner.pid)) return false;
    if (!sameOwner(readOwner(lockDir), owner)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  }

  // A process can die between mkdir and owner.json. Recover only after the
  // directory has stayed ownerless and unchanged for the initialization grace.
  try {
    const before = statSync(lockDir).mtimeMs;
    if (now - before < initGraceMs) return false;
    if (readOwner(lockDir)) return false;
    if (statSync(lockDir).mtimeMs !== before) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return true;
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError(signal);
}

async function defaultSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return;
  }
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Serialize a filesystem mutation across independent prim processes. */
export async function withFileLock<T>(
  lockDir: string,
  operation: () => Promise<T> | T,
  options: FileLockOptions = {},
): Promise<T> {
  mkdirSync(dirname(lockDir), { recursive: true, mode: DIRECTORY_MODE });
  const nowMs = options.nowMs ?? Date.now;
  const alive = options.processAlive ?? processIsAlive;
  const deadline = nowMs() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  let owner: FileLockOwner | null = null;
  while (!owner) {
    throwIfAborted(options.signal);
    const now = nowMs();
    owner = tryTakeLock(lockDir, now);
    if (owner) break;
    recoverStaleLock(lockDir, now, alive, options.initGraceMs ?? DEFAULT_INIT_GRACE_MS);
    if (now >= deadline) {
      throw new Error(`timed out waiting for file lock ${lockDir}`);
    }
    if (options.sleep) {
      await options.sleep(options.pollMs ?? DEFAULT_POLL_MS);
      throwIfAborted(options.signal);
    } else {
      await defaultSleep(options.pollMs ?? DEFAULT_POLL_MS, options.signal);
    }
  }

  try {
    throwIfAborted(options.signal);
    return await operation();
  } finally {
    if (sameOwner(readOwner(lockDir), owner)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/** Exposed for focused lock tests; callers should use withFileLock. */
export function fileLockExists(lockDir: string): boolean {
  return existsSync(lockDir);
}
