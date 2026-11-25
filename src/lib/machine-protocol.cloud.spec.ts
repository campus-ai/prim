import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverMachineConfiguration,
  rejectedCredentialsMessage,
  verifyMachineIdentity,
} from "./machine-protocol.js";

afterEach(() => vi.unstubAllEnvs());

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("machine authentication guidance in Claude Code cloud sessions", () => {
  it("names the host a cloud environment may be blocking", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(
      discoverMachineConfiguration("https://api.example.com", undefined, unreachable),
    ).rejects.toMatchObject({
      code: "authentication_unavailable",
      message:
        "Machine authentication could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited), then start a new cloud session (a running session keeps the network rules it started with).",
    });
  });

  it("keeps the connection advice on a developer machine", async () => {
    await expect(
      discoverMachineConfiguration("https://api.example.com", undefined, unreachable),
    ).rejects.toMatchObject({
      message: "Machine authentication is temporarily unavailable. Check the connection and retry.",
    });
  });

  it("says the same when the API, not the token service, rejects the machine", async () => {
    const forbidden = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const verify = () =>
      verifyMachineIdentity("https://api.example.com", "token", "client_1", undefined, forbidden);
    await expect(verify()).rejects.toMatchObject({
      message: expect.stringContaining("Ask your administrator"),
    });
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(verify()).rejects.toMatchObject({
      code: "machine_access_rejected",
      message: expect.stringContaining("The cloud environment's credentials were rejected"),
    });
  });

  it("sends a cloud session's owner to the environment, not to an administrator", () => {
    const local =
      "Machine credentials were rejected. Ask your administrator to rotate or enable them.";
    expect(rejectedCredentialsMessage(local, {})).toBe(local);
    const cloud = rejectedCredentialsMessage(local, { CLAUDE_CODE_REMOTE: "true" });
    expect(cloud).toContain("The cloud environment's credentials were rejected");
    expect(cloud).toContain("prim auth enroll --new-installation");
    expect(cloud).toContain("then start a new cloud session");
    expect(cloud).not.toContain("administrator");
  });
});
