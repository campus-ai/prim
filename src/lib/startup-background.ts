import { SETUP_DAEMON_DRAINS_ENV } from "../commands/setup.js";
import { UNINSTALL_ORCHESTRATOR_ENV } from "../commands/uninstall.js";

const ROOT_OPTIONS = new Set(["-y", "--yes", "--non-interactive"]);

function commandArguments(argv: readonly string[]): readonly string[] {
  let index = 0;
  while (ROOT_OPTIONS.has(argv[index] ?? "")) index += 1;
  return argv.slice(index);
}

/** Run only the passive startup work that is safe for this root invocation. */
export function runStartupBackgroundWork(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  work: { notify: () => void; flush: () => void },
): void {
  const args = commandArguments(argv);
  const [command, subcommand] = args;
  const uninstall = command === "uninstall" || env[UNINSTALL_ORCHESTRATOR_ENV] === "1";

  // Uninstall is deliberately offline: neither the orchestrator nor its child
  // commands should check for updates or opportunistically drain journals.
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
}
