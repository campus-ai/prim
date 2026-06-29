/**
 * `prim setup` — the pure step plan. The orchestration (spawning each
 * subcommand, the auth-skip, the result trail) is exercised E2E; here we pin the
 * ordering, agent branch, daemon toggle, and scope passthrough that the runner
 * depends on.
 */

import { describe, expect, it } from "vitest";
import { planSetupSteps } from "./setup.js";

const keys = (opts: Parameters<typeof planSetupSteps>[0]) => planSetupSteps(opts).map((s) => s.key);

describe("planSetupSteps", () => {
  it("claude, with daemon: session → daemon → hooks → skill, in order", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "project" });
    expect(steps.map((s) => s.key)).toEqual(["session", "daemon", "hooks", "skill"]);
    expect(steps[0].args).toEqual(["claude", "install"]);
    // daemon is the only tolerated-skip step; the rest are required.
    expect(steps.filter((s) => !s.required).map((s) => s.key)).toEqual(["daemon"]);
  });

  it("codex: session step targets the codex integration", () => {
    const steps = planSetupSteps({ agent: "codex", daemon: true, scope: "project" });
    expect(steps[0].args).toEqual(["codex", "install"]);
    expect(steps[0].label).toMatch(/codex/i);
  });

  it("--no-daemon: drops the daemon step, keeps the required ones", () => {
    expect(keys({ agent: "claude", daemon: false, scope: "project" })).toEqual([
      "session",
      "hooks",
      "skill",
    ]);
  });

  it("user scope: appends --scope user to the session install only", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["claude", "install", "--scope", "user"]);
    // hooks/skill are not scoped.
    expect(steps.find((s) => s.key === "hooks")?.args).toEqual(["hooks", "install"]);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual(["skill", "install"]);
  });

  it("project scope: no --scope flag on the session install", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "project" });
    expect(steps[0].args).toEqual(["claude", "install"]);
  });

  it("hermes: global-only, so no scope flag even under --scope user; skill targets .hermes.md", () => {
    const steps = planSetupSteps({ agent: "hermes", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["hermes", "install"]);
    expect(steps[0].label).toMatch(/hermes/i);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--target",
      ".hermes.md",
    ]);
  });
});
