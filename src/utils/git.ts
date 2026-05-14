import { execSync } from "node:child_process";

export interface GitContext {
  branch: string | null;
  sha: string | null;
  repoFullName: string | null;
  prNumber: number | null;
}

function safeExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function parseRepoFullName(remoteUrl: string): string | null {
  const match = remoteUrl.match(/(?:github\.com[:/])([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function getGitContext(): GitContext {
  const branchRaw = safeExec("git rev-parse --abbrev-ref HEAD");
  const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : null;

  const sha = safeExec("git rev-parse HEAD");

  const remoteUrl = safeExec("git remote get-url origin");
  const repoFullName = remoteUrl ? parseRepoFullName(remoteUrl) : null;

  let prNumber: number | null = null;
  if (safeExec("command -v gh")) {
    const raw = safeExec("gh pr view --json number -q .number");
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    if (Number.isFinite(n)) prNumber = n;
  }

  return { branch, sha, repoFullName, prNumber };
}
