import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RULES, scrub, scrubEnvironmentPaths, scrubFromCwd } from "./redact.js";

describe("scrub", () => {
  it("redacts bearer and Basic authorization credentials case-insensitively", () => {
    expect(scrub("authorization: bearer abc.def-ghi_jkl")).toBe(
      "authorization: <REDACTED:bearer-token>",
    );
    expect(scrub("Authorization: Basic dXNlcjpwYXNz")).toBe("Authorization: <REDACTED:basic-auth>");
    expect(scrub("https://alice:p%40ss@example.test/path")).toBe(
      "<REDACTED:basic-auth>example.test/path",
    );
  });

  it("redacts legacy, Anthropic, and OpenAI project API keys", () => {
    for (const key of [
      `sk-${"x".repeat(40)}`,
      `sk-ant-api03-${"A_b-".repeat(12)}`,
      `sk-proj-${"Z9_-".repeat(12)}`,
    ]) {
      expect(scrub(`API_KEY=${key}`)).toBe("API_KEY=<REDACTED:sk-api-key>");
    }
  });

  it("redacts AWS, GCP, and JWT credentials", () => {
    const awsAccessKey = `AKIA${"A1".repeat(8)}`;
    const awsSecret = "aB3/".repeat(10);
    const gcpApiKey = `AIza${"A_b9-".repeat(7)}`;
    const gcpOauth = `ya29.${"A_b9-".repeat(6)}`;
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature_value";
    const unsignedJwt = "eyJhbGciOiJub25lIn0.eyJzdWIiOiIxMjMifQ.";

    expect(scrub(`AWS_ACCESS_KEY_ID=${awsAccessKey}`)).toBe(
      "AWS_ACCESS_KEY_ID=<REDACTED:aws-access-key>",
    );
    expect(scrub(`AWS_SECRET_ACCESS_KEY=${awsSecret}`)).toBe("<REDACTED:aws-secret>");
    expect(scrub(`key=${gcpApiKey}`)).toBe("key=<REDACTED:gcp-api-key>");
    expect(scrub(`token=${gcpOauth}`)).toBe("token=<REDACTED:gcp-oauth-token>");
    expect(scrub(`cookie=${jwt}`)).toBe("cookie=<REDACTED:jwt>");
    expect(scrub(`cookie=${unsignedJwt}`)).toBe("cookie=<REDACTED:jwt>");
  });

  it("redacts an entire private-key block including newlines", () => {
    const key = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA...",
      "...zlGzr+w==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    expect(scrub(`Config: ${key}\nDone`)).toBe("Config: <REDACTED:private-key>\nDone");
  });

  it("redacts Slack and current GitHub token forms", () => {
    expect(scrub(`token=xoxb-${"x".repeat(20)}`)).toBe("token=<REDACTED:slack-token>");
    expect(scrub(`pat=ghp_${"X".repeat(40)}`)).toBe("pat=<REDACTED:github-pat>");
    expect(scrub(`pat=github_pat_${"X_".repeat(30)}`)).toBe("pat=<REDACTED:github-pat>");
  });

  it("removes username-bearing home path prefixes", () => {
    expect(scrub("file=/Users/alice/work/repo/src/a.ts")).toBe(
      "file=/Users/__redacted_user__/work/repo/src/a.ts",
    );
    expect(scrub("file=C:\\Users\\alice\\repo\\a.ts")).toBe(
      "file=C:\\Users\\__redacted_user__\\repo\\a.ts",
    );
  });

  it("walks arrays and objects recursively while preserving non-string scalars", () => {
    expect(
      scrub({
        tool: "Read",
        headers: ["Bearer abc.def.ghi"],
        nested: { secret: `sk-${"x".repeat(40)}` },
        count: 42,
        active: true,
        missing: null,
      }),
    ).toEqual({
      tool: "Read",
      headers: ["<REDACTED:bearer-token>"],
      nested: { secret: "<REDACTED:sk-api-key>" },
      count: 42,
      active: true,
      missing: null,
    });
    expect(scrub(undefined)).toBeUndefined();
  });

  it("exposes the complete stable default policy", () => {
    expect([...new Set(DEFAULT_RULES.map((rule) => rule.reason))].sort()).toEqual([
      "aws-access-key",
      "aws-secret",
      "basic-auth",
      "bearer-token",
      "gcp-api-key",
      "gcp-oauth-token",
      "github-pat",
      "jwt",
      "private-key",
      "sk-api-key",
      "slack-token",
      "user-home-path",
    ]);
  });
});

