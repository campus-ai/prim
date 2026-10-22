import type { Command } from "commander";
import { diffLines } from "diff";
import {
  cleanSandbox,
  createSandbox,
  decisionBytes,
  readSample,
  writeSample,
} from "../demo/sandbox.js";
import {
  BLOCKED_EDIT,
  REPOSITORY_EDIT,
  SAMPLE_DECISIONS,
  SAMPLE_FILES,
  SAMPLE_NOTE,
  WARNING_EDIT,
} from "../demo/scenario.js";
import {
  type DemoAction,
  type DemoChoice,
  type DemoRun,
  RUN_ID,
  demoCommand,
  exclusionPath,
  finishOnboarding,
  lockRun,
  pendingRuns,
  prepareRun,
  readDemoJson,
  saveRun,
} from "../demo/state.js";
import type { Agent } from "../hooks/agent.js";
import { bold, color } from "../lib/ansi.js";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import { printJson } from "../output.js";

const intro = "SIMULATED TOUR · fictional Decisions · scripted verdicts";
const handoff = "Sample files removed. Next: propose one real Decision for your approval.";
const captureNotice =
  "Passive capture stays off in this session, including resumes.\nStart a new session to resume capture.";
const completionReceipt = ["Extracted", "Adopted", "Warned", "Blocked", "Corrected"] as const;

type DemoResult = {
  simulated: true;
  runId?: string;
  stage: string;
  nextAction?: string;
  skipAction?: string;
  retryAction?: string;
  sandbox?: string;
  decisions?: unknown;
  proposal?: unknown;
  sourceNote?: string;
  evidence?: unknown;
  message?: string;
  receipt?: readonly string[];
  recoverableRuns?: { runId: string; skipAction: string }[];
};

function resultFor(run: DemoRun): DemoResult {
  const action =
    run.stage === "prepared" ? "start" : run.stage === "proposal" ? "confirm" : "resolve";
  const done = run.stage === "completed" || run.stage === "skipped";
  return {
    simulated: true,
    runId: run.id,
    stage: run.stage,
    ...(done
      ? { message: handoff, nextAction: `prim welcome${run.binding ? " --capture-excluded" : ""}` }
      : {
          nextAction: demoCommand(run, action, action === "resolve" ? "repository" : undefined),
          skipAction: demoCommand(run, "skip"),
        }),
    ...(run.sandbox ? { sandbox: run.sandbox.path } : {}),
    ...(run.stage === "conflict"
      ? { retryAction: demoCommand(run, "resolve", "local-storage") }
      : {}),
  };
}

export function demoTrustGuidance(agent?: Agent): string {
  if (agent === "codex")
    return "Trust the installed prim hooks with /hooks in Codex, then retry the exact nextAction.";
  if (agent === "hermes")
    return "Approve the installed prim hooks when Hermes prompts, then retry the exact nextAction.";
  if (agent === "cursor")
    return "Trust this Cursor workspace and activate its installed hooks, then retry the exact nextAction.";
  return "Activate the installed prim hooks in your agent, then retry the exact nextAction.";
}

function consumeAcknowledgment(run: DemoRun, action: DemoAction, choice?: DemoChoice): boolean {
  if (run.terminal) return Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const ack = run.acknowledgment;
  run.acknowledgment = undefined;
  saveRun(run);
  if (!run.binding || !ack || ack.command !== demoCommand(run, action, choice)) return false;
  const age = Date.now() - ack.at;
  if (!Number.isFinite(age) || age < 0 || age > 30_000) return false;
  try {
    const exclusion = readDemoJson(exclusionPath(run.binding)) as { runId?: string };
    return typeof exclusion.runId === "string" && RUN_ID.test(exclusion.runId);
  } catch {
    return false;
  }
}

