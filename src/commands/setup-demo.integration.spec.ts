import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSetupCommand } from "./setup.js";

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
  const setup = async (options: string[] = []) => {
    calls.length = 0;
    const exit = vi.fn();
    const program = new Command().option("--non-interactive");
    registerSetupCommand(program, {
      exit,
      note: (message) => notes.push(message),
      run: (args) => {
        calls.push(args);
        if (args[0] === failedStep) return { code: 1, stdout: "" };
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
    await program.parseAsync(["setup", "--agent", "codex", ...options], { from: "user" });
    return exit;
  };
  return {
    root,
    calls,
    outputs,
    summaries,
    notes,
    setup,
    fail: (step: string) => {
      failedStep = step;
    },
  };
}

describe("setup's optional demo handoff", () => {
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