describe("resource bounds", () => {
  it("redacts an oversized string wholesale", () => {
    expect(scrub("a".repeat(300_000))).toBe("<REDACTED:oversized>");
  });

  it("leaves normal-sized strings intact", () => {
    expect(scrub("normal text")).toBe("normal text");
  });
});

describe("scrubEnvironmentPaths", () => {
  it("scrubs only local path identity and preserves correlation fields", () => {
    const environment = scrubEnvironmentPaths({
      cwd: "/Users/alice/work/repo/subdir",
      repoRoot: "/Users/alice/work/repo",
      gitRoot: "/Users/alice/work/repo",
      repoKey: "repo_v1_opaque",
      repoSyncId: "repoSync123",
      repoFullName: "campus-ai/primitive",
      workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    });
    expect(environment).toEqual({
      cwd: "/Users/__redacted_user__/work/repo/subdir",
      repoRoot: "/Users/__redacted_user__/work/repo",
      gitRoot: "/Users/__redacted_user__/work/repo",
      repoKey: "repo_v1_opaque",
      repoSyncId: "repoSync123",
      repoFullName: "campus-ai/primitive",
      workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    });
    const payloadPath = scrub("/Users/alice/work/repo/src/a.ts");
    expect(payloadPath).toBe(`${environment.repoRoot}/src/a.ts`);
  });
});

describe("scrubFromCwd workspace overrides", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "prim-redact-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(scratch, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "redaction.json"), content);
  }

  it("applies a valid workspace rule on top of the defaults", async () => {
    writeConfig(JSON.stringify({ rules: [{ pattern: "ACME-[0-9]+", reason: "acme-id" }] }));
    await expect(scrubFromCwd("ticket ACME-42 with Bearer abc.def", scratch)).resolves.toBe(
      "ticket <REDACTED:acme-id> with <REDACTED:bearer-token>",
    );
  });

  it("forces workspace matching to be global when callers supply other flags", async () => {
    writeConfig(
      JSON.stringify({ rules: [{ pattern: "secret", reason: "workspace", flags: "i" }] }),
    );
    await expect(scrubFromCwd("SECRET and secret", scratch)).resolves.toBe(
      "<REDACTED:workspace> and <REDACTED:workspace>",
    );
  });

  it("keeps an explicitly global workspace rule global", async () => {
    writeConfig(
      JSON.stringify({ rules: [{ pattern: "secret", reason: "workspace", flags: "gi" }] }),
    );
    await expect(scrubFromCwd("SECRET and secret", scratch)).resolves.toBe(
      "<REDACTED:workspace> and <REDACTED:workspace>",
    );
  });

  it("falls back to defaults when the config is malformed", async () => {
    writeConfig("{ not json");
    await expect(scrubFromCwd(`key sk-${"x".repeat(40)}`, scratch)).resolves.toBe(
      "key <REDACTED:sk-api-key>",
    );
  });

  it("skips invalid rules without logging their raw pattern", async () => {
    const rawSecret = "DO_NOT_LOG_THIS_SECRET(";
    writeConfig(
      JSON.stringify({
        rules: [
          { pattern: rawSecret, reason: "broken" },
          { pattern: "WIDGET-[0-9]+", reason: "widget" },
        ],
      }),
    );
    vi.stubEnv("PRIM_HOOK_DEBUG", "1");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(scrubFromCwd("WIDGET-7", scratch)).resolves.toBe("<REDACTED:widget>");
    expect(stderr.mock.calls.flat().join(" ")).not.toContain(rawSecret);
  });

  it("rejects unsafe metadata rather than allowing replacement-marker injection", async () => {
    writeConfig(
      JSON.stringify({ rules: [{ pattern: "secret", reason: "bad>marker", flags: "y" }] }),
    );
    await expect(scrubFromCwd("secret", scratch)).resolves.toBe("secret");
  });

  it("terminates catastrophic workspace regexes and fails closed", async () => {
    writeConfig(JSON.stringify({ rules: [{ pattern: "(a+)+$", reason: "hostile" }] }));
    const startedAt = Date.now();
    await expect(scrubFromCwd(`${"a".repeat(50_000)}!`, scratch)).resolves.toBe(
      "<REDACTED:workspace-rule-failed>",
    );
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it("uses only defaults when no workspace config exists", async () => {
    await expect(scrubFromCwd("Bearer abc.def", scratch)).resolves.toBe("<REDACTED:bearer-token>");
  });
});
