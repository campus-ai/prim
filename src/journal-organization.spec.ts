import { describe, expect, it, vi } from "vitest";
import type { CliClient } from "./client.js";
import {
  InvalidJournalEnvelopeError,
  buildOrganizationBoundMoveRequest,
  classifyJournalBuckets,
  inspectJournalDelivery,
  parseOrganizationBinding,
} from "./journal-organization.js";
import type { Move } from "./protocol/move.js";

const binding = {
  captureAuthorityKind: "workos" as const,
  organizationId: "jd7k2p9x",
  workosOrganizationId: "org_01ABC",
};

function client(response: unknown): CliClient {
  return {
    get: vi.fn().mockResolvedValue(response),
    post: vi.fn(),
  };
}

function move(): Move {
  return {
    moveId: "move_1",
    capturedAt: 1,
    sessionId: "session_1",
    eventType: "PostToolUse",
    payload: { ok: true },
    env: { cwd: "/repo", cliVersion: "test", osPlatform: "darwin" },
    envelopeVersion: 1,
  };
}

describe("journal organization binding", () => {
  it("accepts only the versioned exact local and WorkOS organization tuple", () => {
    expect(
      parseOrganizationBinding({
        authenticated: true,
        organizationBindingVersion: 1,
        ...binding,
      }),
    ).toEqual({ state: "current", binding });
    expect(parseOrganizationBinding({ authenticated: true, ...binding })).toEqual({
      state: "server_contract_unavailable",
    });
    expect(
      parseOrganizationBinding({
        authenticated: true,
        organizationBindingVersion: 1,
        captureAuthorityKind: "workos",
        organizationId: binding.organizationId,
        workosOrganizationId: null,
      }),
    ).toEqual({ state: "organization_identity_unreconciled" });
    expect(
      parseOrganizationBinding({
        authenticated: true,
        organizationBindingVersion: 1,
        captureAuthorityKind: "workos",
        organizationId: "x".repeat(129),
        workosOrganizationId: binding.workosOrganizationId,
      }),
    ).toEqual({ state: "server_contract_unavailable" });
    expect(
      parseOrganizationBinding({
        authenticated: true,
        organizationBindingVersion: 1,
        captureAuthorityKind: "unknown",
        organizationId: null,
        workosOrganizationId: null,
      }),
    ).toEqual({ state: "server_contract_unavailable" });
  });

  it("sends exact local or WorkOS buckets and retains every other bucket", () => {
    const result = classifyJournalBuckets(
      [binding.organizationId, binding.workosOrganizationId, "org_other", "_unbound"],
      binding,
    );
    expect([...result.deliverableBuckets]).toEqual([
      binding.organizationId,
      binding.workosOrganizationId,
    ]);
    expect(result.retainedBuckets).toEqual([
      { bucket: "_unbound", reason: "unbound" },
      { bucket: "org_other", reason: "organization_mismatch" },
    ]);
  });

  it("fails closed before delivery on an old server or identity outage", async () => {
    await expect(
      inspectJournalDelivery([binding.organizationId], {
        client: client({ authenticated: true }),
      }),
    ).resolves.toMatchObject({
      retainedBuckets: [
        {
          bucket: binding.organizationId,
          reason: "server_contract_unavailable",
        },
      ],
    });
    await expect(
      inspectJournalDelivery([binding.organizationId], {
        createClient: vi.fn().mockRejectedValue(new Error("offline")),
      }),
    ).resolves.toMatchObject({
      retainedBuckets: [{ bucket: binding.organizationId, reason: "identity_unavailable" }],
    });
  });

  it("returns the same pinned client that supplied the tenant proof", async () => {
    const pinned = client({
      authenticated: true,
      organizationBindingVersion: 1,
      ...binding,
    });
    const result = await inspectJournalDelivery([binding.organizationId], {
      client: pinned,
    });
    expect(result.client).toBe(pinned);
    expect(result.binding).toEqual(binding);
    expect([...result.deliverableBuckets]).toEqual([binding.organizationId]);
  });

  it("projects immutable WAL events to v4 under the exact sending authority", () => {
    const original = move();
    const workos = buildOrganizationBoundMoveRequest([original], binding);
    expect(workos.batch).toEqual([
      expect.objectContaining({
        moveId: original.moveId,
        envelopeVersion: 4,
        capturedOrganizationId: binding.workosOrganizationId,
        captureAuthorityKind: "workos",
        decisionLifecycleProtocolVersion: 2,
      }),
    ]);
    expect(original.envelopeVersion).toBe(1);

    const service = buildOrganizationBoundMoveRequest([original], {
      ...binding,
      captureAuthorityKind: "service_token",
    });
    expect(service.batch[0]).toMatchObject({
      capturedOrganizationId: binding.organizationId,
      captureAuthorityKind: "service_token",
    });
  });

  it("rejects a malformed local envelope before transport", () => {
    expect(() => buildOrganizationBoundMoveRequest([null as unknown as Move], binding)).toThrow(
      InvalidJournalEnvelopeError,
    );
  });
});

describe("machine journal authority", () => {
  const machine = {
    ...binding,
    captureAuthorityKind: "workos_m2m" as const,
    machineId: "machine_one",
    clientId: "client_installation",
  };
  const apiUrl = "https://api.getprimitive.ai";
  it("retains legacy and other-machine buckets after switching", async () => {
    const { machineJournalBucket } = await import("./lib/machine-credentials.js");
    const selected = machineJournalBucket({ apiUrl, clientId: machine.clientId });
    const other = machineJournalBucket({ apiUrl, clientId: "client_other" });
    const result = classifyJournalBuckets(
      [binding.organizationId, binding.workosOrganizationId, selected, other],
      machine,
    );
    expect([...result.deliverableBuckets]).toEqual([selected]);
    expect(result.retainedBuckets).toEqual(
      expect.arrayContaining([
        { bucket: binding.organizationId, reason: "legacy_authority_retained" },
        { bucket: other, reason: "machine_identity_mismatch" },
      ]),
    );
  });
  it("never assigns legacy bytes or another machine's capture to a new machine", () => {
    expect(() => buildOrganizationBoundMoveRequest([move()], machine)).toThrow(
      InvalidJournalEnvelopeError,
    );
    const captured: Move = {
      ...move(),
      captureActor: { kind: "machine", apiUrl, clientId: "client_other" },
    };
    expect(() => buildOrganizationBoundMoveRequest([captured], machine)).toThrow(
      InvalidJournalEnvelopeError,
    );
    expect(() => buildOrganizationBoundMoveRequest([captured], binding)).toThrow(
      InvalidJournalEnvelopeError,
    );
  });
  it("emits v5 with machine provenance without rewriting the journal record", () => {
    const captured: Move = {
      ...move(),
      captureActor: {
        kind: "machine",
        apiUrl,
        clientId: machine.clientId,
        machineId: machine.machineId,
        organizationId: machine.organizationId,
      },
    };
    const request = buildOrganizationBoundMoveRequest([captured], machine);
    expect(request.batch[0]).toMatchObject({
      envelopeVersion: 5,
      capturedMachineId: machine.machineId,
      captureAuthorityKind: "workos_m2m",
    });
    expect(request.batch[0]).not.toHaveProperty("captureActor");
    expect(captured.envelopeVersion).toBe(1);
  });
});
