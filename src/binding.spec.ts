/**
 * Unit tests for the org-binding chain.
 *
 * Filesystem fixtures live under a temp dir; the default-org tier is
 * driven through the PRIM_TOKEN env var (the preferred headless path),
 * which the shared credential resolver checks before its token file — so
 * these runs never read the real token file or session markers.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fromDefaultOrg, fromWorkspaceFile, resolveOrg } from "./binding.js";

let scratch: string;
let savedToken: string | undefined;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "prim-binding-"));
  savedToken = process.env.PRIM_TOKEN;
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  if (savedToken === undefined) {
    Reflect.deleteProperty(process.env, "PRIM_TOKEN");
  } else {
    process.env.PRIM_TOKEN = savedToken;
  }
});

function jwtWithPayload(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

describe("fromWorkspaceFile", () => {
  it("reads orgId from a workspace.json in the exact directory", () => {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "workspace.json"), JSON.stringify({ orgId: "org-abc" }));
    expect(fromWorkspaceFile(scratch)).toBe("org-abc");
  });

  it("walks up from a nested directory until it finds a workspace.json", () => {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "workspace.json"), JSON.stringify({ orgId: "org-xyz" }));
    const deep = join(scratch, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    expect(fromWorkspaceFile(deep)).toBe("org-xyz");
  });

  it("returns undefined when no workspace.json exists in any ancestor", () => {
    const deep = join(scratch, "a", "b");
    mkdirSync(deep, { recursive: true });
    expect(fromWorkspaceFile(deep)).toBeUndefined();
  });

  it("returns undefined when workspace.json is malformed", () => {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "workspace.json"), "{ not json");
    expect(fromWorkspaceFile(scratch)).toBeUndefined();
  });

  it("returns undefined when workspace.json lacks orgId", () => {
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(join(scratch, ".prim", "workspace.json"), JSON.stringify({ other: "x" }));
    expect(fromWorkspaceFile(scratch)).toBeUndefined();
  });
});

describe("fromDefaultOrg", () => {
  it("decodes org_id from the PRIM_TOKEN env JWT (preferred headless path)", () => {
    process.env.PRIM_TOKEN = jwtWithPayload({ org_id: "jorg-from-jwt" });
    expect(fromDefaultOrg(scratch)).toBe("jorg-from-jwt");
  });

  it("returns undefined for a non-JWT token", () => {
    process.env.PRIM_TOKEN = "not-a-jwt";
    expect(fromDefaultOrg(scratch)).toBeUndefined();
  });

  it("returns undefined when the JWT payload has no org_id", () => {
    process.env.PRIM_TOKEN = jwtWithPayload({ sub: "u1" });
    expect(fromDefaultOrg(scratch)).toBeUndefined();
  });
});

describe("resolveOrg precedence", () => {
  it("prefers a workspace pin over the default-org token", () => {
    process.env.PRIM_TOKEN = jwtWithPayload({ org_id: "jorg-default" });
    mkdirSync(join(scratch, ".prim"), { recursive: true });
    writeFileSync(
      join(scratch, ".prim", "workspace.json"),
      JSON.stringify({ orgId: "jorg-workspace" }),
    );
    expect(resolveOrg({ sessionId: "no-such-session", cwd: scratch })).toEqual({
      orgId: "jorg-workspace",
      source: "workspace",
    });
  });

  it("falls through to the default org when no session/workspace binding exists", () => {
    process.env.PRIM_TOKEN = jwtWithPayload({ org_id: "jorg-default" });
    expect(resolveOrg({ sessionId: "no-such-session", cwd: scratch })).toEqual({
      orgId: "jorg-default",
      source: "defaultOrg",
    });
  });

  it("is unbound when the token carries no org and nothing else resolves", () => {
    process.env.PRIM_TOKEN = "not-a-jwt";
    expect(resolveOrg({ sessionId: "no-such-session", cwd: scratch })).toEqual({
      orgId: undefined,
      source: "unbound",
    });
  });
});
