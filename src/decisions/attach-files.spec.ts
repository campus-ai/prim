import { describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import { fetchAttachFiles, formatAttachFilesHuman } from "./attach-files.js";

describe("attach-files", () => {
  it("posts the repository-scoped idempotent attachment contract", async () => {
    const outcome = {
      decisionId: "decision-id",
      shortId: "abc12345",
      files: ["src/a.ts"],
      attachedCount: 0,
    };
    const post = vi.fn().mockResolvedValue(outcome);
    const client = { post, get: vi.fn() } as unknown as CliClient;
    await expect(
      fetchAttachFiles(
        { idOrShortId: "dec_abc12345", files: ["src/a.ts"], repoKey: "repo_v1_key" },
        { getClient: () => client },
      ),
    ).resolves.toEqual(outcome);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/attach-files",
      { idOrShortId: "dec_abc12345", files: ["src/a.ts"], repoKey: "repo_v1_key" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(formatAttachFilesHuman(outcome)).toContain("0 newly attached");
  });
});
