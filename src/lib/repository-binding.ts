import { type RequestOptions, getClient } from "../client.js";
import { isValidRepoSyncId, setRepoSyncId } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";

type BindResponse = { repoSyncId?: unknown };

/** Resolve the active server binding for the checkout's current GitHub origin. */
export async function resolveRepositoryBinding(
  root: string,
  options?: RequestOptions,
): Promise<{ repoSyncId: string; repositoryFullName: string }> {
  const repositoryFullName = githubRepositoryFullName(root);
  if (!repositoryFullName) {
    throw new Error("origin must be a GitHub HTTPS/SSH remote in owner/name form");
  }
  const response = (await getClient().post(
    "/api/cli/repositories/bind",
    { repositoryFullName },
    options,
  )) as BindResponse;
  if (!isValidRepoSyncId(response.repoSyncId)) {
    throw new Error("server returned no repository binding");
  }
  return { repoSyncId: response.repoSyncId, repositoryFullName };
}

/** Bind a GitHub checkout and persist only the opaque id returned by Prim. */
export async function bindRepository(
  root: string,
  options?: RequestOptions,
): Promise<{ repoSyncId: string; repositoryFullName: string }> {
  const binding = await resolveRepositoryBinding(root, options);
  setRepoSyncId(root, binding.repoSyncId);
  return binding;
}
