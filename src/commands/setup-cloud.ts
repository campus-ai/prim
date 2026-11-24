import { declaresInactive, explicitlyActive, hasProjectPrimInstall } from "../lib/activation.js";
import {
  CLOUD_GITHUB_CONNECT_REMEDY,
  CLOUD_PROXY_FAILING,
  CLOUD_SETUP_POINTER,
} from "../lib/cloud-env.js";
import {
  clearCloudPrepared,
  insideClaudeCode,
  isPreparedCloudSession,
  markCloudPrepared,
  preparedInSession,
} from "../lib/cloud-prepared.js";
import {
  CLOUD_CREDENTIALS_REMEDY,
  cloudAllowedDomains,
  cloudEgressRemedy,
  isClaudeCloudSession,
  isCloudMachineSession,
  repositoryIdentityRemedy,
} from "../lib/cloud-session.js";
import { resolveStoredCredential } from "../lib/credentials.js";
import { gitToplevel, githubRepositoryFullName } from "../lib/git.js";
import { stageHookRuntime } from "../lib/hook-runtime.js";
import { hasMachineConfiguration } from "../lib/machine-credentials.js";
import { MachineAuthError } from "../lib/machine-protocol.js";
import { SERVER_WAIT_PREFIX, clearMachineCooldowns } from "../lib/machine-retry.js";
import { primConfigDirectory } from "../lib/paths.js";
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
  markPrepared?: (origin: "image" | "session") => void;
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
 *
 * Run from inside a session instead, it wires a VM whose Claude Code has
 * already read its settings, and new sessions start from the environment's
 * image, not this VM. It then records that origin and reports that this run
 * did not prepare the image, so neither it nor a later `prim setup --cloud`
 * claims hooks that never loaded.
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
  const origin = prepareOrigin(deps);
  prepareSteps(deps, results, remedies, origin);
  if (origin === "session" && results.prepared === "ok") {
    // This run cannot see the environment's setup script, only that it did
    // not prepare this VM before Claude Code started.
    const reason =
      "image · not prepared by this run: it ran inside a running Claude Code session, so only this VM is wired. Claude Code loads the hooks when it next starts here, and new sessions start from the environment's image. If the environment's setup script does not run `prim setup --cloud --prepare` yet, add it there; sessions started after that load the hooks";
    deps.note(reason);
    remedies.push(reason);
    results.image = "missing";
  }
  finish(deps, "prepare", results, remedies);
}

/**
 * Who is preparing: the environment's setup script, or a command inside a
 * session. Claude Code reads its settings once, when it starts, and the setup
 * script runs before that; anything Claude Code itself started runs after.
 * The exception is a VM the image already prepared: its hooks were wired
 * before Claude Code started, so re-running there leaves them live. Decided
 * before the steps clear the earlier marker.
 */
function prepareOrigin(deps: CloudSetupDependencies): "image" | "session" {
  const env = deps.env ?? process.env;
  if (!insideClaudeCode(env)) return "image";
  const live =
    isPreparedCloudSession(env) &&
    !preparedInSession(env) &&
    (deps.userHooksComplete ?? cloudUserInstallComplete)();
  return live ? "image" : "session";
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
  const outcome: SessionOutcome = {};
  sessionSteps(deps, results, remedies, {}, outcome);
  finish(deps, "session", results, remedies, outcome.optedOut);
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
  // A repository that opts out wants nothing set up, the VM included: an
  // environment left unprepared may be how its owner keeps prim off elsewhere.
  if (
    !isPreparedCloudSession(env) &&
    !(root && hasProjectPrimInstall(root)) &&
    !(root && optsOut(root))
  ) {
    prepareSteps(deps, results, remedies, "session");
    preparedNow = results.prepared === "ok";
  }
  const outcome: SessionOutcome = {};
  sessionSteps(deps, results, remedies, { preparedNow }, outcome);
  finish(deps, "session", results, remedies, outcome.optedOut);
}

/**
 * The repository commits its opt-out and nobody turned this clone on. An
 * activation prim itself wrote down for an implicit opt-in is not that.
 */
function optsOut(root: string): boolean {
  return declaresInactive(root) && !explicitlyActive(root);
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
    attempt("prepared", "cloud activation", () =>
      (deps.markPrepared ?? ((from) => markCloudPrepared(env, from)))(origin),
    );
}

/** What the session steps found beyond each step's own result. */
type SessionOutcome = {
  /** The repository commits its own opt-out and nothing was activated. */
  optedOut?: boolean;
};

/** What each per-session check reads and reports through. */
type SessionCheck = {
  deps: CloudSetupDependencies;
  results: CloudResults;
  remedy: (message: string) => void;
  env: NodeJS.ProcessEnv;
};