function narrateDecision(index: 0 | 1, details: boolean): void {
  const item = SAMPLE_DECISIONS[index];
  const status = index === 1 ? "proposed" : item.stage;
  const source = index === 1 ? "Fictional authoring proposal" : item.source;
  process.stderr.write(
    `${bold(`Decision [${status}]`)}\n${item.decision}\n` +
      `Why: ${item.rationale}\n${index === 0 ? "Demo scope" : "File"}: ${item.files.join(", ")}\n`,
  );
  if (details) {
    process.stderr.write(
      `Source: ${source}\nAlternatives rejected: ${item.alternativesRejected.join("; ")}\n`,
    );
    if (index === 0) process.stderr.write(`Scope basis: ${SAMPLE_DECISIONS[0].scopeBasis}\n`);
  }
}

/** Show the actual lines, without patch transport headers or hunk metadata. */
function narrateDiff(file: string, before: string, after: string): void {
  process.stderr.write(`${bold(file)}\n`);
  for (const part of diffLines(before, after)) {
    const prefix = part.added ? "+" : part.removed ? "-" : " ";
    const lines = part.value.endsWith("\n") ? part.value.slice(0, -1) : part.value;
    for (const line of lines.split("\n")) {
      const text = `${prefix} ${line}\n`;
      process.stderr.write(
        part.added ? color(text, "green") : part.removed ? color(text, "red") : text,
      );
    }
  }
}

function narrateBlockedAttempt(unchanged: string, details: boolean): void {
  process.stderr.write(`\n${bold(color("× BLOCKED — file unchanged", "red"))}\n`);
  process.stderr.write(
    `${SAMPLE_DECISIONS[1].decision} [adopted]\nlocalStorage.setItem(…) ──×──→ orders.ts\nBypasses repository validation.\n`,
  );
  if (details) process.stderr.write(`Refused proposal:\n${BLOCKED_EDIT}`);
  process.stderr.write(
    `${bold("orders.ts · before = after")}\n${unchanged}Next: shared repository → orders.save(order)\n`,
  );
}

function narrateCompletion(run: DemoRun): void {
  process.stderr.write(`\n${bold(color("WALKTHROUGH COMPLETE — simulated", "green"))}\n`);
  process.stderr.write(`${completionReceipt.map((item) => `✓ ${item}`).join(" · ")}\n`);
  process.stderr.write(`${handoff}\n${run.terminal ? "" : `${captureNotice}\n`}`);
}

