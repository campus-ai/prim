import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

// Keep the real HttpError (and everything else); only swap getClient so the
// reconcile command talks to our mock transport.
vi.mock("../client.js", async (importActual) => {
  const actual = await importActual<typeof import("../client.js")>();
  return {
    ...actual,
    getClient: () => ({ post: mockPost, get: vi.fn() }),
  };
});

import { HttpError } from "../client.js";
import { performReconcile, registerReconcileCommands } from "./reconcile.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

function okBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    bypassId: "bp_1",
    decisionId: "k_decision",
    decisionShortId: "abc12345",
    conflictFlagId: "k_flag",
    issuedAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    reissued: false,
    ...overrides,
  };
}

beforeEach(() => {
  mockPost.mockReset();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.restoreAllMocks();
});

describe("performReconcile", () => {
  it("posts to the issue route and emits ok JSON + 'issued' verdict on success", async () => {
    mockPost.mockResolvedValueOnce(okBody());
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_abc12345");

    expect(mockPost).toHaveBeenCalledWith("/api/cli/reconcile/issue", {
      idOrShortId: "dec_abc12345",
    });
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile bypass issued for dec_abc12345"),
    );
    expect(stdoutSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
  });

  it("renders a reissue as 'reissued', not 'issued'", async () => {
    mockPost.mockResolvedValueOnce(okBody({ reissued: true }));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_abc12345");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile bypass reissued for dec_abc12345"),
    );
    expect(process.exitCode).toBe(0);
  });

  it("succeeds on a flag-less bypass (conflictFlagId undefined)", async () => {
    mockPost.mockResolvedValueOnce(okBody({ conflictFlagId: undefined }));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_abc12345");

    expect(process.exitCode).toBe(0);
  });

  it("passes --flag through as conflictFlagId in the issue body", async () => {
    mockPost.mockResolvedValueOnce(okBody());
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_short", { flag: "k_specificFlag" });

    expect(mockPost).toHaveBeenCalledWith("/api/cli/reconcile/issue", {
      idOrShortId: "dec_short",
      conflictFlagId: "k_specificFlag",
    });
  });

  it("omits conflictFlagId from the body when --flag is absent", async () => {
    mockPost.mockResolvedValueOnce(okBody());
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_short");

    expect(mockPost).toHaveBeenCalledWith("/api/cli/reconcile/issue", { idOrShortId: "dec_short" });
  });

  it("maps a 4xx domain rejection to exit 2 with the server message", async () => {
    mockPost.mockRejectedValueOnce(
      new HttpError(422, "No pending review flag for this decision — nothing to reconcile"),
    );
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile rejected: No pending review flag"),
    );
    expect(process.exitCode).toBe(2);
  });

  it("maps a 403 org-unbound to exit 2 (actionable), not a transport error", async () => {
    mockPost.mockRejectedValueOnce(new HttpError(403, "CLI token is not bound to an organization"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(process.exitCode).toBe(2);
  });

  it("maps a 5xx to exit 3 (transport/server)", async () => {
    mockPost.mockRejectedValueOnce(new HttpError(500, "HTTP 500"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile failed: HTTP 500"),
    );
    expect(process.exitCode).toBe(3);
  });

  it("maps a non-HTTP network failure to exit 3", async () => {
    mockPost.mockRejectedValueOnce(new Error("fetch failed"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(process.exitCode).toBe(3);
  });

  it("flags a malformed success body with exit 3", async () => {
    mockPost.mockResolvedValueOnce({ unknown: "shape" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile: malformed server response"),
    );
    expect(process.exitCode).toBe(3);
  });
});

describe("reconcile help", () => {
  it("describes the capability without asserting an organization feature state", () => {
    const program = new Command();
    registerReconcileCommands(program);
    const description = program.commands
      .find((command) => command.name() === "reconcile")
      ?.description();
    expect(description).toContain("Conflict Gates Enforcement");
    expect(description).not.toContain("not currently enabled");
  });
});
