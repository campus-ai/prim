import { canonicalRepositoryPath, resolveRepositoryContext } from "../lib/git.js";

export class DecisionFileScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionFileScopeError";
  }
}

export type DecisionFileScope = { files: string[]; repoKey: string };

/** Validate explicit Decision scope against the current repository identity. */
export function resolveDecisionFileScope(
  files: string[],
  cwd: string = process.cwd(),
): DecisionFileScope {
  const repository = resolveRepositoryContext(cwd);
  if (!repository) {
    throw new DecisionFileScopeError("file scope requires a Git repository");
  }
  if (!repository.repoKey) {
    throw new DecisionFileScopeError(
      "repository identity unavailable (configure origin or create the first commit)",
    );
  }
  const canonical = new Set<string>();
  for (const path of files) {
    // `--files` is explicitly git-root-relative. Absolute inputs are accepted
    // only when they resolve inside this same root.
    const result = canonicalRepositoryPath(path, repository, repository.repoRoot);
    if (!result.ok) {
      throw new DecisionFileScopeError(
        result.reason === "outside_repository"
          ? `file is outside the current repository: ${path}`
          : `invalid repository file path: ${path}`,
      );
    }
    canonical.add(result.file);
  }
  if (canonical.size === 0) throw new DecisionFileScopeError("at least one file is required");
  return { files: [...canonical], repoKey: repository.repoKey };
}
