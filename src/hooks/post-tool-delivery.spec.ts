import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Move } from "../protocol/move.js";

let directory: string;
const issuer = "https://auth.example.com";
const audience = "client_environment";
const clientId = "client_installation";
const status = {
  authenticated: true,
  organizationBindingVersion: 2,
  captureAuthorityKind: "workos_m2m",
  organizationId: "organization_one",
  workosOrganizationId: "org_one",
  principal: {
    kind: "machine",
    machineId: "machine_one",
    clientId,
    displayName: "Runner",
    scopes: ["cli:read", "cli:capture"],
  },
};
const persisted = { disposition: "persisted", acknowledged: 1, accepted: 1 };
let uploaded: unknown[];
let beforeUpload: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "prim-post-tool-machine-"));
  vi.stubEnv("PRIM_CONFIG_DIR", directory);
  vi.stubEnv("PRIM_API_URL", "https://api.example.com");
  vi.stubEnv("PRIM_TOKEN", "");
  vi.stubEnv("PRIM_M2M_CLIENT_ID", clientId);
  vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "fixture-secret");
  uploaded = [];
  beforeUpload = undefined;
  let statusCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (String(url).endsWith("/m2m/config"))
        return Response.json({ protocol_version: 1, issuer, audience });
      if (String(url).endsWith("/oauth2/token")) {
        const claims = {
          iss: issuer,
          aud: audience,
          sub: clientId,
          client_id: clientId,
          org_id: "org_one",
          exp: Math.floor(Date.now() / 1000) + 3600,
        };
        return Response.json({
          access_token: `header.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`,
          token_type: "bearer",
          expires_in: 3600,
        });
      }
      if (String(url).endsWith("/auth/status")) {
        if (++statusCalls > 1) beforeUpload?.();
        return Response.json(status);
      }
      if (String(url).endsWith("/moves/ingest")) {
        uploaded.push(JSON.parse(options.body));
        return Response.json(persisted);
      }
      throw new Error("Unexpected fixture request");
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function move(): Move {
  return {
    moveId: "move-one",
    capturedAt: Date.now(),
    sessionId: "session-one",
    eventType: "PostToolUse",
    payload: { tool_name: "Edit" },
    envelopeVersion: 3,
    producer: "codex",
    env: { cwd: "/repo", cliVersion: "0.1.0", osPlatform: "darwin" },
  };
}

it("sends the same machine-bound envelope directly and on a later journal drain", async () => {
  const { deliverPostToolMove } = await import("./post-tool-delivery.js");
  const { listBuckets, readMovesFromPath } = await import("../journal.js");
  const { buildOrganizationBoundMoveRequest, parseOrganizationBinding } = await import(
    "../journal-organization.js"
  );
  const original = move();
  expect(await deliverPostToolMove(original, undefined)).toEqual(persisted);
  const binding = parseOrganizationBinding(status);
  if (binding.state !== "current") throw new Error("Missing fixture binding");
  const journal = readMovesFromPath(listBuckets()[0].path);
  expect(uploaded).toEqual([buildOrganizationBoundMoveRequest(journal, binding.binding)]);
  expect(uploaded[0]).toMatchObject({
    batch: [
      {
        envelopeVersion: 5,
        capturedMachineId: "machine_one",
        capturedOrganizationId: "organization_one",
        captureAuthorityKind: "workos_m2m",
      },
    ],
  });
  expect(original).not.toHaveProperty("captureActor");
  expect(original.envelopeVersion).toBe(3);
});

it("retains capture without uploading when credentials change between status and delivery", async () => {
  beforeUpload = () => {
    process.env.PRIM_M2M_CLIENT_ID = "client_other";
  };
  const { deliverPostToolMove } = await import("./post-tool-delivery.js");
  const { listBuckets, readMovesFromPath } = await import("../journal.js");
  await expect(deliverPostToolMove(move(), undefined)).rejects.toMatchObject({ status: 409 });
  expect(uploaded).toEqual([]);
  expect(readMovesFromPath(listBuckets()[0].path)[0].captureActor?.clientId).toBe(clientId);
});

it("preserves legacy direct delivery without requiring a new auth-status contract", async () => {
  vi.stubEnv("PRIM_M2M_CLIENT_ID", undefined);
  vi.stubEnv("PRIM_M2M_CLIENT_SECRET", undefined);
  vi.stubEnv("PRIM_TOKEN", "legacy-fixture");
  const { deliverPostToolMove } = await import("./post-tool-delivery.js");
  const original = move();
  expect(await deliverPostToolMove(original, "org_one")).toEqual(persisted);
  expect(uploaded).toEqual([{ batch: [original] }]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
