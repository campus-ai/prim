/**
 * PII / secrets scrubbing tests.
 *
 * Covers each default rule + the recursive payload walk + non-string
 * passthrough, the workspace-override loader (valid / malformed / invalid
 * regex), and the oversized-input guard.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RULES, scrub, scrubFromCwd } from "./redact.js";

describe("scrub", () => {
  it("redacts Bearer tokens in plain strings", () => {
    const out = scrub("Authorization: Bearer abc.def-ghi_jkl");
    expect(out).toBe("Authorization: <REDACTED:bearer-token>");
  });

  it("redacts sk- API keys", () => {
    const key = `sk-${"x".repeat(40)}`;
    const out = scrub(`OPENAI=${key}`);
    expect(out).toBe("OPENAI=<REDACTED:sk-api-key>");
  });

  it("redacts an entire PRIVATE KEY block, including newlines", () => {
    const pk = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIEpAIBAAKCAQEA...",
      "...zlGzr+w==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    const out = scrub(`Config: ${pk}\nDone`);
    expect(out).toBe("Config: <REDACTED:private-key>\nDone");
  });

  it("redacts Slack and GitHub PATs", () => {
    expect(scrub(`token=xoxb-${"x".repeat(20)}`)).toBe("token=<REDACTED:slack-token>");
    expect(scrub(`pat=ghp_${"X".repeat(40)}`)).toBe("pat=<REDACTED:github-pat>");
  });

  it("redacts Primitive PATs and Convex deploy keys", () => {
    expect(scrub(`token=prim_pat_${"a".repeat(64)}`)).toBe("token=<REDACTED:primitive-pat>");
    expect(
      scrub("CONVEX_DEPLOY_KEY=prod:example-deployment-123|eyJ2MiI6ImFiY2RlZmdoaWprbG1ub3AifQ"),
    ).toBe("CONVEX_DEPLOY_KEY=<REDACTED:convex-deploy-key>");
  });

  it("walks arrays and objects recursively", () => {
    const out = scrub({
      tool: "Read",
      headers: ["Bearer abc.def.ghi"],
      nested: { secret: `sk-${"x".repeat(40)}` },
    });
    expect(out).toEqual({
      tool: "Read",
      headers: ["<REDACTED:bearer-token>"],
      nested: { secret: "<REDACTED:sk-api-key>" },
    });
  });

  it("passes non-string scalars through unchanged", () => {
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
    expect(scrub(null)).toBeNull();
    expect(scrub(undefined)).toBeUndefined();
  });

  it("exposes a stable default rule set", () => {
    expect(DEFAULT_RULES.map((r) => r.reason).sort()).toEqual([
      "bearer-token",
      "convex-deploy-key",
      "github-pat",
      "primitive-pat",
      "private-key",
      "sk-api-key",
      "slack-token",
    ]);
  });
});

describe("oversized input guard", () => {
  it("redacts an oversized string wholesale (fail-closed, bounded cold path)", () => {
    expect(scrub("a".repeat(300_000))).toBe("<REDACTED:oversized>");
  });

  it("leaves normal-sized strings intact", () => {
    expect(scrub("normal text")).toBe("normal text");
  });
});

describe("scrubFromCwd workspace overrides", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "prim-redact-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  function writeConfig(content: string): void {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "redaction.json"), content);
  }

  it("applies a valid workspace rule on top of the defaults", () => {
    writeConfig(JSON.stringify({ rules: [{ pattern: "ACME-[0-9]+", reason: "acme-id" }] }));
    expect(scrubFromCwd("ticket ACME-42 with Bearer abc.def", scratch)).toBe(
      "ticket <REDACTED:acme-id> with <REDACTED:bearer-token>",
    );
  });

  it("falls back to the defaults only when the config is malformed", () => {
    writeConfig("{ not json");
    expect(scrubFromCwd(`key sk-${"x".repeat(40)}`, scratch)).toBe("key <REDACTED:sk-api-key>");
  });

  it("skips an invalid-regex rule but keeps the valid ones", () => {
    writeConfig(
      JSON.stringify({
        rules: [
          { pattern: "(", reason: "broken" },
          { pattern: "WIDGET-[0-9]+", reason: "widget" },
        ],
      }),
    );
    expect(scrubFromCwd("WIDGET-7", scratch)).toBe("<REDACTED:widget>");
  });

  it("uses only the defaults when no workspace config exists", () => {
    expect(scrubFromCwd("Bearer abc.def", scratch)).toBe("<REDACTED:bearer-token>");
  });

  it("loads the repository-root override from a nested session cwd", () => {
    writeConfig(JSON.stringify({ rules: [{ pattern: "ROOT-[0-9]+", reason: "root-id" }] }));
    const nested = join(scratch, "src", "nested");
    mkdirSync(nested, { recursive: true });
    expect(scrubFromCwd("ROOT-7", nested, scratch)).toBe("<REDACTED:root-id>");
  });
});
