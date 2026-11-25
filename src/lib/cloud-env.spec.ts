import { describe, expect, it } from "vitest";
import { cloudDomainEditNote, cloudProxyRouting, cloudSetupPointer } from "./cloud-env.js";

describe("cloudProxyRouting", () => {
  const session = { CLAUDE_CODE_REMOTE: "true", HTTPS_PROXY: "http://127.0.0.1:3128" };

  it.each([
    [
      "the secret in the variables",
      { PRIM_M2M_CLIENT_ID: "client_a", PRIM_M2M_CLIENT_SECRET: "s" },
    ],
    [
      "a network secret",
      { PRIM_M2M_CLIENT_ID: "client_a", PRIM_M2M_CLIENT_AUTH: "network-secret" },
    ],
    [
      "a proxy-held token",
      { PRIM_M2M_CLIENT_ID: "client_a", PRIM_M2M_CLIENT_AUTH: "network-token" },
    ],
  ])("routes a cloud session with a proxy and %s", (_name, credentials) => {
    expect(cloudProxyRouting({ ...session, ...credentials })).toBe(true);
    expect(
      cloudProxyRouting({ CLAUDE_CODE_REMOTE: "true", https_proxy: "http://p:1", ...credentials }),
    ).toBe(true);
    // Not a cloud session, or no proxy to route through.
    expect(cloudProxyRouting({ HTTPS_PROXY: session.HTTPS_PROXY, ...credentials })).toBe(false);
    expect(cloudProxyRouting({ CLAUDE_CODE_REMOTE: "true", ...credentials })).toBe(false);
    expect(cloudProxyRouting({ ...session, HTTPS_PROXY: "", ...credentials })).toBe(false);
    expect(
      cloudProxyRouting({ CLAUDE_CODE_REMOTE: "true", HTTP_PROXY: "http://p:1", ...credentials }),
    ).toBe(false);
  });

  it("reads the proxy's name as Node does: lower case first, and an empty one names none", () => {
    const credentials = { CLAUDE_CODE_REMOTE: "true", PRIM_M2M_CLIENT_ID: "client_a" };
    expect(cloudProxyRouting({ ...credentials, https_proxy: "http://p:1", HTTPS_PROXY: "" })).toBe(
      true,
    );
    // Node would not use HTTPS_PROXY here, so the broker would not be routed by it.
    expect(cloudProxyRouting({ ...credentials, https_proxy: "", HTTPS_PROXY: "http://p:1" })).toBe(
      false,
    );
  });

  it("leaves a fixed token or a stored sign-in connecting directly", () => {
    expect(cloudProxyRouting(session)).toBe(false);
    expect(cloudProxyRouting({ ...session, PRIM_TOKEN: "human" })).toBe(false);
  });

  it("adds the in-session note to a domain remedy only where it routes", () => {
    expect(cloudDomainEditNote({ ...session, PRIM_M2M_CLIENT_ID: "client_a" })).toBe(
      "; the change takes effect in this session within about a minute",
    );
    expect(cloudDomainEditNote(session)).toBe("");
    expect(cloudDomainEditNote({})).toBe("");
  });
});

describe("cloudSetupPointer", () => {
  it("leaves the message alone outside a Claude Code cloud session", () => {
    expect(cloudSetupPointer("GitHub repo connection is required", {})).toBe(
      "GitHub repo connection is required",
    );
  });

  it("points at cloud setup, which names the cause, inside one", () => {
    expect(
      cloudSetupPointer("Machine authentication is cooling down. Retry later.", {
        CLAUDE_CODE_REMOTE: "true",
      }),
    ).toBe(
      "Machine authentication is cooling down. Retry later; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
    );
  });
});
