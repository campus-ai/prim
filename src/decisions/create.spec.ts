/**
 * `prim decisions create` — formatter coverage and the fetch contract.
 *
 * Formatters: the created-identity human line (intent + web URL) and the
 * JSON (verbatim plus webUrl). fetchCreate: it POSTs to
 * /api/cli/decisions/create with a body pruned to only the fields the
 * author set (undefined and empty arrays dropped), returns the server's
 * identity, and propagates a domain error untouched for the command to
 * map to an exit code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import {
  type CreateOutcome,
  createScopeWarnings,
  fetchCreate,
  formatCreateHuman,
  formatCreateJson,
} from "./create.js";

const FULL_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const SHORT_ID = "abc12345";
const WEB_URL = `https://app.getprimitive.ai/decisions/${FULL_ID}`;

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
  // Plain STDERR lines (no OSC 8), as an agent's Bash tool sees them; the
  // terminal variants are covered once in decision-url.spec.ts.
  beforeEach(() => vi.stubEnv("NO_COLOR", "1"));
  afterEach(() => vi.unstubAllEnvs());

  it("leads with the intent and its web URL, without the dec_ handle", () => {
    expect(formatCreateHuman(OUTCOME, "Adopt X over Y")).toBe(
      `[prim] created "Adopt X over Y" → ${WEB_URL}.`,
    );
  });

  it("sanitizes the intent before terminal rendering", () => {
    const esc = String.fromCharCode(0x1b);
    const out = formatCreateHuman(OUTCOME, `Adopt\nX${esc}[2J\u202e`);
    expect(out).toContain('"Adopt X[2J"');
    expect(out).not.toContain(esc);
    expect(out).not.toContain("\u202e");
  });
});

describe("formatCreateJson", () => {
  it("emits the created identity verbatim plus the additive webUrl", () => {
    expect(formatCreateJson(OUTCOME)).toBe(
      JSON.stringify({ ...OUTCOME, webUrl: WEB_URL }, null, 2),
    );
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

  it("posts coarse location scope selectors without dropping them", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    await fetchCreate(
      {
        intent: "Govern API changes",
        attribution: "user",
        scope: {
          location: {
            repository: true,
            directories: ["packages/api"],
            globs: ["src/**/*.ts"],
            branches: ["main"],
          },
        },
      },
      { getClient: () => clientWith(post) },
    );

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/create",
      {
        intent: "Govern API changes",
        attribution: "user",
        scope: {
          location: {
            repository: true,
            directories: ["packages/api"],
            globs: ["src/**/*.ts"],
            branches: ["main"],
          },
        },
      },
      expect.anything(),
    );
  });

  it("posts a time scope without requiring repository-only create fields", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    await fetchCreate(
      {
        intent: "Freeze the public API during the migration",
        attribution: "user",
        scope: {
          time: { effectiveFrom: 1_789_072_496_789, effectiveUntil: 1_789_158_896_789 },
        },
      },
      { getClient: () => clientWith(post) },
    );

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/create",
      {
        intent: "Freeze the public API during the migration",
        attribution: "user",
        scope: {
          time: { effectiveFrom: 1_789_072_496_789, effectiveUntil: 1_789_158_896_789 },
        },
      },
      expect.anything(),
    );
  });

  it("posts canonical audience selectors alongside other scope dimensions", async () => {
    const post = vi.fn().mockResolvedValue(OUTCOME);
    await fetchCreate(
      {
        intent: "Use the service token only for deployment decisions",
        attribution: "user",
        scope: {
          time: { effectiveFrom: 1_789_072_496_789 },
          users: [
            { kind: "user", userId: "user-1" },
            { kind: "role", role: "admin" },
            { kind: "agent", agent: "codex" },
            { kind: "credential", credential: "service_token" },
          ],
        },
      },
      { getClient: () => clientWith(post) },
    );

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/create",
      {
        intent: "Use the service token only for deployment decisions",
        attribution: "user",
        scope: {
          time: { effectiveFrom: 1_789_072_496_789 },
          users: [
            { kind: "user", userId: "user-1" },
            { kind: "role", role: "admin" },
            { kind: "agent", agent: "codex" },
            { kind: "credential", credential: "service_token" },
          ],
        },
      },
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

describe("createScopeWarnings", () => {
  it("surfaces server scope warnings and detects an old response that omits scope", () => {
    const request = {
      intent: "Govern API changes",
      attribution: "user" as const,
      scope: { location: { directories: ["packages/api"] } },
    };

    expect(
      createScopeWarnings(request, { ...OUTCOME, scopeWarnings: ["invalid glob removed"] }),
    ).toEqual([
      "invalid glob removed",
      "the server did not confirm this Decision scope; upgrade Primitive and retry",
    ]);
  });

  it("does not invent an old-server warning when scope was confirmed", () => {
    expect(
      createScopeWarnings(
        {
          intent: "Govern API changes",
          attribution: "user",
          scope: { location: { repository: true } },
        },
        {
          ...OUTCOME,
          scope: {
            location: { repository: true, directories: [], globs: [], branches: [] },
            time: {},
            users: [],
          },
        },
      ),
    ).toEqual([]);
  });
});
