import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TEMP_ID = "00000000-0000-4000-8000-000000000042";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(() => TEMP_ID) };
});

import { atomicWriteFile } from "./atomic-file.js";

describe("atomicWriteFile", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prim-atomic-file-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("creates missing parents and installs fully written bytes with the requested mode", () => {
    const target = join(root, "nested", "token");
    atomicWriteFile(target, "secret\n", { ensureParent: true, mode: 0o600 });

    expect(readFileSync(target, "utf8")).toBe("secret\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("refuses a pre-planted temporary symlink without touching its victim", () => {
    const target = join(root, "settings.json");
    const victim = join(root, "victim");
    const temporary = `${target}.${TEMP_ID}.tmp`;
    writeFileSync(target, "old");
    writeFileSync(victim, "victim");
    symlinkSync(victim, temporary);

    expect(() => atomicWriteFile(target, "next")).toThrow(
      expect.objectContaining({ code: "EEXIST" }),
    );
    expect(readFileSync(target, "utf8")).toBe("old");
    expect(readFileSync(victim, "utf8")).toBe("victim");
    expect(lstatSync(temporary).isSymbolicLink()).toBe(true);
  });

  it("replaces a symlink target itself instead of following it", () => {
    const target = join(root, "settings.json");
    const victim = join(root, "victim");
    writeFileSync(victim, "victim");
    symlinkSync(victim, target);

    atomicWriteFile(target, "next");

    expect(lstatSync(target).isSymbolicLink()).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("next");
    expect(readFileSync(victim, "utf8")).toBe("victim");
  });

  it("leaves the old target intact and cleans its temp when validation fails before rename", () => {
    const target = join(root, "config.yaml");
    const temporary = `${target}.${TEMP_ID}.tmp`;
    writeFileSync(target, "old\n");

    expect(() =>
      atomicWriteFile(target, "new\n", {
        validate(path) {
          expect(readFileSync(path, "utf8")).toBe("new\n");
          throw new Error("simulated pre-rename crash");
        },
      }),
    ).toThrow("simulated pre-rename crash");
    expect(readFileSync(target, "utf8")).toBe("old\n");
    expect(existsSync(temporary)).toBe(false);
  });
});
