/**
 * `prim enable` / `prim disable` — activate or mute prim in the current repo.
 *
 * The user-scope git hooks (a global core.hooksPath) fire everywhere but only
 * act where `prim.active` is true. These commands set that repo-local flag, so
 * a user installs prim once and opts each repo in (or out) with one command —
 * no per-repo hook wiring. AX: STDOUT is the JSON result, STDERR the human line.
 */
import type { Command } from "commander";
import { getClient } from "../client.js";
import { setRepoActive, setRepoSyncId } from "../lib/activation.js";
import { gitToplevel, githubRepositoryFullName } from "../lib/git.js";
import { printJson } from "../output.js";

type BindResponse = { repoSyncId?: unknown };

async function applyActivation(active: boolean): Promise<void> {
  const root = gitToplevel();
  if (!root) {
    process.stderr.write(
      `[prim] not a git repository — run \`prim ${active ? "enable" : "disable"}\` inside a repo\n`,
    );
    process.exit(1);
  }
  try {
    let bound: { repoSyncId: string; repositoryFullName: string } | undefined;
    if (active) {
      const repositoryFullName = githubRepositoryFullName(root);
      if (!repositoryFullName) {
        throw new Error("origin must be a GitHub HTTPS/SSH remote in owner/name form");
      }
      const response = (await getClient().post("/api/cli/repositories/bind", {
        repositoryFullName,
      })) as BindResponse;
      if (typeof response.repoSyncId !== "string" || response.repoSyncId.length === 0) {
        throw new Error("server returned no repository binding");
      }
      setRepoSyncId(root, response.repoSyncId);
      bound = { repoSyncId: response.repoSyncId, repositoryFullName };
    }
    setRepoActive(root, active);
    process.stderr.write(`[prim] prim ${active ? "enabled" : "disabled"} in ${root}\n`);
    printJson({ active, repo: root, ...bound });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[prim] failed to ${active ? "bind and enable" : "disable"} prim: ${detail}\n`,
    );
    process.exit(1);
  }
}

export function registerActivationCommands(program: Command): void {
  program
    .command("enable")
    .description("Activate prim's hooks in this repo (git config prim.active=true)")
    .action(() => applyActivation(true));

  program
    .command("disable")
    .description("Mute prim's hooks in this repo (git config prim.active=false)")
    .action(() => applyActivation(false));
}