/** Fixed transitions only. The blocked candidate is never passed to a writer. */
export function advanceDemo(
  id: string,
  action: DemoAction,
  choice?: DemoChoice,
  details = false,
): DemoResult {
  return lockRun(id, (run) => {
    if (action === "skip") {
      cleanSandbox(run);
      run.stage = "skipped";
      saveRun(run);
      finishOnboarding("skipped");
      process.stderr.write(`[prim] Tour skipped. ${handoff}\n`);
      if (run.binding) process.stderr.write(`${captureNotice}\n`);
      return resultFor(run);
    }
    if (!consumeAcknowledgment(run, action, choice)) {
      const message = `Tour pending: session isolation has not been acknowledged. ${demoTrustGuidance(run.agent)}`;
      process.stderr.write(`[prim] ${message}\n`);
      return {
        ...resultFor(run),
        stage: "pending",
        message,
        nextAction: demoCommand(run, action, choice),
      };
    }
    if (action === "confirm" && run.stage === "prepared") {
      throw new Error("start the demo before confirming its proposal");
    }
    if (action === "resolve" && (run.stage === "prepared" || run.stage === "proposal")) {
      throw new Error("confirm the sample Decision before resolving");
    }
    try {
      if (!run.terminal && action === "start") process.stderr.write(`${captureNotice}\n`);
      if (run.stage === "completed") {
        narrateCompletion(run);
        return { ...resultFor(run), receipt: completionReceipt };
      }
      if (run.stage === "skipped") return resultFor(run);
      if (action === "start") {
        if (run.stage === "prepared") {
          createSandbox(run);
          run.stage = "proposal";
          saveRun(run);
        }
        if (run.stage === "proposal") {
          process.stderr.write(`${bold("Add order saving")}\n${intro}\n`);
          process.stderr.write(
            `\n${bold("1/4 · Extract")}\nTeam conversation\n“${SAMPLE_DECISIONS[0].evidence[0]}”\n  ↓ scripted extraction\n`,
          );
          process.stderr.write(`${bold(color("✓ DECISION EXTRACTED", "green"))}\n`);
          narrateDecision(0, details);
          if (details) process.stderr.write(`\nFull source:\n${SAMPLE_NOTE}\n`);
          process.stderr.write(`\n${bold("2/4 · Adopt")}\n`);
          narrateDecision(1, details);
          process.stderr.write("Proposed ── your approval ──→ Adopted\n");
        }
        return {
          ...resultFor(run),
          decisions: SAMPLE_DECISIONS.slice(0, run.stage === "proposal" ? 1 : 2),
          ...(run.stage === "proposal"
            ? {
                sourceNote: SAMPLE_NOTE,
                proposal: {
                  ...SAMPLE_DECISIONS[1],
                  stage: "proposed",
                  source: "Fictional authoring proposal",
                },
              }
            : {}),
        };
      }
      if (action === "confirm") {
        const before = SAMPLE_FILES["service.ts"];
        if (run.stage === "proposal") {
          writeSample(run, "decisions.json", decisionBytes(true));
          writeSample(run, "service.ts", WARNING_EDIT);
          run.stage = "conflict";
          saveRun(run);
          process.stderr.write(
            `\n${bold(color("✓ SAMPLE DECISION ADOPTED", "green"))}\nProposed → Adopted\n`,
          );
        }
        const after = readSample(run, "service.ts");
        const unchanged = readSample(run, "orders.ts");
        process.stderr.write(`\n${bold("3/4 · Protect · simulated")}\n`);
        process.stderr.write(`${bold(color("! WARNING — edit allowed", "yellow"))}\n`);
        process.stderr.write(
          `${SAMPLE_DECISIONS[0].decision} [provisional]\nBypasses shared retries and tracing.\n`,
        );
        narrateDiff("service.ts · changed", before, after);
        narrateBlockedAttempt(unchanged, details);
        if (!run.terminal)
          process.stderr.write("\nChoose: shared repository · retry direct storage\n");
        process.stderr.write(
          "\nScripted verdicts. Live gates vary; Claude may ask where other agents block.\n",
        );
        return {
          ...resultFor(run),
          decisions: SAMPLE_DECISIONS,
          evidence: {
            warning: { before, after },
            block: {
              before: unchanged,
              proposed: BLOCKED_EDIT,
              after: readSample(run, "orders.ts"),
            },
          },
        };
      }
      if (choice !== "repository" && choice !== "local-storage")
        throw new Error("choose repository or local-storage");
      if (choice === "local-storage") {
        const unchanged = readSample(run, "orders.ts");
        process.stderr.write(`${bold("3/4 · Retry · simulated")}\n`);
        narrateBlockedAttempt(unchanged, details);
        return { ...resultFor(run), evidence: { unchanged } };
      }
      const before = readSample(run, "service.ts");
      const ordersBefore = readSample(run, "orders.ts");
      writeSample(run, "service.ts", SAMPLE_FILES["service.ts"]);
      writeSample(run, "orders.ts", REPOSITORY_EDIT);
      const after = readSample(run, "service.ts");
      const orders = readSample(run, "orders.ts");
      process.stderr.write(`\n${bold("4/4 · Correct · simulated")}\n`);
      narrateDiff("orders.ts", ordersBefore, orders);
      narrateDiff("service.ts", before, after);
      process.stderr.write(
        `${bold(color("✓ PASS — order saving added", "green"))}\nBoth sample Decisions respected.\n`,
      );
      cleanSandbox(run);
      run.stage = "completed";
      saveRun(run);
      finishOnboarding("completed");
      narrateCompletion(run);
      return {
        ...resultFor(run),
        receipt: completionReceipt,
        evidence: {
          correction: { before, after },
          orders,
          orderCorrection: { before: ordersBefore, after: orders },
        },
      };
    } catch (error) {
      // Reclaim only still-owned fixtures. Unexpected contents remain available
      // for inspection and an explicit skip/recovery; never mark failure complete.
      try {
        cleanSandbox(run);
        run.stage = "prepared";
        saveRun(run);
      } catch {
        // The original failure includes the retained path when ownership changed.
      }
      throw error;
    }
  });
}

