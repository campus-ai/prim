import { type CliClient, getClient } from "../client.js";

export type AttachFilesRequest = {
  idOrShortId: string;
  files: string[];
  repoKey: string;
};

export type AttachFilesOutcome = {
  decisionId: string;
  shortId?: string;
  files: string[];
  attachedCount: number;
  alreadyAttachedCount?: number;
};

export const ATTACH_FILES_TIMEOUT_MS = 10_000;

export async function fetchAttachFiles(
  request: AttachFilesRequest,
  deps: { getClient: () => CliClient } = { getClient },
): Promise<AttachFilesOutcome> {
  return (await deps.getClient().post("/api/cli/decisions/attach-files", request, {
    signal: AbortSignal.timeout(ATTACH_FILES_TIMEOUT_MS),
  })) as AttachFilesOutcome;
}

export function formatAttachFilesHuman(outcome: AttachFilesOutcome): string {
  const id = outcome.shortId ? `dec_${outcome.shortId}` : outcome.decisionId;
  return `[prim] ${id} is code-scoped to ${String(outcome.files.length)} file(s) (${String(outcome.attachedCount)} newly attached).`;
}
