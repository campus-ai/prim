import { describe, expect, it, vi } from "vitest";
import { type CliManagementClient, CliManagementResponseError, HttpError } from "../client.js";
import {
  USER_API_KEY_EXIT,
  type UserApiKeyDependencies,
  listUserApiKeys,
  mintUserApiKey,
  revokeUserApiKey,
} from "./api-keys.js";

const REQUEST_ID = "a".repeat(64);
const API_KEY_ID = "api_key_example123";
const SECRET = "sk_example123 secret456";
const SIGNAL = new AbortController().signal;

function metadata() {
  return {
    id: API_KEY_ID,
    name: "Primitive CLI",
    obfuscatedValue: "sk_\u2026cdef",
    permissions: ["decisions:read"],
    lastUsedAt: null,
    expiresAt: null,
    createdAt: 1_787_078_400_000,
    updatedAt: 1_787_078_400_000,
  };
}

function harness(overrides: Partial<CliManagementClient> = {}) {
  const get = vi.fn();
  const post = vi.fn();
  const del = vi.fn();
  const client: CliManagementClient = {
    get,
    post,
    delete: del,
    ...overrides,
  };
  const stdout: string[] = [];
  const stderr: string[] = [];
  const getClient = vi.fn(async () => client);
  const dependencies: UserApiKeyDependencies = {
    getClient,
    requestId: () => REQUEST_ID,
    signal: () => SIGNAL,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
  return { client, del, dependencies, get, getClient, post, stderr, stdout };
}

function machine(stdout: string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0] ?? "null") as Record<string, unknown>;
}

describe("WorkOS user API-key mint", () => {
  it("posts once under a pinned client and returns the secret on stdout only", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ apiKey: metadata(), secret: SECRET });

    const code = await mintUserApiKey({ name: "Primitive CLI" }, dependencies);

    expect(code).toBe(USER_API_KEY_EXIT.ok);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      "/api/cli/auth/api-keys",
      { requestId: REQUEST_ID, name: "Primitive CLI" },
      { signal: SIGNAL },
    );
    expect(machine(stdout)).toEqual({ apiKey: metadata(), secret: SECRET });
    expect(stdout.join("\n").match(new RegExp(SECRET, "gu"))).toHaveLength(1);
    expect(stderr.join("\n")).not.toContain(SECRET);
    expect(stderr[0]).toContain("will not be shown again");
  });

  it("reconciles an uncertain mint when the returned expiration differs", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      apiKey: { ...metadata(), expiresAt: 1_800_000_000_000 },
      secret: SECRET,
    });

    expect(
      await mintUserApiKey({ name: "Primitive CLI", expiresAt: 1_800_000_000_001 }, dependencies),
    ).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "operation_uncertain" });
    expect(stdout.join("\n")).not.toContain(SECRET);
    expect(stderr).toEqual([expect.stringContaining("do not retry automatically")]);
  });

  it("rejects invalid input before resolving credentials or transport", async () => {
    const { dependencies, getClient, stdout } = harness();

    expect(await mintUserApiKey({ name: "\nspoofed" }, dependencies)).toBe(
      USER_API_KEY_EXIT.rejected,
    );
    expect(getClient).not.toHaveBeenCalled();
    expect(machine(stdout)).toMatchObject({ code: "invalid_input" });
  });

  it("reconciles a lost mint response without retrying", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(new Error("connection reset after write"));

    expect(await mintUserApiKey({ name: "Primitive CLI" }, dependencies)).toBe(
      USER_API_KEY_EXIT.server,
    );
    expect(post).toHaveBeenCalledOnce();
    expect(machine(stdout)).toMatchObject({ code: "operation_uncertain" });
    expect(stdout.join("\n")).not.toContain("connection reset");
    expect(stderr).toEqual([expect.stringContaining("do not retry automatically")]);
  });

  it("rejects terminal injection in a one-time secret without displaying it", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ apiKey: metadata(), secret: `${SECRET}\nspoofed` });

    expect(await mintUserApiKey({ name: "Primitive CLI" }, dependencies)).toBe(
      USER_API_KEY_EXIT.server,
    );
    expect(machine(stdout)).toMatchObject({ code: "operation_uncertain" });
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("spoofed");
  });

  it("reconciles an incomplete successful mint response without exposing a secret", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ apiKey: metadata() });

    expect(await mintUserApiKey({ name: "Primitive CLI" }, dependencies)).toBe(
      USER_API_KEY_EXIT.server,
    );
    expect(machine(stdout)).toMatchObject({ code: "operation_uncertain" });
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain(SECRET);
    expect(stderr).toEqual([expect.stringContaining("do not retry automatically")]);
  });

  it("reconciles provider-state uncertainty after dispatch", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(
      new HttpError(503, "ignored", { error: "provider_state_uncertain" }),
    );

    expect(await mintUserApiKey({ name: "Primitive CLI" }, dependencies)).toBe(
      USER_API_KEY_EXIT.server,
    );
    expect(machine(stdout)).toMatchObject({ code: "operation_uncertain", status: 503 });
    expect(stderr).toEqual([expect.stringContaining("do not retry automatically")]);
  });
});

