import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  detectAgent,
  planSetupSteps,
  primCommand,
  registerSetupCommand,
  resolveAgent,
} from "./setup.js";

const cli = resolve("dist/index.js");
const originalCwd = process.cwd();
const roots: string[] = [];
afterEach(() => {
  process.chdir(originalCwd);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness() {
  const root = mkdtempSync(join(tmpdir(), "prim-setup-demo-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  vi.stubEnv("PRIM_CONFIG_DIR", join(root, "config"));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_COUNT", "0");
  process.chdir(repo);
  execFileSync("git", ["init", "-q"]);
  const calls: string[][] = [];
  const outputs: Record<string, unknown>[] = [];
  const notes: string[] = [];
  const summaries: { nextAction?: string; onboarding: { nextAction?: string } }[] = [];
  vi.spyOn(console, "log").mockImplementation((value) => summaries.push(JSON.parse(String(value))));
  let failedStep = "";
  let health = "{}";
  const timeouts: Record<string, number | undefined> = {};
  const setup = async (options: string[] = [], agentArgs = ["--agent", "codex"]) => {
    calls.length = 0;
    const exit = vi.fn();
    const program = new Command().option("--non-interactive");
    registerSetupCommand(program, {
      exit,
      note: (message) => notes.push(message),
      run: (args, _capture, timeoutMs) => {
        calls.push(args);
        timeouts[args[0]] = timeoutMs;
        if (args[0] === failedStep) return { code: 1, stdout: "" };
        if (args[0] === "doctor") return { code: 0, stdout: health };
        if (args[0] === "auth") return { code: 0, stdout: '{"status":"valid"}' };
        if (args[0] === "demo" || args.includes("demo")) {
          const child = spawnSync(process.execPath, [cli, ...args], {
            encoding: "utf8",
            timeout: 5000,
          });
          if (child.stdout) outputs.push(JSON.parse(child.stdout));
          return { code: child.status ?? 1, stdout: child.stdout ?? "" };
        }
        return { code: 0, stdout: "{}" };
      },
    });
    await program.parseAsync(["setup", ...agentArgs, ...options], { from: "user" });
    return exit;
  };
  return {
    timeouts,
    root,
    calls,
    outputs,
    summaries,
    notes,
    setup,
    health: (value: unknown) => {
      health = JSON.stringify(value);
    },
    fail: (step: string) => {
      failedStep = step;
    },
  };
}

describe("setup's optional demo handoff", () => {
  it("detects a Codex session while honoring an explicit override", () => {
    expect(detectAgent({ CODEX_THREAD_ID: "thread" })).toBe("codex");
    expect(resolveAgent("claude", { CODEX_THREAD_ID: "thread" })).toEqual({
      agent: "claude",
      detected: false,
    });
  });
  it("preserves degraded health and does not claim capture was verified", async () => {
    const h = harness();
    const health = {
      ok: true,
      status: "warn",
      checks: [{ name: "pre-commit", status: "warn", detail: "unsupported_interpreter" }],
    };
    h.health(health);
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.summaries.at(-1)).toMatchObject({
      status: "complete",
      steps: { health: "warn" },
      health,
      readiness: { installation: "installed", health: "warn", passiveCapture: "not-verified" },
      instructions: expect.stringContaining("Continue nextAction now"),
    });
  });
  it("returns one structured setup result with the onboarding action", async () => {
    const h = harness();
    await h.setup();
    expect(h.summaries).toHaveLength(1);
    expect(h.summaries[0]).toMatchObject({
      setup: true,
      status: "complete",
      onboarding: { stage: "prepared", fictional: true, evaluation: "live" },
    });
    expect(h.summaries[0].nextAction).toBe(h.summaries[0].onboarding.nextAction);
  });
  it("keeps optional tour failure separate from installation success", async () => {
    const h = harness();
    h.fail("demo");
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.summaries.at(-1)).toMatchObject({
      status: "complete",
      onboarding: { stage: "pending" },
    });
    expect(h.notes.join("\n")).toContain("setup succeeded");
  });
  it("defers seeding after successful installation and returns a content-free agent handoff", async () => {
    const h = harness();
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.calls.findIndex((args) => args[0] === "doctor")).toBeLessThan(
      h.calls.findIndex((args) => args[0] === "demo"),
    );
    expect(h.calls).toContainEqual(["welcome", "--agent", "codex", "--defer-seeding"]);
    expect(h.outputs.at(-1)).toMatchObject({
      fictional: true,
      evaluation: "live",
      stage: "prepared",
    });
    expect(JSON.stringify(h.outputs)).not.toContain("shared HTTP");
  });

  it("remembers explicit skipping and preserves ordinary welcome on repeat setup", async () => {
    const h = harness();
    expect(await h.setup(["--skip-demo"])).toHaveBeenCalledWith(0);
    expect(h.calls).toContainEqual(["demo", "skip"]);
    expect(h.calls).toContainEqual(["welcome", "--agent", "codex"]);
    expect(
      JSON.parse(readFileSync(join(h.root, "config", "demo", "onboarding.json"), "utf8")),
    ).toEqual({ outcome: "skipped" });
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.calls.some((args) => args[0] === "demo")).toBe(false);
  });

  it("does not start a tour after a failed required step and keeps demo errors separate", async () => {
    const h = harness();
    h.fail("enable");
    expect(await h.setup()).toHaveBeenCalledWith(1);
    expect(h.calls.some((args) => args[0] === "demo")).toBe(false);
    h.fail("demo");
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.notes.join("\n")).toContain("demo · pending after an error; setup succeeded");
  });

  it("keeps seeding deferred when the onboarding marker is unreadable", async () => {
    const h = harness();
    const demo = join(h.root, "config", "demo");
    mkdirSync(demo, { recursive: true });
    writeFileSync(join(demo, "onboarding.json"), "invalid JSON");
    expect(await h.setup()).toHaveBeenCalledWith(0);
    expect(h.calls).toContainEqual(["welcome", "--agent", "codex", "--defer-seeding"]);
    expect(h.outputs.at(-1)).toMatchObject({
      fictional: true,
      evaluation: "live",
      stage: "prepared",
    });
    expect(h.notes.join("\n")).toContain("cannot read onboarding state");
    expect(await h.setup(["--skip-demo"])).toHaveBeenCalledWith(0);
    expect(JSON.parse(readFileSync(join(demo, "onboarding.json"), "utf8"))).toEqual({
      outcome: "skipped",
    });
  });
});

