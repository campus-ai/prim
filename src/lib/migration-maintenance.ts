/** Cooperative legacy maintenance fence; never a claim about older binaries. */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, opendirSync, realpathSync, unlinkSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { atomicWriteFile, ensureDurableDirectory, syncDirectory } from "./atomic-file.js";
import { readBoundedRegularFile } from "./bounded-file.js";
import { withFileLock, withFileLockSync } from "./file-lock.js";
import { primConfigDirectory } from "./paths.js";

const ID = /^[0-9a-f]{32}$/;
const MAX_LEASES = 512;
const MAX_ENTRIES = 4096;
const MAX_DEPTH = 5;
const LOCK_OPTIONS = { timeoutMs: 2_000, pollMs: 10 };
const SCOPE = "cooperative-runtime-only";
type ActivityKind = "append" | "direct-upload" | "drain";
type Pause = { version: 1; id: string; createdAt: number };
type Lease = Pause & { pid: number; kind: ActivityKind };
type HandoffReservation = {
  version: 1;
  maintenanceId: string;
  id: string;
  transactionDirectory: string;
};
let transactionOwner: string | undefined;
export type MaintenanceBlocker = { path: string; reason: string; bytes: number };
export type MaintenanceStatus = {
  protocolVersion: 1;
  configRoot: string;
  paused: boolean;
  maintenanceId: string | null;
  quiescent: boolean;
  inventoryComplete: boolean;
  drained: boolean;
  ready: boolean;
  activeLeases: number;
  handoffReserved: boolean;
  blockers: MaintenanceBlocker[];
  scope: typeof SCOPE;
  legacySessionsMustBeClosed: true;
};

export class MaintenancePausedError extends Error {
  constructor() {
    super("Legacy capture/delivery is paused for migration; no new capture was acknowledged");
    this.name = "MaintenancePausedError";
  }
}

export function reportMaintenancePause(error: unknown): void {
  if (error instanceof MaintenancePausedError) process.stderr.write(`[prim] ${error.message}\n`);
}

function paths() {
  const configured = primConfigDirectory();
  const root = existsSync(configured) ? realpathSync(configured) : configured;
  return {
    root,
    state: join(root, "migration-maintenance.json"),
    lock: join(root, ".migration-maintenance.lock"),
    leases: join(root, "migration-activity"),
    reservation: join(root, "migration-handoff-reservation.json"),
  };
}

function privateDirectory(path: string, create = false): void {
  if (create && !existsSync(path)) ensureDurableDirectory(path, 0o700);
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  ) {
    throw new Error(
      "Maintenance requires owned directories without group/other write access; repair permissions explicitly",
    );
  }
}

function boundedNames(path: string, limit: number): string[] {
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) return names;
      if (names.length >= limit)
        throw new Error("Maintenance directory inventory exceeds its bound");
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
}

function object(path: string): Record<string, unknown> {
  const stat = lstatSync(path);
  const file = readBoundedRegularFile(path, 4096);
  if (
    !file ||
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && file.ownerUid !== process.getuid())
  )
    throw new Error("Invalid maintenance file");
  let value: unknown;
  try {
    value = JSON.parse(file.text);
  } catch {
    throw new Error("Invalid maintenance record JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid maintenance record");
  return value as Record<string, unknown>;
}

