/**
 * `prim decisions create` — formatter coverage and the fetch contract.
 *
 * Formatters: the created-identity human line (dec_ short form and the
 * full-id fallback) and the verbatim JSON. fetchCreate: it POSTs to
 * /api/cli/decisions/create with a body pruned to only the fields the
 * author set (undefined and empty arrays dropped), returns the server's
 * identity, and propagates a domain error untouched for the command to
 * map to an exit code.
 */

import { describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import { type CreateOutcome, fetchCreate, formatCreateHuman, formatCreateJson } from "./create.js";

const FULL_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const SHORT_ID = "abc12345";

const OUTCOME: CreateOutcome = {
  decisionId: FULL_ID,
  shortId: SHORT_ID,
  createdAt: 1_700_000_000_000,
};

function clientWith(post: CliClient["post"]): CliClient {
  return {
    post,
    get: () => {
      throw new Error("unexpected GET call");
    },
  };
}

describe("formatCreateHuman", () => {
  it("renders the dec_ short form", () => {
    expect(formatCreateHuman(OUTCOME)).toBe(`[prim] created dec_${SHORT_ID}.`);
  });

  it("falls back to the full id when the server returned no shortId", () => {
    expect(formatCreateHuman({ decisionId: FULL_ID, createdAt: 1 })).toBe(
      `[prim] created ${FULL_ID}.`,
    );
  });
});

describe("formatCreateJson", () => {
  it("emits the created identity verbatim", () => {
    expect(formatCreateJson(OUTCOME)).toBe(JSON.stringify(OUTCOME, null, 2));
  });
});

describe("fetchCreate", () => {
  it("posts only the fields the author set, pruning undefined and empty arrays", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    await fetchCreate(
      {
        intent: "Adopt prosemirror-collab over Yjs",
        attribution: "agent",
        decided: [],
        alternatives: ["Yjs", "Automerge"],
        confidence: "high",
        files: ["src/editor.ts"],
        protocolVersion: 3,
        repoSyncId: "sync-1",
        stageOverride: "draft",
      },
      { getClient: () => clientWith(post) },
    );
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/create",
      {
        intent: "Adopt prosemirror-collab over Yjs",
        attribution: "agent",
        alternatives: ["Yjs", "Automerge"],
        confidence: "high",
        files: ["src/editor.ts"],
        protocolVersion: 3,
        repoSyncId: "sync-1",
        stageOverride: "draft",
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("always posts intent and attribution when nothing else is set", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    await fetchCreate(
      { intent: "Use X", attribution: "user", decided: [], alternatives: [] },
      { getClient: () => clientWith(post) },
    );
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/create",
      { intent: "Use X", attribution: "user" },
      expect.anything(),
    );
  });

  it("returns the created identity from the server", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    const result = await fetchCreate(
      { intent: "Use X", attribution: "user" },
      { getClient: () => clientWith(post) },
    );
    expect(result).toEqual(OUTCOME);
  });

  it("propagates a domain error untouched", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new HttpError(403, "CLI token is not bound to an organization"));
    await expect(
      fetchCreate({ intent: "Use X", attribution: "agent" }, { getClient: () => clientWith(post) }),
    ).rejects.toThrow("not bound to an organization");
  });
});
