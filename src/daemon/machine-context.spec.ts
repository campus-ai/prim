import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { DECISION_IDENTITY_VERSION } from "./protocol.js";

let directory: string | undefined;
let server: Server | undefined;
afterEach(async () => {
  if (server?.listening) await new Promise<void>((resolve) => server?.close(() => resolve()));
  vi.unstubAllEnvs();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

it.skipIf(process.platform === "win32")(
  "lets a fresh injected-credential hook read principal-bound daemon snapshots without a token exchange",
  async () => {
    vi.resetModules();
    directory = mkdtempSync(join(tmpdir(), "prim-env-hook-"));
    vi.stubEnv("PRIM_CONFIG_DIR", directory);
    vi.stubEnv("PRIM_API_URL", "https://api.example.com");
    vi.stubEnv("PRIM_TOKEN", "");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_hook");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "injected-hook-fixture");
    const issuer = "https://auth.example.com";
    const audience = "client_environment";
    const accessToken = `header.${Buffer.from(JSON.stringify({ iss: issuer, aud: audience, sub: "client_hook", client_id: "client_hook", org_id: "org_hook", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature`;
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/m2m/config"))
        return Response.json({ protocol_version: 1, issuer, audience });
      if (String(url).endsWith("/oauth2/token"))
        return Response.json({ access_token: accessToken, token_type: "bearer", expires_in: 3600 });
      return Response.json({
        authenticated: true,
        organizationBindingVersion: 2,
        captureAuthorityKind: "workos_m2m",
        organizationId: "organization_hook",
        workosOrganizationId: "org_hook",
        principal: {
          kind: "machine",
          clientId: "client_hook",
          machineId: "machine_hook",
          displayName: "Runner",
          scopes: ["cli:read"],
        },
      });
    });
    const { acquireMachineCredential } = await import("../lib/machine-credentials.js");
    await acquireMachineCredential({}, { fetch: fetcher });
    const { resolveDaemonPrincipal, daemonPrincipalsMatch } = await import("./principal.js");
    const daemonPrincipal = resolveDaemonPrincipal();
    expect(daemonPrincipal).toBeDefined();
    server = createServer((socket) => {
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (!input.includes("\n")) return;
        const request = JSON.parse(input);
        const ok = daemonPrincipalsMatch(request.caller, daemonPrincipal);
        socket.end(
          `${JSON.stringify({ id: request.id, ok, result: ok ? { snapshot: request.method } : undefined, decisionIdentityVersion: DECISION_IDENTITY_VERSION })}\n`,
        );
      });
    });
    await new Promise<void>((resolve) =>
      server?.listen(join(directory as string, "sock"), resolve),
    );

    // Model a new hook process: no module-local access token or identity remains.
    vi.resetModules();
    const fresh = await import("../lib/machine-credentials.js");
    const { daemonRequest } = await import("./client.js");
    expect(fresh.cachedMachineCredential()).toBeUndefined();
    for (const method of [
      "status_snapshot",
      "decision_digest_snapshot",
      "decision_draft_digest_snapshot",
    ]) {
      expect(await daemonRequest(method)).toEqual({ snapshot: method });
    }
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