function pauseRecord(): Pause | undefined {
  const { state } = paths();
  // lstat distinguishes a dangling symlink from a missing state file.
  try {
    lstatSync(state);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = object(state);
  if (
    record.version !== 1 ||
    typeof record.id !== "string" ||
    !ID.test(record.id) ||
    !Number.isSafeInteger(record.createdAt) ||
    (record.createdAt as number) <= 0 ||
    Object.keys(record).sort().join() !== "createdAt,id,version"
  )
    throw new Error("Invalid maintenance pause");
  return record as Pause;
}

function matchingPause(id: string): Pause {
  if (!ID.test(id)) throw new Error("A 32-character maintenance ID is required");
  const record = pauseRecord();
  if (!record || record.id !== id)
    throw new Error("Maintenance ID does not match the durable pause");
  return record;
}

function handoffReservation(): HandoffReservation | undefined {
  const { reservation } = paths();
  try {
    lstatSync(reservation);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const record = object(reservation);
  if (
    record.version !== 1 ||
    typeof record.maintenanceId !== "string" ||
    !ID.test(record.maintenanceId) ||
    typeof record.id !== "string" ||
    !ID.test(record.id) ||
    typeof record.transactionDirectory !== "string" ||
    !isAbsolute(record.transactionDirectory) ||
    record.transactionDirectory.length > 3072 ||
    /[\p{Cc}\p{Cf}]/u.test(record.transactionDirectory) ||
    Object.keys(record).sort().join() !== "id,maintenanceId,transactionDirectory,version"
  )
    throw new Error("Invalid maintenance handoff reservation");
  return record as HandoffReservation;
}

function reservationForTransaction(
  id: string,
  reservationId: string,
  transactionDirectory: string,
): HandoffReservation {
  if (transactionOwner !== id)
    throw new Error("Handoff reservation requires the guarded transaction lock");
  matchingPause(id);
  if (
    !ID.test(reservationId) ||
    transactionDirectory.length > 3072 ||
    /[\p{Cc}\p{Cf}]/u.test(transactionDirectory) ||
    !isAbsolute(transactionDirectory) ||
    realpathSync(transactionDirectory) !== transactionDirectory
  ) {
    throw new Error("Invalid canonical handoff transaction reference");
  }
  privateDirectory(transactionDirectory);
  const record: HandoffReservation = {
    version: 1,
    maintenanceId: id,
    id: reservationId,
    transactionDirectory,
  };
  if (Buffer.byteLength(`${JSON.stringify(record)}\n`) > 4096)
    throw new Error("Handoff transaction reference exceeds the maintenance record bound");
  return record;
}

function sameReservation(left: HandoffReservation, right: HandoffReservation): boolean {
  return (
    left.id === right.id &&
    left.maintenanceId === right.maintenanceId &&
    left.transactionDirectory === right.transactionDirectory
  );
}

/** Only call inside withPausedMaintenance, before the first handoff mutation. */
export function reserveMaintenanceHandoff(
  id: string,
  reservationId: string,
  transactionDirectory: string,
): void {
  const record = reservationForTransaction(id, reservationId, transactionDirectory);
  const previous = handoffReservation();
  if (previous) {
    if (!sameReservation(previous, record))
      throw new Error("Another handoff owns the maintenance reservation");
    return;
  }
  atomicWriteFile(paths().reservation, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

/** Only a verified safe rollback/abort may release a reserved handoff. */
export function releaseMaintenanceHandoff(
  id: string,
  reservationId: string,
  transactionDirectory: string,
): void {
  const record = reservationForTransaction(id, reservationId, transactionDirectory);
  const previous = handoffReservation();
  if (!previous) return;
  if (!sameReservation(previous, record))
    throw new Error("Another handoff owns the maintenance reservation");
  unlinkSync(paths().reservation);
  syncDirectory(paths().root);
}

function leaseProcessMayBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Only ESRCH proves absence. EPERM and unexpected probe errors retain the
    // lease conservatively; never turn uncertain liveness into readiness.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function activeLeases(reap = false): number {
  const { leases } = paths();
  try {
    lstatSync(leases);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  privateDirectory(leases);
  const entries = boundedNames(leases, MAX_LEASES);
  if (entries.length > MAX_LEASES) throw new Error("Maintenance lease inventory exceeds its bound");
  let active = 0;
  for (const entry of entries) {
    if (!/^[0-9a-f]{32}\.json$/.test(entry))
      throw new Error("Unrecognized maintenance activity entry");
    const path = join(leases, entry);
    const record = object(path);
    if (
      record.version !== 1 ||
      record.id !== entry.slice(0, -5) ||
      !Number.isSafeInteger(record.pid) ||
      (record.pid as number) <= 0 ||
      (record.pid as number) > 0x7fffffff ||
      !Number.isSafeInteger(record.createdAt) ||
      (record.createdAt as number) <= 0 ||
      !["append", "direct-upload", "drain"].includes(String(record.kind)) ||
      Object.keys(record).sort().join() !== "createdAt,id,kind,pid,version"
    )
      throw new Error("Invalid maintenance activity record");
    // PID reuse is conservative: any live process retains the lease. Never
    // expire a live lease based on age or signal an observed process.
    if (leaseProcessMayBeAlive(record.pid as number)) active += 1;
    else if (reap) {
      unlinkSync(path);
      syncDirectory(leases);
    }
  }
  return active;
}

function admit(kind: ActivityKind, maintenanceId?: string): () => void {
  const p = paths();
  privateDirectory(p.root, true);
  const lease = withFileLockSync(
    p.lock,
    () => {
      if (maintenanceId === undefined) {
        if (pauseRecord() || handoffReservation()) throw new MaintenancePausedError();
      } else {
        matchingPause(maintenanceId);
        const reservation = handoffReservation();
        if (reservation && reservation.maintenanceId !== maintenanceId)
          throw new Error("Handoff reservation does not match the durable pause");
      }
      privateDirectory(p.leases, true);
      activeLeases(true);
      if (boundedNames(p.leases, MAX_LEASES).length >= MAX_LEASES)
        throw new Error("Maintenance activity admission bound reached");
      const record: Lease = {
        version: 1,
        id: randomBytes(16).toString("hex"),
        pid: process.pid,
        kind,
        createdAt: Date.now(),
      };
      const path = join(p.leases, `${record.id}.json`);
      atomicWriteFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      return { path, record };
    },
    LOCK_OPTIONS,
  );
  return () =>
    withFileLockSync(
      p.lock,
      () => {
        const current = object(lease.path);
        if (JSON.stringify(current) !== JSON.stringify(lease.record))
          throw new Error("Maintenance activity owner changed");
        unlinkSync(lease.path);
        syncDirectory(p.leases);
      },
      LOCK_OPTIONS,
    );
}

export function withMaintenanceActivitySync<T>(kind: ActivityKind, action: () => T): T {
  const release = admit(kind);
  try {
    return action();
  } finally {
    release();
  }
}

export async function withMaintenanceActivity<T>(
  kind: ActivityKind,
  action: () => Promise<T>,
  maintenanceId?: string,
): Promise<T> {
  const release = admit(kind, maintenanceId);
  try {
    return await action();
  } finally {
    release();
  }
}

function inventory(root: string): { complete: boolean; blockers: MaintenanceBlocker[] } {
  const moves = join(root, "moves");
  const blockers: MaintenanceBlocker[] = [];
  let entries = 0;
  let complete = true;
  function walk(path: string, depth: number): void {
    if (++entries > MAX_ENTRIES || depth > MAX_DEPTH) {
      complete = false;
      if (!blockers.some((row) => row.reason === "inventory_bound"))
        blockers.push({ path: "moves", reason: "inventory_bound", bytes: 0 });
      return;
    }
    const stat = lstatSync(path);
    const name = relative(root, path);
    if ((process.getuid && stat.uid !== process.getuid()) || stat.isSymbolicLink()) {
      complete = false;
      blockers.push({ path: name, reason: "unowned_or_symlink", bytes: 0 });
      return;
    }
    if ((stat.mode & 0o022) !== 0) {
      complete = false;
      blockers.push({ path: name, reason: "unsafe_permissions", bytes: 0 });
      return;
    }
    if (stat.isDirectory()) {
      const children = boundedNames(path, MAX_ENTRIES);
      for (const child of children) {
        if (entries >= MAX_ENTRIES) {
          complete = false;
          blockers.push({ path: name, reason: "inventory_bound", bytes: 0 });
          break;
        }
        walk(join(path, child), depth + 1);
      }
      return;
    }
    if (!stat.isFile() || stat.nlink !== 1) {
      complete = false;
      blockers.push({ path: name, reason: "non_regular_or_linked", bytes: 0 });
      return;
    }
    const basename = path.slice(path.lastIndexOf("/") + 1);
    if (basename === "journal.ndjson" && stat.size === 0) return;
    const reason =
      basename === "journal.ndjson"
        ? "pending_journal"
        : basename.startsWith("journal.ndjson.flushing.")
          ? "retained_rotation"
          : name.split("/").includes("dead-letter")
            ? "quarantined_data"
            : "unrecognized_or_retained_data";
    blockers.push({ path: name, reason, bytes: stat.size });
  }
  try {
    lstatSync(moves);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { complete, blockers };
    return { complete: false, blockers: [{ path: "moves", reason: "inventory_error", bytes: 0 }] };
  }
  try {
    walk(moves, 0);
  } catch {
    complete = false;
    blockers.push({ path: "moves", reason: "inventory_error", bytes: 0 });
  }
  return { complete, blockers };
}

function statusUnlocked(expectedId?: string): MaintenanceStatus {
  const p = paths();
  const pause = expectedId === undefined ? pauseRecord() : matchingPause(expectedId);
  const reservation = handoffReservation();
  if (reservation && reservation.maintenanceId !== pause?.id)
    throw new Error("Handoff reservation does not match the durable pause");
  const active = activeLeases(true);
  const queue = inventory(p.root);
  const drained = queue.complete && queue.blockers.length === 0;
  return {
    protocolVersion: 1,
    configRoot: p.root,
    paused: !!pause,
    maintenanceId: pause?.id ?? null,
    quiescent: !!pause && active === 0,
    inventoryComplete: queue.complete,
    drained,
    ready: !!pause && active === 0 && drained,
    activeLeases: active,
    handoffReserved: !!reservation,
    blockers: queue.blockers,
    scope: SCOPE,
    legacySessionsMustBeClosed: true,
  };
}

export async function maintenanceStatus(expectedId?: string): Promise<MaintenanceStatus> {
  const p = paths();
  privateDirectory(p.root, true);
  return withFileLock(p.lock, () => statusUnlocked(expectedId), LOCK_OPTIONS);
}

export async function pauseMaintenance(timeoutMs = 5000): Promise<MaintenanceStatus> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000)
    throw new Error("Maintenance timeout must be 0..30000 ms");
  const p = paths();
  privateDirectory(p.root, true);
  const record = await withFileLock(
    p.lock,
    () => {
      const previous = pauseRecord();
      if (previous) return previous;
      const value: Pause = {
        version: 1,
        id: randomBytes(16).toString("hex"),
        createdAt: Date.now(),
      };
      atomicWriteFile(p.state, `${JSON.stringify(value)}\n`, { mode: 0o600 });
      return value;
    },
    LOCK_OPTIONS,
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await maintenanceStatus(record.id);
    if (result.quiescent || Date.now() >= deadline) return result;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))),
    );
  }
}

