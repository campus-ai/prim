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
  drainProgressDirectory,
  drainProgressPath,
  drainResumeOffset,
  removeDrainCheckpoint,
  sweepOrphanedDrainCheckpoints,
  writeDrainCheckpoint,
} from "./drain-progress.js";

describe("drain checkpoints", () => {
  let dir: string;
  let rotation: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-drain-checkpoint-"));
    rotation = join(dir, "journal.ndjson.flushing.1700000000000.4242");
    writeFileSync(rotation, "{}\n{}\n");
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
    writeDrainCheckpoint(rotation, { v: 1, offset: 3, size: 6 });
    writeDrainCheckpoint(rotation, { v: 1, offset: 6, size: 6 });

    expect(JSON.parse(readFileSync(drainProgressPath(rotation), "utf8"))).toEqual({
      v: 1,
      offset: 6,
      size: 6,
    });
    expect(readdirSync(drainProgressDirectory(rotation))).toEqual([
      "journal.ndjson.flushing.1700000000000.4242.json",
    ]);
    expect(statSync(drainProgressDirectory(rotation)).mode & 0o777).toBe(0o700);
    expect(statSync(drainProgressPath(rotation)).mode & 0o777).toBe(0o600);
    expect(drainResumeOffset(rotation, 6)).toBe(6);
  });

  it("resumes from the first line without a checkpoint and tolerates removing one twice", () => {
    expect(drainResumeOffset(rotation, 6)).toBe(0);
    writeDrainCheckpoint(rotation, { v: 1, offset: 3, size: 6 });

    removeDrainCheckpoint(rotation);
    removeDrainCheckpoint(rotation);
    expect(drainResumeOffset(rotation, 6)).toBe(0);
    // A drained bucket keeps no drain residue.
    expect(readdirSync(dir)).toEqual(["journal.ndjson.flushing.1700000000000.4242"]);
  });

  it("keeps the checkpoint directory while another rotation still uses it", () => {
    const other = join(dir, "journal.ndjson.flushing.1700000000001.4242");
    writeDrainCheckpoint(rotation, { v: 1, offset: 3, size: 6 });
    writeDrainCheckpoint(other, { v: 1, offset: 0, size: 0 });

    removeDrainCheckpoint(rotation);
    expect(readdirSync(drainProgressDirectory(rotation))).toEqual([
      "journal.ndjson.flushing.1700000000001.4242.json",
    ]);
  });

  it("sweeps only checkpoints and interrupted writes whose rotation is gone", () => {
    expect(() => sweepOrphanedDrainCheckpoints(dir)).not.toThrow();
    const retired = join(dir, "journal.ndjson.flushing.1600000000000.99");
    writeDrainCheckpoint(rotation, { v: 1, offset: 3, size: 6 });
    writeDrainCheckpoint(retired, { v: 1, offset: 6, size: 6 });
    const directory = drainProgressDirectory(rotation);
    const liveTemporary = `${drainProgressPath(rotation)}.123.0123456789abcdef.tmp`;
    const orphanTemporary = `${drainProgressPath(retired)}.123.0123456789abcdef.tmp`;
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
    writeDrainCheckpoint(retired, { v: 1, offset: 6, size: 6 });

    sweepOrphanedDrainCheckpoints(dir);
    expect(existsSync(drainProgressDirectory(retired))).toBe(false);
  });
});
