import { SETUP_DAEMON_DRAINS_ENV } from "../commands/setup.js";
import { UNINSTALL_ORCHESTRATOR_ENV } from "../commands/uninstall.js";

const ROOT_OPTIONS = new Set(["-y", "--yes", "--non-interactive"]);

// Root commands that must never upgrade the daemon implicitly. `daemon` manages
// it explicitly (and is what the heal itself spawns), `doctor` must not mutate
// what it diagnoses, `setup` starts or stops it itself, `hooks` manages the Git
// hook entrypoints, `statusline` is run by the editor on every render, and
// `help` only prints.
const DAEMON_HEAL_EXCLUDED_COMMANDS = new Set([
  "daemon",
  "doctor",
  "help",
  "hooks",
  "setup",
  "statusline",
]);

function commandArguments(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (ROOT_OPTIONS.has(argv[index] ?? "")) index += 1;
  return argv.slice(index);
}

function attendedDaemonHeal(
  command: string | undefined,
  subcommand: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  // A bare `prim`, `--help`, or `--version` prints and exits without a command.
  if (command === undefined || command.startsWith("-")) return false;
  if (DAEMON_HEAL_EXCLUDED_COMMANDS.has(command)) return false;
  // The Stop, post-commit, and post-rewrite hooks spawn a detached
  // `prim moves flush`; it is an unattended hook entrypoint, not a person.
  if (command === "moves" && subcommand === "flush") return false;
  return env[SETUP_ORCHESTRATOR_ENV] !== "1";
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
  // Only an attended command may upgrade a daemon left behind by this CLI; the
  // heal itself is a detached child and never delays the command.
  if (attendedDaemonHeal(command, subcommand, env)) work.healDaemon();
}
