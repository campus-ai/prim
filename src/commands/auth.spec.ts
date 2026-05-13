import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", async () => {
  const actual = await vi.importActual<typeof import("../client.js")>("../client.js");
  return {
    ...actual,
    getAuthToken: vi.fn(),
    getTokenExpiresAt: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

import { existsSync } from "node:fs";
import { getAuthToken, getTokenExpiresAt } from "../client.js";
import { registerAuthCommands } from "./auth.js";

describe("registerAuthCommands", () => {
  it("registers the auth command group", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
  });

  it("registers login, set-token, clear, and status subcommands", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    const subcommands = auth?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("login");
    expect(subcommands).toContain("set-token");
    expect(subcommands).toContain("clear");
    expect(subcommands).toContain("status");
  });
});

describe("auth status --json", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a shaped JSON object and exits 0 when authenticated", async () => {
    vi.mocked(getAuthToken).mockReturnValue("tok");
    vi.mocked(getTokenExpiresAt).mockReturnValue(Date.now() + 60_000);
    vi.mocked(existsSync).mockReturnValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`exit:${code ?? 0}`);
      });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:0");

    const out = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(out.authenticated).toBe(true);
    expect(out.refreshTokenPresent).toBe(true);
    expect(out.accessTokenExpired).toBe(false);
    expect(typeof out.accessTokenExpiresInMs).toBe("number");
    expect(out.warnings).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("emits {authenticated: false} and exits 1 when unauthenticated", async () => {
    vi.mocked(getAuthToken).mockReturnValue(undefined);
    vi.mocked(getTokenExpiresAt).mockReturnValue(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`exit:${code ?? 0}`);
      });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:1");

    const out = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(out.authenticated).toBe(false);
    expect(out.tokenFile).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
