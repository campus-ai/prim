/** Exact reviewed legacy ownership; desired bytes come from the pinned native installer. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { isExpectedOwnedGlobalHook } from "../commands/hooks.js";
import {
  type Image,
  boundedNames,
  canonicalDirectory,
  digest,
  equal,
  guardImage,
  image,
  json,
  object,
  pathSafe,
  readOwned,
  run,
  yaml,
} from "./migration-handoff-io.js";

export const agents = ["claude", "codex", "cursor", "hermes"] as const;
export type Agent = (typeof agents)[number];
export type HostTarget = {
  kind: "host";
  path: string;
  agent: Agent;
  removeHooks: Record<string, unknown[]>;
  removeStatusLine?: unknown;
};
export type GitTarget = {
  kind: "git";
  path: string;
  removeBlock: string;
  global?: boolean;
  reviewedFileSha256?: string;
};
export type Spec = {
  version: 1;
  legacyConfigRoot: string;
  maintenanceId: string;
  home: string;
  projects: string[];
  agentDirectories: Record<Agent, string>;
  operator: {
    legacySessionsClosed: true;
    nativeSessionsClosed: true;
    scopeComplete: true;
    noConcurrentStart: true;
  };
  native: {
    cli: string;
    cliSha256: string;
    runtime: string;
    runtimeSha256: string;
    profile: string;
    siteURL: string;
    expectedAuthority: Record<string, unknown>;
  };
  targets: (HostTarget | GitTarget)[];
  redactions: {
    path: string;
    sha256: string;
    reviewedForGoRE2: true;
    probe: string;
    expected: string;
  }[];
};
export type Change = { path: string; before: Image; after: Image };
export type Guard = { path: string; before: Image };
export type Inventory = { known: string[]; gitDirs: string[]; guards: Guard[] };
const suspicious = /prim(?:itive)?(?:[-_ /]|\b)|PRIM_/i;
const events = ["pre-commit", "post-commit", "post-rewrite"];
export function hasPrim(value: unknown): boolean {
  return suspicious.test(JSON.stringify(value));
}
export function validateSpec(input: unknown): Spec {
  const value = object(input);
  if (
    value.version !== 1 ||
    typeof value.maintenanceId !== "string" ||
    !/^[0-9a-f]{32}$/.test(value.maintenanceId)
  )
    throw new Error("Invalid handoff specification version or pause ID");
  const spec = value as unknown as Spec;
  canonicalDirectory(spec.home);
  canonicalDirectory(spec.legacyConfigRoot);
  if (spec.home !== homedir()) throw new Error("Declared home must match this process HOME");
  if (
    !Array.isArray(spec.projects) ||
    spec.projects.length > 64 ||
    !Array.isArray(spec.targets) ||
    spec.targets.length < 1 ||
    spec.targets.length > 256 ||
    !Array.isArray(spec.redactions) ||
    spec.redactions.length > 128
  )
    throw new Error("Handoff inventory exceeds its scope bound");
  if (
    !equal(spec.operator, {
      legacySessionsClosed: true,
      nativeSessionsClosed: true,
      scopeComplete: true,
      noConcurrentStart: true,
    })
  )
    throw new Error(
      "Close all legacy/native sessions and keep native Start disabled throughout handoff",
    );
  for (const project of spec.projects) canonicalDirectory(project);
  const hostEnvironment: Record<Agent, string> = {
    claude: "CLAUDE_CONFIG_DIR",
    codex: "CODEX_HOME",
    cursor: "CURSOR_CONFIG_DIR",
    hermes: "HERMES_HOME",
  };
  for (const agent of agents) {
    pathSafe(spec.agentDirectories[agent]);
    const configured = process.env[hostEnvironment[agent]];
    if (configured && configured !== spec.agentDirectories[agent])
      throw new Error("Declared host root does not match the active environment override");
  }
  pathSafe(spec.native.profile);
  for (const field of ["cli", "runtime"] as const) {
    pathSafe(spec.native[field]);
    if (!/^[0-9a-f]{64}$/.test(spec.native[`${field}Sha256`]))
      throw new Error("Pin both native executable SHA-256 hashes");
  }
  const authority = object(spec.native.expectedAuthority);
  const principal = object(authority.principal);
  if (
    authority.organizationBindingVersion !== 3 ||
    authority.captureAuthorityKind !== "workos_m2m" ||
    principal.kind !== "machine" ||
    ![
      authority.organizationId,
      authority.workosOrganizationId,
      principal.machineId,
      principal.clientId,
      principal.authorizedUserId,
    ].every((v) => typeof v === "string" && v.length > 0)
  )
    throw new Error(
      "Handoff requires an explicitly reviewed v3 organization and actor authority; authenticate/enroll separately",
    );
  const paths = new Set<string>();
  for (const target of spec.targets) {
    pathSafe(target.path);
    if (paths.has(target.path)) throw new Error("Duplicate handoff target");
    paths.add(target.path);
    if (target.kind === "host") {
      if (!agents.includes(target.agent)) throw new Error("Unknown host");
      object(target.removeHooks);
      for (const entries of Object.values(target.removeHooks))
        if (!Array.isArray(entries) || entries.some((entry) => !hasPrim(entry)))
          throw new Error("Reviewed removals must contain exact legacy Prim entries");
      if (target.removeStatusLine !== undefined && !hasPrim(target.removeStatusLine))
        throw new Error("Reviewed statusLine must identify legacy Prim");
    } else if (target.kind === "git") {
      const event = basename(target.path);
      const begin = `# >>> prim ${event} hook >>>`;
      const end = `# <<< prim ${event} hook <<<`;
      if (
        !events.includes(event) ||
        typeof target.removeBlock !== "string" ||
        !target.removeBlock.startsWith(`${begin}\n`) ||
        !target.removeBlock.endsWith(end) ||
        target.removeBlock.split(begin).length !== 2 ||
        target.removeBlock.split(end).length !== 2
      )
        throw new Error("Git removal requires one exact reviewed legacy managed block");
    } else throw new Error("Unknown handoff target kind");
  }
  return spec;
}
export function pinned(spec: Spec): void {
  for (const field of ["cli", "runtime"] as const) {
    const path = pathSafe(spec.native[field]);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o111) === 0 ||
      stat.size > 128 * 1024 * 1024 ||
      digest(readOwned(path, 128 * 1024 * 1024, true)?.bytes ?? Buffer.alloc(0)) !==
        spec.native[`${field}Sha256`]
    )
      throw new Error("Pinned native executable changed or is unavailable");
  }
}
export function profile(spec: Spec): Record<string, unknown> {
  const value = object(json(image(spec.native.profile).text ?? "null"));
  if (
    value.siteURL !== spec.native.siteURL ||
    typeof value.socketPath !== "string" ||
    typeof value.stateDirectory !== "string"
  )
    throw new Error("Native profile does not match the expected site");
  pathSafe(value.socketPath);
  canonicalDirectory(value.stateDirectory);
  return value;
}
export async function rpc(
  spec: Spec,
  method: "hello" | "status" | "auth.verify" | "auth.status" | "quit",
  params = {},
): Promise<Record<string, unknown>> {
  const p = profile(spec);
  const socket = lstatSync(p.socketPath as string);
  if (
    !socket.isSocket() ||
    (process.getuid && socket.uid !== process.getuid()) ||
    (socket.mode & 0o077) !== 0
  )
    throw new Error("Native socket must be private and owned");
  try {
    const { stdout } = await run(
      spec.native.runtime,
      [
        "rpc",
        "--socket",
        p.socketPath as string,
        "--method",
        method,
        "--params",
        JSON.stringify(params),
      ],
      { timeout: 18000, maxBuffer: 1024 * 1024 },
    );
    return object(json(stdout));
  } catch {
    throw new Error(`Native ${method} failed; handoff retained its pause and snapshots`);
  }
}
export async function stopped(spec: Spec, epoch?: string): Promise<Record<string, unknown>> {
  const value = await rpc(spec, "status");
  if (
    value.stopped !== true ||
    value.outboxPending !== 0 ||
    value.outboxQuarantined !== 0 ||
    typeof value.runtimeEpoch !== "string" ||
    (epoch !== undefined && value.runtimeEpoch !== epoch)
  )
    throw new Error(
      "Native runtime must stay stopped with zero pending/quarantined work and the prepared runtime epoch",
    );
  return value;
}
export async function verifyAndQuit(spec: Spec): Promise<string> {
  const hello = await rpc(spec, "hello");
  if (
    hello.protocolVersion !== 1 ||
    hello.backendContractVersion !== 9 ||
    !Array.isArray(hello.capabilities) ||
    !hello.capabilities.includes("explicit_quit")
  )
    throw new Error("Native protocol is incompatible");
  const before = await rpc(spec, "status");
  if (before.outboxPending !== 0 || before.outboxQuarantined !== 0)
    throw new Error("Native target has pending or quarantined data");
  const verified = await rpc(spec, "auth.verify", { refresh: false });
  const auth = await rpc(spec, "auth.status");
  if (
    verified.state !== "authenticated" ||
    auth.authenticated !== true ||
    auth.siteUrl !== spec.native.siteURL ||
    !equal(auth.authority, spec.native.expectedAuthority)
  )
    throw new Error("Protected native authority differs from the reviewed organization/actor");
  const ack = await rpc(spec, "quit");
  if (ack.stopped !== true || ack.outboxPending !== 0 || ack.outboxQuarantined !== 0)
    throw new Error("Native Quit did not acknowledge settled zero-queue state");
  return (await stopped(spec)).runtimeEpoch as string;
}
function filename(agent: Agent): string {
  return agent === "claude" ? "settings.json" : agent === "hermes" ? "config.yaml" : "hooks.json";
}
async function git(root: string, args: string[]): Promise<string> {
  for (const key of Object.keys(process.env))
    if (key.startsWith("GIT_") && process.env[key])
      throw new Error("Clear GIT_* overrides before scoped handoff inventory");
  try {
    return (
      await run("/usr/bin/git", ["-C", root, ...args], {
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          HOME: homedir(),
          PATH: "/usr/bin:/bin",
          XDG_CONFIG_HOME: join(homedir(), ".config"),
        },
      })
    ).stdout.trim();
  } catch (error) {
    if (args[0] === "config" && (error as { code?: number }).code === 1) return "";
    throw new Error(
      "Git inventory failed; missing and unreadable configuration are not equivalent",
    );
  }
}
function legacyPassthrough(path: string, text: string): boolean {
  const event = basename(path);
  if (
    ![
      "applypatch-msg",
      "pre-applypatch",
      "post-applypatch",
      "pre-merge-commit",
      "prepare-commit-msg",
      "commit-msg",
      "pre-rebase",
      "post-checkout",
      "post-merge",
      "pre-push",
      "pre-auto-gc",
      "push-to-checkout",
      "sendemail-validate",
      "reference-transaction",
      "post-index-change",
    ].includes(event)
  )
    return false;
  return (
    text ===
    `#!/bin/sh
# prim pass-through hook (core.hooksPath) — managed by prim; do not edit.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/${event}"
[ -x "$repo_hook" ] && exec "$repo_hook" "$@"
exit 0
`
  );
}
export async function inventory(
  spec: Spec,
  reviewedBefore = new Map<string, Image>(),
): Promise<Inventory> {
  const known = new Set<string>();
  const gitDirs = new Set<string>();
  const guards = new Set<string>([spec.native.profile]);
  for (const agent of agents) {
    for (const dir of new Set([spec.agentDirectories[agent], join(spec.home, `.${agent}`)]))
      known.add(join(dir, filename(agent)));
  }
  known.add(join(spec.agentDirectories.cursor, "cli-config.json"));
  known.add(join(spec.home, ".cursor", "cli-config.json"));
  known.add(join(spec.agentDirectories.claude, "settings.local.json"));
  known.add(join(spec.home, ".claude", "settings.local.json"));
  for (const root of [spec.home, ...spec.projects]) {
    const origins = await git(root, ["config", "--show-origin", "--list"]);
    for (const line of origins.split("\n").filter(Boolean)) {
      const origin = line.split("\t", 1)[0];
      if (!origin.startsWith("file:"))
        throw new Error("Git configuration has an unsupported non-file origin");
      const source = origin.slice(5);
      guards.add(pathSafe(source.startsWith("/") ? source : join(root, source)));
    }
  }
  for (const root of spec.projects) {
    for (const agent of agents.filter((a) => a !== "hermes"))
      known.add(join(root, `.${agent}`, filename(agent)));
    known.add(join(root, ".claude", "settings.local.json"));
    const common = await git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (!common) throw new Error("Every declared repository must be a readable Git repository");
    gitDirs.add(join(common, "hooks"));
    guards.add(join(common, "config"));
    const effective = await git(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "hooks",
    ]);
    if (!effective) throw new Error("Cannot inventory effective Git hooks directory");
    gitDirs.add(effective);
    const husky = join(root, ".husky");
    if (existsSync(husky)) gitDirs.add(husky);
    if (basename(effective) === "_" && basename(dirname(effective)) === ".husky")
      gitDirs.add(dirname(effective));
  }
  guards.add(join(spec.home, ".gitconfig"));
  guards.add(join(spec.home, ".config", "git", "config"));
  // Include global configuration even when no repository currently overrides it.
  const global = await git(spec.home, ["config", "--global", "--path", "--get", "core.hooksPath"]);
  if (global) {
    if (!global.startsWith("/"))
      throw new Error("Relative global hooksPath requires manual resolution");
    gitDirs.add(global);
  }
  for (const dir of gitDirs) {
    pathSafe(dir);
    if (existsSync(dir))
      for (const entry of boundedNames(dir, 1024)) {
        if (
          entry === "_" &&
          basename(dir) === ".husky" &&
          lstatSync(join(dir, entry)).isDirectory()
        )
          continue;
        if (
          entry.endsWith(".sample") ||
          entry.endsWith(".primitive-native.json") ||
          entry.endsWith(".primitive-lock")
        )
          continue;
        if (known.size > 1024) throw new Error("Git hook inventory exceeds bound");
        known.add(join(dir, entry));
      }
    for (const event of events) known.add(join(dir, event));
  }
  const targets = new Map(spec.targets.map((target) => [target.path, target]));
  for (const target of spec.targets) {
    if (target.kind === "git" && target.global !== undefined && typeof target.global !== "boolean")
      throw new Error("Global Git scope must be explicit boolean");
    if (target.kind === "git" && target.global && dirname(target.path) !== global)
      throw new Error("Whole-file Git replacement requires the effective global hooksPath");
    if (target.kind === "host") {
      const allowed = new Set([
        join(spec.agentDirectories[target.agent], filename(target.agent)),
        join(spec.home, `.${target.agent}`, filename(target.agent)),
        ...spec.projects
          .filter(() => target.agent !== "hermes")
          .map((root) => join(root, `.${target.agent}`, filename(target.agent))),
      ]);
      if (target.agent === "cursor") {
        allowed.add(join(spec.agentDirectories.cursor, "cli-config.json"));
        allowed.add(join(spec.home, ".cursor", "cli-config.json"));
      }
      if (!allowed.has(target.path))
        throw new Error("Host target does not match its declared agent/scope");
    }
    if (!known.has(target.path))
      throw new Error("Target is outside the known declared host/Git inventory");
    if (target.kind === "git" && !gitDirs.has(dirname(target.path)))
      throw new Error("Git target is not in a discovered hooks directory");
    if (
      target.kind === "host" &&
      ![filename(target.agent), ...(target.agent === "cursor" ? ["cli-config.json"] : [])].includes(
        basename(target.path),
      )
    )
      throw new Error("Host target filename mismatch");
  }
  for (const path of known) {
    const before = reviewedBefore.get(path) ?? image(path);
    if (
      !targets.has(path) &&
      before.text !== null &&
      suspicious.test(before.text) &&
      !legacyPassthrough(path, before.text)
    )
      throw new Error(`Unreviewed Prim hook/settings in inventory: ${path}`);
    guards.add(path);
    if (
      (
        reviewedBefore.get(`${path}.primitive-native.json`) ??
        image(`${path}.primitive-native.json`)
      ).text !== null
    )
      throw new Error("Fresh handoff refuses existing native ownership receipts");
    guards.add(`${path}.primitive-native.json`);
  }
  return {
    known: [...known].sort(),
    gitDirs: [...gitDirs].sort(),
    guards: [...guards].sort().map((path) => ({ path, before: guardImage(path) })),
  };
}
function stripHost(target: HostTarget, before: string): string {
  const doc = target.agent === "hermes" ? yaml(before) : null;
  const config = object(doc ? (doc.toJS({ maxAliasCount: 0 }) ?? {}) : json(before));
  const hooks = object(config.hooks ?? {});
  for (const [event, entries] of Object.entries(target.removeHooks)) {
    const current = hooks[event];
    if (!Array.isArray(current)) throw new Error("Reviewed hook event is missing");
    for (const entry of entries) {
      const matches = current.map((v, i) => (equal(v, entry) ? i : -1)).filter((i) => i >= 0);
      if (matches.length !== 1)
        throw new Error("Reviewed legacy hook is missing, changed or duplicated");
      current.splice(matches[0], 1);
    }
    if (!current.length) Reflect.deleteProperty(hooks, event);
  }
  config.hooks = hooks;
  if (target.removeStatusLine !== undefined) {
    if (!equal(config.statusLine, target.removeStatusLine))
      throw new Error("Reviewed legacy statusLine changed");
    Reflect.deleteProperty(config, "statusLine");
  }
  // Inspect active execution surfaces. Unrelated descriptions/permissions can mention Prim.
  if (hasPrim(config.hooks) || (config.statusLine !== undefined && hasPrim(config.statusLine)))
    throw new Error("Unreviewed Prim command remains after exact removals");
  if (doc) {
    doc.set("hooks", hooks);
    return doc.toString();
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}
export async function plan(spec: Spec, directory: string): Promise<Change[]> {
  const stage = mkdtempSync(join(directory, "stage-"));
  const changes: Change[] = [];
  const p = profile(spec);
  const env: NodeJS.ProcessEnv = {
    HOME: stage,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: tmpdir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(stage, "gitconfig"),
    PRIMITIVE_RUNTIME_BINARY: spec.native.runtime,
    PRIMITIVE_RUNTIME_SOCKET: p.socketPath as string,
  };
  let planningTarget = "none";
  try {
    for (const target of spec.targets) {
      planningTarget = `${target.kind}:${target.path}`;
      const before = image(target.path);
      if (before.text === null) throw new Error("Reviewed legacy target is missing");
      if (target.kind === "host") {
        const home = join(stage, `host-${changes.length}`);
        mkdirSync(home, { mode: 0o700 });
        const dir = join(home, `.${target.agent}`);
        mkdirSync(dir, { mode: 0o700 });
        const staged = join(dir, basename(target.path));
        const cursorCompanion = join(spec.agentDirectories.cursor, "cli-config.json");
        const companionPlanned = spec.targets.some((entry) => entry.path === cursorCompanion);
        if (
          target.agent === "cursor" &&
          basename(target.path) === "cli-config.json" &&
          !spec.targets.some(
            (entry) =>
              entry.kind === "host" &&
              entry.agent === "cursor" &&
              basename(entry.path) === "hooks.json",
          )
        )
          throw new Error("Cursor footer handoff also requires an explicit hooks target");
        if (target.agent === "cursor" && !companionPlanned) {
          const footer = image(cursorCompanion);
          if (footer.text !== null)
            writeFileSync(join(dir, "cli-config.json"), footer.text, { mode: 0o600 });
        }
        writeFileSync(staged, stripHost(target, before.text), { mode: 0o600 });
        await run(spec.native.cli, [target.agent, "install", "--scope", "user"], {
          cwd: home,
          env: { ...env, HOME: home },
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        });
        const after = image(staged);
        after.mode = before.mode;
        changes.push({ path: target.path, before, after });
        if (
          target.agent === "cursor" &&
          !companionPlanned &&
          !changes.some((entry) => entry.path === cursorCompanion)
        ) {
          const prior = image(cursorCompanion);
          const next = image(join(dir, "cli-config.json"));
          if (prior.hash !== next.hash)
            changes.push({
              path: cursorCompanion,
              before: prior,
              after: { ...next, mode: prior.mode },
            });
        }
        const receipt = image(`${staged}.primitive-native.json`);
        if (basename(target.path) !== "cli-config.json") {
          const ownership = object(json(receipt.text ?? "null"));
          if (
            ownership.owner !== "primitive-native" ||
            ownership.version !== 1 ||
            ownership.agent !== target.agent ||
            !Object.keys(object(ownership.entries)).length
          )
            throw new Error("Pinned installer did not generate native host ownership");
        }
        if (receipt.text !== null)
          changes.push({
            path: `${target.path}.primitive-native.json`,
            before: image(`${target.path}.primitive-native.json`),
            after: receipt,
          });
      } else {
        const event = basename(target.path);
        if (before.text.split(target.removeBlock).length !== 2)
          throw new Error("Reviewed Git block is missing or duplicated");
        const remaining = before.text.replace(target.removeBlock, "");
        if (
          target.global &&
          (target.reviewedFileSha256 !== before.hash ||
            !isExpectedOwnedGlobalHook(before.text, event))
        )
          throw new Error("Global chain replacement requires exact reviewed whole-file hash");
        // Legacy global chain code is retained only if it contains no additional Prim launcher.
        if (
          !target.global &&
          /prim-(?:hook|git|pre|post)|primitive-runtime|PRIMITIVE NATIVE|>>> prim/.test(remaining)
        )
          throw new Error("Unreviewed Prim Git launcher remains");
        const repo = join(stage, `git-${changes.length}`);
        mkdirSync(repo, { mode: 0o700 });
        const gitEnv = { ...env, HOME: repo, GIT_CONFIG_GLOBAL: join(repo, "gitconfig") };
        await run("/usr/bin/git", ["init", "--quiet", repo], { env: gitEnv, timeout: 5000 });
        await run(
          spec.native.cli,
          [
            "hooks",
            "install",
            "--scope",
            target.global ? "user" : "project",
            ...(target.global ? ["--global-hooks-path"] : []),
          ],
          { cwd: repo, env: gitEnv, timeout: 20000, maxBuffer: 1024 * 1024 },
        );
        const staged = target.global
          ? join(repo, ".config", "primitive", "git-hooks", event)
          : join(repo, ".git", "hooks", event);
        const generated = image(staged).text ?? "";
        const begin = `# BEGIN PRIMITIVE NATIVE ${event} v1`;
        const end = `# END PRIMITIVE NATIVE ${event} v1`;
        const start = generated.indexOf(begin);
        const finish = generated.indexOf(end);
        if (start < 0 || finish < start)
          throw new Error("Native installer did not produce expected Git block");
        const block = generated.slice(start, finish + end.length);
        const text = target.global ? generated : before.text.replace(target.removeBlock, block);
        changes.push({
          path: target.path,
          before,
          after: { text, hash: digest(text), mode: before.mode | 0o100 },
        });
        const receipt = object(json(image(`${staged}.primitive-native.json`).text ?? "null"));
        receipt.created = target.global === true;
        const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
        changes.push({
          path: `${target.path}.primitive-native.json`,
          before: image(`${target.path}.primitive-native.json`),
          after: { text: receiptText, hash: digest(receiptText), mode: 0o600 },
        });
      }
    }
    return changes;
  } catch (error) {
    const detail =
      error instanceof Error && !("stdout" in error) && !("stderr" in error)
        ? error.message
        : "native installer process refused the staged plan";
    throw new Error(
      `Native configuration planning failed at ${planningTarget}: ${detail}; installed settings were not changed`,
    );
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}
