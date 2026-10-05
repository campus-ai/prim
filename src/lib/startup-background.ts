import { SETUP_DAEMON_DRAINS_ENV, SETUP_ORCHESTRATOR_ENV } from "../commands/setup.js";
import { UNINSTALL_ORCHESTRATOR_ENV } from "../commands/uninstall.js";
import { isUnattended } from "./unattended.js";

const ROOT_OPTIONS = new Set(["-y", "--yes", "--non-interactive"]);
const HELP_OPTIONS = new Set(["-h", "--help"]);

// The commands a person (or their agent) runs that may start a background
// upgrade of an older daemon, as root command → qualifying subcommands, or
// "any" for a leaf command. An allowlist, so a new command, a typo, or a help
// request never heals until someone decides it should.
//
// Absent on purpose: `daemon` (explicit management, and what the heal itself
// runs), `doctor` (must not change what it diagnoses), `setup` (starts or
// stops the daemon itself), `statusline` (an editor render loop), `help`, and
// every removal (`uninstall`, `disable`, each integration's `uninstall`, `hooks
// uninstall`, `skill uninstall`, and signing out with `auth clear`): taking
// Primitive out is no time to upgrade it.
export const DAEMON_HEAL_COMMANDS: ReadonlyMap<string, ReadonlySet<string> | "any"> = new Map<
  string,
  ReadonlySet<string> | "any"
>([
  // Credentials; `auth login` is how a person returns to a daemon held for re-auth.
  ["auth", new Set(["api-keys", "login", "set-token", "status"])],
  // Reading and curating the decision graph: the everyday attended surface.
  [
    "decisions",
    new Set([
      "cascade",
      "check",
      "confirm",
      "create",
      "demote",
      "link",
      "promote",
      "publish",
      "ratify",
      "recent",
      "repairs",
      "rescope",
      "restore",
      "show",
      "supersede",
      "unlink",
      "withdraw",
    ]),
  ],
  ["reconcile", "any"],
  // Repository connection, activation, and journal plumbing a person steers.
  // Hook-side `moves flush` drains are unattended and never reach this table.
  ["github", new Set(["connect"])],
  ["enable", "any"],
  ["moves", new Set(["bind", "drop", "flush", "status", "tail"])],
  ["session", new Set(["drop", "list", "start"])],
  // Installing or inspecting an integration, never removing one.
  ["claude", new Set(["install", "preauth", "status"])],
  ["codex", new Set(["install", "status"])],
  ["cursor", new Set(["install", "status"])],
  ["hermes", new Set(["install", "status"])],
  ["hooks", new Set(["install"])],
  ["skill", new Set(["install", "status"])],
  ["welcome", "any"],
]);

function commandArguments(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (ROOT_OPTIONS.has(argv[index] ?? "")) index += 1;
  return argv.slice(index);
}

/**
 * Whether this invocation may upgrade a daemon left behind by this CLI. Only
 * an allowlisted command run by a person qualifies: not an unattended child
 * (hook drains, SessionStart's repair) and not one of setup's own steps.
 */
export function mayHealDaemon(argv: readonly string[], env: NodeJS.ProcessEnv): boolean {
  if (isUnattended(env) || env[SETUP_ORCHESTRATOR_ENV] === "1") return false;
  const args = commandArguments(argv);
  // `--help` anywhere only prints, whatever command it names.
  if (args.some((arg) => HELP_OPTIONS.has(arg))) return false;
  const [command, subcommand] = args;
  const allowed = command === undefined ? undefined : DAEMON_HEAL_COMMANDS.get(command);
  if (allowed === undefined) return false;
  return allowed === "any" || (subcommand !== undefined && allowed.has(subcommand));
}

/** Run only the passive startup work that is safe for this root invocation. */
export function runStartupBackgroundWork(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  work: { notify: () => void; flush: () => void; healDaemon: () => void },
): void {
  const args = commandArguments(argv);
  const [command, subcommand] = args;
  const uninstall = command === "uninstall" || env[UNINSTALL_ORCHESTRATOR_ENV] === "1";

  // Uninstall is deliberately offline: neither the orchestrator nor its child
  // commands should check for updates, opportunistically drain journals, or
  // upgrade the daemon it is removing.
  if (uninstall) return;

  work.notify();
  // The explicit command drains directly; a concurrent opportunistic drain
  // would be redundant. A setup that starts the daemon, and its child steps,
  // leave the drain to that daemon: a background drain holding the drain lock
  // would make the daemon's sweeps bow out unrecorded, hiding delivery
  // failures from setup's health check. `setup --no-daemon` starts no daemon,
  // so it and its steps drain like any other command. Every other command
  // only hands an overdue journal to a detached drain, so the drain can never
  // keep the command itself alive.
  const setupDaemonDrains =
    (command === "setup" && !args.includes("--no-daemon")) || env[SETUP_DAEMON_DRAINS_ENV] === "1";
  if (!setupDaemonDrains && (command !== "moves" || subcommand !== "flush")) work.flush();
  // The heal itself is a detached child and never delays the command.
  if (mayHealDaemon(argv, env)) work.healDaemon();
}
