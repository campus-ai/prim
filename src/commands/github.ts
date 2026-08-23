import type { Command, OptionValues } from "commander";
import { type CliClient, getPinnedClient } from "../client.js";
import { isNonInteractive } from "../lib/confirmation.js";
import { gitToplevel } from "../lib/git.js";
import {
  type RepositoryBindingResult,
  persistRepositoryBinding,
  resolveRepositoryBindingWithClient,
} from "../lib/repository-binding.js";
import { stripControlChars } from "../lib/terminal-safe.js";
import { printJson } from "../output.js";
import { openBrowser } from "./auth.js";

const GITHUB_INSTALL_INTENT_PATH = "/github/install-intents/start";
const GITHUB_APP_INSTALL_URL = "https://github.com/apps/primitive/installations/new";
const INSTALL_STATE_RE = /^[0-9a-f]{64}$/u;
const MAX_WAIT_MS = 15 * 60 * 1000;
const POLL_INTERVAL_MS = 1500;
const REQUEST_TIMEOUT_MS = 10_000;

type GitHubInstallStart = {
  mode: "install_intent_v1";
  state: string;
  expiresAt: number;
};

export type GitHubConnectResult = {
  connected: true;
  status: "already_connected" | "connected";
  repositoryFullName: string;
  repoSyncId: string;
};

export type GitHubConnectDependencies = {
  cwd: () => string;
  now: () => number;
  client: () => Promise<CliClient>;
  open: (url: string) => void;
  sleep: (milliseconds: number) => Promise<void>;
  writeStatus: (message: string) => void;
};

const DEFAULT_DEPENDENCIES: GitHubConnectDependencies = {
  cwd: () => process.cwd(),
  now: Date.now,
  client: getPinnedClient,
  open: openBrowser,
  sleep: (milliseconds) =>
    new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    }),
  writeStatus: (message) => process.stderr.write(`${message}\n`),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseGitHubInstallStart(value: unknown, now: number): GitHubInstallStart {
  if (!isRecord(value)) {
    throw new Error("GitHub connection returned an invalid response");
  }
  if (value.mode === "legacy_bridge") {
    throw new Error(
      "Proof-backed GitHub connection is not enabled on this deployment; use Primitive Settings until the server upgrade is complete",
    );
  }
  if (
    value.mode !== "install_intent_v1" ||
    typeof value.state !== "string" ||
    !INSTALL_STATE_RE.test(value.state) ||
    typeof value.expiresAt !== "number" ||
    !Number.isSafeInteger(value.expiresAt) ||
    value.expiresAt <= now
  ) {
    throw new Error("GitHub connection returned an invalid response");
  }
  return {
    mode: "install_intent_v1",
    state: value.state,
    expiresAt: value.expiresAt,
  };
}

export function githubAppInstallUrl(state: string): string {
  if (!INSTALL_STATE_RE.test(state)) {
    throw new Error("GitHub install state is invalid");
  }
  const url = new URL(GITHUB_APP_INSTALL_URL);
  url.searchParams.set("state", state);
  return url.toString();
}

function requestSignal(remainingMs: number): AbortSignal {
  return AbortSignal.timeout(Math.max(1, Math.min(REQUEST_TIMEOUT_MS, remainingMs)));
}

/**
 * Connect the current checkout through one credential/deployment generation.
 * The browser callback commits the server intent; this process only polls the
 * existing authoritative repository-binding endpoint and persists its result.
 */
export async function connectGitHubRepository(
  options: { browser: boolean; nonInteractive: boolean },
  dependencies: GitHubConnectDependencies = DEFAULT_DEPENDENCIES,
): Promise<GitHubConnectResult> {
  const root = gitToplevel(dependencies.cwd());
  if (!root) {
    throw new Error("run `prim github connect` inside a Git repository");
  }
  const client = await dependencies.client();
  const initial = await resolveRepositoryBindingWithClient(root, client, {
    signal: requestSignal(REQUEST_TIMEOUT_MS),
  });
  if (initial.status === "connected") {
    persistRepositoryBinding(root, initial);
    return {
      connected: true,
      status: "already_connected",
      repositoryFullName: initial.repositoryFullName,
      repoSyncId: initial.repoSyncId,
    };
  }

  const issuedAt = dependencies.now();
  const start = parseGitHubInstallStart(
    await client.post(GITHUB_INSTALL_INTENT_PATH, undefined, {
      signal: requestSignal(REQUEST_TIMEOUT_MS),
    }),
    issuedAt,
  );
  const installUrl = githubAppInstallUrl(start.state);
  dependencies.writeStatus(`Connect ${initial.repositoryFullName} at:\n${installUrl}`);
  if (options.browser && !options.nonInteractive) {
    dependencies.open(installUrl);
  }
  dependencies.writeStatus("Waiting for GitHub authorization and repository binding...");

  const deadline = Math.min(start.expiresAt, issuedAt + MAX_WAIT_MS);
  while (dependencies.now() < deadline) {
    const remainingMs = deadline - dependencies.now();
    const binding = await resolveRepositoryBindingWithClient(root, client, {
      signal: requestSignal(remainingMs),
    });
    if (binding.status === "connected") {
      persistRepositoryBinding(root, binding);
      return {
        connected: true,
        status: "connected",
        repositoryFullName: binding.repositoryFullName,
        repoSyncId: binding.repoSyncId,
      };
    }
    await dependencies.sleep(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  throw new Error(
    `GitHub connection timed out for ${initial.repositoryFullName}; rerun \`prim github connect\` to issue a new install link`,
  );
}

function reportGitHubConnectFailure(error: unknown): void {
  const detail = stripControlChars(error instanceof Error ? error.message : String(error));
  process.stderr.write(`[prim] GitHub connection failed: ${detail}\n`);
  printJson({ connected: false, error: "github_connect_failed" });
  process.exitCode = 1;
}

export function registerGitHubCommands(program: Command): void {
  const github = program.command("github").description("Manage GitHub repository connections");
  github
    .command("connect")
    .description("Connect the current GitHub repository to Primitive")
    .option("--no-browser", "Print the install URL without opening a browser")
    .action(async (options: { browser: boolean }, command: Command) => {
      try {
        const globals: OptionValues = command.optsWithGlobals();
        const result = await connectGitHubRepository({
          browser: options.browser,
          nonInteractive: isNonInteractive(globals),
        });
        process.stderr.write(
          result.status === "already_connected"
            ? `[prim] ${result.repositoryFullName} is already connected\n`
            : `[prim] connected ${result.repositoryFullName}\n`,
        );
        printJson(result);
        process.exitCode = 0;
      } catch (error) {
        reportGitHubConnectFailure(error);
      }
    });
}
