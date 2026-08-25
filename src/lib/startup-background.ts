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
  work: { notify: () => void; flush: () => Promise<void> },
): void {
  const [command, subcommand] = commandArguments(argv);
  const uninstall = command === "uninstall" || env[UNINSTALL_ORCHESTRATOR_ENV] === "1";

  // Uninstall is deliberately offline: neither the orchestrator nor its child
  // commands should check for updates or opportunistically drain journals.
  if (uninstall) return;

  work.notify();
  // The explicit command drains directly; a concurrent opportunistic drain
  // would be redundant. All other drains remain best-effort and non-blocking.
  if (command !== "moves" || subcommand !== "flush") work.flush().catch(() => {});
}
