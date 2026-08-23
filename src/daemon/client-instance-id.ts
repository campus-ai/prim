import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { type FileLockOptions, withFileLock } from "../lib/file-lock.js";

const CONFIG_DIRECTORY_MODE = 0o700;
const INSTANCE_FILE_MODE = 0o600;
const INSTANCE_ENTROPY_BYTES = 32;
const INSTANCE_BODY_CHARS = 43;
const INSTANCE_PREFIX = "pci_";
const CLIENT_INSTANCE_ID_RE = /^pci_[A-Za-z0-9_-]{43}$/u;
const MAX_STORED_BYTES = INSTANCE_PREFIX.length + INSTANCE_BODY_CHARS + 1;

export interface ClientInstanceIdOptions {
  configDir: string;
  lockOptions?: FileLockOptions;
}

/** Exact opaque wire format; it cannot carry a hostname or user-chosen label. */
export function isClientInstanceId(value: unknown): value is string {
  return typeof value === "string" && CLIENT_INSTANCE_ID_RE.test(value);
}

function ensurePrivateConfigDirectory(configDir: string): void {
  mkdirSync(configDir, { recursive: true, mode: CONFIG_DIRECTORY_MODE });
  const metadata = lstatSync(configDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("prim config path must be a private directory");
  }
  chmodSync(configDir, CONFIG_DIRECTORY_MODE);
}

function readExisting(path: string): string | undefined {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("stored client instance identity is invalid");
  }
  // Repair a valid pre-existing file's privacy before reading it. Never print
  // its contents in errors: a malformed file could contain arbitrary PII.
  chmodSync(path, INSTANCE_FILE_MODE);
  if (metadata.size > MAX_STORED_BYTES) {
    throw new Error("stored client instance identity is invalid");
  }
  const raw = readFileSync(path, "utf8");
  const value = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  if ((raw !== value && raw !== `${value}\n`) || !isClientInstanceId(value)) {
    throw new Error("stored client instance identity is invalid");
  }
  return value;
}

/**
 * Return one install-scoped opaque identity, generating it exactly once under
 * a cross-process lock. Malformed state fails closed and is never rotated
 * silently, because rotation would turn one machine into false multi-machine
 * lifecycle evidence.
 */
export async function getOrCreateClientInstanceId(
  options: ClientInstanceIdOptions,
): Promise<string> {
  const configDir = options.configDir;
  const path = join(configDir, "client_instance_id");
  const lockPath = join(configDir, "client-instance.lock");
  ensurePrivateConfigDirectory(configDir);
  return withFileLock(
    lockPath,
    () => {
      const existing = readExisting(path);
      if (existing !== undefined) {
        return existing;
      }
      const generated = `${INSTANCE_PREFIX}${randomBytes(INSTANCE_ENTROPY_BYTES).toString(
        "base64url",
      )}`;
      if (!isClientInstanceId(generated)) {
        throw new Error("generated client instance identity is invalid");
      }
      atomicWriteFile(path, `${generated}\n`, { mode: INSTANCE_FILE_MODE });
      return generated;
    },
    options.lockOptions,
  );
}
