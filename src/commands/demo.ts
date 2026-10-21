import type { Command } from "commander";
import { createPatch } from "diff";
import {
  cleanSandbox,
  createSandbox,
  decisionBytes,
  readSample,
  writeSample,
} from "../demo/sandbox.js";
import {
  BLOCKED_EDIT,
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

const intro =
  "SIMULATED TOUR — fictional Decisions and scripted verdicts; no live ingestion or enforcement check.";
const handoff =
  "Sample files removed. Next: discover real Decisions in your repository's shared memory, approving each individually.";
const captureNotice =
  "Passive Decision capture is excluded for the rest of this agent session, including resumed use. Start a new session for normal capture. Explicitly approved real Decisions can still be created.";

type DemoResult = {
  simulated: true;
  runId?: string;
  stage: string;
  nextAction?: string;
  skipAction?: string;
  retryAction?: string;
  sandbox?: string;
  decisions?: unknown;
  evidence?: unknown;
  message?: string;
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

function narrateDecision(index: 0 | 1): void {
  const item = SAMPLE_DECISIONS[index];
  const status = index === 1 ? "proposed adoption, awaiting confirmation" : item.stage;
  const source = index === 1 ? "Fictional authoring proposal" : item.source;
  process.stderr.write(
    `\nDecision: ${item.decision}\nStatus: ${status} (sample)\nSource: ${source}\n` +
      `Rationale: ${item.rationale}\nScope: ${item.files.join(", ")}\nAlternatives rejected: ${item.alternativesRejected.join("; ")}\n`,
  );
  if (index === 0) {
    const extracted = SAMPLE_DECISIONS[0];
    process.stderr.write(
      `Source evidence:\n${extracted.evidence.map((quote) => `  "${quote}"`).join("\n")}\nScope basis: ${extracted.scopeBasis}\n`,
    );
  }
}

function narrateBlockedAttempt(unchanged: string): void {
  process.stderr.write(`\n${bold(color("BLOCKED — file unchanged (simulated)", "red"))}\n`);
  process.stderr.write(
    `Attempt: save the order with localStorage.setItem(...).\nDecision (adopted sample): ${SAMPLE_DECISIONS[1].decision}\nConflict: direct storage bypasses the shared repository and its validation.\nOutcome: this scenario refuses the proposed write.\n`,
  );
  process.stderr.write(createPatch("orders.ts (refused proposal)", unchanged, BLOCKED_EDIT));
  process.stderr.write(
    `Proof: orders.ts is unchanged. Actual file:\n${unchanged}\nNext: save through orders.save(...) to preserve repository validation.\n`,
  );
}

/** Fixed transitions only. The blocked candidate is never passed to a writer. */
export function advanceDemo(id: string, action: DemoAction, choice?: DemoChoice): DemoResult {
  return lockRun(id, (run) => {
    if (action === "skip") {
      cleanSandbox(run);
      run.stage = "skipped";
      saveRun(run);
      finishOnboarding("skipped");
      process.stderr.write(`[prim] ${handoff}\n`);
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
      process.stderr.write(`${bold(intro)}\n`);
      if (!run.terminal && action === "start") process.stderr.write(`${captureNotice}\n`);
      if (run.stage === "completed" || run.stage === "skipped") return resultFor(run);
      if (action === "start") {
        if (run.stage === "prepared") {
          createSandbox(run);
          run.stage = "proposal";
          saveRun(run);
        }
        if (run.stage === "proposal") {
          process.stderr.write(
            `\n${bold("YOUR MISSION: add order saving")}\nYour fictional team discussed how this should work. Watch that context become Decisions, then guide an agent's implementation.\nLocal simulation · fictional examples · disposable files\n`,
          );
          process.stderr.write(`\nSample ingestion (scripted extraction):\n${SAMPLE_NOTE}\n`);
          process.stderr.write(`\n${bold(color("DECISION EXTRACTED — simulated", "green"))}\n`);
          narrateDecision(0);
          process.stderr.write("The choice, its reason, and its source now travel together.\n");
          process.stderr.write("\nNow explicitly author another sample Decision:\n");
          narrateDecision(1);
          process.stderr.write("Confirm this fictional Decision to adopt it, or skip the tour.\n");
        }
        return {
          ...resultFor(run),
          decisions: SAMPLE_DECISIONS.slice(0, run.stage === "proposal" ? 1 : 2),
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
            `\n${bold(color("SAMPLE DECISION ADOPTED — simulated", "green"))}\n${SAMPLE_DECISIONS[1].decision}\nYour confirmation changed this proposal into an adopted sample Decision.\n`,
          );
        }
        const after = readSample(run, "service.ts");
        const unchanged = readSample(run, "orders.ts");
        process.stderr.write(`\n${bold(color("WARNING — edit allowed (simulated)", "yellow"))}\n`);
        process.stderr.write(
          `Attempt: call fetch("/orders") directly.\nDecision (provisional sample): ${SAMPLE_DECISIONS[0].decision}\nConflict: direct fetch bypasses consistent retries and request tracing.\nOutcome: this scenario surfaces the conflict and allows the edit.\n`,
        );
        process.stderr.write(createPatch("service.ts", before, after));
        process.stderr.write(
          `Proof: service.ts ${before === after ? "already matches the shared client" : "changed, as shown above"}.\nNext: restore the shared HTTP client for consistent retries and tracing.\n`,
        );
        narrateBlockedAttempt(unchanged);
        process.stderr.write(
          "\nChoose the shared repository correction, or retry direct storage.\nThese verdicts are scripted for this scenario. Live outcomes depend on Decision state and agent behavior; Claude may ask permission where other agents block.\n",
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
        narrateBlockedAttempt(unchanged);
        return { ...resultFor(run), evidence: { unchanged } };
      }
      const before = readSample(run, "service.ts");
      writeSample(run, "service.ts", SAMPLE_FILES["service.ts"]);
      const after = readSample(run, "service.ts");
      const orders = readSample(run, "orders.ts");
      process.stderr.write(createPatch("service.ts", before, after));
      process.stderr.write(`orders.ts uses the shared repository:\n${orders}`);
      process.stderr.write(`${bold(color("PASS — compliant correction (simulated)", "green"))}\n`);
      cleanSandbox(run);
      run.stage = "completed";
      saveRun(run);
      finishOnboarding("completed");
      process.stderr.write(`${handoff}\n${run.terminal ? "" : `${captureNotice}\n`}`);
      return { ...resultFor(run), evidence: { correction: { before, after }, orders } };
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

function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[prim] demo: ${message}\n`);
  printJson({ simulated: true, stage: "error", message });
  process.exitCode = 1;
}

export function registerDemoCommands(program: Command): void {
  const demo = program
    .command("demo")
    .description("Try a fictional, local Decision and enforcement walkthrough")
    .option("--agent <agent>", "calling agent; requires hook acknowledgment before samples")
    .action(async (options: { agent?: string }, command: Command) => {
      try {
        const agent = parseDemoAgent(options.agent);
        const terminal =
          !agent &&
          !isNonInteractive(command.optsWithGlobals()) &&
          Boolean(process.stdin.isTTY && process.stderr.isTTY) &&
          !process.env.CLAUDECODE &&
          !process.env.CODEX_THREAD_ID &&
          !process.env.CURSOR_AGENT &&
          !process.env.HERMES_INTERACTIVE;
        const recovery = pendingRuns().map((id) =>
          lockRun(id, (run) => ({ runId: id, skipAction: demoCommand(run, "skip") })),
        );
        const run = prepareRun(agent, terminal);
        if (!terminal) {
          process.stderr.write(
            "[prim] Preparing the simulated tour. Run nextAction exactly, as a standalone shell command. No sample content is shown until session isolation is acknowledged.\n",
          );
          if (recovery.length)
            process.stderr.write(
              "[prim] Earlier unfinished tours are listed in recoverableRuns; use their skipAction to clean up.\n",
            );
          printJson({ ...resultFor(run), recoverableRuns: recovery });
          return;
        }
        advanceDemo(run.id, "start");
        if (!(await askConfirmation("Adopt this fictional Decision?", process.stderr))) {
          printJson(advanceDemo(run.id, "skip"));
          return;
        }
        advanceDemo(run.id, "confirm");
        if (await askConfirmation("Apply the shared repository correction?", process.stderr)) {
          printJson(advanceDemo(run.id, "resolve", "repository"));
        } else {
          printJson(advanceDemo(run.id, "skip"));
        }
      } catch (error) {
        reportError(error);
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
