import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cursorSkillDirectory,
  hasUsableCursorSkill,
  runInstall,
  runStatus,
  runUninstall,
} from "./skill.js";

describe("native Cursor skill ownership", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "prim-cursor-skill-"));
    execFileSync("git", ["init", "-q", root]);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("installs, reports, repeats, and removes an exactly owned project skill", () => {
    const directory = cursorSkillDirectory(root, "project");
    const skill = join(directory, "SKILL.md");
    const manifest = join(directory, ".prim-owned.json");

    expect(runInstall(root, { agent: "cursor", scope: "project" })).toBe(0);
    expect(existsSync(skill)).toBe(true);
    expect(existsSync(manifest)).toBe(true);
    expect(runStatus(root, { agent: "cursor", scope: "project", json: true })).toBe(0);
    expect(hasUsableCursorSkill(root)).toBe(true);
    expect(runInstall(root, { agent: "cursor", scope: "project" })).toBe(0);
    expect(runUninstall(root, { agent: "cursor", scope: "project" })).toBe(0);
    expect(existsSync(skill)).toBe(false);
    expect(existsSync(manifest)).toBe(false);
  });

  it("refuses to overwrite a foreign skill or remove an edited owned skill", () => {
    const directory = cursorSkillDirectory(root, "project");
    const skill = join(directory, "SKILL.md");
    mkdirSync(directory, { recursive: true });
    writeFileSync(skill, "foreign\n");
    expect(runInstall(root, { agent: "cursor", scope: "project" })).toBe(1);
    expect(readFileSync(skill, "utf8")).toBe("foreign\n");

    rmSync(directory, { recursive: true, force: true });
    expect(runInstall(root, { agent: "cursor", scope: "project" })).toBe(0);
    writeFileSync(skill, `${readFileSync(skill, "utf8")}edited\n`);
    expect(runUninstall(root, { agent: "cursor", scope: "project" })).toBe(1);
    expect(existsSync(skill)).toBe(true);
  });

  it("uses CURSOR_CONFIG_DIR for a user-scoped skill", () => {
    const config = join(root, "cursor-config");
    vi.stubEnv("CURSOR_CONFIG_DIR", config);

    expect(runInstall(root, { agent: "cursor", scope: "user" })).toBe(0);
    expect(existsSync(join(config, "skills", "prim", "SKILL.md"))).toBe(true);
  });

  it("rejects an unknown scope without writing a project skill", () => {
    expect(runInstall(root, { agent: "cursor", scope: "workspace" })).toBe(1);
    expect(existsSync(join(root, ".cursor", "skills", "prim", "SKILL.md"))).toBe(false);
  });
});
