import { hasProjectPrimInstall } from "../lib/activation.js";
import {
  clearCloudPrepared,
  isPreparedCloudSession,
  markCloudPrepared,
  preparedInSession,
} from "../lib/cloud-prepared.js";
import {
  CLOUD_CREDENTIALS_REMEDY,
  cloudEgressRemedy,
  isClaudeCloudSession,
  repositoryIdentityRemedy,
} from "../lib/cloud-session.js";
import { resolveStoredCredential } from "../lib/credentials.js";
import { gitToplevel, githubRepositoryFullName } from "../lib/git.js";
import { stageHookRuntime } from "../lib/hook-runtime.js";
import { hasMachineConfiguration } from "../lib/machine-credentials.js";
import { MachineAuthError } from "../lib/machine-protocol.js";
import { stripControlChars } from "../lib/terminal-safe.js";
import { printJson } from "../output.js";
import {
  cloudUserInstallComplete,
  hasDeveloperUserInstall,
  performCloudUserInstall,
} from "./claude-install.js";

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
  installUserHooks?: () => void;
  markPrepared?: () => void;
  /** A developer's own user-scope prim install that preparing would rewrite. */
  developerInstall?: () => boolean;
  /** The VM's user-scope settings still carry prim's complete cloud wiring. */
  userHooksComplete?: () => boolean;
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
  refuse(
    deps,
    mode,
    mode === "prepare"
      ? "cloud · refusing: --prepare is for a Claude Code cloud environment's setup script (a Linux VM); on this machine it would disable the daemon"
      : "cloud · refusing: this is not a Claude Code cloud session (CLAUDE_CODE_REMOTE is not true); on this machine it would disable the daemon. Run `prim setup` instead",
  );
  return true;
}

/** A refusal in the same JSON contract as a finished run. */
function refuse(deps: CloudSetupDependencies, mode: "prepare" | "session", reason: string): void {
  deps.note(reason);
  printJson({
    ok: false,
    cloud: mode,
    results: { cloud: "missing" },
    failed: ["cloud"],
    remedies: [reason],
    instructions: "Cloud setup does not apply on this machine. Tell the user why in one sentence.",
  });
  deps.exit(EXIT_USAGE);
}

type CloudResults = Record<string, CloudSetupStep>;

/**
 * `prim setup --cloud --prepare`: the image-time half, run from a cloud
 * environment's setup script. It needs no credentials, network, or repository:
 * the setup script runs before environment variables are set and its result is
 * cached as a filesystem snapshot. It stages the hook runtime and wires prim
 * into the VM's user-scope Claude settings, which Claude Code reads at startup,
 * so repositories need no commit. Each hook defers to a repository's own
 * committed install. It marks the environment prepared, so sessions activate
 * the repositories they open, and records the daemon opt-out (a paused VM
 * would only kill the daemon; capture delivers directly instead).
 */
export function prepareCloudImage(deps: CloudSetupDependencies): void {
  if (refuseOutsideCloud(deps, "prepare")) return;
  const env = deps.env ?? process.env;
  // A Linux host outside a session may be a developer's machine; never rewrite
  // their own user-scope install or statusline into the cloud form.
  if (!isClaudeCloudSession(env) && (deps.developerInstall ?? hasDeveloperUserInstall)()) {
    refuse(
      deps,
      "prepare",
      "cloud · refusing: this machine has its own user-scope prim install; --prepare is for a Claude Code cloud environment's setup script",
    );
    return;
  }
  const results: CloudResults = {};
  const remedies: string[] = [];
  prepareSteps(deps, results, remedies);
  finish(deps, "prepare", results, remedies);
}

/**
 * `prim setup --cloud`: the per-session check. A cloud clone starts without
 * prim's repo-local git config and hooks, so verify the machine credential,
 * wire git hooks (including the pre-commit check), and activate. Claude Code
 * hooks come from the prepared environment or the repository's committed
 * project settings, which this never edits; wiring git hooks writes
 * into a repository-relative hooks directory (such as .husky) where the
 * repository uses one, exactly as `prim enable` does.
 */
export function setupCloudSession(deps: CloudSetupDependencies): void {
  if (refuseOutsideCloud(deps, "session")) return;
  const results: CloudResults = {};
  const remedies: string[] = [];
  sessionSteps(deps, results, remedies);
  finish(deps, "session", results, remedies);
}

