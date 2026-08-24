import { beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_ID = "00000000-0000-4000-8000-000000000042";

vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => TEMP_ID) }));
vi.mock("node:fs", () => ({
  constants: {
    O_RDONLY: 0,
    O_WRONLY: 1,
    O_CREAT: 0x200,
    O_EXCL: 0x800,
    O_NOFOLLOW: 0x100,
  },
  closeSync: vi.fn(),
  fchmodSync: vi.fn(),
  fsyncSync: vi.fn(),
  mkdirSync: vi.fn(),
  openSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { constants, closeSync, fsyncSync, mkdirSync, openSync, renameSync } from "node:fs";
import { atomicWriteFile, ensureDurableDirectory, syncFile } from "./atomic-file.js";

const mockedCloseSync = vi.mocked(closeSync);
const mockedFsyncSync = vi.mocked(fsyncSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedOpenSync = vi.mocked(openSync);
const mockedRenameSync = vi.mocked(renameSync);

beforeEach(() => {
  vi.clearAllMocks();
  mockedMkdirSync.mockReturnValue(undefined);
});

describe("atomicWriteFile durability", () => {
  it("creates explicit-mode directories without a permissive intermediate mode", () => {
    ensureDurableDirectory("/private/config", 0o700);

    expect(mockedMkdirSync).toHaveBeenCalledWith("/private/config", {
      recursive: true,
      mode: 0o700,
    });
  });

  it("flushes a copied immutable file without following a symlink", () => {
    mockedOpenSync.mockReturnValue(12);

    syncFile("/private/config/release/dist/index.js");

    expect(mockedOpenSync).toHaveBeenCalledWith(
      "/private/config/release/dist/index.js",
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    expect(mockedFsyncSync).toHaveBeenCalledWith(12);
    expect(mockedCloseSync).toHaveBeenCalledWith(12);
  });

  it("flushes the target directory after the atomic rename", () => {
    const target = "/private/config/credential";
    const temporary = `${target}.${TEMP_ID}.tmp`;
    mockedOpenSync.mockReturnValueOnce(10).mockReturnValueOnce(11);

    atomicWriteFile(target, "credential");

    expect(mockedRenameSync).toHaveBeenCalledWith(temporary, target);
    expect(mockedOpenSync).toHaveBeenNthCalledWith(2, "/private/config", 0);
    expect(mockedFsyncSync).toHaveBeenNthCalledWith(1, 10);
    expect(mockedFsyncSync).toHaveBeenNthCalledWith(2, 11);
    expect(mockedRenameSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockedFsyncSync.mock.invocationCallOrder[1] ?? Number.POSITIVE_INFINITY,
    );
    expect(mockedCloseSync).toHaveBeenCalledWith(11);
  });

  it("flushes every recursive directory link before the target directory after rename", () => {
    const target = "/private/config/prim/agent/credential";
    const firstCreatedParent = "/private/config";
    const parent = "/private/config/prim/agent";
    // Node returns the first path recursive mkdir created, not the leaf.
    mockedMkdirSync.mockReturnValue(firstCreatedParent);
    mockedOpenSync
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(21)
      .mockReturnValueOnce(22)
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(23);

    atomicWriteFile(target, "credential", { ensureParent: true });

    expect(mockedOpenSync).toHaveBeenNthCalledWith(1, "/private", 0);
    expect(mockedOpenSync).toHaveBeenNthCalledWith(2, firstCreatedParent, 0);
    expect(mockedOpenSync).toHaveBeenNthCalledWith(3, "/private/config/prim", 0);
    expect(mockedOpenSync).toHaveBeenNthCalledWith(5, parent, 0);
    expect(mockedFsyncSync.mock.calls).toEqual([[20], [21], [22], [10], [23]]);
  });
});
