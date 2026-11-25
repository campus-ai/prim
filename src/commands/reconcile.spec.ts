import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getClient, post } = vi.hoisted(() => ({ getClient: vi.fn(), post: vi.fn() }));

vi.mock("../client.js", async (importActual) => {
  const actual = await importActual<typeof import("../client.js")>();
  return { ...actual, getClient };
});

import { HttpError } from "../client.js";
import { performReconcile } from "./reconcile.js";

const ORIGINAL_EXIT_CODE = process.exitCode;
const GENERIC_REMEDY = "[prim] This credential is not permitted to record a resolution.\n";
const CLOUD_REMEDY =
  "[prim] This Claude Code cloud session's credential is not permitted to record a resolution. Recording an outcome does not bypass the gate or change a Decision; continue without the record.\n";

let stderr: string;
let stdout: string[];

/** The error the HTTP client raises for a non-2xx answer: `null` body when it is not JSON. */
function refused(status: number, body: unknown): HttpError {
  const code = (body as { error?: unknown } | null)?.error;
  return new HttpError(status, typeof code === "string" ? code : `HTTP ${status}`, body);
}

async function resolve(error: unknown): Promise<{ json: unknown; exitCode: unknown }> {
  post.mockRejectedValueOnce(error);
  await performReconcile("dec_0123abcd", { check: "check-1", outcome: "followed" });
  expect(post).toHaveBeenCalledWith("/api/cli/reconcile/resolve", {
    idOrShortId: "dec_0123abcd",
    checkId: "check-1",
    outcome: "followed",
  });
  expect(stdout).toHaveLength(1);
  return { json: JSON.parse(stdout[0] ?? ""), exitCode: process.exitCode };
}

