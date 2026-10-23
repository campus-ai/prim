import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import { diffLines } from "diff";
import { demoApi, demoStatus } from "../demo/api.js";
import { isolationDiagnostics } from "../demo/diagnostics.js";
import { cleanSandbox, createSandbox, readSample, writeSample } from "../demo/sandbox.js";
import {
  type DemoAction,
  type DemoChoice,
  type DemoRun,
  RUN_ID,
  demoCommand,
  demoDiagnosticCommand,
  demoResumeCommand,
  demoWelcomeCommand,
  exclusionPath,
  finishOnboarding,
  lockRun,
  lockRunAsync,
  pendingRuns,
  preparationKey,
  prepareRun,
  readDemoJson,
  readRun,
  saveRun,
} from "../demo/state.js";
import {
  DEMO_ADHERE,
  DEMO_INITIAL,
  DEMO_ORIGINAL,
  DEMO_RATIONALE,
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
    return "Check /hooks in Codex. Approve only if a trust action is offered. If hooks are already active, retry the exact standalone command once; do not keep asking for trust or a new session. If still pending, run diagnosticAction once. Inspect its expected PreToolUse/Bash event and runtime; UserPromptSubmit does not acknowledge the tour. Do not prepare a new run.";
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
  if (run.stage === "prepared") return "Tour prepared → Isolation pending → Story not started.";
  if (run.stage === "skipped") return "Tour skipped. Owned sample files removed.";
  const server = run.server;
  if (!server) throw new Error("Start the story first");
  if (run.stage === "prompt")
    return `[DEMO] How Primitive Catches Conflicts

You're a new engineer on ${safeMarkdown(server.story.orgName)}'s team.
And you've been tasked with implementing CSV export functionality for customer records.
Enter this prompt to do so:
${DEMO_TASK}`;
  if (run.stage === "conflict")
    return `[DEMO] Primitive Caught a Conflict

You proposed:
"${DEMO_TASK}"

But this conflicts with ${safeMarkdown(server.authorName)}'s Decision from ${safeMarkdown(server.story.decisionDate)}:
Intent: ${DEMO_ORIGINAL}
Rationale ${DEMO_RATIONALE}

\`\`\`
${readSample(run, "customers.ts").trimEnd()}
\`\`\`

You can either:
- Accept ${safeMarkdown(server.authorName)}'s Decision and export only names, or
- Supercede ${safeMarkdown(server.authorName)}'s Decision and proceed with exporting both names and email addresses`;
  if (run.stage === "completed") {
    const accepted = server.choice === "adhere";
    const after = accepted ? DEMO_ADHERE : DEMO_SUPERSEDE;
    return `[DEMO] ${accepted ? "Accepted" : "Superceded"} ${safeMarkdown(server.authorName)}'s Decision

Implemented CSV Export with ${accepted ? "only names" : "both names and email addresses"}:
\`\`\`
${compactDiff(DEMO_INITIAL, after)}
\`\`\`

Check ${safeMarkdown(server.story.recipient)} for details regarding this Decision.

Start a new session and continue working to begin capturing Decisions.
Or, you can explore existing Decisions by prompting your agent e.g.:
- Show me my team's recent decisions and summarize what each one settled.
- Pick the most load-bearing decision in our graph and walk me through its blast radius — what would changing it disturb?
- Before I refactor, check which prior decisions govern the files I'm about to touch.
- Find a file governed by one of our decisions, try a conflicting edit, and show me what the conflict gate says. Don't keep the change.
- Is anything in our decision graph under review or waiting on me? Show me what needs attention.`;
  }
  if (run.stage === "cleanup") {
    const choice = run.server?.choice;
    const after = choice === "adhere" ? DEMO_ADHERE : DEMO_SUPERSEDE;
    return `${label}\n\n**PASS — CSV export implemented**\n${diagram(`CSV [${choice === "adhere" ? "name" : "name, email"}] → CHECK PASSED → IMPLEMENTED\nYour Decision → ${choice === "adhere" ? "preserved" : "replacement + your reason"} → EMAIL ${run.server?.email.toUpperCase()}`)}\n\n\`\`\`diff\n${compactDiff(DEMO_INITIAL, after)}\n\`\`\`\n\nSample cleanup still needs attention. ${run.server?.email === "accepted" ? "The provider accepted the email; inbox delivery is not confirmed." : "Queued is not inbox delivery."}\n\n${run.binding ? captureNotice : "Ready for your real Decisions."}`;
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
          prompt: `What's your rationale for superceding ${safeMarkdown(run.server?.authorName ?? "the author")}'s existing Decision?`,
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
function pendingIsolation(
  run: DemoRun,
  isolation: string,
  action: DemoAction,
  choice?: DemoChoice,
  reason?: string,
) {
  return {
    fictional: true,
    evaluation: "live",
    runId: run.id,
    stage: "pending",
    isolation,
    ...(action === "status"
      ? { resumeAction: demoResumeCommand(run) }
      : { nextAction: demoCommand(run, action, choice, reason) }),
    diagnostics: isolationDiagnostics(run),
    ...(action === "status" ? {} : { diagnosticAction: demoDiagnosticCommand(run) }),
    skipAction: demoCommand(run, "skip"),
    presentation: `Tour prepared → **Isolation pending** → ${run.stage === "prepared" ? "Story not started" : "Story paused"}.\n\n${isolation}. Checking the installed pre-tool hook before continuing.`,
    guidance: demoTrustGuidance(run.agent),
    recovery: `${action === "status" ? "Use this evidence to repair the hook before resumeAction." : "Run diagnosticAction once."} If no hook observation exists, the CLI has no evidence this command reached its installed pre-tool hook. Check the host hook event/error view and configuration-directory access; absence of a log is not proof of healthy hooks. Retry only after a repair, using this run. Never fabricate acknowledgment or read sample files.`,
  };
}
export async function advanceDemo(
  id: string,
  action: DemoAction,
  choice?: DemoChoice,
  reason?: string,
) {
  // Read-only diagnostics must work even when the host cannot create a lock.
  if (action === "status") {
    const run = readRun(id);
    if (!run.terminal && !run.acknowledgment)
      return pendingIsolation(run, "acknowledgment-missing", action);
  }
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
    const isolation =
      action === "status" && !run.terminal && !run.acknowledgment
        ? "acknowledgment-missing"
        : consumeAcknowledgment(run, action, choice, reason);
    if (isolation) return pendingIsolation(run, isolation, action, choice, reason);
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
      if (run.needsStatus && run.server) {
        const latest = await demoStatus(run.server.runId);
        if (latest.runId !== run.server.runId)
          throw new Error("Server returned a different demo run");
        run.server = latest;
        run.needsStatus = false;
        saveRun(run);
      }
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
      run.needsStatus = true;
      saveRun(run);
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
  const code = (error as NodeJS.ErrnoException)?.code;
  process.stderr.write(`[prim] demo: ${message}\n`);
  printJson({
    fictional: true,
    evaluation: "live",
    stage: "error",
    message,
    ...(code === "EPERM" || code === "EACCES"
      ? {
          code,
          recovery:
            "The host denied access to Primitive local state. Run the same action with the configuration-directory access authorized for setup, within host policy. Do not create another run or change permissions recursively.",
        }
      : {}),
  });
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
      `${text.replace("[DEMO] Primitive Caught a Conflict", color("[DEMO] Primitive Caught a Conflict", "red")).replace("PASS — CSV export implemented", color("PASS — CSV export implemented", "green"))}\n`,
    );
    if (["completed", "skipped"].includes(result.stage) && "nextAction" in result) {
      process.stderr.write(`Next: ${result.nextAction}\n`);
    }
    return result;
  };
  try {
    const started = show(await advanceDemo(run.id, "start"));
    if (started.stage !== "prompt") return started;
    const task = await rl.question("Enter the task above (or skip): ");
    if (task.trim() !== DEMO_TASK) return show(await advanceDemo(run.id, "skip"));
    const blocked = show(await advanceDemo(run.id, "attempt"));
    if (blocked.stage !== "conflict") return blocked;
    const answer = (await rl.question("Accept or Supercede? [accept/supercede/skip] "))
      .trim()
      .toLowerCase();
    const choice = answer === "accept" ? "adhere" : answer === "supercede" ? "supersede" : answer;
    if (choice !== "adhere" && choice !== "supersede")
      return show(await advanceDemo(run.id, "skip"));
    const reason =
      choice === "supersede"
        ? await rl.question(
            `What's your rationale for superceding ${terminalSafeLine("server" in blocked ? (blocked.server?.authorName ?? "the author") : "the author")}'s existing Decision? `,
          )
        : undefined;
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
    .option("--resume-pending", "reuse a pending tour prepared in this Codex session")
    .action(async (options: { agent?: string; resumePending?: boolean }, command: Command) => {
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
        // Atomic state reads are sufficient for a recovery inventory. A busy
        // unrelated run must not prevent preparing an independent tour.
        const runs = pendingRuns().map(readRun);
        const recovery = runs.map((run) => ({
          runId: run.id,
          resumeAction: run.version === 2 ? demoResumeCommand(run) : undefined,
          skipAction: demoCommand(
            { ...run, launcher: [process.execPath, resolve(process.argv[1])] },
            "skip",
          ),
        }));
        const key = preparationKey(agent);
        const pending =
          options.resumePending && key
            ? runs.find(
                (run) => run.version === 2 && run.preparationKey === key && run.agent === agent,
              )
            : undefined;
        const run = pending
          ? lockRun(pending.id, (run) => {
              run.launcher = [process.execPath, resolve(process.argv[1])];
              run.acknowledgment = undefined;
              saveRun(run);
              return run;
            })
          : prepareRun(agent, terminal);
        if (terminal) {
          const result = await terminalTour(run);
          if (!process.stdout.isTTY) printJson(result);
          return;
        }
        process.stderr.write(
          "[prim] Tour prepared → verify isolation to continue. Follow nextAction.\n",
        );
        printJson({
          fictional: true,
          evaluation: "live",
          runId: run.id,
          stage: run.stage,
          nextAction: demoCommand(run, run.stage === "prepared" ? "start" : "status"),
          skipAction: demoCommand(run, "skip"),
          statusAction: demoDiagnosticCommand(run),
          presentation: `Tour prepared → Isolation pending → ${run.stage === "prepared" ? "Story not started" : "Story paused"}.`,
          instructions:
            "Continue nextAction now within the authorized setup request; do not stop at welcome or ask whether to begin. Run nextAction exactly as a standalone command with the same authorized local-state access as setup. Render presentation once, preserving diagrams. At awaitUserPrompt, wait for the user to enter that task before running attemptAction. At the block, wait for adhere or supersede; supersede requires the user's own reason and approval of the displayed replacement. Append --reason and the reason using the same single-quoted argv format (escape an apostrophe as '\\''). Never invent a reason, delegate this tour, or save fictional samples to memory or real Decisions. On completion display success before following welcome. A new session resumes passive capture.",
          recoverableRuns: recovery,
        });
      } catch (error) {
        reportError(error);
      }
    });
  demo
    .command("resume <runId>")
    .description("Recover this run's launcher without revealing story content")
    .action((id: string) => {
      try {
        printJson(
          lockRun(id, (run) => {
            if (run.version !== 2) throw new Error("Legacy tour must be skipped before replay");
            run.launcher = [process.execPath, resolve(process.argv[1])];
            run.acknowledgment = undefined;
            saveRun(run);
            return {
              fictional: true,
              evaluation: "live",
              runId: id,
              stage: "pending",
              nextAction: demoCommand(run, run.stage === "prepared" ? "start" : "status"),
              diagnosticAction: demoDiagnosticCommand(run),
              presentation: "Run nextAction to verify isolation and resume this tour.",
            };
          }),
        );
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