export async function resumeMaintenance(id: string): Promise<MaintenanceStatus> {
  const p = paths();
  privateDirectory(p.root, true);
  return withFileLock(
    p.lock,
    () => {
      matchingPause(id);
      if (handoffReservation())
        throw new Error("Cannot resume a reserved handoff; complete guarded rollback first");
      if (activeLeases(true) !== 0)
        throw new Error("Cannot resume while maintenance activity remains admitted");
      unlinkSync(p.state);
      syncDirectory(p.root);
      return statusUnlocked();
    },
    LOCK_OPTIONS,
  );
}

/** Hold the same admission lock across a bounded local handoff transaction.
 * Callback may use the reservation helpers, but must not re-enter other
 * maintenance APIs or perform network/auth work.
 */
export async function withPausedMaintenance<T>(
  id: string,
  action: (status: MaintenanceStatus) => Promise<T>,
): Promise<T> {
  const p = paths();
  privateDirectory(p.root, true);
  return withFileLock(
    p.lock,
    async () => {
      const status = statusUnlocked(id);
      if (!status.ready) throw new Error("Maintenance is not quiescent and completely drained");
      transactionOwner = id;
      try {
        return await action(status);
      } finally {
        transactionOwner = undefined;
      }
    },
    LOCK_OPTIONS,
  );
}