/**
 * Plain `prim setup` inside a Claude Code cloud session, which is what the
 * documented "set up Primitive for this repo" prompt runs. The developer
 * flow cannot work there (browser sign-in, a supervised daemon, onboarding),
 * so do the cloud setup instead. When the environment was never prepared
 * and the repository commits no install, prepare this VM first: its hooks
 * load when Claude Code next starts, so say how to make that permanent.
 */
export function setupDetectedCloudSession(deps: CloudSetupDependencies): void {
  const env = deps.env ?? process.env;
  deps.note("cloud · Claude Code cloud session detected; running cloud setup");
  const results: CloudResults = {};
  const remedies: string[] = [];
  const root = gitToplevel(deps.cwd);
  let preparedNow = false;
  if (!isPreparedCloudSession(env) && !(root && hasProjectPrimInstall(root))) {
    prepareSteps(deps, results, remedies, "session");
    preparedNow = results.prepared === "ok";
  }
  sessionSteps(deps, results, remedies, { preparedNow });
  finish(deps, "session", results, remedies);
}

/**
 * The image-time steps: stage the hook runtime, wire prim into the VM's
 * user-scope Claude settings, pre-authorize, install the skill, record the
 * daemon opt-out, and mark the environment prepared once the runtime and
 * hooks are in place.
 */
function prepareSteps(
  deps: CloudSetupDependencies,
  results: CloudResults,
  remedies: string[],
  origin: "image" | "session" = "image",
): void {
  const env = deps.env ?? process.env;
  // A failed re-run must not leave an earlier run's opt-in behind.
  clearCloudPrepared(env);
  const attempt = (key: string, label: string, action: () => void): void => {
    deps.note(`${label} · installing…`);
    try {
      action();
      results[key] = "ok";
    } catch (error) {
      const reason = `${label} · ${error instanceof Error ? error.message : String(error)}`;
      deps.note(reason);
      remedies.push(reason);
      results[key] = "failed";
    }
  };
  attempt("runtime", "hook runtime", deps.stage ?? stageHookRuntime);
  attempt(
    "userHooks",
    "Claude Code hooks (user scope)",
    deps.installUserHooks ??
      (() => {
        performCloudUserInstall();
      }),
  );
  const step = (key: string, label: string, args: string[]): void => {
    deps.note(`${label}…`);
    results[key] = deps.run(args).code === 0 ? "ok" : "failed";
    if (results[key] === "failed")
      remedies.push(`${key} · failed; run \`prim ${args.join(" ")}\` to see why`);
  };
  step("preauth", "pre-authorize · writing prim allow-rule (user scope)", [
    "claude",
    "preauth",
    "--scope",
    "user",
  ]);
  step("skill", "agent skill · installing", [
    "skill",
    "install",
    "--agent",
    "claude",
    "--scope",
    "user",
  ]);
  step("daemon", "daemon · recording the opt-out", ["daemon", "stop"]);
  // Activation needs only the runtime and the hooks; a missing skill or
  // allow-rule is reported but does not switch prim off everywhere.
  if (results.runtime === "ok" && results.userHooks === "ok")
    attempt(
      "prepared",
      "cloud activation",
      deps.markPrepared ?? (() => markCloudPrepared(env, origin)),
    );
}

