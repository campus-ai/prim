/** Shared, ownership-aware delivery of the one-time onboarding skill. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWriteFile } from "../lib/atomic-file.js";

export const WELCOME_SKILL_SOURCE = join("skills", "prim-welcome", "SKILL.md");
const OWNER = "@primitive.ai/prim";
const MANIFEST = ".prim-owned.json";

type Manifest = { version: 1; owner: typeof OWNER; contentSha256: string };
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const manifestPath = (skillPath: string) => join(dirname(skillPath), MANIFEST);
function leafKind(path: string): "file" | "missing" | "foreign" {
  try {
    return lstatSync(path).isFile() ? "file" : "foreign";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

export function codexWelcomeSkillPath(): string {
  return join(homedir(), ".agents", "skills", "prim-welcome", "SKILL.md");
}

export function welcomeSkillStatus(skillPath: string) {
  const skillKind = leafKind(skillPath);
  const manifestKind = leafKind(manifestPath(skillPath));
  let manifest: Manifest | undefined;
  if (manifestKind === "file")
    try {
      const value = JSON.parse(readFileSync(manifestPath(skillPath), "utf8")) as Partial<Manifest>;
      if (
        value.version === 1 &&
        value.owner === OWNER &&
        /^[a-f0-9]{64}$/u.test(value.contentSha256 ?? "")
      )
        manifest = value as Manifest;
    } catch {
      // A missing or foreign manifest does not grant ownership.
    }
  const content = skillKind === "file" ? readFileSync(skillPath, "utf8") : undefined;
  const owned = manifest !== undefined;
  const installed =
    manifest !== undefined && content !== undefined && digest(content) === manifest.contentSha256;
  return {
    installed,
    owned,
    edited: owned && content !== undefined && !installed,
    target: skillPath,
    content,
    unsafe: skillKind === "foreign" || manifestKind === "foreign",
  };
}

export function installWelcomeSkill(skillPath: string, content: string, dryRun = false): number {
  const status = welcomeSkillStatus(skillPath);
  const foreignManifest = existsSync(manifestPath(skillPath)) && !status.owned;
  if (
    status.unsafe ||
    foreignManifest ||
    status.edited ||
    (!status.owned && status.content !== undefined && status.content !== content)
  ) {
    console.error(`Refusing to overwrite a foreign or edited welcome skill at ${skillPath}`);
    return 1;
  }
  if (status.installed && status.content === content) return 0;
  if (dryRun) {
    console.log(`Would write welcome skill to ${skillPath}`);
    return 0;
  }
  const manifest: Manifest = { version: 1, owner: OWNER, contentSha256: digest(content) };
  atomicWriteFile(skillPath, content, { ensureParent: true });
  atomicWriteFile(manifestPath(skillPath), `${JSON.stringify(manifest, null, 2)}\n`, {
    ensureParent: true,
  });
  console.log(`Installed prim-welcome skill at ${skillPath}`);
  return 0;
}

export function uninstallWelcomeSkill(skillPath: string): number {
  const status = welcomeSkillStatus(skillPath);
  if (status.unsafe) {
    console.error(`Refusing to remove a non-file welcome skill at ${skillPath}`);
    return 1;
  }
  if (!status.owned) return 0;
  if (status.edited) {
    console.error(`Refusing to remove an edited welcome skill at ${skillPath}`);
    return 1;
  }
  if (existsSync(skillPath)) unlinkSync(skillPath);
  unlinkSync(manifestPath(skillPath));
  if (readdirSync(dirname(skillPath)).length === 0) rmdirSync(dirname(skillPath));
  console.log(`Removed prim-welcome skill from ${skillPath}`);
  return 0;
}
