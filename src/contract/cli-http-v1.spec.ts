import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGeneratedOutputs } from "../../scripts/generate-cli-contract.mjs";
import {
  isCliErrorResponse,
  isDurableMoveIngestResponse,
  isFeedbackAckRequest,
  isFeedbackAckRequestStructure,
  isFeedbackLeaseRequest,
  isMoveIngestRequest,
  isPreflightRequestV3,
  isPreflightRequestV3Structure,
  isRepositoryBindRequest,
} from "./cli-http-v1.js";

const WORKSPACE_ID = "123e4567-e89b-42d3-a456-426614174000";

function artifactFixture(): {
  artifact: Record<string, unknown>;
  lock: Record<string, unknown>;
} {
  return {
    artifact: JSON.parse(
      readFileSync(resolve("contracts/cli-http-v1.schema.json"), "utf8"),
    ) as Record<string, unknown>,
    lock: JSON.parse(readFileSync(resolve("contracts/cli-http-v1.lock.json"), "utf8")) as Record<
      string,
      unknown
    >,
  };
}

function generatedInput(
  artifact: Record<string, unknown>,
  lock: Record<string, unknown>,
): [Buffer, Buffer] {
  const artifactBytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`);
  return [
    artifactBytes,
    Buffer.from(
      `${JSON.stringify({
        ...lock,
        sha256: createHash("sha256").update(artifactBytes).digest("hex"),
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

  it("validates repository binding names from the server-owned pattern", () => {
    expect(isRepositoryBindRequest({ repositoryFullName: "campus-ai/primitive" })).toBe(true);
    expect(isRepositoryBindRequest({ repositoryFullName: "campus--ai/primitive" })).toBe(false);
    expect(
      isRepositoryBindRequest({ repositoryFullName: "campus-ai/primitive", unexpected: true }),
    ).toBe(false);
  });

  it("fails generation closed when an artifact introduces an unknown refinement", async () => {
    const { artifact, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    definitions.PreflightRequestV3["x-primitive-runtime-refinements"] = [
      "canonical_repository_paths",
      "future_unknown_rule",
    ];
    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      "unsupported runtime refinement: future_unknown_rule",
    );
  });

  it("fails generation closed when a refinement is nested inside a definition", async () => {
    const { artifact, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    const repositoryBind = definitions.RepositoryBindRequest;
    const properties = repositoryBind.properties as Record<string, Record<string, unknown>>;
    properties.repositoryFullName["x-primitive-runtime-refinements"] = [
      "future_unknown_nested_rule",
    ];

    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      "unsupported runtime refinement: future_unknown_nested_rule",
    );

    properties.repositoryFullName["x-primitive-runtime-refinements"] = [
      "canonical_repository_paths",
    ];
    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      "uses runtime refinements outside a definition root",
    );
  });

  it("fails generation closed when a refinement is attached to the schema root", async () => {
    const { artifact, lock } = artifactFixture();
    artifact["x-primitive-runtime-refinements"] = ["future_unknown_root_rule"];

    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      "unsupported runtime refinement: future_unknown_root_rule",
    );

    artifact["x-primitive-runtime-refinements"] = ["canonical_repository_paths"];
    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      "uses runtime refinements outside a definition root",
    );
  });

  it("fails generation closed on unsupported schema keywords", async () => {
    const { artifact, lock } = artifactFixture();
    const definitions = artifact.$defs as Record<string, Record<string, unknown>>;
    definitions.RepositoryBindRequest.futureKeyword = true;

    await expect(buildGeneratedOutputs(...generatedInput(artifact, lock))).rejects.toThrow(
      'strict mode: unknown keyword: "futureKeyword"',
    );
  });

  it("rejects an artifact whose bytes do not match the provenance lock", async () => {
    const { artifact, lock } = artifactFixture();
    const artifactBytes = Buffer.from(`${JSON.stringify({ ...artifact, title: "tampered" })}\n`);

    await expect(
      buildGeneratedOutputs(artifactBytes, Buffer.from(`${JSON.stringify(lock)}\n`)),
    ).rejects.toThrow("contract artifact checksum mismatch");
  });

  it("requires a canonical source repository and artifact path", async () => {
    const { artifact, lock } = artifactFixture();
    await expect(
      buildGeneratedOutputs(
        ...generatedInput(artifact, { ...lock, sourceRepository: "example/test" }),
      ),
    ).rejects.toThrow("sourceRepository must be campus-ai/primitive");
    await expect(
      buildGeneratedOutputs(
        ...generatedInput(artifact, { ...lock, sourcePath: "contracts/other.schema.json" }),
      ),
    ).rejects.toThrow("sourcePath must be contracts/cli-http-v1.schema.json");
  });
});
