import { execFileSync } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { compareSemver } from "../lib/semver.js";

// 2.1.211 fixed hook "ask" being automatically approved by the host. Keep
// automatic/bypass permission modes excluded even on newer versions.
// https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md
const MINIMUM_CLAUDE_VERSION = "2.1.211";
const PROBE_TIMEOUT_MS = 250;
const MAX_PROCESS_OUTPUT = 64 * 1024;
const MAX_ANCESTORS = 8;
const MAX_SETTINGS_BYTES = 128 * 1024;
const TERMINAL_PATH = /^\/dev\/(?:ttys\d+|pts\/\d+|tty\d+)$/u;
// Match conservatively anywhere in the process's argv. ps does not preserve
// argument boundaries on Darwin, so a prompt quoting one also falls back.
const UNSUPPORTED_ARGUMENT =
  /(?:^|\s)(?:-p(?:\s|$)|--(?:print|input-format|output-format|permission-prompt-tool|permission-prompts|sdk-url|sdk|bg|background|remote-control|rc|cloud|teleport|plugin-dir|plugin-url|dangerously-skip-permissions|agent)(?:[=\s]|$)|(?:bg-pty-host|bg-spare|worker|self-hosted-runner)(?:\s|$))/u;

export type NativeReviewContext = { supported: true; hostVersion: string } | { supported: false };

type ProcessInfo = {
  pid: number;
  parent: number;
  uid: number;
  executable: string;
  startedAt: number;
};

function probe(command: string, args: string[]): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS,
    maxBuffer: MAX_PROCESS_OUTPUT,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, LC_ALL: "C" },
  }).trim();
}

function processInfo(pid: number): ProcessInfo | null {
  const identity = probe("/bin/ps", ["-p", String(pid), "-o", "uid=,ppid="])
    .split(/\s+/u)
    .map(Number);
  if (identity.length !== 2 || !identity.every(Number.isSafeInteger)) return null;
  const executable =
    process.platform === "linux"
      ? realpathSync(`/proc/${pid}/exe`)
      : probe("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="]);
  const startedAt = Date.parse(probe("/bin/ps", ["-p", String(pid), "-o", "lstart="]));
  return Number.isFinite(startedAt)
    ? { pid, uid: identity[0], parent: identity[1], executable, startedAt }
    : null;
}

function nativeExecutable(path: string): boolean {
  if (!isAbsolute(path)) return false;
  const fd = openSync(path, "r");
  try {
    const magic = Buffer.alloc(4);
    if (readSync(fd, magic, 0, 4, 0) !== 4) return false;
    return [
      "7f454c46",
      "cffaedfe",
      "cefaedfe",
      "feedfacf",
      "feedface",
      "cafebabe",
      "bebafeca",
    ].includes(magic.toString("hex"));
  } finally {
    closeSync(fd);
  }
}

function hasTerminalDescriptors(pid: number): boolean {
  if (process.platform === "linux") {
    const input = realpathSync(`/proc/${pid}/fd/0`);
    const output = realpathSync(`/proc/${pid}/fd/1`);
    return input === output && TERMINAL_PATH.test(input) && statSync(input).isCharacterDevice();
  }
  const fields = probe("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "0,1", "-F0ftn"])
    .split(/[\0\n]/u)
    .filter(Boolean);
  const descriptors = new Map<string, { type?: string; name?: string }>();
  let current: { type?: string; name?: string } | undefined;
  for (const field of fields) {
    if (field.startsWith("f")) {
      current = {};
      descriptors.set(field.slice(1), current);
    } else if (current && field.startsWith("t")) current.type = field.slice(1);
    else if (current && field.startsWith("n")) current.name = field.slice(1);
  }
  const input = descriptors.get("0");
  const output = descriptors.get("1");
  return !!(
    input?.type === "CHR" &&
    output?.type === "CHR" &&
    input.name &&
    input.name === output.name &&
    TERMINAL_PATH.test(input.name)
  );
}

function unsafeSettings(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_SETTINGS_BYTES) return true;
    const bytes = Buffer.alloc(MAX_SETTINGS_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_SETTINGS_BYTES) return true;
    raw = bytes.subarray(0, length).toString("utf8");
  } finally {
    closeSync(fd);
  }
  const value = JSON.parse(raw) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return true;
  const hooks = value.hooks as Record<string, unknown> | undefined;
  if (hooks?.PermissionRequest !== undefined) return true;
  // Plugins may install permission responders or mods. We cannot attest their
  // human-review behavior from a shell hook; keep them on the browser path.
  if (value.enabledPlugins && Object.values(value.enabledPlugins).some(Boolean)) return true;
  return false;
}

