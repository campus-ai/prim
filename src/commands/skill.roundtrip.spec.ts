import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SKILL_BEGIN, SKILL_END, runInstall, runStatus, runUninstall } from "./skill.js";

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "prim-skill-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("skill install/uninstall round-trip (real fs)", () => {
  it("installs into a fresh CLAUDE.md and is byte-stable on re-run", () => {
    const target = join(work, "CLAUDE.md");
    writeFileSync(target, "# CLAUDE.md\n");

    expect(runInstall(work, {})).toBe(0);
    const afterFirst = readFileSync(target);
    expect(afterFirst.toString()).toContain(SKILL_BEGIN);
    expect(afterFirst.toString()).toContain(SKILL_END);

    expect(runInstall(work, {})).toBe(0);
    const afterSecond = readFileSync(target);
    expect(afterSecond.equals(afterFirst)).toBe(true);
  });

  it("status reports installed after install, absent after uninstall", () => {
    const target = join(work, "CLAUDE.md");
    writeFileSync(target, "# CLAUDE.md\n");

    expect(runInstall(work, {})).toBe(0);
    expect(runStatus(work, {})).toBe(0);

    expect(runUninstall(work, {})).toBe(0);
    expect(runStatus(work, {})).toBe(1);
  });

  it("restores byte-identical content after install→uninstall", () => {
    const target = join(work, "CLAUDE.md");
    const original = "# CLAUDE.md\n\nsome notes\n";
    writeFileSync(target, original);

    expect(runInstall(work, {})).toBe(0);
    expect(runUninstall(work, {})).toBe(0);
    expect(readFileSync(target, "utf-8")).toBe(original);
  });

  it("respects --target override and ignores auto-detected files", () => {
    writeFileSync(join(work, "CLAUDE.md"), "# CLAUDE.md\n");
    expect(runInstall(work, { target: "custom.md" })).toBe(0);
    const custom = readFileSync(join(work, "custom.md"), "utf-8");
    expect(custom).toContain(SKILL_BEGIN);
    const claude = readFileSync(join(work, "CLAUDE.md"), "utf-8");
    expect(claude).toBe("# CLAUDE.md\n");
  });
});