/** Whether the session has a credential Primitive accepts. */
function credentialsReady({ deps, results, remedy, env }: SessionCheck): boolean {
  let machine: boolean;
  try {
    machine = hasMachineConfiguration({ env });
  } catch (error) {
    remedy(`credentials · ${error instanceof MachineAuthError ? error.message : String(error)}`);
    results.credentials = "failed";
    return false;
  }
  // A fixed bearer token or a stored sign-in also authenticates prim; only no
  // credential at all is missing. The SessionStart diagnosis asks the same
  // question the same way, so the two never disagree.
  if (!machine && !resolveStoredCredential(env)) {
    // Both hosts are blocked by default, and that fix is made in the same
    // settings: name it now rather than in the next session.
    remedy(
      `credentials · missing: ${CLOUD_CREDENTIALS_REMEDY}; the environment must also allow ${cloudAllowedDomains(undefined, undefined, env).join(" and ")} under Allowed domains (blocked by default)`,
    );
    results.credentials = "missing";
    return false;
  }
  // An explicit check retries now: a cooldown left by an earlier failure would
  // report "cooling down" in place of the cause, or of the fix having worked.
  clearMachineCooldowns(primConfigDirectory({ env }));
  const status = deps.run(["auth", "status", "--json"], true);
  const auth = deps.parseAuthStatus(status);
  if (auth !== "valid") {
    const detail = authFailureDetail(status.stdout);
    remedy(
      auth === "unreachable"
        ? unreachableRemedy(detail, env)
        : machine
          ? `credentials · ${detail ?? "rejected"}${
              // Guidance that already names the replacement needs no second copy.
              detail?.includes("prim auth enroll")
                ? ""
                : "; if the credential itself was revoked, mint a replacement with `prim auth enroll --new-installation` and revoke the old installation in Settings → Developer installations"
            }`
          : // A fixed token or stored sign-in has no installation to revoke.
            `credentials · the sign-in was rejected: ${CLOUD_CREDENTIALS_REMEDY}`,
    );
    results.credentials = "failed";
    return false;
  }
  // A human sign-in the server accepts only for enrolling an installation
  // verifies, yet authorizes nothing else, and a cloud session cannot enroll.
  if (enrollmentRequired(status.stdout)) {
    remedy(
      `credentials · this sign-in can only enroll an installation, which a cloud session cannot do: ${CLOUD_CREDENTIALS_REMEDY}`,
    );
    results.credentials = "failed";
    return false;
  }
  results.credentials = "ok";
  return true;
}

/** The repository to set up, or undefined where there is none to activate. */
function repositoryRoot(
  { deps, results, remedy }: SessionCheck,
  outcome: SessionOutcome,
): string | undefined {
  const root = gitToplevel(deps.cwd);
  if (!root) {
    remedy("repository · not a git repository; run from the cloned repository");
    results.repository = "missing";
    return undefined;
  }
  // The repository's committed opt-out is its answer to a prepared environment
  // (and to this command, which the documented agent prompt runs): leave it
  // off. A clone someone explicitly enabled is theirs to keep on.
  if (optsOut(root)) {
    deps.note(
      "repository · opted out: its .claude/settings.json declares PRIM_ACTIVE=false, so prim stays off here. `prim enable` turns it on for this session's clone; `prim enable --scope project` removes the opt-out",
    );
    results.repository = "ok";
    outcome.optedOut = true;
    return undefined;
  }
  if (!githubRepositoryFullName(root)) {
    remedy(`repository · ${repositoryIdentityRemedy(root)}`);
    results.repository = "missing";
    return undefined;
  }
  return root;
}

/** Whether Claude Code has prim's hooks loaded for this repository. */
function sessionHooks(
  { deps, results, remedy, env }: SessionCheck,
  root: string | undefined,
  options: { preparedNow?: boolean },
): void {
  // Prepared from inside a session (now or by an earlier run in it): the
  // hooks are wired in this VM but Claude Code has not loaded them.
  const pendingHooks = options.preparedNow === true || preparedInSession(env);
  if (
    (root !== undefined && hasProjectPrimInstall(root)) ||
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
      `session hooks · none: run \`prim setup --cloud --prepare\` in the environment's setup script${
        // Outside a repository there is nothing to commit an install to.
        root === undefined
          ? ""
          : ", or commit `prim claude install --scope project` in this repository"
      }`,
    );
    results.session = "missing";
  }
}

/**
 * The per-session steps. Every prerequisite is fixed in the environment's
 * settings (or the repository) and reaches only the next session, so each one
 * that can be judged now is reported together: a user told only about
 * credentials would learn about the setup script a session later.
 */
