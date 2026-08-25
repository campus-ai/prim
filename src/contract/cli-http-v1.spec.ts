import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedOutputs } from "../../scripts/generate-cli-contract.mjs";
import {
  isCliErrorResponse,
  isDecisionsRecentResponse,
  isDecisionsRecentResponseStructure,
  isDurableMoveIngestResponse,
  isFeedbackAckRequest,
  isFeedbackAckRequestStructure,
  isFeedbackAckResponse,
  isFeedbackAckResponseStructure,
  isFeedbackLeaseRequest,
  isFeedbackLeaseResponse,
  isFeedbackLeaseResponseStructure,
  isMoveIngestRequest,
  isPreflightRequestV3,
  isPreflightRequestV3Structure,
  isRepositoryBindRequest,
} from "./cli-http-v1.js";

const WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";

function artifactFixture(): {
  artifact: Record<string, unknown>;
  fixtures: Record<string, unknown>;
  lock: Record<string, unknown>;
} {
  return {
    artifact: JSON.parse(
      readFileSync(resolve("contracts/cli-http-v1.schema.json"), "utf8"),
    ) as Record<string, unknown>,
    fixtures: JSON.parse(
      readFileSync(resolve("contracts/cli-http-v1.fixtures.json"), "utf8"),
    ) as Record<string, unknown>,
    lock: JSON.parse(readFileSync(resolve("contracts/cli-http-v1.lock.json"), "utf8")) as Record<
      string,
      unknown
    >,
  };
}

function generatedInput(
  artifact: Record<string, unknown>,
  fixtures: Record<string, unknown>,
  lock: Record<string, unknown>,
): [Buffer, Buffer, Buffer] {
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  const fixtureBytes = Buffer.from(`${JSON.stringify(fixtures, null, 2)}\n`);
  return [
    artifactBytes,
    fixtureBytes,
    Buffer.from(
      `${JSON.stringify({
        ...lock,
        artifacts: {
          ...(lock.artifacts as Record<string, unknown>),
          schema: {
            ...((lock.artifacts as Record<string, Record<string, unknown>>).schema ?? {}),
            sha256: createHash("sha256").update(artifactBytes).digest("hex"),
          },
          fixtures: {
            ...((lock.artifacts as Record<string, Record<string, unknown>>).fixtures ?? {}),
            sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
          },
        },
      })}\n`,
    ),
  ];
}

function preflight(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 3,
    agent: "claude_code",
    sessionId: "session-1",
    invocationId: "call-1",
    repoSyncId: "abc123",
    paths: ["src/index.ts"],
    coverage: "complete",
    clientMode: "block",
    clientVersion: "0.1.0-alpha.68",
    proposal: "{}",
    ...overrides,
  };
}

