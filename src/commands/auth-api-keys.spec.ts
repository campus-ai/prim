import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { listUserApiKeys, mintUserApiKey, revokeUserApiKey } = vi.hoisted(() => ({
  listUserApiKeys: vi.fn(),
  mintUserApiKey: vi.fn(),
  revokeUserApiKey: vi.fn(),
}));

vi.mock("../auth/api-keys.js", () => ({
  listUserApiKeys,
  mintUserApiKey,
  revokeUserApiKey,
}));

import { registerAuthCommands } from "./auth.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

function program(): Command {
  const root = new Command().exitOverride();
  root.option("--non-interactive", "fail fast instead of prompting");
  registerAuthCommands(root);
  return root;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.exitCode = 0;
  listUserApiKeys.mockResolvedValue(0);
  mintUserApiKey.mockResolvedValue(0);
  revokeUserApiKey.mockResolvedValue(0);
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
});

describe("auth api-keys command registration", () => {
  it("registers only mint, list, and revoke management verbs", () => {
    const auth = program().commands.find((command) => command.name() === "auth");
    const keys = auth?.commands.find((command) => command.name() === "api-keys");
    expect(keys?.commands.map((command) => command.name())).toEqual(["mint", "list", "revoke"]);
  });

  it("mints with an exact name and optional epoch", async () => {
    await program().parseAsync(
      ["auth", "api-keys", "mint", "--name", "Primitive CLI", "--expires-at", "1800000000000"],
      { from: "user" },
    );

    expect(mintUserApiKey).toHaveBeenCalledWith({
      name: "Primitive CLI",
      expiresAt: 1_800_000_000_000,
    });
    expect(process.exitCode).toBe(0);
  });

  it("lists with canonical defaults and bounded cursor options", async () => {
    await program().parseAsync(
      ["auth", "api-keys", "list", "--limit", "25", "--after", "api_key_previous"],
      { from: "user" },
    );

    expect(listUserApiKeys).toHaveBeenCalledWith({
      limit: 25,
      after: "api_key_previous",
    });
  });

  it("passes invalid numeric text to the contract boundary as NaN", async () => {
    mintUserApiKey.mockResolvedValueOnce(2);
    await program().parseAsync(
      ["auth", "api-keys", "mint", "--name", "Primitive CLI", "--expires-at", "later"],
      { from: "user" },
    );

    expect(mintUserApiKey).toHaveBeenCalledWith({
      name: "Primitive CLI",
      expiresAt: Number.NaN,
    });
    expect(process.exitCode).toBe(2);
  });

  it("revokes the exact full API-key ID without a second inferred identifier", async () => {
    await program().parseAsync(["--non-interactive", "auth", "api-keys", "revoke", "api_key_1"], {
      from: "user",
    });

    expect(revokeUserApiKey).toHaveBeenCalledWith("api_key_1");
  });
});
