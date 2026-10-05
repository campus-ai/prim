import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readBoundedRegularFile } from "./bounded-file.js";

// A FIFO at the path is covered in drift-heal.spec.ts, in a child process: if
// the guard regressed, the read would block this test thread for good.
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "prim-bounded-file-"));
  roots.push(directory);
  return directory;
}

describe("readBoundedRegularFile", () => {
  it("reads a regular file within the bound with its owner", () => {
    const path = join(root(), "launcher");
    writeFileSync(path, "#!/bin/sh\n");

    expect(readBoundedRegularFile(path, 64)).toEqual({
      text: "#!/bin/sh\n",
      ownerUid: statSync(path).uid,
    });
  });

  it("treats an oversized file, a directory, a symlink, or a missing path as absent", () => {
    const directory = root();
    const large = join(directory, "large");
    writeFileSync(large, "x".repeat(65));
    const target = join(directory, "target");
    writeFileSync(target, "ok\n");
    const link = join(directory, "link");
    symlinkSync(target, link);
    const nested = join(directory, "nested");
    mkdirSync(nested);

    expect(readBoundedRegularFile(large, 64)).toBeUndefined();
    expect(readBoundedRegularFile(link, 64)).toBeUndefined();
    expect(readBoundedRegularFile(nested, 64)).toBeUndefined();
    expect(readBoundedRegularFile(join(directory, "missing"), 64)).toBeUndefined();
    expect(readBoundedRegularFile(target, 64)?.text).toBe("ok\n");
  });
});
