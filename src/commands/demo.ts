import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { diffLines } from "diff";
import { demoApi, demoStatus } from "../demo/api.js";
import { cleanSandbox, createSandbox, readSample, writeSample } from "../demo/sandbox.js";
import {
  type DemoAction,
  type DemoChoice,
  type DemoRun,
  RUN_ID,
  demoCommand,
  demoDiagnosticCommand,
  demoWelcomeCommand,
  exclusionPath,
  finishOnboarding,
  lockRun,
  lockRunAsync,
  pendingRuns,
  prepareRun,
  readDemoJson,
  saveRun,
} from "../demo/state.js";
import {
  DEMO_ADHERE,
  DEMO_INITIAL,
  DEMO_ORIGINAL,
  DEMO_REPLACEMENT,
  DEMO_SUPERSEDE,
  DEMO_TASK,
} from "../demo/story.js";
import type { Agent } from "../hooks/agent.js";
import { bold, color } from "../lib/ansi.js";
import { isNonInteractive } from "../lib/confirmation.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";

const printJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const captureNotice =
  "Start a new agent session to resume passive capture. Explicitly approved real Decisions still work here.";
const label = "**Fictional project · real conflict check**";
const diagram = (value: string) => `\n\`\`\`text\n${value}\n\`\`\``;
const safeMarkdown = (value: string) => terminalSafeLine(value).replace(/[\\`*_{}[\]<>]/gu, "\\$&");
function compactDiff(before: string, after: string): string {
  return diffLines(before, after)
    .filter((part) => part.added || part.removed)
    .map((part) =>
      part.value
        .trimEnd()
        .split("\n")
        .map((line) => `${part.added ? "+" : "-"} ${line}`)
        .join("\n"),
    )
    .join("\n");
}
export function demoTrustGuidance(agent?: Agent): string {
  if (agent === "codex")
    return "Check /hooks in Codex. Approve only if a trust action is offered. If hooks are already active, retry the exact standalone command once; do not keep asking for trust or a new session. If still pending, run diagnosticAction and inspect hook errors.";
  if (agent === "hermes")
    return "Approve the installed prim hooks when Hermes prompts, then retry the exact nextAction.";
  if (agent === "cursor")
    return "Trust this Cursor workspace and activate its installed hooks, then retry the exact nextAction.";
  return "Activate the installed prim hooks in your agent, then retry the exact nextAction.";
}

function consumeAcknowledgment(
  run: DemoRun,
  action: DemoAction,
  choice?: DemoChoice,
  reason?: string,
): string | undefined {
  if (run.terminal)
    return process.stdin.isTTY && process.stderr.isTTY ? undefined : "terminal-required";
  const ack = run.acknowledgment;
  run.acknowledgment = undefined;
  saveRun(run);
  if (!run.binding || !ack) return "acknowledgment-missing";
  if (ack.command !== demoCommand(run, action, choice, reason)) return "command-mismatch";
  const age = Date.now() - ack.at;
  if (!Number.isFinite(age) || age < 0 || age > 30_000) return "acknowledgment-expired";
  try {
    const exclusion = readDemoJson(exclusionPath(run.binding)) as { runId?: string };
    return typeof exclusion.runId === "string" && RUN_ID.test(exclusion.runId)
      ? undefined
      : "exclusion-invalid";
  } catch {
    return "exclusion-missing";
  }
}

function resultFor(run: DemoRun) {
  const complete = run.stage === "completed" || run.stage === "skipped";
  return {
    fictional: true as const,
    evaluation: "live" as const,
    runId: run.id,
    stage: run.stage,
    ...(run.server && run.stage !== "skipped" ? { server: run.server } : {}),
    ...(run.sandbox ? { sandbox: run.sandbox.path } : {}),
    skipAction: demoCommand(run, "skip"),
    statusAction: demoCommand(run, "status"),
    ...(complete ? { nextAction: demoWelcomeCommand(run) } : {}),
  };
}
function present(run: DemoRun): string {
  if (run.stage === "prepared") return "Tour ready. Run nextAction to check session isolation.";
  if (run.stage === "skipped") return "Tour skipped. Owned sample files removed.";
  if (run.stage === "prompt")
    return `${label}\n\nImagine you’re a new engineer joining a team. In this story, you previously authored a Decision; now experience it as the new engineer. We’ll email the outcome to your signed-in address.\n${diagram("[1 Enter task] → [2 Your Decision stops it] → [3 Choose → Email]")}\n\nEnter this prompt in this chat:\n\n\`\`\`text\n${DEMO_TASK}\n\`\`\``;
  if (run.stage === "conflict")
    return `${label}\n\n**YOUR DECISION STOPPED THIS**\n${diagram("CSV export [name, email]\n                   │\n            ✕ email excluded\n                   │\n         customers.ts unchanged")}\n\n**${DEMO_ORIGINAL}**\nFictional prior author: ${safeMarkdown(run.server?.authorName ?? "you")}\n\n\`\`\`ts\n${readSample(run, "customers.ts").trimEnd()}\n\`\`\`\n\nChoose **Adhere** (export names only) or **Supersede** with **${DEMO_REPLACEMENT}** and your short reason.`;
  if (run.stage === "completed" || run.stage === "cleanup") {
    const choice = run.server?.choice;
    const after = choice === "adhere" ? DEMO_ADHERE : DEMO_SUPERSEDE;
    return `${label}\n\n**PASS — CSV export implemented**\n${diagram(`CSV [${choice === "adhere" ? "name" : "name, email"}] → CHECK PASSED → IMPLEMENTED\nYour Decision → ${choice === "adhere" ? "preserved" : "replacement + your reason"} → EMAIL ${run.server?.email.toUpperCase()}`)}\n\n\`\`\`diff\n${compactDiff(DEMO_INITIAL, after)}\n\`\`\`\n\n${run.stage === "cleanup" ? "Sample cleanup still needs attention." : "Owned sample files removed."} ${run.server?.email === "accepted" ? "The provider accepted the email; inbox delivery is not confirmed." : "Queued is not inbox delivery."}\n\n${run.binding ? captureNotice : "Ready for your real Decisions."}`;
  }
  return `${label}\n\nChecked edit saved; email finalization is pending. Retry the same resolution to finish. No second email will be queued.`;
}
function handoff(run: DemoRun) {
  const result = { ...resultFor(run), presentation: present(run) };
  if (run.stage === "prepared") return { ...result, nextAction: demoCommand(run, "start") };
  if (run.stage === "prompt")
    return { ...result, awaitUserPrompt: DEMO_TASK, attemptAction: demoCommand(run, "attempt") };
  if (run.stage === "conflict")
    return {
      ...result,
      choices: {
        adhere: demoCommand(run, "resolve", "adhere"),
        supersede: {
          command: demoCommand(run, "resolve", "supersede"),
          requiredArgument: "--reason <user-provided reason>",
          replacement: DEMO_REPLACEMENT,
        },
      },
    };
  if (run.server?.choice && !["completed", "skipped"].includes(run.stage))
    return {
      ...result,
      nextAction: demoCommand(run, "resolve", run.server.choice, run.server.reason),
    };
  return result;
}
function requireResolution(choice?: DemoChoice, reason?: string) {
  if (choice !== "adhere" && choice !== "supersede") throw new Error("Choose adhere or supersede");
  if (choice === "supersede" && (!reason?.trim() || reason.length > 500))
    throw new Error("Supersession requires your short reason (1–500 characters)");
  if (choice === "adhere" && reason !== undefined)
    throw new Error("A supersession reason only applies to supersede");
}
async function finishResolution(run: DemoRun, choice: DemoChoice, reason?: string) {
  if (!run.server) throw new Error("Start the story first");
  if (
    run.stage !== "conflict" &&
    run.server.choice &&
    (run.server.choice !== choice || run.server.reason !== reason)
  )
    throw new Error("This run already has a different approved resolution");
  if (run.stage === "conflict") {
    run.server = await demoApi("resolve", {
      runId: run.server.runId,
      revision: run.server.revision,
      choice,
      ...(reason === undefined ? {} : { reason }),
    });
    if (run.server.stage !== "approved" || run.server.verdict !== "pass") {
      saveRun(run);
      return;
    }
    run.stage = "approved";
    saveRun(run);
  }
  if (run.stage === "approved") {
    const after = choice === "adhere" ? DEMO_ADHERE : DEMO_SUPERSEDE;
    if (digest(after) !== run.server.approvedDigest)
      throw new Error("Server approved unexpected sample bytes");
    const before = readSample(run, "customers.ts");
    if (before !== DEMO_INITIAL && before !== after)
      throw new Error("Sample changed; retained for inspection");
    writeSample(run, "customers.ts", after);
    if (readSample(run, "customers.ts") !== after) throw new Error("Sample write was not verified");
    run.receipt = { revision: run.server.revision, appliedDigest: digest(after) };
    run.stage = "applied";
    saveRun(run);
  }
  if (run.stage === "applied") {
    if (!run.receipt || digest(readSample(run, "customers.ts")) !== run.receipt.appliedDigest)
      throw new Error("Applied sample receipt no longer matches");
    run.server = await demoApi("complete", { runId: run.server.runId, ...run.receipt });
    if (run.server.stage !== "completed" || run.server.email === "not_queued")
      throw new Error("Email was not durably queued");
    run.stage = "cleanup";
    saveRun(run);
  }
  if (run.stage === "cleanup") {
    cleanSandbox(run);
    run.stage = "completed";
    saveRun(run);
    finishOnboarding("completed");
  }
}
export async function advanceDemo(
  id: string,
  action: DemoAction,
  choice?: DemoChoice,
  reason?: string,
) {
  return await lockRunAsync(id, async (run) => {
    if (action === "resolve") requireResolution(choice, reason);
    if (action === "skip") {
      if (run.server && !["completed", "skipped"].includes(run.server.stage)) {
        const latest = await demoStatus(run.server.runId);
        run.server = await demoApi("skip", { runId: latest.runId, revision: latest.revision });
      }
      cleanSandbox(run);
      run.stage = "skipped";
      saveRun(run);
      finishOnboarding("skipped");
      return handoff(run);
    }
    if (run.version === 1)
      throw new Error(
        `Legacy tour: clean up with ${demoCommand(run, "skip")}, then run prim demo again`,
      );
    const isolation = consumeAcknowledgment(run, action, choice, reason);
    if (isolation)
      return {
        fictional: true,
        evaluation: "live",
        runId: id,
        stage: "pending",
        isolation,
        nextAction: demoCommand(run, action, choice, reason),
        diagnosticAction: demoDiagnosticCommand(run),
        skipAction: demoCommand(run, "skip"),
        presentation: `Session isolation pending (${isolation}). ${demoTrustGuidance(run.agent)}`,
      };
    if (action === "status") {
      const server = run.server ? await demoStatus(run.server.runId) : undefined;
      return { ...handoff(run), ...(server ? { server } : {}) };
    }
    if (["completed", "skipped"].includes(run.stage)) return handoff(run);
    const allowed =
      action === "start"
        ? ["prepared", "prompt"]
        : action === "attempt"
          ? ["prompt", "conflict"]
          : ["conflict", "approved", "applied", "cleanup"];
    if (!allowed.includes(run.stage)) throw new Error("Invalid demo transition");
    try {
      if (action === "start" && run.stage === "prepared") {
        run.server = await demoApi("start", { scenarioVersion: 1, localRunId: run.id });
        if (run.server.stage !== "ready")
          throw new Error("Existing backend run needs recovery; inspect status");
        saveRun(run);
        createSandbox(run);
        run.stage = "prompt";
        saveRun(run);
      } else if (action === "attempt" && run.stage === "prompt") {
        if (!run.server || readSample(run, "customers.ts") !== DEMO_INITIAL)
          throw new Error("Initial sample changed");
        run.server = await demoApi("check", {
          runId: run.server.runId,
          revision: run.server.revision,
        });
        if (run.server.stage === "blocked" && run.server.verdict === "block")
          run.stage = "conflict";
        saveRun(run);
      } else if (action === "resolve") {
        if (!["conflict", "approved", "applied", "cleanup"].includes(run.stage))
          throw new Error("Enter the task and see its conflict before resolving");
        await finishResolution(run, choice as DemoChoice, reason);
      } else if (
        !(
          (action === "start" && run.stage === "prompt") ||
          (action === "attempt" && run.stage === "conflict")
        )
      ) {
        throw new Error("Invalid demo transition");
      }
      if (run.server?.verdict === "pending")
        return {
          ...resultFor(run),
          stage: "pending",
          nextAction: demoCommand(run, action, choice, reason),
          presentation: `${label}\n\nCheck pending (${run.server.reasonCode ?? "evaluation in progress"}). File unchanged; retry or skip.`,
        };
      return handoff(run);
    } catch (error) {
      return {
        ...resultFor(run),
        stage: "pending",
        nextAction: demoCommand(run, action, choice, reason),
        presentation: `Tour pending: ${terminalSafeLine(error instanceof Error ? error.message : String(error))}`,
        ...(run.stage === "cleanup" ? { outcomePresentation: present(run) } : {}),
      };
    }
  });
}
function parseAgent(value?: string): Agent | undefined {
  if (value === "claude") return "claude_code";
  if (value === undefined || ["claude_code", "codex", "cursor", "hermes"].includes(value))
    return value as Agent | undefined;
  throw new Error("Expected --agent claude, codex, cursor, or hermes");
}
function reportError(error: unknown) {
  const message = terminalSafeLine(error instanceof Error ? error.message : String(error));
  process.stderr.write(`[prim] demo: ${message}\n`);
  printJson({ fictional: true, evaluation: "live", stage: "error", message });
  process.exitCode = 1;
}
async function terminalTour(run: DemoRun) {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const show = (result: Awaited<ReturnType<typeof advanceDemo>>) => {
    const text = result.presentation
      .replace(/^```(?:text|ts|diff)?\n/gmu, "")
      .replace(/```/gu, "")
      .replace(/\*\*(.*?)\*\*/gu, (_match: string, title: string) => bold(title));
    process.stderr.write(
      `${text.replace("YOUR DECISION STOPPED THIS", color("YOUR DECISION STOPPED THIS", "red")).replace("PASS — CSV export implemented", color("PASS — CSV export implemented", "green"))}\n`,
    );
    return result;
  };
  try {
    const started = show(await advanceDemo(run.id, "start"));
    if (started.stage !== "prompt") return started;
    const task = await rl.question("Enter the task above (or skip): ");
    if (task.trim() !== DEMO_TASK) return show(await advanceDemo(run.id, "skip"));
    const blocked = show(await advanceDemo(run.id, "attempt"));
    if (blocked.stage !== "conflict") return blocked;
    const choice = (await rl.question("Adhere or supersede? [adhere/supersede/skip] "))
      .trim()
      .toLowerCase();
    if (choice !== "adhere" && choice !== "supersede")
      return show(await advanceDemo(run.id, "skip"));
    const reason =
      choice === "supersede" ? await rl.question("Your reason for the replacement: ") : undefined;
    return show(await advanceDemo(run.id, "resolve", choice, reason));
  } finally {
    rl.close();
  }
}
export function registerDemoCommands(program: Command): void {
  const demo = program
    .command("demo")
    .description("Experience your Decision protecting a fictional teammate change")
    .option("--agent <agent>", "calling agent; requires session isolation")
    .option("--details", "include supporting story detail")
    .action(async (options: { agent?: string }, command: Command) => {
      try {
        const agent = parseAgent(options.agent);
        const terminal =
          !agent &&
          !isNonInteractive(command.optsWithGlobals()) &&
          !!process.stdin.isTTY &&
          !!process.stderr.isTTY &&
          !process.env.CLAUDECODE &&
          !process.env.CODEX_THREAD_ID &&
          !process.env.CURSOR_AGENT &&
          !process.env.HERMES_INTERACTIVE;
        const recovery = pendingRuns().map((id) =>
          lockRun(id, (run) => ({
            runId: id,
            skipAction: demoCommand(
              { ...run, launcher: [process.execPath, resolve(process.argv[1])] },
              "skip",
            ),
          })),
        );
        const run = prepareRun(agent, terminal);
        if (terminal) {
          const result = await terminalTour(run);
          if (!process.stdout.isTTY) printJson(result);
          return;
        }
        process.stderr.write("[prim] Tour ready → run nextAction to check session isolation.\n");
        printJson({
          ...handoff(run),
          instructions:
            "Run nextAction exactly as a standalone command. Render presentation once, preserving diagrams. At awaitUserPrompt, wait for the user to enter that task before running attemptAction. At the block, wait for adhere or supersede; supersede requires the user's own reason and approval of the displayed replacement. Append --reason and the reason using the same single-quoted argv format (escape an apostrophe as '\\''). Never invent a reason, delegate this tour, or save fictional samples to memory or real Decisions. On completion display success before following welcome. A new session resumes passive capture.",
          recoverableRuns: recovery,
        });
      } catch (error) {
        reportError(error);
      }
    });
  for (const action of ["start", "attempt", "resolve", "status", "skip"] as const) {
    const sub = demo.command(`${action} ${action === "skip" ? "[runId]" : "<runId>"}`);
    if (action === "resolve")
      sub
        .requiredOption("--choice <choice>", "adhere or supersede")
        .option("--reason <reason>", "your reason for the displayed replacement");
    sub.action(
      async (id: string | undefined, options: { choice?: DemoChoice; reason?: string }) => {
        try {
          if (action === "skip" && !id) {
            finishOnboarding("skipped");
            printJson({
              fictional: true,
              stage: "skipped",
              message: "Tour skipped. Run prim welcome for real Decisions.",
            });
            return;
          }
          printJson(await advanceDemo(id as string, action, options.choice, options.reason));
        } catch (error) {
          reportError(error);
        }
      },
    );
  }
}