function sessionSteps(
  deps: CloudSetupDependencies,
  results: CloudResults,
  remedies: string[],
  options: { preparedNow?: boolean } = {},
  outcome: SessionOutcome = {},
): void {
  const remedy = (message: string): void => {
    deps.note(message);
    remedies.push(message);
  };
  const check: SessionCheck = { deps, results, remedy, env: deps.env ?? process.env };
  const credentials = credentialsReady(check);
  const root = repositoryRoot(check, outcome);
  // Whether the environment's image carries the hooks needs no repository; a
  // repository that opts out wants nothing set up, so nothing is judged for it.
  if (!outcome.optedOut) sessionHooks(check, root ?? gitToplevel(deps.cwd) ?? undefined, options);
  if (!credentials || !root) return;

  const step = (key: string, label: string, args: string[]): void => {
    if (label) deps.note(`${label} · installing…`);
    results[key] = deps.run(args).code === 0 ? "ok" : "failed";
    if (results[key] === "failed")
      remedy(`${label || key} · failed; run \`prim ${args.join(" ")}\` to see why`);
  };
  // Preparing in this session already recorded the daemon opt-out.
  if (results.daemon === undefined) step("daemon", "", ["daemon", "stop"]);
  step("hooks", "git hooks", ["hooks", "install"]);
  // An unconnected repository fails here. A machine cannot connect it from
  // the session, and a person's sign-in can only print the link: name the fix
  // either way rather than a command to run for the reason.
  deps.note("activate this repo · installing…");
  const enabled = deps.run(["enable", "--non-interactive"]);
  results.enable = enabled.code === 0 ? "ok" : "failed";
  if (results.enable === "failed") {
    const unconnected = unconnectedRepository(enabled.stdout);
    remedy(
      unconnected
        ? `repository · ${unconnected} is not connected to Primitive: ${
            isCloudMachineSession(deps.env ?? process.env)
              ? CLOUD_GITHUB_CONNECT_REMEDY
              : "run `prim github connect --no-browser` and open the link it prints"
          }`
        : "activate this repo · failed; run `prim enable --non-interactive` to see why",
    );
  }
}

/**
 * Why the credential check could not reach Primitive, said once. A wait the
 * sign-in service asked for is not a network fault, and no setting ends it.
 * Nor does any setting repair the environment's proxy when it is the proxy
 * that is failing: that is relayed as it is, with no word about domains the
 * user may already have allowed. A failure that names the host it could not
 * reach keeps that host, which may not be the default one, and adds the full
 * list instead of repeating the fix. Where the fix is an edit to Allowed
 * domains, the remedy itself says when that edit reaches this session.
 */
function unreachableRemedy(detail: string | undefined, env: NodeJS.ProcessEnv): string {
  if (detail?.startsWith(SERVER_WAIT_PREFIX)) return `credentials · ${detail}`;
  if (detail && CLOUD_PROXY_FAILING.startsWith(detail)) return `credentials · ${detail}`;
  if (detail?.includes("Allowed domains"))
    return `credentials · ${detail}; prim needs ${cloudAllowedDomains(undefined, undefined, env).join(" and ")} allowed`;
  return `credentials · Primitive is unreachable from this environment: ${cloudEgressRemedy(undefined, undefined, env)}${detail ? ` (${detail})` : ""}`;
}

/** The repository `enable --non-interactive` reported as not connected, if that is why it failed. */
function unconnectedRepository(stdout: string): string | undefined {
  try {
    const parsed = JSON.parse(stdout || "{}") as {
      bindingStatus?: unknown;
      repositoryFullName?: unknown;
    };
    return parsed.bindingStatus === "unbound" && typeof parsed.repositoryFullName === "string"
      ? stripControlChars(parsed.repositoryFullName)
      : undefined;
  } catch {
    return undefined;
  }
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
    // A message that points at cloud setup is relayed without the pointer:
    // this is cloud setup.
    return typeof parsed.recoveryDetail === "string"
      ? stripControlChars(parsed.recoveryDetail)
          .replace(CLOUD_SETUP_POINTER, "")
          .replace(/\.$/u, "")
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
  optedOut = false,
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
        : optedOut
          ? "This repository opts out of Primitive (PRIM_ACTIVE=false in its .claude/settings.json), so nothing was activated. Tell the user in one sentence, then continue their task; do not run prim enable unless they ask."
          : "Primitive is set up in this Claude Code cloud session. Tell the user in one sentence, then continue their task. There is no welcome or demo in cloud sessions."
      : "Cloud setup is incomplete. Tell the user each remedy in one sentence before continuing; do not run prim auth login or prim auth enroll, which cannot work in a cloud session.";
  printJson({
    ok: failed.length === 0,
    cloud: mode,
    results,
    failed,
    remedies,
    instructions,
    ...(optedOut ? { optedOut: true } : {}),
  });
  if (failed.length) deps.exit(EXIT_INCOMPLETE);
}
