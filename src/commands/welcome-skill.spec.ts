import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installWelcomeSkill, uninstallWelcomeSkill, welcomeSkillStatus } from "./welcome-skill.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prim-welcome-skill-"));
  roots.push(root);
  return join(root, "skills", "prim-welcome", "SKILL.md");
}

it("installs, upgrades, and removes only owned welcome content", () => {
  const path = fixture();
  expect(installWelcomeSkill(path, "welcome v1\n")).toBe(0);
  expect(welcomeSkillStatus(path)).toMatchObject({ installed: true, owned: true, edited: false });
  expect(installWelcomeSkill(path, "welcome v1\n")).toBe(0);
  expect(installWelcomeSkill(path, "welcome v2\n")).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("welcome v2\n");
  expect(uninstallWelcomeSkill(path)).toBe(0);
  expect(existsSync(path)).toBe(false);
});

it("preserves foreign and edited welcome skills", () => {
  const path = fixture();
  expect(installWelcomeSkill(path, "welcome\n")).toBe(0);
  writeFileSync(path, "user edit\n");
  expect(installWelcomeSkill(path, "new welcome\n")).toBe(1);
  expect(uninstallWelcomeSkill(path)).toBe(1);
  expect(readFileSync(path, "utf8")).toBe("user edit\n");
  const foreign = fixture();
  expect(installWelcomeSkill(foreign, "same as package\n")).toBe(0);
  rmSync(join(foreign, "..", ".prim-owned.json"));
  writeFileSync(foreign, "foreign\n");
  expect(installWelcomeSkill(foreign, "new welcome\n")).toBe(1);
  expect(uninstallWelcomeSkill(foreign)).toBe(0);
  expect(readFileSync(foreign, "utf8")).toBe("foreign\n");
});

it("adopts an unchanged welcome skill installed before ownership records", () => {
  const path = fixture();
  expect(installWelcomeSkill(path, "welcome\n")).toBe(0);
  rmSync(join(path, "..", ".prim-owned.json"));
  expect(installWelcomeSkill(path, "welcome\n")).toBe(0);
  expect(welcomeSkillStatus(path).installed).toBe(true);
});
