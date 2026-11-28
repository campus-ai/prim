import { appendFileSync, existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Move } from "./protocol/move.js";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const workosBinding = {
  authenticated: true,
  organizationBindingVersion: 1,
  captureAuthorityKind: "workos",
  organizationId: "org_local",
  workosOrganizationId: "org_workos",
};

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

  it("pins one token, drains only its exact organization bucket, and retains mismatches", async () => {
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
      quarantined: 0,
      retained: [{ bucket: "org_other", reason: "organization_mismatch" }],
    });
    expect(existsSync(matchingPath)).toBe(false);
    expect(existsSync(wrongPath)).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.token === "Bearer token-a")).toBe(true);
    expect(calls.every((call) => call.url.startsWith("https://api.example.test/"))).toBe(true);
  });

  it("delivers what a cold machine session captured before it knew its identity", async () => {
    // A fresh Claude Code cloud VM: credentials in the environment, and no
    // verified identity until something first asks the server.
    process.env = {
      ...originalEnv,
      PRIM_API_URL: "https://api.example.test",
      PRIM_CONFIG_DIR: configDir,
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "environment-secret",
    };
    process.env.PRIM_TOKEN = undefined;
    const posted: Array<{ batch: Array<Record<string, unknown>> }> = [];
    vi.doMock("./client.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./client.js")>()),
      getPinnedClient: async () => ({
        // The installation is delegated: the server names the user it acts for.
        get: async () => ({
          authenticated: true,
          organizationBindingVersion: 3,
          captureAuthorityKind: "workos_m2m",
          organizationId: "org_local",
          workosOrganizationId: "org_workos",
          principal: {
            kind: "machine",
            clientId: "client_cloud",
            machineId: "machine_cloud",
            displayName: "Claude Code cloud",
            authorizedUserId: "user_alex",
            scopes: ["cli:capture"],
          },
        }),
        post: async (_path: string, body: unknown) => {
          posted.push(body as { batch: Array<Record<string, unknown>> });
          return { disposition: "persisted", acknowledged: 1, accepted: 1 };
        },
      }),
    }));
    try {
      const journal = await import("./journal.js");
      const { flush } = await import("./flusher.js");
      const captured = journal.appendMove(move("cold-start"), undefined);
      // Nothing but the client: the session start hook ran before any sign-in.
      expect(captured.captureActor).toEqual({
        kind: "machine",
        apiUrl: "https://api.example.test",
        clientId: "client_cloud",
      });

      // It waits apart from any verified identity's bucket.
      expect(journal.listBuckets().map(({ bucket }) => bucket)).toEqual([
        expect.stringMatching(/^_machine_pending_[a-f0-9]{64}$/u),
      ]);

      await expect(flush()).resolves.toEqual({ flushed: 1, quarantined: 0 });
      expect(posted).toHaveLength(1);
      expect(posted[0]?.batch[0]).toMatchObject({
        moveId: "cold-start",
        envelopeVersion: 6,
        capturedMachineId: "machine_cloud",
        capturedUserId: "user_alex",
        capturedOrganizationId: "org_local",
      });
      expect(journal.listBuckets()).toEqual([]);
    } finally {
      vi.doUnmock("./client.js");
    }
  });

  it("keeps a service identity's captures in place when its client turns out to be delegated", async () => {
    process.env = {
      ...originalEnv,
      PRIM_API_URL: "https://api.example.test",
      PRIM_CONFIG_DIR: configDir,
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "environment-secret",
    };
    process.env.PRIM_TOKEN = undefined;
    const post = vi.fn();
    vi.doMock("./client.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./client.js")>()),
      getPinnedClient: async () => ({
        get: async () => ({
          authenticated: true,
          organizationBindingVersion: 3,
          captureAuthorityKind: "workos_m2m",
          organizationId: "org_local",
          workosOrganizationId: "org_workos",
          principal: {
            kind: "machine",
            clientId: "client_cloud",
            machineId: "machine_cloud",
            displayName: "Claude Code cloud",
            authorizedUserId: "user_alex",
            scopes: ["cli:capture"],
          },
        }),
        post,
      }),
    }));
    try {
      const journal = await import("./journal.js");
      const { flush } = await import("./flusher.js");
      const { machineJournalBucket } = await import("./lib/machine-credentials.js");
      // Captured while the client was verified as a service identity: the
      // actor names that machine and organization, and no user.
      const serviceBucket = machineJournalBucket({
        apiUrl: "https://api.example.test",
        clientId: "client_cloud",
      });
      const path = journal.journalPath(serviceBucket);
      journal.appendMoveToPath(path, {
        ...move("service-era"),
        captureActor: {
          kind: "machine",
          apiUrl: "https://api.example.test",
          clientId: "client_cloud",
          machineId: "machine_cloud",
          organizationId: "org_local",
        },
      });

      // Retained under its original authority: not uploaded, not dead-lettered.
      await expect(flush()).resolves.toEqual({
        flushed: 0,
        quarantined: 0,
        retained: [{ bucket: serviceBucket, reason: "machine_identity_mismatch" }],
      });
      expect(post).not.toHaveBeenCalled();
      expect(journal.readMovesFromPath(path).map(({ moveId }) => moveId)).toEqual(["service-era"]);
    } finally {
      vi.doUnmock("./client.js");
    }
  });

  it("retains every bucket without a POST when the server lacks the binding tuple", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(response({ authenticated: true })));
    vi.stubGlobal("fetch", fetchMock);
    const journal = await import("./journal.js");
    const { flush } = await import("./flusher.js");
    journal.appendMove(move("old-server"), "org_local");

    await expect(flush()).resolves.toEqual({
      flushed: 0,
      quarantined: 0,
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

  it("sweeps a checkpoint orphaned between a rotation's unlink and its own", async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("no request expected")));
    vi.stubGlobal("fetch", fetchMock);
    const journal = await import("./journal.js");
    const progress = await import("./drain-progress.js");
    const { flush } = await import("./flusher.js");
    const retired = join(dirname(journal.journalPath("org_local")), "journal.ndjson.flushing.1.2");
    progress.writeDrainCheckpoint(retired, { v: 2, offset: 10, size: 10, ino: 1, dev: 1 });

    await expect(flush()).resolves.toEqual({ flushed: 0, quarantined: 0 });
    expect(existsSync(progress.drainProgressPath(retired))).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retires a fully checkpointed rotation that reports no pending move", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request) => {
        const url = String(input);
        urls.push(url);
        if (url.endsWith("/api/cli/auth/status")) {
          return Promise.resolve(response(workosBinding));
        }
        return Promise.reject(new Error("no ingest expected"));
      }),
    );
    const journal = await import("./journal.js");
    const progress = await import("./drain-progress.js");
    const { flush, hasPendingDrainWork, shouldFlushPending } = await import("./flusher.js");
    // A drain that died after acknowledging every line but before the unlink;
    // this process's pid makes the rotation adoptable.
    const rotation = `${journal.journalPath("org_local")}.flushing.1.${String(process.pid)}`;
    journal.appendMoveToPath(rotation, move("delivered-a"));
    journal.appendMoveToPath(rotation, move("delivered-b"));
    const stat = statSync(rotation);
    progress.writeDrainCheckpoint(rotation, {
      v: 2,
      offset: stat.size,
      ...progress.rotationIdentity(stat),
    });

    const before = journal.pendingJournalStats();
    expect(before).toMatchObject({ pendingCount: 0, strandedCount: 0, strandedFileCount: 1 });
    // The daemon's and the opportunistic flusher's gates both see work.
    expect(hasPendingDrainWork(before)).toBe(true);
    expect(shouldFlushPending(before, Date.now())).toBe(true);

    await expect(flush()).resolves.toEqual({ flushed: 0, quarantined: 0 });
    expect(existsSync(rotation)).toBe(false);
    expect(existsSync(progress.drainProgressPath(rotation))).toBe(false);
    expect(urls.every((url) => url.endsWith("/api/cli/auth/status"))).toBe(true);
    expect(hasPendingDrainWork(journal.pendingJournalStats())).toBe(false);
  });

  it("credits a sweep that fails partway and resumes it at the checkpoint", async () => {
    const batchSizes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/cli/auth/status")) {
          return Promise.resolve(response(workosBinding));
        }
        const { batch } = JSON.parse(String(init?.body)) as { batch: unknown[] };
        batchSizes.push(batch.length);
        if (batchSizes.length === 2) {
          return Promise.resolve(response({ error: "temporarily unavailable" }, 503));
        }
        return Promise.resolve(
          response({
            disposition: "persisted",
            acknowledged: batch.length,
            accepted: batch.length,
          }),
        );
      }),
    );
    const journal = await import("./journal.js");
    const { HttpError } = await import("./client.js");
    const { FlushError, flush } = await import("./flusher.js");
    const captured = journal.appendMove(move("partial-0"), "org_local");
    // Keep real routing/authority stamping, then seed the remaining drain input
    // without timing hundreds of capture-admission fsyncs as fixture setup.
    appendFileSync(
      journal.journalPath("org_local"),
      Array.from(
        { length: 500 },
        (_, index) =>
          `${JSON.stringify({ ...captured, moveId: `partial-${String(index + 1)}` })}\n`,
      ).join(""),
    );

    const failure = await flush().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FlushError);
    // The first batch was acknowledged and checkpointed before the 503.
    expect(failure).toMatchObject({ flushed: 500, quarantined: 0 });
    expect((failure as Error).cause).toBeInstanceOf(HttpError);
    expect((failure as Error).cause).toMatchObject({ status: 503 });

    await expect(flush()).resolves.toEqual({ flushed: 1, quarantined: 0 });
    expect(batchSizes).toEqual([500, 1, 1]);
    expect(journal.listFlushing({ sampleBytes: 0 })).toEqual([]);
  });

  it("credits a failed sweep's progress only to its failing drains, and carries what it held back", async () => {
    // One organization, two deliverable buckets (organizationId and
    // workosOrganizationId) plus one it holds back. The workos bucket's last
    // Move is always rejected with a status that never dead-letters.
    const posted: string[][] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith("/api/cli/auth/status")) {
          return Promise.resolve(response(workosBinding));
        }
        const { batch } = JSON.parse(String(init?.body)) as { batch: Array<{ moveId: string }> };
        const ids = batch.map((item) => item.moveId);
        posted.push(ids);
        if (ids.includes("stuck-2")) {
          return Promise.resolve(response({ error: "unexpected" }, 500));
        }
        return Promise.resolve(
          response({ disposition: "persisted", acknowledged: ids.length, accepted: ids.length }),
        );
      }),
    );
    const journal = await import("./journal.js");
    const { FlushError, flush } = await import("./flusher.js");
    for (const id of ["stuck-0", "stuck-1", "stuck-2"]) journal.appendMove(move(id), "org_workos");
    for (const id of ["sent-0", "sent-1", "sent-2"]) journal.appendMove(move(id), "org_local");
    journal.appendMove(move("held"), "org_other");
    const retained = [{ bucket: "org_other", reason: "organization_mismatch" }];

    // The failing drain bisects down to its poison Move, acknowledging the
    // two Moves before it, while the sibling bucket delivers all three.
    const first = await flush().catch((error: unknown) => error);
    expect(first).toBeInstanceOf(FlushError);
    expect(first).toMatchObject({ flushed: 5, failedDrainFlushed: 2, quarantined: 0, retained });

    // The retry resumes the failing rotation at its checkpoint, so only the
    // poison Move is sent and nothing advances there; the sibling bucket's
    // fresh captures still deliver, but they are not that failure's progress.
    posted.length = 0;
    for (const id of ["late-0", "late-1"]) journal.appendMove(move(id), "org_local");
    const second = await flush().catch((error: unknown) => error);
    expect(second).toBeInstanceOf(FlushError);
    expect(second).toMatchObject({ flushed: 2, failedDrainFlushed: 0, quarantined: 0, retained });
    expect(posted).toEqual([["stuck-2"], ["late-0", "late-1"]]);
    expect(existsSync(journal.journalPath("org_other"))).toBe(true);
  });
});