beforeEach(() => {
  post.mockReset();
  getClient.mockReset();
  getClient.mockReturnValue({ get: vi.fn(), post });
  stderr = "";
  stdout = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((line) => {
    stdout.push(String(line));
  });
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("prim reconcile --check: a refused resolution", () => {
  it("names the machine-scope refusal and says the credential may not record it", async () => {
    const result = await resolve(
      refused(403, { error: "machine_scope_required", requiredScope: null }),
    );

    expect(stderr).toBe(
      `[prim] resolution failed (403): machine_scope_required\n${GENERIC_REMEDY}`,
    );
    expect(result.json).toEqual({ ok: false, status: 403, error: "machine_scope_required" });
    expect(result.exitCode).toBe(2);
  });

  it("tells a cloud machine session to continue without the record", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    vi.stubEnv("PRIM_TOKEN", undefined);

    const result = await resolve(
      refused(403, { error: "machine_scope_required", requiredScope: null }),
    );

    expect(stderr).toBe(`[prim] resolution failed (403): machine_scope_required\n${CLOUD_REMEDY}`);
    expect(result.json).toEqual({ ok: false, status: 403, error: "machine_scope_required" });
    expect(result.exitCode).toBe(2);
  });

  it("names no lifecycle command to a refused credential", async () => {
    for (const cloud of [false, true]) {
      if (cloud) {
        vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
        vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
        vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
        vi.stubEnv("PRIM_TOKEN", undefined);
      }
      stderr = "";
      stdout = [];

      await resolve(refused(403, { error: "machine_scope_required" }));

      expect(stderr).not.toMatch(/supersede|withdraw|prim decisions/iu);
    }
  });

  it("gives a person's sign-in in a cloud session the plain sentence", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CONFIG_DIR", "/nonexistent/prim-config");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", undefined);
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", undefined);
    vi.stubEnv("PRIM_M2M_CLIENT_AUTH", undefined);
    vi.stubEnv("PRIM_TOKEN", "person-token");

    await resolve(refused(403, { error: "machine_scope_required" }));

    expect(stderr).toBe(
      `[prim] resolution failed (403): machine_scope_required\n${GENERIC_REMEDY}`,
    );
  });

  it("reports another 403 with the server's error and message, and no credential sentence", async () => {
    const body = {
      error: "human_approval_required",
      message: "Reconcile bypasses are disabled.",
    };

    const result = await resolve(refused(403, body));

    expect(stderr).toBe(
      "[prim] resolution failed (403): human_approval_required: Reconcile bypasses are disabled.\n",
    );
    expect(result.json).toEqual({ ok: false, status: 403, ...body });
    expect(result.exitCode).toBe(2);
  });

  it("reports a 404 with the server's error", async () => {
    const result = await resolve(refused(404, { error: "not_found" }));

    expect(stderr).toBe("[prim] resolution failed (404): not_found\n");
    expect(result.json).toEqual({ ok: false, status: 404, error: "not_found" });
    expect(result.exitCode).toBe(2);
  });

  it.each(["conflicting_resolution", "invalid_decision_state"])(
    "reports a 409 %s with the server's error",
    async (error) => {
      const result = await resolve(refused(409, { error }));

      expect(stderr).toBe(`[prim] resolution failed (409): ${error}\n`);
      expect(result.json).toEqual({ ok: false, status: 409, error });
      expect(result.exitCode).toBe(2);
    },
  );

  it("reports only the status when a 4xx body is not JSON", async () => {
    const result = await resolve(refused(400, null));

    expect(stderr).toBe("[prim] resolution failed (400)\n");
    expect(result.json).toEqual({ ok: false, status: 400 });
    expect(result.exitCode).toBe(2);
  });

  it("reports only the status when a 4xx JSON body carries no error code", async () => {
    const result = await resolve(refused(422, { detail: "unexpected" }));

    expect(stderr).toBe("[prim] resolution failed (422)\n");
    expect(result.json).toEqual({ ok: false, status: 422 });
    expect(result.exitCode).toBe(2);
  });

  it("keeps a 5xx a server failure", async () => {
    const bare = await resolve(refused(500, null));

    expect(stderr).toBe("[prim] resolution failed (500)\n");
    expect(bare.json).toEqual({ ok: false, status: 500 });
    expect(bare.exitCode).toBe(3);

    stderr = "";
    stdout = [];
    const coded = await resolve(refused(503, { error: "temporarily_unavailable" }));

    expect(stderr).toBe("[prim] resolution failed (503): temporarily_unavailable\n");
    expect(coded.json).toEqual({ ok: false, status: 503, error: "temporarily_unavailable" });
    expect(coded.exitCode).toBe(3);
  });

  it("keeps a transport failure a server failure with no status", async () => {
    const result = await resolve(new TypeError("fetch failed"));

    expect(stderr).toBe("[prim] resolution failed\n");
    expect(result.json).toEqual({ ok: false });
    expect(result.exitCode).toBe(3);
  });

  it("strips terminal controls from the STDERR line and leaves STDOUT as sent", async () => {
    const error = "not_found\u001b[2J\nforged line";

    const result = await resolve(refused(404, { error }));

    expect(stderr).toBe("[prim] resolution failed (404): not_found[2J forged line\n");
    expect(result.json).toEqual({ ok: false, status: 404, error });
  });

  it("bounds an oversized error and message on both streams", async () => {
    const megabyte = 1024 * 1024;
    const error = "e".repeat(megabyte);
    const message = "m".repeat(megabyte);

    const result = await resolve(refused(409, { error, message }));

    expect(stderr).toBe(
      `[prim] resolution failed (409): ${"e".repeat(239)}…: ${"m".repeat(239)}…\n`,
    );
    expect(result.json).toEqual({
      ok: false,
      status: 409,
      error: `${"e".repeat(499)}…`,
      message: `${"m".repeat(499)}…`,
    });
    expect(stdout[0]?.length).toBeLessThan(1100);
    expect(result.exitCode).toBe(2);
  });

  it("passes a server string at the STDOUT cap through unchanged", async () => {
    const error = "e".repeat(500);

    const result = await resolve(refused(409, { error }));

    expect(result.json).toEqual({ ok: false, status: 409, error });
  });
});

describe("prim reconcile --check: a recorded resolution", () => {
  it("prints the server's response and exits 0", async () => {
    const response = {
      ok: true,
      checkId: "check-1",
      decisionId: "dec_0123abcd",
      outcome: "followed",
      recordedAt: 1_700_000_000_000,
      duplicate: false,
    };
    post.mockResolvedValueOnce(response);

    await performReconcile("dec_0123abcd", { check: "check-1", outcome: "followed" });

    expect(JSON.parse(stdout[0] ?? "")).toEqual(response);
    expect(stderr).toBe("[prim] recorded followed for check check-1\n");
    expect(process.exitCode).toBe(0);
  });
});