function argumentValue(argv: string, name: string): string | undefined {
  const matches = [...argv.matchAll(new RegExp(`(?:^|\\s)--${name}(?:=|\\s+)([^\\s]+)`, "gu"))];
  if (matches.length > 1) throw new Error("Repeated settings arguments are ambiguous");
  return matches[0]?.[1];
}

function unambiguousInteractiveArguments(argv: string): boolean {
  // Darwin's ps joins arguments with spaces. Accept only a small complete
  // grammar, so a filename containing spaces cannot hide a settings suffix.
  // Positional prompts, wrappers and future flags conservatively use the web.
  const words = argv.split(/\s+/u);
  if (!/^(?:\S*\/)?(?:claude(?:\.exe)?|\d+\.\d+\.\d+)$/u.test(words.shift() ?? "")) return false;
  const flags = new Set(["--verbose"]);
  const values: Record<string, RegExp> = {
    "--permission-mode": /^(?:default|manual|acceptEdits)$/u,
    "--setting-sources": /^(?:user|project|local)(?:,(?:user|project|local))*$/u,
    "--settings": /^\/[^\s"'\\]+$/u,
    "--model": /^[A-Za-z0-9._:-]+$/u,
    "--effort": /^(?:low|medium|high|max)$/u,
  };
  const seen = new Set<string>();
  for (let index = 0; index < words.length; index++) {
    const [flag, inline, ...rest] = words[index].split("=");
    if (seen.has(flag) || rest.length) return false;
    seen.add(flag);
    if (flags.has(flag) && inline === undefined) continue;
    const pattern = values[flag];
    const value = inline ?? words[++index];
    if (!pattern || value === undefined || !pattern.test(value)) return false;
  }
  return true;
}

function hostWorkingDirectory(pid: number): string {
  if (process.platform === "linux") return realpathSync(`/proc/${pid}/cwd`);
  const entries = probe("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
    .split("\n")
    .filter((line) => line.startsWith("n"));
  if (entries.length !== 1) throw new Error("Host working directory is unknown");
  return realpathSync(entries[0].slice(1));
}

function hasUnverifiedPermissionConfiguration(cwd: string, argv: string): boolean {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
  if (!isAbsolute(configDir)) return true;
  const sourcesArgument = argumentValue(argv, "setting-sources");
  const sources = sourcesArgument?.split(",") ?? ["user", "project", "local"];
  if (sources.some((source) => !["user", "project", "local"].includes(source))) return true;
  const extraSettings = argumentValue(argv, "settings");
  // ps loses argument boundaries. Only an unquoted absolute filename is
  // unambiguous; JSON settings and paths containing spaces use browser review.
  if (extraSettings && (!isAbsolute(extraSettings) || /["'\\]/u.test(extraSettings))) return true;
  const paths = new Set([
    process.platform === "darwin"
      ? "/Library/Application Support/ClaudeCode/managed-settings.json"
      : "/etc/claude-code/managed-settings.json",
  ]);
  if (sources.includes("user")) {
    paths.add(join(configDir, "settings.json"));
    // A wrapper may give the hook a different HOME than its host. Include the
    // OS-account default as well instead of overlooking active user plugins.
    paths.add(join(userInfo().homedir, ".claude", "settings.json"));
  }
  if (extraSettings) paths.add(extraSettings);
  const directory = realpathSync(cwd);
  if (sources.includes("project")) paths.add(join(directory, ".claude", "settings.json"));
  if (sources.includes("local")) {
    // Shared settings come from the primary cwd; local settings additionally
    // use the Git/main-worktree root since 2.1.211. Walking all ancestors would
    // accidentally load excluded user settings, and miss a sibling main tree.
    // https://code.claude.com/docs/en/settings#where-claude-code-keeps-the-local-file-in-a-git-repository
    paths.add(join(directory, ".claude", "settings.local.json"));
    const locations = probe("git", [
      "-C",
      directory,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ]).split("\n");
    if (locations.length !== 2 || locations.some((path) => !isAbsolute(path))) return true;
    const [repositoryRoot, commonDirectory] = locations;
    if (basename(commonDirectory) !== ".git") return true;
    paths.add(join(repositoryRoot, ".claude", "settings.local.json"));
    paths.add(join(dirname(commonDirectory), ".claude", "settings.local.json"));
  }
  return [...paths].some(unsafeSettings);
}

/**
 * Recognize an ordinary native terminal host, never a synthetic envelope flag.
 * Unknown versions/processes/platforms and known permission responders use web
 * review. This relies on the host honoring its hook contract; it is not an
 * attestation against a modified host or an OS user tampering with hooks.
 */
export function detectClaudeNativeReview(input: {
  permissionMode: unknown;
  agentId: unknown;
  cwd: string;
}): NativeReviewContext {
  if (
    (process.platform !== "darwin" && process.platform !== "linux") ||
    (input.permissionMode !== "default" && input.permissionMode !== "acceptEdits") ||
    input.agentId !== undefined
  )
    return { supported: false };
  try {
    let pid = process.ppid;
    for (let depth = 0; depth < MAX_ANCESTORS && pid > 1; depth++) {
      const parent = processInfo(pid);
      if (!parent || parent.uid !== process.getuid?.()) return { supported: false };
      const path = parent.executable;
      if (/(?:^|\/)(?:claude(?:\.exe)?|\d+\.\d+\.\d+)$/u.test(path)) {
        if (!isAbsolute(path) || !hasTerminalDescriptors(pid)) return { supported: false };
        const argv = probe("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="]);
        if (!argv || UNSUPPORTED_ARGUMENT.test(argv) || !unambiguousInteractiveArguments(argv))
          return { supported: false };
        if (hostWorkingDirectory(pid) !== realpathSync(input.cwd)) return { supported: false };
        if (hasUnverifiedPermissionConfiguration(input.cwd, argv)) return { supported: false };
        const executable = process.platform === "linux" ? `/proc/${pid}/exe` : realpathSync(path);
        const before = statSync(executable);
        // Darwin reports the launch path rather than a pinned /proc handle.
        // If it was replaced after launch, a fresh --version is not evidence
        // about the running host. Round to ps's whole-second timestamp.
        if (
          process.platform === "darwin" &&
          Math.max(before.mtimeMs, before.ctimeMs) >= parent.startedAt
        )
          return { supported: false };
        if (!before.isFile() || !nativeExecutable(executable)) return { supported: false };
        const version = probe(executable, ["--version"]).match(
          /^(\d+\.\d+\.\d+) \(Claude Code\)$/u,
        )?.[1];
        const order = compareSemver(version, MINIMUM_CLAUDE_VERSION);
        const after = statSync(executable);
        const current = processInfo(pid);
        if (
          !version ||
          order === undefined ||
          order < 0 ||
          !current ||
          current.startedAt !== parent.startedAt ||
          current.executable !== path ||
          current.uid !== parent.uid ||
          before.ino !== after.ino ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          argv !== probe("/bin/ps", ["-ww", "-p", String(pid), "-o", "args="]) ||
          !hasTerminalDescriptors(pid)
        )
          return { supported: false };
        return { supported: true, hostVersion: version };
      }
      pid = parent.parent;
    }
  } catch {
    // Read-only probing must never invent prompt support on failure.
  }
  return { supported: false };
}
