import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/activation.js", () => ({ repoSyncId: () => undefined }));
vi.mock("../lib/git.js", () => ({
  canonicalGitRoot: () => "/repo",
  canonicalRepositoryPath: (file: string) => ({ ok: true, file }),
  currentBranch: () => "main",
}));

import { checkAffectedDecisions } from "./decisions-check.js";

afterEach(() => vi.unstubAllEnvs());

describe("checkAffectedDecisions on an unbound checkout", () => {
  it("names `prim enable` on a developer machine", async () => {
    await expect(checkAffectedDecisions(["README.md"])).resolves.toMatchObject({
      unavailable: "this checkout has no current Primitive repository binding; run prim enable",
    });
  });

  it("points a cloud session at cloud setup: enable cannot fix credentials or a blocked host", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const result = await checkAffectedDecisions(["README.md"]);
    expect(result.unavailable).toBe(
      "this checkout has no current Primitive repository binding; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
    );
  });
});
