import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyAuthCredential,
  classifyDaemonHealth,
  classifyRepositoryBinding,
  classifySessionAuth,
} from "./doctor.js";

afterEach(() => vi.unstubAllEnvs());

describe("doctor auth line for a session identified through GitHub", () => {
  it("names the person the session is attributed to", () => {
    expect(
      classifySessionAuth({
        authenticated: true,
        status: "valid",
        reason: "verified",
        tokenFile: null,
        accessTokenExpiresInMs: 90_000,
        accessTokenExpired: false,
        refreshTokenPresent: false,
        warnings: [],
        principalKind: "session",
        identity: "github",
        displayName: "Jane Doe",
        githubLogin: "octojane",
      }),
    ).toEqual({
      name: "auth",
      status: "ok",
      detail:
        "session attributed to Jane Doe (GitHub @octojane) · identified through GitHub · expires in 90s",
    });
  });

  it("relays why the session is attributed to no one", () => {
    const check = classifySessionAuth({
      authenticated: false,
      status: "invalid",
      reason: "access_rejected",
      tokenFile: null,
      accessTokenExpiresInMs: null,
      accessTokenExpired: false,
      refreshTokenPresent: false,
      warnings: [],
      principalKind: "session",
      identity: "github",
      recoveryReason: "github_account_not_linked",
      recoveryDetail:
        "GitHub account @octojane started this Claude Code cloud session but is not linked to a Primitive account yet.",
    });
    expect(check).toEqual({
      name: "auth",
      status: "fail",
      detail:
        "session identity: GitHub account @octojane started this Claude Code cloud session but is not linked to a Primitive account yet.",
    });
  });
});

describe("doctor daemon check in Claude Code cloud sessions", () => {
  it("treats the cloud opt-out as healthy: capture delivers directly", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    expect(classifyDaemonHealth(null, { disabled: true })).toEqual({
      name: "daemon",
      status: "ok",
      detail: "not used in Claude Code cloud sessions; capture delivers directly",
    });
  });

  it("still fails an explicit stop on a developer machine", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "");
    expect(classifyDaemonHealth(null, { disabled: true })).toMatchObject({ status: "fail" });
  });
});

describe("doctor guidance in Claude Code cloud sessions", () => {
  const unbound = { status: "unbound", repositoryFullName: "campus-ai/demo-app" } as const;

  it("names the environment's credentials, not the sign-in a cloud session refuses", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const check = classifyAuthCredential(undefined, undefined, false);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET");
    expect(check.detail).not.toContain("prim auth login");
  });

  it("still names `prim auth login` on a developer machine", () => {
    expect(classifyAuthCredential(undefined, undefined, false).detail).toBe(
      "no token — run `prim auth login`",
    );
  });

  it("sends an unconnected repository's owner to their own machine", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    vi.stubEnv("PRIM_TOKEN", undefined);
    for (const active of [true, false]) {
      const detail = classifyRepositoryBinding(undefined, unbound, active).detail;
      expect(detail).toContain(
        "run `prim github connect` in a clone of it on your own machine, then start a new cloud session",
      );
      expect(detail).not.toContain("prim enable");
    }
  });

  it("keeps the direct command for a cloud session carrying a person's own token", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CONFIG_DIR", "/nonexistent/prim-config");
    for (const name of ["PRIM_M2M_CLIENT_ID", "PRIM_M2M_CLIENT_SECRET", "PRIM_M2M_CLIENT_AUTH"])
      vi.stubEnv(name, undefined);
    vi.stubEnv("PRIM_TOKEN", "person-token");
    expect(classifyRepositoryBinding(undefined, unbound, true).detail).toContain(
      "Run `prim github connect` to complete it.",
    );
  });

  it("keeps the direct command on a developer machine", () => {
    expect(classifyRepositoryBinding(undefined, unbound, true).detail).toContain(
      "Run `prim github connect` to complete it.",
    );
    expect(classifyRepositoryBinding(undefined, unbound, false).detail).toContain(
      "Run `prim github connect`, then `prim enable`.",
    );
  });
});
