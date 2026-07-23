import { type RequestOptions, getClient } from "../client.js";
import { setRepoSyncId } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";

type BindResponse = { repoSyncId?: unknown };

export async function bindRepository(
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
  if (typeof response.repoSyncId !== "string" || response.repoSyncId.length === 0) {
    throw new Error("server returned no repository binding");
  }
  setRepoSyncId(root, response.repoSyncId);
  return { repoSyncId: response.repoSyncId, repositoryFullName };
}