describe("setup's Claude hand-off to the prim-welcome skill", () => {
  it("activates and checks health for Claude like every other agent", () => {
    const keys = (agent: "claude" | "codex") =>
      planSetupSteps({ agent, daemon: true, scope: "user" }).map((step) => step.key);
    expect(keys("claude")).toEqual(keys("codex"));
    expect(keys("claude")).toEqual(["session", "daemon", "skill", "enable", "health"]);
  });

  it("connects GitHub just before activation, and returns the skill path without prose", async () => {
    vi.stubEnv("CI", "");
    vi.stubEnv("PRIM_NON_INTERACTIVE", "");
    const h = harness();
    h.health({ ok: true, status: "ok", checks: [] });
    expect(await h.setup(["--agent", "claude"])).toHaveBeenCalledWith(0);
    const commands = h.calls.map((args) => args[0]);
    expect(commands.indexOf("github")).toBe(commands.indexOf("enable") - 1);
    expect(commands.indexOf("skill")).toBeLessThan(commands.indexOf("github"));
    expect(h.timeouts.github).toBe(90_000);
    for (const command of ["welcome", "demo"]) expect(commands).not.toContain(command);
    const welcomeSkill = join(h.root, "home", ".claude", "skills", "prim-welcome", "SKILL.md");
    expect(h.summaries).toEqual([
      {
        setup: true,
        status: "complete",
        steps: {
          auth: "ok",
          preauth: "ok",
          session: "ok",
          daemon: "ok",
          skill: "ok",
          github: "ok",
          enable: "ok",
          health: "ok",
        },
        health: { ok: true, status: "ok", checks: [] },
        readiness: { installation: "installed", health: "ok", passiveCapture: "not-verified" },
        welcomeSkill,
        prim: primCommand(),
        demo: "due",
        instructions: "Read the file at welcomeSkill and follow it.",
      },
    ]);
    expect(h.notes.at(-1)).toBe(`setup complete · ${welcomeSkill}`);
  });

  it("skips the GitHub connection when non-interactive", async () => {
    vi.stubEnv("CI", "1");
    const h = harness();
    expect(await h.setup(["--agent", "claude"])).toHaveBeenCalledWith(0);
    expect(h.calls.map((args) => args[0])).not.toContain("github");
  });

  it("hands off only when Claude Code is detected, keeping the welcome for people", async () => {
    vi.stubEnv("CLAUDECODE", "");
    const person = harness();
    expect(await person.setup([], [])).toHaveBeenCalledWith(0);
    expect(person.calls.map((args) => args[0])).toContain("welcome");
    expect(person.summaries.at(-1)).not.toHaveProperty("welcomeSkill");

    vi.stubEnv("CLAUDECODE", "1");
    const agent = harness();
    expect(await agent.setup([], [])).toHaveBeenCalledWith(0);
    expect(agent.summaries.at(-1)).toHaveProperty("welcomeSkill");
    expect(await agent.setup(["--scope", "project"], [])).toHaveBeenCalledWith(0);
    expect(agent.summaries.at(-1)).not.toHaveProperty("welcomeSkill");
  });

  it("pins an installed package through npx and runs a checkout by path", () => {
    expect(
      primCommand(["node", "/x/_npx/1/node_modules/@primitive.ai/prim/dist/index.js"], "1.2.3"),
    ).toBe("npx --yes @primitive.ai/prim@1.2.3");
    expect(primCommand(["node", "/opt/it's/dist/index.js"], "1.2.3")).toBe(
      `'${process.execPath}' '/opt/it'\\''s/dist/index.js'`,
    );
    const version = execFileSync("/bin/sh", ["-c", `${primCommand(["node", cli])} --version`], {
      encoding: "utf8",
    });
    expect(version.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });

  it("reports the demo as done once skipped", async () => {
    const h = harness();
    expect(await h.setup(["--agent", "claude", "--skip-demo"])).toHaveBeenCalledWith(0);
    expect(h.calls).toContainEqual(["demo", "skip"]);
    expect(h.summaries.at(-1)).toMatchObject({ demo: "done" });
    expect(await h.setup(["--agent", "claude"])).toHaveBeenCalledWith(0);
    expect(h.summaries.at(-1)).toMatchObject({ demo: "done" });
  });

  it("reports a failed activation without pointing at the skill", async () => {
    const h = harness();
    h.fail("enable");
    expect(await h.setup(["--agent", "claude"])).toHaveBeenCalledWith(1);
    expect(h.summaries.at(-1)).toMatchObject({ status: "incomplete", steps: { enable: "failed" } });
    expect(h.summaries.at(-1)).not.toHaveProperty("welcomeSkill");
  });
});
