import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { processIsAlive } from "../lib/process-liveness.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
export const DAEMON_STARTUP_GRACE_MS = 5_000;

export type DaemonOwnerRecord = { pid: number; instanceId: string; startedAt: number };
export type DaemonPidRecord = { pid: number; mtimeMs: number };

export interface DaemonOwnership {
  configDir: string;
  lockDir: string;
  ownerPath: string;
  pidPath: string;
  pid: number;
  instanceId: string;
}

function readLockRecord(path: string): DaemonOwnerRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf-8")) as Partial<DaemonOwnerRecord>;
    if (
      Number.isSafeInteger(value.pid) &&
      (value.pid as number) > 0 &&
      typeof value.instanceId === "string" &&
      typeof value.startedAt === "number"
    ) {
      return value as DaemonOwnerRecord;
    }
  } catch {
    // Missing/malformed owner is handled as an incomplete lock below.
  }
  return;
}

function numericPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf-8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return;
  }
}

export function readDaemonOwner(configDir: string): DaemonOwnerRecord | undefined {
  return readLockRecord(join(configDir, "daemon.lock", "owner.json"));
}

export function readDaemonPid(configDir: string): DaemonPidRecord | undefined {
  const path = join(configDir, "daemon.pid");
  const pid = numericPid(path);
  if (pid === undefined) {
    return;
  }
  try {
    return { pid, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return;
  }
}

/**
 * Claim an atomic directory lock and retain the numeric pidfile for legacy
 * clients. Stale locks are moved aside with one atomic rename before retrying,
 * preventing two concurrent repair attempts from both believing they won.
 */
export function acquireDaemonOwnership(
  configDir: string,
  opts: { pid?: number; now?: number; isAlive?: (pid: number) => boolean } = {},
): DaemonOwnership {
  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? Date.now();
  const isAlive = opts.isAlive ?? processIsAlive;
  const lockDir = join(configDir, "daemon.lock");
  const ownerPath = join(lockDir, "owner.json");
  const pidPath = join(configDir, "daemon.pid");
  const instanceId = randomUUID();

  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: DIR_MODE });
  }

  for (;;) {
    try {
      mkdirSync(lockDir, { mode: DIR_MODE });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      const existing = readLockRecord(ownerPath);
      if (existing && isAlive(existing.pid)) {
        throw new Error(`daemon already running (pid=${String(existing.pid)})`);
      }
      // Do not steal the tiny mkdir→owner-write startup window. If a process
      // died in that window, the incomplete directory becomes recoverable
      // after the grace period.
      if (!existing) {
        let mtimeMs: number;
        try {
          mtimeMs = statSync(lockDir).mtimeMs;
        } catch (statErr) {
          if ((statErr as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          throw statErr;
        }
        if (now - mtimeMs < DAEMON_STARTUP_GRACE_MS) {
          throw new Error("daemon startup already in progress");
        }
      }
      const stale = `${lockDir}.stale.${String(pid)}.${instanceId}`;
      try {
        renameSync(lockDir, stale);
        rmSync(stale, { recursive: true, force: true });
      } catch (renameErr) {
        if ((renameErr as NodeJS.ErrnoException).code !== "ENOENT") {
          throw renameErr;
        }
      }
    }
  }

  const ownership: DaemonOwnership = {
    configDir,
    lockDir,
    ownerPath,
    pidPath,
    pid,
    instanceId,
  };
  const record: DaemonOwnerRecord = { pid, instanceId, startedAt: now };
  writeFileSync(ownerPath, `${JSON.stringify(record)}\n`, { mode: FILE_MODE });
  chmodSync(ownerPath, FILE_MODE);

  // A pre-lock daemon version may still own the legacy numeric pidfile. Honor
  // a live value rather than overwriting it during migration.
  const legacyPid = numericPid(pidPath);
  if (legacyPid !== undefined && legacyPid !== pid && isAlive(legacyPid)) {
    rmSync(lockDir, { recursive: true, force: true });
    throw new Error(`daemon already running (pid=${String(legacyPid)})`);
  }
  writeFileSync(pidPath, String(pid), { mode: FILE_MODE });
  chmodSync(pidPath, FILE_MODE);
  return ownership;
}

export function ownsDaemonInstance(ownership: DaemonOwnership): boolean {
  const current = readLockRecord(ownership.ownerPath);
  return current?.pid === ownership.pid && current.instanceId === ownership.instanceId;
}

/** Remove artifacts only while the nonce still identifies this process. */
export function releaseDaemonOwnership(ownership: DaemonOwnership, socketPath?: string): boolean {
  if (!ownsDaemonInstance(ownership)) {
    return false;
  }
  let cleanupError: unknown;
  if (socketPath) {
    try {
      unlinkSync(socketPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupError = err;
      }
    }
  }
  if (numericPid(ownership.pidPath) === ownership.pid) {
    try {
      unlinkSync(ownership.pidPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        cleanupError ??= err;
      }
    }
  }
  rmSync(ownership.lockDir, { recursive: true, force: true });
  if (cleanupError) {
    throw cleanupError;
  }
  return true;
}
