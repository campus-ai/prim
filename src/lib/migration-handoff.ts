/** Reversible maintenance transaction. Neither Start nor legacy resume is ever called. */
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensureDurableDirectory, syncDirectory } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import {
  type Image,
  canonicalDirectory,
  digest,
  equal,
  guardImage,
  image,
  json,
  object,
  pathSafe,
  privateDirectory,
  privateJSON,
  writeImage,
  writePrivate,
} from "./migration-handoff-io.js";
import {
  type Change,
  type Guard,
  type Spec,
  inventory,
  pinned,
  plan,
  rpc,
  stopped,
  validateSpec,
  verifyAndQuit,
} from "./migration-handoff-plan.js";
import { privacyInventory, redactions } from "./migration-handoff-redaction.js";
import {
  maintenanceStatus,
  releaseMaintenanceHandoff,
  reserveMaintenanceHandoff,
  withPausedMaintenance,
} from "./migration-maintenance.js";

type Entry = { path: string; before: string; after: string };
type RecordFile = {
  version: 1;
  id: string;
  spec: Spec;
  epoch: string;
  createdAt: number;
  state: "prepared" | "applying" | "applied" | "rolling-back" | "rolled-back";
  entries: Entry[];
  guards: { path: string; hash: string | null; mode: number }[];
  known: string[];
  gitDirs: string[];
  privacyPaths: string[];
  completed: number;
};
function publicStatus(record: RecordFile) {
  return {
    protocolVersion: 1,
    transactionId: record.id,
    state: record.state,
    paths: record.entries.map((entry) => entry.path),
    completed: record.completed,
    legacyPauseRequired: true,
    nativeStoppedRequired: true,
    resumeRequiresExplicitAction: true,
    scope: "operator-closed-sessions-and-declared-repositories",
  };
}
function checkImage(actual: Image, expected: Pick<Image, "hash" | "mode">): boolean {
  return actual.hash === expected.hash && (actual.hash === null || actual.mode === expected.mode);
}
function checkGuards(guards: RecordFile["guards"]): void {
  for (const guard of guards)
    if (!checkImage(guardImage(guard.path), guard))
      throw new Error(`Handoff inventory changed: ${guard.path}`);
}
function save(directory: string, record: RecordFile): void {
  writePrivate(join(directory, "transaction.json"), record);
}
function load(directory: string): RecordFile {
  privateDirectory(directory);
  const value = object(privateJSON(join(directory, "transaction.json"))) as unknown as RecordFile;
  if (
    value.version !== 1 ||
    !/^[0-9a-f]{32}$/.test(value.id) ||
    typeof value.epoch !== "string" ||
    !Array.isArray(value.entries) ||
    value.entries.length > 512 ||
    !Array.isArray(value.guards) ||
    value.guards.length > 6000 ||
    !["prepared", "applying", "applied", "rolling-back", "rolled-back"].includes(value.state)
  )
    throw new Error("Invalid transaction metadata");
  value.spec = validateSpec(value.spec);
  const allowed = new Set(
    value.spec.targets.flatMap((target) => [target.path, `${target.path}.primitive-native.json`]),
  );
  if (value.spec.targets.some((target) => target.kind === "host" && target.agent === "cursor"))
    allowed.add(join(value.spec.agentDirectories.cursor, "cli-config.json"));
  const seen = new Set<string>();
  value.entries.forEach((entry, index) => {
    if (
      !allowed.has(entry.path) ||
      seen.has(entry.path) ||
      entry.before !== `${index}.before.json` ||
      entry.after !== `${index}.after.json`
    )
      throw new Error("Invalid transaction path or snapshot reference");
    seen.add(entry.path);
  });
  return value;
}
function snapshot(directory: string, name: string): Image {
  const value = object(privateJSON(join(directory, name))) as Image;
  if (
    (value.text !== null && typeof value.text !== "string") ||
    !Number.isInteger(value.mode) ||
    value.mode < 0 ||
    value.mode > 0o777 ||
    value.hash !== (value.text === null ? null : digest(value.text))
  )
    throw new Error("Invalid transaction snapshot");
  return value;
}
function entries(directory: string, record: RecordFile): Change[] {
  return record.entries.map((entry) => ({
    path: entry.path,
    before: snapshot(directory, entry.before),
    after: snapshot(directory, entry.after),
  }));
}
function definitelyExited(pid: unknown): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || (pid as number) > 0x7fffffff) return false;
  try {
    process.kill(pid as number, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
async function pathLocks<T>(paths: string[], id: string, action: () => Promise<T>): Promise<T> {
  const acquired: string[] = [];
  try {
    for (const path of [...new Set(paths)].sort()) {
      pathSafe(path);
      canonicalDirectory(dirname(path));
      if (existsSync(path)) {
        const stat = lstatSync(path);
        const files = readdirSync(path);
        if (
          !stat.isDirectory() ||
          (stat.mode & 0o077) !== 0 ||
          files.length !== 1 ||
          files[0] !== "handoff-owner.json"
        )
          throw new Error("An existing configuration lock requires its owner; no lock was removed");
        const owner = object(privateJSON(join(path, "handoff-owner.json")));
        if (owner.id !== id || !definitelyExited(owner.pid))
          throw new Error("Configuration lock belongs to another live operation");
        unlinkSync(join(path, "handoff-owner.json"));
        rmdirSync(path);
        syncDirectory(dirname(path));
      }
      mkdirSync(path, { mode: 0o700 });
      writePrivate(join(path, "handoff-owner.json"), { id, pid: process.pid });
      acquired.push(path);
    }
    return await action();
  } finally {
    for (const path of acquired.reverse()) {
      const owner = object(privateJSON(join(path, "handoff-owner.json")));
      if (owner.id === id && owner.pid === process.pid) {
        unlinkSync(join(path, "handoff-owner.json"));
        rmdirSync(path);
        syncDirectory(dirname(path));
      }
    }
  }
}
export async function prepareHandoff(specPath: string, directory: string) {
  const spec = validateSpec(privateJSON(pathSafe(specPath)));
  pathSafe(directory);
  canonicalDirectory(dirname(directory));
  if (existsSync(directory)) throw new Error("Choose a new transaction directory");
  if (spec.projects.some((root) => directory === root || directory.startsWith(`${root}/`)))
    throw new Error("Store transaction snapshots outside declared capture repositories");
  const status = await maintenanceStatus(spec.maintenanceId);
  if (status.handoffReserved)
    throw new Error("A handoff reservation already exists; recover or roll it back first");
  if (!status.ready || status.configRoot !== spec.legacyConfigRoot)
    throw new Error("Legacy pause/root/all-queue readiness does not match");
  await pinned(spec);
  const initial = await inventory(spec);
  const privacy = await redactions(spec);
  ensureDurableDirectory(directory, 0o700);
  privateDirectory(directory);
  // Failed preparation retains private diagnostics/snapshots, never silently reuses the directory.
  const changes = await plan(spec, directory);
  const guards: Guard[] = [...initial.guards, ...privacy];
  checkGuards(guards.map(({ path, before }) => ({ path, hash: before.hash, mode: before.mode })));
  const epoch = await verifyAndQuit(spec);
  return withPausedMaintenance(spec.maintenanceId, async (ready) => {
    if (ready.configRoot !== spec.legacyConfigRoot) throw new Error("Legacy root changed");
    checkGuards(guards.map(({ path, before }) => ({ path, hash: before.hash, mode: before.mode })));
    await stopped(spec, epoch);
    const changedPaths = new Set(changes.map((change) => change.path));
    const record: RecordFile = {
      version: 1,
      id: randomBytes(16).toString("hex"),
      spec,
      epoch,
      createdAt: Date.now(),
      state: "prepared",
      entries: [],
      guards: guards
        .filter((guard) => !changedPaths.has(guard.path))
        .map(({ path, before }) => ({ path, hash: before.hash, mode: before.mode })),
      known: initial.known,
      gitDirs: initial.gitDirs,
      privacyPaths: privacy.map((guard) => guard.path).sort(),
      completed: 0,
    };
    changes.forEach((change, index) => {
      const before = `${index}.before.json`;
      const after = `${index}.after.json`;
      writePrivate(join(directory, before), change.before);
      writePrivate(join(directory, after), change.after);
      record.entries.push({ path: change.path, before, after });
    });
    if (record.guards.length > 6000)
      throw new Error("Handoff guard inventory exceeds its durable transaction bound");
    save(directory, record);
    reserveMaintenanceHandoff(spec.maintenanceId, record.id, directory);
    return publicStatus(record);
  });
}
export function handoffStatus(directory: string) {
  return publicStatus(load(pathSafe(directory)));
}
export async function changeHandoff(directory: string, direction: "apply" | "rollback") {
  pathSafe(directory);
  privateDirectory(directory);
  return withFileLock(
    join(directory, ".operation-lock"),
    async () => {
      const record = load(directory);
      const spec = record.spec;
      const changes = entries(directory, record);
      await pinned(spec);
      if (
        direction === "apply" &&
        record.state === "prepared" &&
        Date.now() - record.createdAt > 5 * 60 * 1000
      )
        throw new Error(
          "Prepared authentication evidence expired; prepare a fresh transaction after explicit Start/authentication",
        );
      if (direction === "apply" && ["rolling-back", "rolled-back"].includes(record.state))
        throw new Error("A rollback cannot be reapplied; prepare a new handoff");
      const auth = await rpc(spec, "auth.status");
      if (
        auth.siteUrl !== spec.native.siteURL ||
        !equal(
          direction === "rollback"
            ? (auth.authority ?? auth.lastVerifiedAuthority)
            : auth.authority,
          spec.native.expectedAuthority,
        )
      )
        throw new Error("Prepared native authority changed");
      const ack = await rpc(spec, "quit");
      if (ack.stopped !== true || ack.outboxPending !== 0 || ack.outboxQuarantined !== 0)
        throw new Error("Quit did not acknowledge quiescent native state");
      if (direction === "rollback") record.epoch = (await stopped(spec)).runtimeEpoch as string;
      else await stopped(spec, record.epoch);
      const locks = changes
        .filter((change) => !change.path.endsWith(".primitive-native.json"))
        .map((change) =>
          spec.targets.some((target) => target.kind === "git" && target.path === change.path)
            ? join(dirname(change.path), ".primitive-hooks.primitive-lock")
            : `${change.path}.primitive-lock`,
        );
      return withPausedMaintenance(spec.maintenanceId, async (ready) => {
        if (ready.configRoot !== spec.legacyConfigRoot)
          throw new Error("Legacy configuration root changed");
        reserveMaintenanceHandoff(spec.maintenanceId, record.id, directory);
        return pathLocks(locks, record.id, async () => {
          checkGuards(record.guards);
          const privacy = await redactions(spec, new Set(locks));
          if (!equal(privacy.map((guard) => guard.path).sort(), record.privacyPaths))
            throw new Error("Workspace privacy inventory changed");
          // Directory membership, including unexpected hook files, must still match the prepared inventory.
          const current = await inventoryForRecovery(spec, changes);
          if (!equal(current.known, record.known) || !equal(current.gitDirs, record.gitDirs))
            throw new Error("Known host/Git inventory changed");
          for (const change of changes) {
            const current = image(change.path);
            if (!checkImage(current, change.before) && !checkImage(current, change.after))
              throw new Error(`Outside edit retained; handoff held: ${change.path}`);
          }
          record.state = direction === "apply" ? "applying" : "rolling-back";
          record.completed = 0;
          save(directory, record); // Durable operation intent precedes the first target mutation.
          const ordered = direction === "apply" ? changes : [...changes].reverse();
          for (const change of ordered) {
            await stopped(spec, record.epoch);
            checkGuards(record.guards);
            const current = image(change.path);
            const desired = direction === "apply" ? change.after : change.before;
            if (!checkImage(current, change.before) && !checkImage(current, change.after))
              throw new Error(`Outside edit retained; handoff held: ${change.path}`);
            if (!checkImage(current, desired)) writeImage(change.path, desired);
            record.completed += 1;
            save(directory, record);
          }
          // Native activity is checked before the final filesystem snapshot. No external
          // await follows the last synchronous guard/image reads and terminal record.
          await stopped(spec, record.epoch);
          const finalInventory = await inventoryForRecovery(spec, changes);
          if (
            !equal(finalInventory.known, record.known) ||
            !equal(finalInventory.gitDirs, record.gitDirs)
          )
            throw new Error("Final host/Git inventory changed; reservation retained");
          const finalPrivacy = privacyInventory(spec, new Set(locks));
          if (!equal(finalPrivacy.guards.map((guard) => guard.path).sort(), record.privacyPaths))
            throw new Error("Final workspace privacy inventory changed; reservation retained");
          pinned(spec);
          checkGuards(record.guards);
          for (const change of changes) {
            const desired = direction === "apply" ? change.after : change.before;
            if (!checkImage(image(change.path), desired))
              throw new Error("Final config verification failed; reservation retained");
          }
          record.state = direction === "apply" ? "applied" : "rolled-back";
          save(directory, record);
          if (direction === "rollback")
            releaseMaintenanceHandoff(spec.maintenanceId, record.id, directory);
          return publicStatus(record);
        });
      });
    },
    { timeoutMs: 2000 },
  );
}
/** Inventory only: never hide receipt files or installed bytes by temporarily changing targets. */
async function inventoryForRecovery(spec: Spec, changes: Change[]) {
  // The planner's fresh-install checks intentionally reject native receipts. Reuse its path
  // discovery with exact before-images only as a read adapter, never as filesystem mutation.
  return inventory(spec, new Map(changes.map((change) => [change.path, change.before])));
}
