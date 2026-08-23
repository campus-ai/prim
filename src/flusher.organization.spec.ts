import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Move } from "./protocol/move.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function move(id: string): Move {
  return {
    moveId: id,
    capturedAt: 1,
    sessionId: "session",
    eventType: "PostToolUse",
    payload: { ok: true },
    env: { cwd: "/repo", cliVersion: "test", osPlatform: "darwin" },
    envelopeVersion: 1,
  };
}

describe("credential-bound journal draining", () => {
  const originalEnv = { ...process.env };
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    configDir = mkdtempSync(join(tmpdir(), "prim-org-flush-"));
    process.env = {
      ...originalEnv,
      PRIM_API_URL: "https://api.example.test",
      PRIM_CONFIG_DIR: configDir,
      PRIM_TOKEN: "token-a",
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("pins one token, drains only its exact org bucket, and retains mismatches", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        calls.push({ url, token: headers.get("Authorization") });
        if (url.endsWith("/api/cli/auth/status")) {
          process.env.PRIM_TOKEN = "token-b";
          process.env.PRIM_API_URL = "https://other.example.test";
          return Promise.resolve(
            response({
              authenticated: true,
              organizationBindingVersion: 1,
              captureAuthorityKind: "workos",
              organizationId: "org_local",
              workosOrganizationId: "org_workos",
            }),
          );
        }
        return Promise.resolve(
          response({
            disposition: "persisted",
            acknowledged: 1,
            accepted: 1,
          }),
        );
      }),
    );

    const journal = await import("./journal.js");
    const { flush } = await import("./flusher.js");
    journal.appendMove(move("matching"), "org_local");
    journal.appendMove(move("wrong"), "org_other");
    const matchingPath = journal.journalPath("org_local");
    const wrongPath = journal.journalPath("org_other");

    await expect(flush()).resolves.toEqual({
      flushed: 1,
      retained: [{ bucket: "org_other", reason: "organization_mismatch" }],
    });
    expect(existsSync(matchingPath)).toBe(false);
    expect(existsSync(wrongPath)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.token === "Bearer token-a")).toBe(true);
    expect(calls.every((call) => call.url.startsWith("https://api.example.test/"))).toBe(true);
  });

  it("retains every bucket without a POST when the server lacks the tuple", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response({ authenticated: true })));
    vi.stubGlobal("fetch", fetchMock);
    const journal = await import("./journal.js");
    const { flush } = await import("./flusher.js");
    journal.appendMove(move("old-server"), "org_local");

    await expect(flush()).resolves.toEqual({
      flushed: 0,
      retained: [{ bucket: "org_local", reason: "server_contract_unavailable" }],
    });
    expect(existsSync(journal.journalPath("org_local"))).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never retries a rejected upload under a replacement credential", async () => {
    const calls: Array<{ url: string; token: string | null }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const token = new Headers(init?.headers).get("Authorization");
        calls.push({ url, token });
        if (url.endsWith("/api/cli/auth/status")) {
          process.env.PRIM_TOKEN = "token-b";
          return Promise.resolve(
            response({
              authenticated: true,
              organizationBindingVersion: 1,
              captureAuthorityKind: "workos",
              organizationId: "org_local",
              workosOrganizationId: "org_workos",
            }),
          );
        }
        return Promise.resolve(response({ error: "Unauthorized" }, 401));
      }),
    );

    const journal = await import("./journal.js");
    const { flush } = await import("./flusher.js");
    journal.appendMove(move("rejected"), "org_local");

    await expect(flush()).rejects.toThrow("Authentication expired");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.token === "Bearer token-a")).toBe(true);
    expect(journal.listFlushing({ sampleBytes: 0 })).toHaveLength(1);
  });
});
