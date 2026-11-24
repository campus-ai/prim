import { afterEach, describe, expect, it, vi } from "vitest";
import { discoverMachineConfiguration, rejectedCredentialsMessage } from "./machine-protocol.js";

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
        "Machine authentication could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited).",
    });
  });

  it("says the allowlist edit reaches the session where its requests ride the proxy", async () => {
    // As in the token broker of a cloud session with credentials in its variables.
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:3128");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    const failure = await discoverMachineConfiguration(
      "https://api.example.com",
      undefined,
      unreachable,
    ).catch((error: unknown) => error as Error);
    expect(failure.message).toBe(
      "Machine authentication could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited); the change takes effect in this session within about a minute.",
    );
    expect(failure.message).not.toMatch(/new (cloud )?session/u);
  });

  it("keeps the connection advice on a developer machine", async () => {
    await expect(
      discoverMachineConfiguration("https://api.example.com", undefined, unreachable),
    ).rejects.toMatchObject({
      message: "Machine authentication is temporarily unavailable. Check the connection and retry.",
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
