import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const cli = resolve("dist/index.js");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prim-codex-welcome-"));
  roots.push(root);
  const repo = join(root, "repo");
  const home = join(root, "home");
  mkdirSync(repo);
  mkdirSync(home);
  execFileSync("git", ["init", "-q", repo]);
  const welcome = join(home, ".agents", "skills", "prim-welcome", "SKILL.md");
  const codexHome = join(root, "custom-codex-home");
  const main = join(codexHome, "AGENTS.md");
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, "skill", ...args], {
      cwd: repo,
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
      encoding: "utf8",
    });
  return { welcome, main, run };
}

it("installs and removes Codex's user welcome skill alongside AGENTS guidance", () => {
  const f = fixture();
  expect(f.run("install", "--agent", "codex", "--scope", "user").status).toBe(0);
  expect(readFileSync(f.welcome, "utf8")).toContain("name: prim-welcome");
  expect(readFileSync(f.main, "utf8")).toContain("BEGIN PRIM SKILL");
  expect(
    JSON.parse(f.run("status", "--agent", "codex", "--scope", "user", "--json").stdout),
  ).toMatchObject({ installed: true, welcomeSkill: true, target: f.main });
  expect(f.run("uninstall", "--agent", "codex", "--scope", "user").status).toBe(0);
  expect(existsSync(f.welcome)).toBe(false);
  expect(readFileSync(f.main, "utf8")).not.toContain("BEGIN PRIM SKILL");
});

it("refuses to overwrite an edited or foreign Codex welcome skill", () => {
  const f = fixture();
  expect(f.run("install", "--agent", "codex", "--scope", "user").status).toBe(0);
  writeFileSync(f.welcome, "user edit\n");
  expect(f.run("install", "--agent", "codex", "--scope", "user").status).toBe(1);
  expect(f.run("uninstall", "--agent", "codex", "--scope", "user").status).toBe(1);
  expect(readFileSync(f.welcome, "utf8")).toBe("user edit\n");
  expect(f.run("status", "--agent", "codex", "--scope", "user", "--json").status).toBe(1);

  const foreign = fixture();
  mkdirSync(join(foreign.welcome, ".."), { recursive: true });
  writeFileSync(foreign.welcome, "foreign\n");
  expect(foreign.run("install", "--agent", "codex", "--scope", "user").status).toBe(1);
  expect(readFileSync(foreign.welcome, "utf8")).toBe("foreign\n");
  expect(existsSync(foreign.main)).toBe(false);
});
