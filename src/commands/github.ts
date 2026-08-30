/**
 * `prim github connect` — bind the current checkout's GitHub origin, issuing a
 * server-owned GitHub App install intent when existing access is insufficient.
 */

import type { Command } from "commander";
import { type CliClient, HttpError, getPinnedClient } from "../client.js";
import { boundedHealthError } from "../lib/ansi.js";
import { gitToplevel } from "../lib/git.js";
import {
  type GitHubInstallIntentStart,
  type GitHubInstallIntentStatus,
  createGitHubInstallIntent,
  pollGitHubInstallIntent,
} from "../lib/github-install-intent.js";
import {
  type RepositoryBindingResult,
  bindRepositoryWithClient,
} from "../lib/repository-binding.js";
import { printJson } from "../output.js";
import { openBrowser } from "./auth.js";

const BIND_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 10_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_UNBOUND = 2;

export type GithubConnectDependencies = {
  cwd: () => string;
  gitToplevel: typeof gitToplevel;
  bindRepositoryWithClient: typeof bindRepositoryWithClient;
  getPinnedClient: typeof getPinnedClient;
  createInstallIntent: typeof createGitHubInstallIntent;
  pollInstallIntent: typeof pollGitHubInstallIntent;
  openBrowser: typeof openBrowser;
  now: () => number;
};

const defaultDependencies: GithubConnectDependencies = {
  cwd: () => process.cwd(),
  gitToplevel,
  bindRepositoryWithClient,
  getPinnedClient,
  createInstallIntent: createGitHubInstallIntent,
  pollInstallIntent: pollGitHubInstallIntent,
  openBrowser,
  now: Date.now,
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportConnectFailure(error: unknown): void {
  const message = errorMessage(error);
  const human = boundedHealthError(message) ?? "unknown error";
  process.stderr.write(`[prim] github connect failed: ${human}\n`);
  printJson({
    status: "error",
    error: message,
    ...(error instanceof HttpError ? { httpStatus: error.status } : {}),
  });
  process.exitCode = EXIT_FAILURE;
}

function reportBinding(binding: RepositoryBindingResult, installAttempted = false): void {
  if (binding.status === "connected") {
    process.stderr.write(
      `[prim] repository binding connected for GitHub origin ${binding.repositoryFullName}\n`,
    );
    printJson(binding);
    process.exitCode = EXIT_OK;
    return;
  }

  process.stderr.write(
    installAttempted
      ? `[prim] GitHub installation completed, but ${binding.repositoryFullName} was not granted admin access; repository binding remains unbound\n`
      : `[prim] repository binding unbound for GitHub origin ${binding.repositoryFullName}; starting GitHub App installation\n`,
  );
  printJson(binding);
  process.exitCode = EXIT_UNBOUND;
}

function terminalInstallError(status: GitHubInstallIntentStatus): Error {
  if (status.status === "failed_terminal") {
    return new Error(`GitHub installation failed: ${status.failureCode}`);
  }
  return new Error(`GitHub installation ${status.status}`);
}

async function completeInstallIntent(
  client: CliClient,
  start: GitHubInstallIntentStart,
  dependencies: GithubConnectDependencies,
  browser: boolean,
): Promise<GitHubInstallIntentStatus> {
  process.stderr.write(`[prim] complete GitHub App installation at:\n${start.browserUrl}\n`);
  if (browser) dependencies.openBrowser(start.browserUrl);
  return dependencies.pollInstallIntent(client, start, {
    now: dependencies.now,
  });
}

export async function performGithubConnect(
  dependencies: GithubConnectDependencies = defaultDependencies,
  options: { browser?: boolean } = {},
): Promise<void> {
  const root = dependencies.gitToplevel(dependencies.cwd());
  if (!root) {
    reportConnectFailure(
      new Error("not a git repository — run `prim github connect` inside a GitHub repository"),
    );
    return;
  }

  try {
    const client = await dependencies.getPinnedClient({
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    const existing = await dependencies.bindRepositoryWithClient(root, client, {
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    if (existing.status === "connected") {
      reportBinding(existing);
      return;
    }

    const start = await dependencies.createInstallIntent(client, {
      signal: AbortSignal.timeout(START_TIMEOUT_MS),
      now: dependencies.now,
    });
    const status = await completeInstallIntent(
      client,
      start,
      dependencies,
      options.browser ?? true,
    );
    if (status.status !== "consumed") throw terminalInstallError(status);
    process.stderr.write(
      `[prim] GitHub installation verified: ${status.adminRepositoryCount} admin repositories (${status.repositoryCount} total)\n`,
    );
    const binding = await dependencies.bindRepositoryWithClient(root, client, {
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    reportBinding(binding, true);
  } catch (error) {
    reportConnectFailure(error);
  }
}

export function registerGithubCommands(
  program: Command,
  dependencies: GithubConnectDependencies = defaultDependencies,
): void {
  const github = program.command("github").description("Manage GitHub repository bindings");

  github
    .command("connect")
    .description("Install or reuse the Primitive GitHub App and bind the current GitHub origin")
    .option("--no-browser", "Print the GitHub installation URL without opening a browser")
    .action(async (options: { browser: boolean }, command: Command) => {
      const globals = command.optsWithGlobals() as { nonInteractive?: boolean };
      await performGithubConnect(dependencies, {
        browser: options.browser && globals.nonInteractive !== true,
      });
    });
}
