import { HttpError, type RequestOptions, getClient } from "../client.js";
import { clearRepoSyncId, isValidRepoSyncId, setRepoSyncId } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";

type BindResponse = { repoSyncId?: unknown };

export type RepositoryBindingResult =
  | { status: "connected"; repoSyncId: string; repositoryFullName: string }
  | { status: "pending"; repositoryFullName: string };

/** Resolve the active server binding for the checkout's current GitHub origin. */
export async function resolveRepositoryBinding(
  root: string,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  const repositoryFullName = githubRepositoryFullName(root);
  if (!repositoryFullName) {
    throw new Error("origin must be a GitHub HTTPS/SSH remote in owner/name form");
  }
  let response: BindResponse;
  try {
    response = (await getClient().post(
      "/api/cli/repositories/bind",
      { repositoryFullName },
      options,
    )) as BindResponse;
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return { status: "pending", repositoryFullName };
    }
    throw error;
  }
  if (!isValidRepoSyncId(response.repoSyncId)) {
    throw new Error("server returned no repository binding");
  }
  return { status: "connected", repoSyncId: response.repoSyncId, repositoryFullName };
}

/** Persist a connected binding, or clear a stale id while connection is pending. */
export async function bindRepository(
  root: string,
  options?: RequestOptions,
): Promise<RepositoryBindingResult> {
  const binding = await resolveRepositoryBinding(root, options);
  if (binding.status === "connected") {
    setRepoSyncId(root, binding.repoSyncId);
  } else {
    clearRepoSyncId(root);
  }
  return binding;
}
