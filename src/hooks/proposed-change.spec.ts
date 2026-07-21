import { describe, expect, it } from "vitest";
import {
  PROPOSED_CHANGE_MAX_BYTES,
  conflictCheckV2Request,
  proposedChangePreview,
  shellMutationUnverifiedObservation,
} from "./proposed-change.js";

describe("proposedChangePreview", () => {
  it("selects the proposed content and scrubs secrets", () => {
    const result = proposedChangePreview(
      "Edit",
      { old_string: "old", new_string: `Bearer ${"a".repeat(40)}` },
      "/tmp",
      "claude_code",
    );
    expect(result.tool).toBe("Edit");
    expect(result.preview).toContain("<REDACTED:bearer-token>");
    expect(result.preview).not.toContain("a".repeat(40));
  });

  it("caps the UTF-8 preview at 6 KiB without a broken character", () => {
    const result = proposedChangePreview(
      "Write",
      { content: "界".repeat(PROPOSED_CHANGE_MAX_BYTES) },
      "/tmp",
      "claude_code",
    );
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.preview, "utf8")).toBeLessThanOrEqual(
      PROPOSED_CHANGE_MAX_BYTES,
    );
    expect(result.preview).not.toContain("�");
  });

  it("keeps adopted Edit content ahead of a large replaced block", () => {
    const result = proposedChangePreview(
      "Edit",
      {
        old_string: "old implementation ".repeat(1000),
        new_string: "replace IORegistry with the ioreg subprocess",
      },
      "/tmp",
      "claude_code",
    );
    expect(result.truncated).toBe(true);
    expect(result.preview).toContain("replace IORegistry with the ioreg subprocess");
  });

  it("marks wholesale oversized redaction as a partial preview", () => {
    for (const [tool, input] of [
      ["Write", { content: "x".repeat(300_000) }],
      ["Bash", { command: "x".repeat(300_000) }],
    ] as const) {
      const result = proposedChangePreview(tool, input, "/tmp", "claude_code");
      expect(result.preview).toContain("<REDACTED:oversized>");
      expect(result.truncated).toBe(true);
    }
  });

  it("uses the command text for Bash without executing it", () => {
    expect(
      proposedChangePreview("Bash", { command: "printf x > src/a.ts" }, "/tmp", "claude_code"),
    ).toEqual({
      tool: "Bash",
      preview: "printf x > src/a.ts",
      truncated: false,
    });
  });

  it("includes NotebookEdit cell metadata and new source", () => {
    const result = proposedChangePreview(
      "NotebookEdit",
      {
        notebook_path: "notebooks/model.ipynb",
        cell_id: "cell-1",
        cell_type: "code",
        edit_mode: "replace",
        new_source: "print('new')",
      },
      "/tmp",
      "claude_code",
    );
    expect(JSON.parse(result.preview)).toEqual({
      cell_id: "cell-1",
      cell_type: "code",
      edit_mode: "replace",
      new_source: "print('new')",
    });
  });
});

describe("conflictCheckV2Request", () => {
  it("pins the semantic preflight wire contract", () => {
    const proposedChange = { tool: "Edit", preview: "-a\n+b", truncated: false };
    expect(conflictCheckV2Request("src/a.ts", "repo_v1_key", proposedChange)).toEqual({
      protocolVersion: 2,
      file: "src/a.ts",
      repoKey: "repo_v1_key",
      proposedChange,
    });
  });
});

describe("shellMutationUnverifiedObservation", () => {
  it("contains only privacy-safe preflight metadata", () => {
    expect(shellMutationUnverifiedObservation("repo_v1_key")).toEqual({
      protocolVersion: 2,
      outcome: "unverified",
      reasonCode: "shell_mutation_unverified",
      tool: "Bash",
      repoKey: "repo_v1_key",
    });
    expect(shellMutationUnverifiedObservation(undefined)).toEqual({
      protocolVersion: 2,
      outcome: "unverified",
      reasonCode: "shell_mutation_unverified",
      tool: "Bash",
    });
  });
});
