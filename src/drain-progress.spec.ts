import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type DrainCheckpoint,
  type RotationIdentity,
  drainProgressDirectory,
  drainProgressPath,
  drainResumeOffset,
  removeDrainCheckpoint,
  rotationIdentity,
  sweepOrphanedDrainCheckpoints,
  writeDrainCheckpoint,
} from "./drain-progress.js";

describe("drain checkpoints", () => {
  let dir: string;
  let rotation: string;
  let identity: RotationIdentity;

  /** A checkpoint at `offset` for the rotation as it is on disk now. */
  const at = (offset: number): DrainCheckpoint => ({ v: 2, offset, ...identity });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-drain-checkpoint-"));
    rotation = join(dir, "journal.ndjson.flushing.1700000000000.4242");
    writeFileSync(rotation, "{}\n{}\n");
    identity = rotationIdentity(statSync(rotation));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lives in the bucket's drain-progress directory, outside rotation enumeration", () => {
    expect(drainProgressPath(rotation)).toBe(
      join(dir, "drain-progress", "journal.ndjson.flushing.1700000000000.4242.json"),
    );
  });

  it("atomically replaces an owner-only checkpoint that resumes the drain", () => {
    writeDrainCheckpoint(rotation, at(3));
    writeDrainCheckpoint(rotation, at(6));

    expect(JSON.parse(readFileSync(drainProgressPath(rotation), "utf8"))).toEqual({
      v: 2,
      offset: 6,
      size: 6,
      ino: identity.ino,
      dev: identity.dev,
    });
    expect(readdirSync(drainProgressDirectory(rotation))).toEqual([
      "journal.ndjson.flushing.1700000000000.4242.json",
    ]);
    expect(statSync(drainProgressDirectory(rotation)).mode & 0o777).toBe(0o700);
    expect(statSync(drainProgressPath(rotation)).mode & 0o777).toBe(0o600);
    expect(drainResumeOffset(rotation, identity)).toBe(6);
  });

  it("ignores a checkpoint written for another file or by the identity-less v1 format", () => {
    writeDrainCheckpoint(rotation, at(3));
    expect(drainResumeOffset(rotation, identity)).toBe(3);
    // Same name and size, different file: a recreated rotation starts over.
    expect(drainResumeOffset(rotation, { ...identity, ino: identity.ino + 1 })).toBe(0);
    expect(drainResumeOffset(rotation, { ...identity, dev: identity.dev + 1 })).toBe(0);
    expect(drainResumeOffset(rotation, { ...identity, size: identity.size + 1 })).toBe(0);

    writeFileSync(drainProgressPath(rotation), JSON.stringify({ v: 1, offset: 3, size: 6 }));
    expect(drainResumeOffset(rotation, identity)).toBe(0);
  });

  it("resumes from the first line without a checkpoint and tolerates removing one twice", () => {
    expect(drainResumeOffset(rotation, identity)).toBe(0);
    writeDrainCheckpoint(rotation, at(3));

    removeDrainCheckpoint(rotation);
    removeDrainCheckpoint(rotation);
    expect(drainResumeOffset(rotation, identity)).toBe(0);
    // A drained bucket keeps no drain residue.
    expect(readdirSync(dir)).toEqual(["journal.ndjson.flushing.1700000000000.4242"]);
  });

  it("keeps the checkpoint directory while another rotation still uses it", () => {
    const other = join(dir, "journal.ndjson.flushing.1700000000001.4242");
    writeDrainCheckpoint(rotation, at(3));
    writeDrainCheckpoint(other, { v: 2, offset: 0, size: 0, ino: 1, dev: 1 });

    removeDrainCheckpoint(rotation);
    expect(readdirSync(drainProgressDirectory(rotation))).toEqual([
      "journal.ndjson.flushing.1700000000001.4242.json",
    ]);
  });

  it("sweeps only checkpoints and interrupted writes whose rotation is gone", () => {
    expect(() => sweepOrphanedDrainCheckpoints(dir)).not.toThrow();
    const retired = join(dir, "journal.ndjson.flushing.1600000000000.99");
    writeDrainCheckpoint(rotation, at(3));
    writeDrainCheckpoint(retired, { v: 2, offset: 3, size: 6, ino: 1, dev: 1 });
    const directory = drainProgressDirectory(rotation);
    // atomicWriteFile's `<target>.<uuid>.tmp`, as an interrupted write leaves it.
    const temporarySuffix = `.${randomUUID()}.tmp`;
    const liveTemporary = `${drainProgressPath(rotation)}${temporarySuffix}`;
    const orphanTemporary = `${drainProgressPath(retired)}${temporarySuffix}`;
    writeFileSync(liveTemporary, "");
    writeFileSync(orphanTemporary, "");
    writeFileSync(join(directory, "notes.txt"), "");

    sweepOrphanedDrainCheckpoints(dir);

    expect(existsSync(drainProgressPath(rotation))).toBe(true);
    expect(existsSync(liveTemporary)).toBe(true);
    expect(existsSync(drainProgressPath(retired))).toBe(false);
    expect(existsSync(orphanTemporary)).toBe(false);
    expect(existsSync(join(directory, "notes.txt"))).toBe(true);
  });

  it("removes the checkpoint directory once its last orphan is swept", () => {
    const retired = join(dir, "journal.ndjson.flushing.1600000000000.99");
    writeDrainCheckpoint(retired, { v: 2, offset: 3, size: 6, ino: 1, dev: 1 });

    sweepOrphanedDrainCheckpoints(dir);
    expect(existsSync(drainProgressDirectory(retired))).toBe(false);
  });
});