/** The per-session steps; a missing prerequisite stops the rest. */
function sessionSteps(
  deps: CloudSetupDependencies,
  results: CloudResults,
  remedies: string[],
  options: { preparedNow?: boolean } = {},
): void {
  const remedy = (message: string): void => {
    deps.note(message);
    remedies.push(message);
  };
  const env = deps.env ?? process.env;
  let machine: boolean;
  try {
    machine = hasMachineConfiguration({ env });
  } catch (error) {
    remedy(`credentials · ${error instanceof MachineAuthError ? error.message : String(error)}`);
    results.credentials = "failed";
    return;
  }
  // A fixed bearer token or a stored sign-in also authenticates prim; only no
  // credential at all is missing. The SessionStart diagnosis asks the same
  // question the same way, so the two never disagree.
  if (!machine && !resolveStoredCredential(env)) {
    remedy(`credentials · missing: ${CLOUD_CREDENTIALS_REMEDY}`);
    results.credentials = "missing";
    return;
  }
  const status = deps.run(["auth", "status", "--json"], true);
  const auth = deps.parseAuthStatus(status);
  if (auth !== "valid") {
    const detail = authFailureDetail(status.stdout);
    remedy(
      auth === "unreachable"
        ? `credentials · Primitive is unreachable from this environment: ${cloudEgressRemedy()}${detail ? ` (${detail})` : ""}`
        : machine
          ? `credentials · ${detail ?? "rejected"}; if the credential itself was revoked, mint a replacement with \`prim auth enroll --new-installation\` and revoke the old installation in Settings → Developer installations`
          : // A fixed token or stored sign-in has no installation to revoke.
            `credentials · the sign-in was rejected: ${CLOUD_CREDENTIALS_REMEDY}`,
    );
    results.credentials = "failed";
    return;
  }
  // A human sign-in the server accepts only for enrolling an installation
  // verifies, yet authorizes nothing else, and a cloud session cannot enroll.
  if (enrollmentRequired(status.stdout)) {
    remedy(
      `credentials · this sign-in can only enroll an installation, which a cloud session cannot do: ${CLOUD_CREDENTIALS_REMEDY}`,
    );
    results.credentials = "failed";
    return;
  }
  results.credentials = "ok";

  const root = gitToplevel(deps.cwd);
  if (!root) {
    remedy("repository · not a git repository; run from the cloned repository");
    results.repository = "missing";
    return;
  }
  if (!githubRepositoryFullName(root)) {
    remedy(`repository · ${repositoryIdentityRemedy(root)}`);
    results.repository = "missing";
    return;
  }
  // Prepared from inside a session (now or by an earlier run in it): the
  // hooks are wired in this VM but Claude Code has not loaded them.
  const pendingHooks = options.preparedNow === true || preparedInSession(env);
  if (
    hasProjectPrimInstall(root) ||
    (!pendingHooks &&
      isPreparedCloudSession(env) &&
      (deps.userHooksComplete ?? cloudUserInstallComplete)())
  ) {
    results.session = "ok";
  } else if (pendingHooks) {
    // Claude Code reads its settings only when it starts, and the next session
    // starts from the environment's image, not this VM.
    remedy(
      "session hooks · wired in this VM, but Claude Code loads them only when it next starts here, and new sessions start from the environment's image: add `prim setup --cloud --prepare` to the environment's setup script",
    );
    results.session = "missing";
  } else {
    remedy(
      "session hooks · none: run `prim setup --cloud --prepare` in the environment's setup script, or commit `prim claude install --scope project` in this repository",
    );
    results.session = "missing";
  }

  const step = (key: string, label: string, args: string[]): void => {
    if (label) deps.note(`${label} · installing…`);
    results[key] = deps.run(args).code === 0 ? "ok" : "failed";
    if (results[key] === "failed")
      remedy(`${label || key} · failed; run \`prim ${args.join(" ")}\` to see why`);
  };
  // Preparing in this session already recorded the daemon opt-out.
  if (results.daemon === undefined) step("daemon", "", ["daemon", "stop"]);
  step("hooks", "git hooks", ["hooks", "install"]);
  // An unconnected repository fails here; the enable output names the GitHub connection.
  step("enable", "activate this repo", ["enable", "--non-interactive"]);
}

/** `auth status --json` verified the sign-in for enrollment only. */
function enrollmentRequired(stdout: string): boolean {
  try {
    return (
      (JSON.parse(stdout || "{}") as { enrollmentRequired?: unknown }).enrollmentRequired === true
    );
  } catch {
    return false;
  }
}

/** The machine credential failure's own guidance from `auth status --json`, if any. */
function authFailureDetail(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout || "{}") as { recoveryDetail?: unknown };
    return typeof parsed.recoveryDetail === "string"
      ? stripControlChars(parsed.recoveryDetail).replace(/\.$/u, "")
      : undefined;
  } catch {
    return undefined;
  }
}

function finish(
  deps: CloudSetupDependencies,
  mode: "prepare" | "session",
  results: CloudResults,
  remedies: string[],
): void {
  const failed = Object.keys(results).filter((key) => results[key] !== "ok");
  deps.note(
    failed.length === 0
      ? `cloud ${mode} complete`
      : `cloud ${mode} incomplete (${failed.join(", ")})`,
  );
  // The same agent contract as developer setup: say what to do next. Cloud
  // sessions have no welcome, demo, or browser sign-in to continue into.
  const instructions =
    failed.length === 0
      ? mode === "prepare"
        ? "The cloud environment is prepared; sessions started from it load prim's hooks."
        : "Primitive is set up in this Claude Code cloud session. Tell the user in one sentence, then continue their task. There is no welcome or demo in cloud sessions."
      : "Cloud setup is incomplete. Tell the user each remedy in one sentence before continuing; do not run prim auth login or prim auth enroll, which cannot work in a cloud session.";
  printJson({ ok: failed.length === 0, cloud: mode, results, failed, remedies, instructions });
  if (failed.length) deps.exit(EXIT_INCOMPLETE);
}