function parseDemoAgent(value?: string): Agent | undefined {
  if (value === "claude") return "claude_code";
  if (value === undefined || ["claude_code", "codex", "cursor", "hermes"].includes(value))
    return value as Agent | undefined;
  throw new Error("expected --agent claude, codex, cursor, or hermes");
}

function reportError(error: unknown, json = true): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[prim] demo: ${message}\n`);
  if (json) printJson({ simulated: true, stage: "error", message });
  process.exitCode = 1;
}

export function registerDemoCommands(program: Command): void {
  const demo = program
    .command("demo")
    .description("Try a fictional, local Decision and enforcement walkthrough")
    .option("--agent <agent>", "calling agent; requires hook acknowledgment before samples")
    .option(
      "--details",
      "show the full source and supporting detail in the interactive terminal tour",
    )
    .action(async (options: { agent?: string; details?: boolean }, command: Command) => {
      let terminal = false;
      const output = (result: DemoResult) => {
        // Human terminal sessions already receive narration. Preserve JSON for
        // redirected output and every agent handoff, including agent PTYs.
        if (!terminal || !process.stdout.isTTY) printJson(result);
      };
      try {
        const agent = parseDemoAgent(options.agent);
        terminal =
          !agent &&
          !isNonInteractive(command.optsWithGlobals()) &&
          Boolean(process.stdin.isTTY && process.stderr.isTTY) &&
          !process.env.CLAUDECODE &&
          !process.env.CODEX_THREAD_ID &&
          !process.env.CURSOR_AGENT &&
          !process.env.HERMES_INTERACTIVE;
        if (options.details && !terminal)
          throw new Error(
            "--details requires an interactive terminal; agents receive full detail in JSON",
          );
        const recovery = pendingRuns().map((id) =>
          lockRun(id, (run) => ({ runId: id, skipAction: demoCommand(run, "skip") })),
        );
        const run = prepareRun(agent, terminal);
        if (!terminal) {
          process.stderr.write(
            "[prim] Tour ready. Run nextAction exactly, as a standalone command. Samples wait for trusted hooks.\n",
          );
          if (recovery.length)
            process.stderr.write(
              "[prim] Earlier unfinished tours are listed in recoverableRuns; use their skipAction to clean up.\n",
            );
          printJson({ ...resultFor(run), recoverableRuns: recovery });
          return;
        }
        advanceDemo(run.id, "start", undefined, options.details);
        if (!(await askConfirmation("Adopt this sample Decision?", process.stderr))) {
          output(advanceDemo(run.id, "skip"));
          return;
        }
        advanceDemo(run.id, "confirm", undefined, options.details);
        if (await askConfirmation("Apply the shared repository correction?", process.stderr)) {
          output(advanceDemo(run.id, "resolve", "repository", options.details));
        } else {
          output(advanceDemo(run.id, "skip"));
        }
      } catch (error) {
        reportError(error, !terminal || !process.stdout.isTTY);
      }
    });
  for (const action of ["start", "confirm", "resolve", "skip"] as const) {
    const subcommand = demo.command(`${action} ${action === "skip" ? "[runId]" : "<runId>"}`);
    if (action === "resolve")
      subcommand.requiredOption("--choice <choice>", "repository or local-storage");
    subcommand.action((id: string | undefined, options: { choice?: string }) => {
      try {
        if (action === "skip" && !id) {
          finishOnboarding("skipped");
          printJson({
            simulated: true,
            stage: "skipped",
            message: "Tour skipped. Run prim welcome for real Decision seeding.",
          });
          return;
        }
        if (
          action === "resolve" &&
          options.choice !== "repository" &&
          options.choice !== "local-storage"
        ) {
          throw new Error("choose repository or local-storage");
        }
        printJson(advanceDemo(id as string, action, options.choice as DemoChoice | undefined));
      } catch (error) {
        reportError(error);
      }
    });
  }
}