describe("generated CLI HTTP request-core contract", () => {
  it("accepts the artifact's passthrough move and error envelopes", () => {
    expect(isCliErrorResponse({ error: "bad request", status: 400 })).toBe(true);
    expect(isCliErrorResponse({ error: 400 })).toBe(false);
    expect(
      isMoveIngestRequest({
        batch: [
          {
            moveId: "move-1",
            capturedAt: 1,
            sessionId: "session-1",
            eventType: "PostToolUse",
            legacyExtension: true,
          },
        ],
        requestExtension: true,
      }),
    ).toBe(true);
  });

  it("keeps strict response validation separate from durable-ack compatibility policy", () => {
    expect(
      isDurableMoveIngestResponse({
        disposition: "persisted",
        acknowledged: 1,
        accepted: 1,
        verdictFooter: null,
      }),
    ).toBe(true);
    expect(isDurableMoveIngestResponse({ disposition: "persisted", acknowledged: 1 })).toBe(false);
  });

  it("applies named preflight refinements without mutating or sorting input", () => {
    const request = preflight({ paths: ["src/z.ts", "src/a.ts"] });
    const before = structuredClone(request);
    expect(isPreflightRequestV3(request)).toBe(true);
    expect(request).toEqual(before);
    expect(isPreflightRequestV3(preflight({ paths: ["../outside.ts"] }))).toBe(false);
    expect(isPreflightRequestV3(preflight({ paths: ["src/a.ts", "src/a.ts"] }))).toBe(false);
    expect(isPreflightRequestV3(preflight({ paths: [], coverage: "complete" }))).toBe(false);
    expect(isPreflightRequestV3(preflight({ proposal: "a".repeat(6_145) }))).toBe(false);
  });

  it("labels generated structural validation where semantic refinements remain separate", () => {
    const outside = preflight({ paths: ["../outside.ts"] });
    expect(isPreflightRequestV3Structure(outside)).toBe(true);
    expect(isPreflightRequestV3(outside)).toBe(false);
  });

  it("enforces feedback workspace, identifier, and uniqueness refinements", () => {
    expect(
      isFeedbackLeaseRequest({
        protocolVersion: 1,
        workspaceId: WORKSPACE_ID,
        currentSessionId: "session-1",
      }),
    ).toBe(true);
    expect(
      isFeedbackLeaseRequest({
        protocolVersion: 1,
        workspaceId: WORKSPACE_ID.toUpperCase(),
        currentSessionId: "session-1",
      }),
    ).toBe(false);
    const duplicate = {
      protocolVersion: 1,
      workspaceId: WORKSPACE_ID,
      deliveries: [
        { eventId: "event-1", leaseVersion: 1 },
        { eventId: "event-1", leaseVersion: 2 },
      ],
    };
    expect(isFeedbackAckRequestStructure(duplicate)).toBe(true);
    expect(isFeedbackAckRequest(duplicate)).toBe(false);
    expect(
      isFeedbackAckRequest({
        protocolVersion: 1,
        workspaceId: WORKSPACE_ID,
        deliveries: [{ eventId: "unsafe\u202e", leaseVersion: 1 }],
      }),
    ).toBe(false);
  });

  it("enforces feedback response version negotiation and unique event IDs", () => {
    const event = {
      eventId: "event-1",
      leaseVersion: 1,
      shortId: "0123abcd",
      intent: "Adopt artifact v2",
      webUrl: "https://app.getprimitive.ai/decisions/decision-1",
    };
    const invalidV1 = {
      protocolVersion: 1,
      status: "leased",
      events: [{ ...event, kind: "publish_prompt" }],
      hasMore: false,
    };
    expect(isFeedbackLeaseResponseStructure(invalidV1)).toBe(true);
    expect(isFeedbackLeaseResponse(invalidV1)).toBe(false);

    const invalidV2 = {
      protocolVersion: 2,
      status: "leased",
      events: [event],
      hasMore: false,
    };
    expect(isFeedbackLeaseResponseStructure(invalidV2)).toBe(true);
    expect(isFeedbackLeaseResponse(invalidV2)).toBe(false);
    expect(
      isFeedbackLeaseResponse({
        ...invalidV2,
        events: [{ ...event, kind: "publish_prompt" }],
      }),
    ).toBe(true);
    expect(
      isFeedbackLeaseResponse({
        ...invalidV2,
        events: [
          { ...event, kind: "confirm_prompt" },
          { ...event, kind: "confirm_prompt" },
        ],
      }),
    ).toBe(false);

    const duplicateAck = {
      protocolVersion: 2,
      status: "acked",
      acknowledgedEventIds: ["event-1", "event-1"],
    };
    expect(isFeedbackAckResponseStructure(duplicateAck)).toBe(true);
    expect(isFeedbackAckResponse(duplicateAck)).toBe(false);
  });

  it("enforces resolved, unavailable, and complete-author recent response variants", () => {
    const partialAuthor = {
      decisions: [],
      viewerHasDecisions: false,
      author: { userId: "user-1", name: "Ada" },
    };
    expect(isDecisionsRecentResponseStructure(partialAuthor)).toBe(true);
    expect(isDecisionsRecentResponse(partialAuthor)).toBe(false);
    expect(
      isDecisionsRecentResponse({
        ...partialAuthor,
        authorHasDecisions: false,
        windowTotal: 0,
        windowTotalCapped: false,
      }),
    ).toBe(true);
    expect(
      isDecisionsRecentResponse({
        decisions: [],
        unavailable: "organization_unbound",
      }),
    ).toBe(true);
    expect(
      isDecisionsRecentResponse({
        decisions: [],
        unavailable: "organization_unbound",
        viewerHasDecisions: false,
      }),
    ).toBe(false);
  });

  it("validates repository binding names from the server-owned pattern", () => {
    expect(isRepositoryBindRequest({ repositoryFullName: "campus-ai/primitive" })).toBe(true);
    expect(isRepositoryBindRequest({ repositoryFullName: "campus--ai/primitive" })).toBe(false);
    expect(
      isRepositoryBindRequest({ repositoryFullName: "campus-ai/primitive", unexpected: true }),
    ).toBe(false);
  });

  it("fails generation closed when an artifact introduces an unknown refinement", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    definitions.PreflightRequestV3["x-primitive-runtime-refinements"] = [
      "canonical_repository_paths",
      "future_unknown_rule",
    ];
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("unsupported runtime refinement: future_unknown_rule");
  });

  it("fails generation closed when a refinement is nested inside a definition", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    const repositoryBind = definitions.RepositoryBindRequest;
    const properties = repositoryBind.properties as Record<string, Record<string, unknown>>;
    properties.repositoryFullName["x-primitive-runtime-refinements"] = [
      "future_unknown_nested_rule",
    ];

    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("unsupported runtime refinement: future_unknown_nested_rule");

    properties.repositoryFullName["x-primitive-runtime-refinements"] = [
      "canonical_repository_paths",
    ];
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("uses runtime refinements outside a definition root");
  });

  it("fails generation closed when a refinement is attached to the schema root", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    artifact["x-primitive-runtime-refinements"] = ["future_unknown_root_rule"];

    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("unsupported runtime refinement: future_unknown_root_rule");

    artifact["x-primitive-runtime-refinements"] = ["canonical_repository_paths"];
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("uses runtime refinements outside a definition root");
  });

  it("fails generation closed on unsupported schema keywords", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    definitions.RepositoryBindRequest.futureKeyword = true;

    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow('strict mode: unknown keyword: "futureKeyword"');
  });

  it("rejects an artifact whose bytes do not match the provenance lock", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    const artifactBytes = Buffer.from(`${JSON.stringify({ ...artifact, title: "tampered" })}\n`);

    await expect(
      buildGeneratedOutputs(
        artifactBytes,
        Buffer.from(`${JSON.stringify(fixtures)}\n`),
        Buffer.from(`${JSON.stringify(lock)}\n`),
      ),
    ).rejects.toThrow("contract schema checksum mismatch");
  });

  it("rejects fixture byte drift and fixture metadata drift", async () => {
    const schemaBytes = readFileSync(resolve("contracts/cli-http-v1.schema.json"));
    const fixtureBytes = readFileSync(resolve("contracts/cli-http-v1.fixtures.json"));
    const lockBytes = readFileSync(resolve("contracts/cli-http-v1.lock.json"));
    await expect(
      buildGeneratedOutputs(
        schemaBytes,
        Buffer.concat([fixtureBytes, Buffer.from(" ")]),
        lockBytes,
      ),
    ).rejects.toThrow("conformance fixtures checksum mismatch");

    const { artifact, fixtures, lock } = artifactFixture();
    fixtures.contractVersion = 99;
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("conformance fixtures do not match the contract artifact");
  });

  it("rejects provenance path, repository, commit, and lock-shape tampering", async () => {
    const { artifact, fixtures, lock } = artifactFixture();
    const artifacts = lock.artifacts as Record<string, Record<string, unknown>>;
    artifacts.fixtures.sourcePath = "contracts/renamed-fixtures.json";
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("conformance fixtures source path");

    artifacts.fixtures.sourcePath = "contracts/cli-http-v1.fixtures.json";
    lock.sourceRepository = "other/repository";
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("sourceRepository must be campus-ai/primitive");

    lock.sourceRepository = "campus-ai/primitive";
    lock.sourceCommit = "main";
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("sourceCommit must be a full lowercase Git object ID");

    lock.sourceCommit = "9f394bb03d64c228190155ab3dbce15eca4cbbd5";
    lock.unexpected = true;
    await expect(
      buildGeneratedOutputs(...generatedInput(artifact, fixtures, lock)),
    ).rejects.toThrow("contract lock has unknown or missing fields");
  });
});
