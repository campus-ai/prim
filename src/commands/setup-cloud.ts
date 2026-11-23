import { hasProjectPrimInstall } from "../lib/activation.js";
import {
  CLOUD_CREDENTIALS_REMEDY,
  cloudEgressRemedy,
  isClaudeCloudSession,
  repositoryIdentityRemedy,
} from "../lib/cloud-session.js";
import { gitToplevel, githubRepositoryFullName } from "../lib/git.js";
import { stageHookRuntime } from "../lib/hook-runtime.js";
import { hasMachineConfiguration } from "../lib/machine-credentials.js";
import { MachineAuthError } from "../lib/machine-protocol.js";
import { printJson } from "../output.js";

const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;

export type CloudSetupStep = "ok" | "failed" | "missing";

export type CloudSetupDependencies = {
  run: (args: string[], capture?: boolean) => { code: number; stdout: string };
  note: (message: string) => void;
  exit: (code: number) => void;
  parseAuthStatus: (result: { code: number; stdout: string }) =>
    | "valid"
    | "invalid"
    | "unreachable";
  stage?: () => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
};

/**
 * Both halves stop and disable the daemon, which on a developer's machine
 * would silently end capture delivery until they re-enable it. Cloud VMs are
 * Linux and sessions set CLAUDE_CODE_REMOTE; a setup script may run before
 * that is set, so the image half accepts any Linux host.
 */
function refuseOutsideCloud(deps: CloudSetupDependencies, mode: "prepare" | "session"): boolean {
  const env = deps.env ?? process.env;
  if (isClaudeCloudSession(env)) return false;
  if (mode === "prepare" && (deps.platform ?? process.platform) === "linux") return false;
  deps.note(
    mode === "prepare"
      ? "cloud · refusing: --prepare is for a Claude Code cloud environment's setup script (a Linux VM); on this machine it would disable the daemon"
      : "cloud · refusing: this is not a Claude Code cloud session (CLAUDE_CODE_REMOTE is not true); on this machine it would disable the daemon. Run `prim setup` instead",
  );
  printJson({ ok: false, cloud: mode, results: { cloud: "missing" }, failed: ["cloud"] });
  deps.exit(EXIT_USAGE);
  return true;
}

/**
 * `prim setup --cloud --prepare`: the image-time half, run from a cloud
 * environment's setup script. It needs no credentials, network, or repository:
 * the setup script runs before environment variables are set and its result is
 * cached as a filesystem snapshot. It stages the exact hook runtime the
 * committed hook commands exec, and records the daemon opt-out (a paused VM
 * would only kill the daemon; capture delivers directly instead).
 */
export function prepareCloudImage(deps: CloudSetupDependencies): void {
  if (refuseOutsideCloud(deps, "prepare")) return;
  const results: Record<string, CloudSetupStep> = {};
  deps.note("hook runtime · staging…");
  try {
    (deps.stage ?? stageHookRuntime)();
    results.runtime = "ok";
  } catch (error) {
    deps.note(`hook runtime · ${error instanceof Error ? error.message : String(error)}`);
    results.runtime = "failed";
  }
  deps.note("daemon · recording the opt-out…");
  results.daemon = deps.run(["daemon", "stop"]).code === 0 ? "ok" : "failed";
  finish(deps, "prepare", results);
}

/**
 * `prim setup --cloud`: the per-session half. A cloud clone starts without
 * prim's repo-local git config and hooks, so verify the machine credential,
 * wire git hooks, and activate. Claude Code hooks come from the repository's
 * committed project settings, which this never edits; wiring git hooks writes
 * into a repository-relative hooks directory (such as .husky) where the
 * repository uses one, exactly as `prim enable` does.
 */
export function setupCloudSession(deps: CloudSetupDependencies): void {
  if (refuseOutsideCloud(deps, "session")) return;
  const env = deps.env ?? process.env;
  const results: Record<string, CloudSetupStep> = {};

  let machine: boolean;
  try {
    machine = hasMachineConfiguration({ env });
  } catch (error) {
    deps.note(`credentials · ${error instanceof MachineAuthError ? error.message : String(error)}`);
    results.credentials = "failed";
    finish(deps, "session", results);
    return;
  }
  if (!machine) {
    deps.note(`credentials · missing: ${CLOUD_CREDENTIALS_REMEDY}`);
    results.credentials = "missing";
    finish(deps, "session", results);
    return;
  }
  const auth = deps.parseAuthStatus(deps.run(["auth", "status", "--json"], true));
  if (auth !== "valid") {
    deps.note(
      auth === "unreachable"
        ? `credentials · Primitive is unreachable from this environment: ${cloudEgressRemedy()}`
        : "credentials · rejected; mint a replacement with `prim auth enroll --new-installation` and revoke the old installation in Settings → Developer installations",
    );
    results.credentials = "failed";
    finish(deps, "session", results);
    return;
  }
  results.credentials = "ok";

  const root = gitToplevel(deps.cwd);
  if (!root) {
    deps.note("repository · not a git repository; run from the cloned repository");
    results.repository = "missing";
    finish(deps, "session", results);
    return;
  }
  if (!githubRepositoryFullName(root)) {
    deps.note(`repository · ${repositoryIdentityRemedy(root)}`);
    results.repository = "missing";
    finish(deps, "session", results);
    return;
  }
  if (hasProjectPrimInstall(root)) {
    results.session = "ok";
  } else {
    deps.note(
      "session hooks · this repository has no committed prim project install; run `prim claude install --scope project` locally and commit .claude/settings.json",
    );
    results.session = "missing";
  }

  results.daemon = deps.run(["daemon", "stop"]).code === 0 ? "ok" : "failed";
  deps.note("git hooks · installing…");
  results.hooks = deps.run(["hooks", "install"]).code === 0 ? "ok" : "failed";
  deps.note("activate this repo · installing…");
  results.enable = deps.run(["enable", "--non-interactive"]).code === 0 ? "ok" : "failed";
  finish(deps, "session", results);
}

function finish(
  deps: CloudSetupDependencies,
  mode: "prepare" | "session",
  results: Record<string, CloudSetupStep>,
): void {
  const failed = Object.keys(results).filter((key) => results[key] !== "ok");
  deps.note(
    failed.length === 0
      ? `cloud ${mode} complete`
      : `cloud ${mode} incomplete (${failed.join(", ")})`,
  );
  printJson({ ok: failed.length === 0, cloud: mode, results, failed });
  if (failed.length) deps.exit(EXIT_INCOMPLETE);
}
