import { type CliClient, HttpError, type RequestOptions, getClient } from "../client.js";
import { isValidRepoSyncId, setRepoSyncId, setRepositoryBindingState } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";

type BindResponse = { repoSyncId?: unknown };

class InvalidRepositoryBindingResponseError extends Error {}

export type RepositoryBindingResult =
  | { status: "connected"; repoSyncId: string; repositoryFullName: string }
  | { status: "unbound"; repositoryFullName: string };

/** Resolve a binding through one caller-frozen credential/deployment client. */
export async function resolveRepositoryBindingWithClient(
  root: string,
  client: Pick<CliClient, "post">,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  const repositoryFullName = githubRepositoryFullName(root);
  if (!repositoryFullName) {
    throw new Error("origin must be a GitHub HTTPS/SSH remote in owner/name form");
  }
  let response: BindResponse;
  try {
    response = (await client.post(
      "/api/cli/repositories/bind",
      { repositoryFullName },
      options,
    )) as BindResponse;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { status: "unbound", repositoryFullName };
    }
    throw error;
  }
  if (!isValidRepoSyncId(response.repoSyncId)) {
    throw new InvalidRepositoryBindingResponseError(
      "server returned an invalid repository binding",
    );
  }
  return { status: "connected", repoSyncId: response.repoSyncId, repositoryFullName };
}

/** Resolve the active server binding for the checkout's current GitHub origin. */
export async function resolveRepositoryBinding(
  root: string,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  return resolveRepositoryBindingWithClient(root, getClient(), options);
}

/** Persist one server-authoritative binding result in repository-local config. */
export function persistRepositoryBinding(root: string, binding: RepositoryBindingResult): void {
  if (binding.status === "connected") {
    setRepoSyncId(root, binding.repoSyncId);
    setRepositoryBindingState(root, "connected");
    return;
  }
  // A 404 can be a transient server-side binding outage. Retain the last
  // server-issued id so one failed SessionStart does not self-propagate the
  // outage across later hooks; the server still validates the id on use.
  setRepositoryBindingState(root, "unbound");
}

/** Persist the server's result without deleting a previously issued binding on a 404. */
export async function bindRepositoryWithClient(
  root: string,
  client: Pick<CliClient, "post">,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  let binding: RepositoryBindingResult;
  try {
    binding = await resolveRepositoryBindingWithClient(root, client, options);
  } catch (error) {
    if (error instanceof InvalidRepositoryBindingResponseError) {
      try {
        setRepositoryBindingState(root, "invalid");
      } catch {
        // Preserve the protocol error; the next bind/doctor retries diagnosis.
      }
    }
    throw error;
  }
  persistRepositoryBinding(root, binding);
  return binding;
}

/** Persist the server's result using a fresh client for single-request callers. */
export async function bindRepository(
  root: string,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  return bindRepositoryWithClient(root, getClient(), options);
}
