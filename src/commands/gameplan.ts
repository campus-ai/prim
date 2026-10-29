/** Install the Primitive gameplanning companion without changing the public skill. */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { gitToplevel } from "../lib/git.js";
import {
  type ClaudeSettings,
  type HookEntry,
  atomicWrite,
  readSettings,
} from "./claude-install.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SKILL_NAME = "primitive-gameplan";
const MANIFEST_NAME = ".prim-managed.json";
const MANIFEST_OWNER = "@primitive.ai/prim:gameplan:v1";
const START = "<!-- BEGIN PRIMITIVE GAMEPLAN v1 -->";
const END = "<!-- END PRIMITIVE GAMEPLAN v1 -->";
const HOOK_MARKER = "prim-gameplan-hook-v1";
const HOOK_COMMAND =
  'primitive_gameplan_hook="$(git rev-parse --show-toplevel 2>/dev/null)/.agents/skills/primitive-gameplan/scripts/activate.mjs"; if [ -f "$primitive_gameplan_hook" ]; then node "$primitive_gameplan_hook"; fi # prim-gameplan-hook-v1';
const ASSET_FILES = ["SKILL.md", "scripts/activate.mjs", "claude-hooks.json"] as const;
const AGENTS_BLOCK = `${START}\nWhen using $write-gameplan or $write-workstream, read and follow\n.agents/skills/primitive-gameplan/SKILL.md before architectural discussion.\nKeep the public planning skills unchanged.\n${END}`;

type AssetFile = (typeof ASSET_FILES)[number];
type Manifest = {
  owner: typeof MANIFEST_OWNER;
  packageVersion: string;
  files: Record<AssetFile, string>;
  previousFiles?: Record<AssetFile, string>;
  agentsBlockHash: string;
  previousAgentsBlockHash?: string;
  createdAgents: boolean;
  agentsSeparator: "" | "\n" | "\n\n";
};

type Paths = {
  root: string;
  skillDir: string;
  manifest: string;
  agents: string;
  agentsOverride: string;
  userHooks: string;
};

function packageRoot(): string {
  let directory = __dirname;
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, "assets", SKILL_NAME, "SKILL.md"))) return directory;
    directory = dirname(directory);
  }
  throw new Error("Primitive gameplan assets are missing from this CLI package");
}

function packageVersion(root: string): string {
  const parsed = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof parsed.version !== "string") throw new Error("CLI package version is missing");
  return parsed.version;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function pathsFor(cwd: string): Paths {
  const root = gitToplevel(cwd);
  if (root === null) throw new Error("Run prim gameplan from a Git worktree");
  const skillDir = join(root, ".agents", "skills", SKILL_NAME);
  const codexHome = process.env.CODEX_HOME?.trim()
    ? resolve(process.env.CODEX_HOME)
    : join(homedir(), ".codex");
  return {
    root,
    skillDir,
    manifest: join(skillDir, MANIFEST_NAME),
    agents: join(root, "AGENTS.md"),
    agentsOverride: join(root, "AGENTS.override.md"),
    userHooks: join(codexHome, "hooks.json"),
  };
}

function readRegularFile(path: string): string | null {
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!entry.isFile()) throw new Error(`Refusing non-regular file at ${path}`);
  return readFileSync(path, "utf8");
}

