import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOrCreateClientInstanceId, isClientInstanceId } from "./client-instance-id.js";

const fsyncControl = vi.hoisted(() => ({ failNext: false }));
const atomicCallOrder = vi.hoisted(() => [] as string[]);

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fsyncSync: (fd: Parameters<typeof actual.fsyncSync>[0]) => {
      if (fsyncControl.failNext) {
        fsyncControl.failNext = false;
        throw new Error("simulated flush failure");
      }
      actual.fsyncSync(fd);
    },
  };
});

vi.mock("../lib/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/atomic-file.js")>();
  return {
    ...actual,
    ensureDurableDirectory: (path: string) => {
      atomicCallOrder.push(`directory:${path}`);
      actual.ensureDurableDirectory(path);
    },
    atomicWriteFile: (...args: Parameters<typeof actual.atomicWriteFile>) => {
      atomicCallOrder.push(`write:${args[0]}`);
      actual.atomicWriteFile(...args);
    },
  };
});

describe("stable client instance identity", () => {
  const roots: string[] = [];

  function tempConfig(): string {
    const root = mkdtempSync(join(tmpdir(), "prim-client-instance-test-"));
    roots.push(root);
    return join(root, "config");
  }

  beforeEach(() => {
    fsyncControl.failNext = false;
    atomicCallOrder.length = 0;
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("generates once under concurrency with private config permissions", async () => {
    const configDir = tempConfig();
    const ids = await Promise.all(
      Array.from({ length: 12 }, () => getOrCreateClientInstanceId({ configDir })),
    );

    expect(new Set(ids).size).toBe(1);
    expect(isClientInstanceId(ids[0])).toBe(true);
    expect(ids[0]).toHaveLength(47);
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    const path = join(configDir, "client_instance_id");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(`${ids[0]}\n`);
    expect(existsSync(join(configDir, "client-instance.lock"))).toBe(false);
  });

  it("durably prepares the config directory before publishing an identity", async () => {
    const configDir = tempConfig();
    await getOrCreateClientInstanceId({ configDir });

    expect(atomicCallOrder).toEqual([
      `directory:${configDir}`,
      `write:${join(configDir, "client_instance_id")}`,
    ]);
  });

  it("reuses an existing valid identity and repairs its file mode", async () => {
    const configDir = tempConfig();
    const initial = await getOrCreateClientInstanceId({ configDir });
    const path = join(configDir, "client_instance_id");
    chmodSync(path, 0o644);

    await expect(getOrCreateClientInstanceId({ configDir })).resolves.toBe(initial);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("does not publish an identity after a durability failure", async () => {
    const configDir = tempConfig();
    fsyncControl.failNext = true;

    await expect(getOrCreateClientInstanceId({ configDir })).rejects.toThrow(
      "simulated flush failure",
    );
    expect(existsSync(join(configDir, "client_instance_id"))).toBe(false);
    expect(readdirSync(configDir)).toEqual([]);

    const id = await getOrCreateClientInstanceId({ configDir });
    expect(readFileSync(join(configDir, "client_instance_id"), "utf8")).toBe(`${id}\n`);
  });

  it("keeps daemon-selected config roots isolated", async () => {
    const firstConfigDir = tempConfig();
    const secondConfigDir = tempConfig();

    const first = await getOrCreateClientInstanceId({
      configDir: firstConfigDir,
    });
    const second = await getOrCreateClientInstanceId({
      configDir: secondConfigDir,
    });

    expect(first).not.toBe(second);
    expect(readFileSync(join(firstConfigDir, "client_instance_id"), "utf8")).toBe(`${first}\n`);
    expect(readFileSync(join(secondConfigDir, "client_instance_id"), "utf8")).toBe(`${second}\n`);
  });

  it.each([
    "alice-personal-macbook.local",
    "daemon-12345",
    `pci_${"a".repeat(42)}`,
    `pci_${"a".repeat(44)}`,
    `pci_${"a".repeat(42)}!`,
  ])("fails closed without rotating malformed or PII-bearing state: %s", async (value) => {
    const configDir = tempConfig();
    await getOrCreateClientInstanceId({ configDir });
    const path = join(configDir, "client_instance_id");
    writeFileSync(path, `${value}\n`);

    await expect(getOrCreateClientInstanceId({ configDir })).rejects.toThrow(
      "stored client instance identity is invalid",
    );
    expect(readFileSync(path, "utf8")).toBe(`${value}\n`);
  });

  it("rejects a symlink instead of reading or overwriting its target", async () => {
    const configDir = tempConfig();
    await getOrCreateClientInstanceId({ configDir });
    const path = join(configDir, "client_instance_id");
    const target = join(configDir, "outside-value");
    const original = `pci_${"b".repeat(43)}\n`;
    rmSync(path);
    writeFileSync(target, original);
    symlinkSync(target, path);

    await expect(getOrCreateClientInstanceId({ configDir })).rejects.toThrow(
      "stored client instance identity is invalid",
    );
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(original);
  });
});