describe("WorkOS user API-key list", () => {
  it("uses the exact bounded query and returns metadata without plaintext", async () => {
    const { dependencies, get, stderr, stdout } = harness();
    get.mockResolvedValueOnce({ apiKeys: [metadata()], nextCursor: API_KEY_ID });

    expect(await listUserApiKeys({ limit: 25, after: "api_key_previous" }, dependencies)).toBe(
      USER_API_KEY_EXIT.ok,
    );
    expect(get).toHaveBeenCalledWith(
      `/api/cli/auth/api-keys?request_id=${REQUEST_ID}&limit=25&after=api_key_previous`,
      { signal: SIGNAL },
    );
    expect(machine(stdout)).toEqual({ apiKeys: [metadata()], nextCursor: API_KEY_ID });
    expect(stdout.join("\n")).not.toContain(SECRET);
    expect(stderr).toEqual(["[prim] listed 1 user API key."]);
  });

  it("rejects an additive plaintext value in list metadata", async () => {
    const { dependencies, get, stdout } = harness();
    get.mockResolvedValueOnce({
      apiKeys: [{ ...metadata(), value: SECRET }],
      nextCursor: null,
    });

    expect(await listUserApiKeys({ limit: 100 }, dependencies)).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "invalid_response" });
    expect(stdout.join("\n")).not.toContain(SECRET);
  });

  it.each([
    ["terminal control", "sk_\u001bcdef"],
    ["line separator", "sk_\u2028cdef"],
    ["bidi override", "sk_\u202ecdef"],
    ["zero-width character", "sk_\u200bcdef"],
  ])("rejects %s in obfuscated metadata", async (_description, obfuscatedValue) => {
    const { dependencies, get, stdout } = harness();
    get.mockResolvedValueOnce({
      apiKeys: [{ ...metadata(), obfuscatedValue }],
      nextCursor: null,
    });

    expect(await listUserApiKeys({ limit: 100 }, dependencies)).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "invalid_response" });
  });

  it.each([{ limit: 0 }, { limit: 101 }, { limit: 10, after: "api_key_good\nnext" }])(
    "rejects invalid pagination before transport: %j",
    async (input) => {
      const { dependencies, getClient, stdout } = harness();
      expect(await listUserApiKeys(input, dependencies)).toBe(USER_API_KEY_EXIT.rejected);
      expect(getClient).not.toHaveBeenCalled();
      expect(machine(stdout)).toMatchObject({ code: "invalid_input" });
    },
  );
});

describe("WorkOS user API-key revoke", () => {
  it("deletes the exact encoded resource with a fresh request receipt", async () => {
    const { del, dependencies, stderr, stdout } = harness();
    del.mockResolvedValueOnce({ apiKeyId: API_KEY_ID, revoked: true });

    expect(await revokeUserApiKey(API_KEY_ID, dependencies)).toBe(USER_API_KEY_EXIT.ok);
    expect(del).toHaveBeenCalledWith(
      `/api/cli/auth/api-keys/${API_KEY_ID}`,
      { requestId: REQUEST_ID },
      { signal: SIGNAL },
    );
    expect(machine(stdout)).toEqual({ apiKeyId: API_KEY_ID, revoked: true });
    expect(stderr).toEqual([`[prim] API key ${API_KEY_ID} revoked.`]);
  });

  it("rejects a response for a different key", async () => {
    const { del, dependencies, stdout } = harness();
    del.mockResolvedValueOnce({ apiKeyId: "api_key_other", revoked: true });

    expect(await revokeUserApiKey(API_KEY_ID, dependencies)).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "invalid_response" });
  });

  it("rejects malformed and terminal-injection IDs before transport", async () => {
    const { dependencies, getClient, stdout } = harness();
    expect(await revokeUserApiKey("api_key_good\nspoofed", dependencies)).toBe(
      USER_API_KEY_EXIT.rejected,
    );
    expect(getClient).not.toHaveBeenCalled();
    expect(machine(stdout)).toMatchObject({ code: "invalid_input" });
  });
});

describe("WorkOS user API-key errors", () => {
  it("keeps a known mint authentication rejection specific", async () => {
    const { dependencies, post, stdout } = harness();
    post.mockRejectedValueOnce(new HttpError(401, "ignored", { error: "authentication_required" }));

    expect(await mintUserApiKey({ name: "Primitive CLI" }, dependencies)).toBe(
      USER_API_KEY_EXIT.auth,
    );
    expect(machine(stdout)).toMatchObject({ code: "authentication_required", status: 401 });
  });

  it("classifies bounded decoder failures as invalid responses", async () => {
    const { dependencies, get, stdout } = harness();
    get.mockRejectedValueOnce(new CliManagementResponseError());

    expect(await listUserApiKeys({ limit: 10 }, dependencies)).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "invalid_response" });
  });

  it.each([
    [403, "workos_session_required", "workos_session_required", USER_API_KEY_EXIT.auth],
    [403, "current_membership_required", "current_membership_required", USER_API_KEY_EXIT.auth],
    [404, "api_key_not_found", "api_key_not_found", USER_API_KEY_EXIT.notFound],
    [404, "Not found", "unsupported_server", USER_API_KEY_EXIT.server],
    [409, "operation_uncertain", "operation_uncertain", USER_API_KEY_EXIT.server],
  ] as const)(
    "maps HTTP %d / %s to %s without echoing server text",
    async (status, serverCode, expectedCode, expectedExit) => {
      const { dependencies, get, stderr, stdout } = harness();
      get.mockRejectedValueOnce(new HttpError(status, serverCode, { error: serverCode }));

      expect(await listUserApiKeys({ limit: 10 }, dependencies)).toBe(expectedExit);
      expect(machine(stdout)).toMatchObject({ code: expectedCode, status });
      expect(stderr).toHaveLength(1);
    },
  );

  it("does not disclose malformed server error bodies", async () => {
    const { dependencies, get, stderr, stdout } = harness();
    get.mockRejectedValueOnce(
      new HttpError(503, "ignored", { error: "provider\nuntrusted", secret: SECRET }),
    );

    expect(await listUserApiKeys({ limit: 10 }, dependencies)).toBe(USER_API_KEY_EXIT.server);
    expect(machine(stdout)).toMatchObject({ code: "server_error" });
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain(SECRET);
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("untrusted");
  });
});
