/**
 * `prim github connect` — retry the authenticated Primitive binding for the
 * current checkout's GitHub origin.
 *
 * This is deliberately narrower than GitHub App installation. The existing
 * repository-bind endpoint can confirm access already granted to Primitive;
 * it cannot create or expand provider access. AX contract: one truthful
 * verdict on STDERR, the exact connected/unbound result on STDOUT, and no
 * activation, hook, browser, or installation side effect.
 */

import type { Command } from "commander";
import { HttpError } from "../client.js";
import { boundedHealthError } from "../lib/ansi.js";
import { gitToplevel } from "../lib/git.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import { printJson } from "../output.js";

const BIND_TIMEOUT_MS = 10_000;
const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_UNBOUND = 2;

export type GithubConnectDependencies = {
  cwd: () => string;
  gitToplevel: typeof gitToplevel;
  bindRepository: typeof bindRepository;
};

const defaultDependencies: GithubConnectDependencies = {
  cwd: () => process.cwd(),
  gitToplevel,
  bindRepository,
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

function reportBinding(binding: RepositoryBindingResult): void {
  if (binding.status === "connected") {
    process.stderr.write(
      `[prim] repository binding connected for GitHub origin ${binding.repositoryFullName}\n`,
    );
    printJson(binding);
    process.exitCode = EXIT_OK;
    return;
  }

  process.stderr.write(
    `[prim] repository binding unbound for GitHub origin ${binding.repositoryFullName}; no GitHub App installation or access was changed\n`,
  );
  printJson(binding);
  process.exitCode = EXIT_UNBOUND;
}

export async function performGithubConnect(
  dependencies: GithubConnectDependencies = defaultDependencies,
): Promise<void> {
  const root = dependencies.gitToplevel(dependencies.cwd());
  if (!root) {
    reportConnectFailure(
      new Error("not a git repository — run `prim github connect` inside a GitHub repository"),
    );
    return;
  }

  try {
    const binding = await dependencies.bindRepository(root, {
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    reportBinding(binding);
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
    .description(
      "Bind the current GitHub origin using existing access; does not install or change GitHub App access",
    )
    .action(async () => {
      await performGithubConnect(dependencies);
    });
}