function readManifest(path: string): Manifest | null {
  const content = readRegularFile(path);
  if (content === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new Error(`Invalid Primitive gameplan manifest at ${path}`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Primitive gameplan manifest at ${path}`);
  }
  const record = value as Partial<Manifest>;
  if (
    record.owner !== MANIFEST_OWNER ||
    typeof record.packageVersion !== "string" ||
    typeof record.agentsBlockHash !== "string" ||
    typeof record.createdAgents !== "boolean" ||
    !["", "\n", "\n\n"].includes(record.agentsSeparator ?? "invalid") ||
    typeof record.files !== "object" ||
    record.files === null ||
    ASSET_FILES.some((file) => typeof record.files?.[file] !== "string") ||
    (record.previousFiles !== undefined &&
      ASSET_FILES.some((file) => typeof record.previousFiles?.[file] !== "string")) ||
    (record.previousAgentsBlockHash !== undefined &&
      typeof record.previousAgentsBlockHash !== "string")
  ) {
    throw new Error(`Unknown or incomplete Primitive gameplan manifest at ${path}`);
  }
  return record as Manifest;
}

function managedBlock(content: string): string | null {
  const begin = content.indexOf(START);
  const end = content.indexOf(END);
  if (begin === -1 && end === -1) return null;
  if (
    begin === -1 ||
    end < begin ||
    content.indexOf(START, begin + START.length) !== -1 ||
    content.indexOf(END, end + END.length) !== -1
  ) {
    throw new Error("AGENTS.md has malformed Primitive gameplan markers");
  }
  return content.slice(begin, end + END.length);
}

function blockSeparator(content: string): "" | "\n" | "\n\n" {
  if (content.length === 0 || content.endsWith("\n\n")) return "";
  return content.endsWith("\n") ? "\n" : "\n\n";
}

function upsertBlock(content: string): string {
  const current = managedBlock(content);
  if (current !== null) return content.replace(current, AGENTS_BLOCK);
  return `${content}${blockSeparator(content)}${AGENTS_BLOCK}\n`;
}

function removeBlock(content: string, separator: string): string {
  const block = managedBlock(content);
  if (block === null) return content;
  const start = content.indexOf(block);
  let before = content.slice(0, start);
  if (separator.length > 0 && before.endsWith(separator)) {
    before = before.slice(0, -separator.length);
  }
  const after = content.slice(start + block.length);
  return `${before}${after.replace(/^\n/u, "")}`;
}

function publicSkillPath(paths: Paths): string | null {
  const codexHome = dirname(paths.userHooks);
  const candidates = [
    join(paths.root, ".agents", "skills", "write-gameplan", "SKILL.md"),
    join(codexHome, "skills", "write-gameplan", "SKILL.md"),
    join(homedir(), ".agents", "skills", "write-gameplan", "SKILL.md"),
  ];
  for (const path of candidates) {
    try {
      const content = readFileSync(path, "utf8");
      if (/^name:\s*write-gameplan\s*$/mu.test(content)) return path;
    } catch {
      // Continue to the next recognized Codex skill location.
    }
  }
  return null;
}

function assetContents(): Record<AssetFile, string> {
  const root = packageRoot();
  return Object.fromEntries(
    ASSET_FILES.map((file) => [file, readFileSync(join(root, "assets", SKILL_NAME, file), "utf8")]),
  ) as Record<AssetFile, string>;
}

function markedHookCommands(settings: ClaudeSettings): string[] {
  const entries = settings.hooks?.UserPromptSubmit ?? [];
  if (!Array.isArray(entries)) throw new Error("Codex UserPromptSubmit hooks are not an array");
  return entries.flatMap((entry) =>
    (entry.hooks ?? []).flatMap((hook) =>
      typeof hook.command === "string" && hook.command.includes(HOOK_MARKER) ? [hook.command] : [],
    ),
  );
}

function ensureUserHook(settings: ClaudeSettings): ClaudeSettings {
  const marked = markedHookCommands(settings);
  if (marked.some((command) => command !== HOOK_COMMAND)) {
    throw new Error("A modified Primitive gameplan Codex hook is present; resolve it manually");
  }
  if (marked.length > 1) throw new Error("Duplicate Primitive gameplan Codex hooks are present");
  if (marked.length === 1) return settings;
  const hooks = { ...(settings.hooks ?? {}) };
  hooks.UserPromptSubmit = [
    ...(hooks.UserPromptSubmit ?? []),
    { hooks: [{ type: "command", command: HOOK_COMMAND }] },
  ];
  return { ...settings, hooks };
}

function removeUserHook(settings: ClaudeSettings): ClaudeSettings {
  const marked = markedHookCommands(settings);
  if (marked.some((command) => command !== HOOK_COMMAND)) {
    throw new Error("A modified Primitive gameplan Codex hook is present; resolve it manually");
  }
  if (marked.length === 0) return settings;
  const hooks = { ...(settings.hooks ?? {}) };
  hooks.UserPromptSubmit = (hooks.UserPromptSubmit ?? []).flatMap((entry: HookEntry) => {
    const commands = (entry.hooks ?? []).filter((hook) => hook.command !== HOOK_COMMAND);
    return commands.length > 0 ? [{ ...entry, hooks: commands }] : [];
  });
  if (hooks.UserPromptSubmit.length === 0) hooks.UserPromptSubmit = undefined;
  return { ...settings, hooks };
}

function checkOwnedFiles(paths: Paths, manifest: Manifest | null): void {
  if (existsSync(paths.skillDir) && !lstatSync(paths.skillDir).isDirectory()) {
    throw new Error(`Refusing non-directory companion path at ${paths.skillDir}`);
  }
  if (manifest === null && existsSync(paths.skillDir) && readdirSync(paths.skillDir).length > 0) {
    throw new Error(`Refusing unowned companion files at ${paths.skillDir}`);
  }
  if (manifest === null) return;
  for (const file of ASSET_FILES) {
    const path = join(paths.skillDir, file);
    const current = readRegularFile(path);
    if (
      current !== null &&
      sha256(current) !== manifest.files[file] &&
      sha256(current) !== manifest.previousFiles?.[file]
    ) {
      throw new Error(`Refusing modified companion file at ${path}`);
    }
  }
}

function checkAgentsBlock(
  paths: Paths,
  manifest: Manifest | null,
): { content: string; created: boolean } {
  const content = readRegularFile(paths.agents) ?? "";
  const block = managedBlock(content);
  if (
    block !== null &&
    (manifest === null ||
      (sha256(block) !== manifest.agentsBlockHash &&
        sha256(block) !== manifest.previousAgentsBlockHash))
  ) {
    throw new Error(`Refusing modified or unowned Primitive gameplan block in ${paths.agents}`);
  }
  return { content, created: manifest?.createdAgents ?? !existsSync(paths.agents) };
}

function install(cwd: string): object {
  const paths = pathsFor(cwd);
  const publicSkill = publicSkillPath(paths);
  if (publicSkill === null) {
    throw new Error(
      "Codex cannot find $write-gameplan. Install the public skill in .agents/skills/write-gameplan or ~/.codex/skills/write-gameplan, then retry.",
    );
  }
  if ((readRegularFile(paths.agentsOverride) ?? "").trim().length > 0) {
    throw new Error(
      "AGENTS.override.md shadows AGENTS.md in this repository; remove the override or install the companion manually in the effective rules.",
    );
  }
  const assets = assetContents();
  const manifest = readManifest(paths.manifest);
  checkOwnedFiles(paths, manifest);
  const agents = checkAgentsBlock(paths, manifest);
  const hooksBefore = readSettings(paths.userHooks);
  const hooksAfter = ensureUserHook(hooksBefore);
  const nextManifest: Manifest = {
    owner: MANIFEST_OWNER,
    packageVersion: packageVersion(packageRoot()),
    files: Object.fromEntries(ASSET_FILES.map((file) => [file, sha256(assets[file])])) as Record<
      AssetFile,
      string
    >,
    ...(manifest === null ? {} : { previousFiles: manifest.files }),
    agentsBlockHash: sha256(AGENTS_BLOCK),
    ...(manifest === null ? {} : { previousAgentsBlockHash: manifest.agentsBlockHash }),
    createdAgents: agents.created,
    agentsSeparator: manifest?.agentsSeparator ?? blockSeparator(agents.content),
  };

  // The manifest includes previous digests so an interrupted upgrade can
  // safely repair either the old or new managed files on the next invocation.
  atomicWriteFile(paths.manifest, `${JSON.stringify(nextManifest, null, 2)}\n`, {
    ensureParent: true,
  });
  for (const file of ASSET_FILES) {
    const path = join(paths.skillDir, file);
    if (readRegularFile(path) !== assets[file]) {
      atomicWriteFile(path, assets[file], { ensureParent: true });
    }
  }
  const agentsAfter = upsertBlock(agents.content);
  if (agentsAfter !== agents.content) {
    atomicWriteFile(paths.agents, agentsAfter, { ensureParent: true });
  }
  if (JSON.stringify(hooksAfter) !== JSON.stringify(hooksBefore)) {
    atomicWrite(paths.userHooks, hooksAfter);
  }
  return { installed: true, root: paths.root, publicSkill, userHooks: paths.userHooks };
}

function status(cwd: string): object {
  const paths = pathsFor(cwd);
  const manifest = readManifest(paths.manifest);
  const publicSkill = publicSkillPath(paths);
  const files = Object.fromEntries(
    ASSET_FILES.map((file) => {
      const current = readRegularFile(join(paths.skillDir, file));
      return [
        file,
        current !== null && manifest !== null && sha256(current) === manifest.files[file],
      ];
    }),
  ) as Record<AssetFile, boolean>;
  const agents = readRegularFile(paths.agents) ?? "";
  const block = managedBlock(agents);
  const agentsBinding =
    block !== null && manifest !== null && sha256(block) === manifest.agentsBlockHash;
  const agentsOverrideShadows = (readRegularFile(paths.agentsOverride) ?? "").trim().length > 0;
  const hooks = markedHookCommands(readSettings(paths.userHooks));
  const userHook = hooks.length === 1 && hooks[0] === HOOK_COMMAND;
  const installed =
    manifest !== null &&
    Object.values(files).every(Boolean) &&
    agentsBinding &&
    !agentsOverrideShadows &&
    userHook &&
    publicSkill !== null;
  return {
    installed,
    root: paths.root,
    packageVersion: manifest?.packageVersion ?? null,
    files,
    agentsBinding,
    agentsOverrideShadows,
    userHook,
    publicSkill,
    userHooks: paths.userHooks,
  };
}

function uninstall(cwd: string, removeSharedHook: boolean): object {
  const paths = pathsFor(cwd);
  const manifest = readManifest(paths.manifest);
  if (manifest === null)
    return { uninstalled: false, reason: "No managed companion in this repository" };
  checkOwnedFiles(paths, manifest);
  const expected = new Set(["SKILL.md", "claude-hooks.json", "scripts", MANIFEST_NAME]);
  const extras = readdirSync(paths.skillDir).filter((entry) => !expected.has(entry));
  const scriptsPath = join(paths.skillDir, "scripts");
  if (existsSync(scriptsPath)) {
    extras.push(...readdirSync(scriptsPath).filter((entry) => entry !== "activate.mjs"));
  }
  if (extras.length > 0) {
    throw new Error(`Refusing to remove unowned companion files: ${extras.join(", ")}`);
  }
  const agents = checkAgentsBlock(paths, manifest);
  const hooksBefore = readSettings(paths.userHooks);
  const hooksAfter = removeSharedHook ? removeUserHook(hooksBefore) : hooksBefore;
  const agentsAfter = removeBlock(agents.content, manifest.agentsSeparator);
  if (agentsAfter !== agents.content) {
    if (manifest.createdAgents && agentsAfter.trim().length === 0) {
      unlinkSync(paths.agents);
    } else {
      atomicWriteFile(paths.agents, agentsAfter);
    }
  }
  for (const file of ASSET_FILES) {
    const path = join(paths.skillDir, file);
    if (existsSync(path)) unlinkSync(path);
  }
  unlinkSync(paths.manifest);
  if (existsSync(scriptsPath)) rmdirSync(scriptsPath);
  rmdirSync(paths.skillDir);
  if (JSON.stringify(hooksAfter) !== JSON.stringify(hooksBefore))
    atomicWrite(paths.userHooks, hooksAfter);
  return { uninstalled: true, root: paths.root, sharedUserHookRetained: !removeSharedHook };
}

function requireCodex(agent: string): void {
  if (agent !== "codex") throw new Error(`Unsupported gameplan agent "${agent}" (expected codex)`);
}

function reportCommandError(error: unknown): void {
  console.error(`[prim] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

export function registerGameplanCommands(program: Command): void {
  const gameplan = program
    .command("gameplan")
    .description("Manage the Primitive Codex gameplanning companion");
  gameplan
    .command("install")
    .description("Install the companion in this repo and its dispatcher in user Codex hooks")
    .option("--agent <agent>", "agent host", "codex")
    .action((opts: { agent: string }) => {
      try {
        requireCodex(opts.agent);
        const result = install(process.cwd());
        console.error(
          "[prim] Gameplan companion installed. Review Codex /hooks and start a fresh session.",
        );
        console.log(JSON.stringify(result));
      } catch (error) {
        reportCommandError(error);
      }
    });
  gameplan
    .command("status")
    .description("Check the companion, public skill, AGENTS binding, and user prompt hook")
    .option("--agent <agent>", "agent host", "codex")
    .action((opts: { agent: string }) => {
      try {
        requireCodex(opts.agent);
        const result = status(process.cwd()) as { installed: boolean; publicSkill: string | null };
        console.error(
          result.installed && result.publicSkill !== null
            ? "[prim] Gameplan companion is configured; actual hook execution is not verified."
            : "[prim] Gameplan companion is incomplete; inspect the JSON status and run prim gameplan install.",
        );
        console.log(JSON.stringify(result));
        if (!result.installed || result.publicSkill === null) process.exitCode = 1;
      } catch (error) {
        reportCommandError(error);
      }
    });
  gameplan
    .command("uninstall")
    .description("Remove this repo's companion; keep the shared user hook unless requested")
    .option("--agent <agent>", "agent host", "codex")
    .option("--remove-user-hook", "Also remove the hook shared with other repositories")
    .action((opts: { agent: string; removeUserHook?: boolean }) => {
      try {
        requireCodex(opts.agent);
        const result = uninstall(process.cwd(), opts.removeUserHook ?? false);
        console.error("[prim] Removed this repository's managed gameplan companion.");
        console.log(JSON.stringify(result));
      } catch (error) {
        reportCommandError(error);
      }
    });
}
