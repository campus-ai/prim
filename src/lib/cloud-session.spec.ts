import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const humanCredential = vi.hoisted(() => ({ value: undefined as { token: string } | undefined }));
vi.mock("./credentials.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./credentials.js")>()),
  resolveAuthCredential: () => humanCredential.value,
}));

import { cloudAllowedDomains, cloudEgressRemedy, diagnoseCloudSession } from "./cloud-session.js";

const API = "https://api.getprimitive.ai";
let configDir: string;

function cloudEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { CLAUDE_CODE_REMOTE: "true", PRIM_CONFIG_DIR: configDir, ...extra };
}

const machineEnv = () =>
  cloudEnv({ PRIM_M2M_CLIENT_ID: "client_cloud", PRIM_M2M_CLIENT_SECRET: "secret" });

/** A fetch that refuses the listed hosts the way the cloud egress proxy does. */
function egress(blocked: string[]): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (blocked.includes(url.hostname))
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${url.hostname}`), {
          code: "ENOTFOUND",
        }),
      });
    return new Response(JSON.stringify({ issuer: "https://signin.getprimitive.ai" }));
  }) as typeof fetch;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "prim-cloud-session-"));
  humanCredential.value = undefined;
});
afterEach(() => rmSync(configDir, { recursive: true, force: true }));

describe("diagnoseCloudSession", () => {
  it("says nothing outside a Claude Code cloud session", async () => {
    expect(await diagnoseCloudSession({ env: { PRIM_CONFIG_DIR: configDir } })).toBeUndefined();
  });

  it("names the environment variables when no credential is present", async () => {
    const notice = await diagnoseCloudSession({ env: cloudEnv(), fetch: egress([]), siteUrl: API });
    expect(notice).toContain("has no credentials");
    expect(notice).toContain("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET");
  });

  it("names incomplete machine credentials", async () => {
    const notice = await diagnoseCloudSession({
      env: cloudEnv({ PRIM_M2M_CLIENT_ID: "client_cloud" }),
      fetch: egress([]),
      siteUrl: API,
    });
    expect(notice).toContain("PRIM_M2M_CLIENT_SECRET");
    expect(notice).toContain("To fix it");
  });

  it("does not blame the allowlist for a timeout or a TLS failure", async () => {
    const failing = (error: Error) => (async () => Promise.reject(error)) as typeof fetch;
    const timeout = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: failing(new DOMException("timed out", "TimeoutError")),
      siteUrl: API,
    });
    expect(timeout).toContain("did not answer in time");
    const tls = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: failing(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("self-signed"), { code: "SELF_SIGNED_CERT_IN_CHAIN" }),
        }),
      ),
      siteUrl: API,
    });
    expect(tls).toContain("could not be reached (SELF_SIGNED_CERT_IN_CHAIN)");
    expect(tls).not.toContain("cannot reach");
  });

  it("asks to remove a conflicting token rather than set more credentials", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: egress([]),
      siteUrl: API,
    });
    expect(notice).not.toContain("PRIM_TOKEN");
    const conflicting = await diagnoseCloudSession({
      env: { ...machineEnv(), PRIM_TOKEN: "human" },
      fetch: egress([]),
      siteUrl: API,
    });
    expect(conflicting).toMatch(/PRIM_TOKEN/u);
    expect(conflicting).not.toContain("To fix it, set PRIM_M2M_CLIENT_ID");
  });

  it("never probes an issuer that is not an HTTPS origin", async () => {
    const fetchSpy = vi.fn(
      (async () =>
        new Response(JSON.stringify({ issuer: "http://169.254.169.254/latest" }))) as typeof fetch,
    );
    await diagnoseCloudSession({ env: machineEnv(), fetch: fetchSpy, siteUrl: API });
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("blames an outage, not the allowlist, for a proxy's own 5xx", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: (async () =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: new Error("Proxy response (502) !== 200 when HTTP Tunneling"),
          }),
        )) as typeof fetch,
      siteUrl: API,
    });
    expect(notice).toContain("could not be reached");
  });

  it("names NODE_USE_ENV_PROXY in network-secret mode before probing", async () => {
    const fetchSpy = vi.fn(egress([]));
    const notice = await diagnoseCloudSession({
      env: cloudEnv({
        PRIM_M2M_CLIENT_ID: "client_cloud",
        PRIM_M2M_CLIENT_AUTH: "network-secret",
        HTTPS_PROXY: "http://127.0.0.1:3128",
      }),
      fetch: fetchSpy,
      siteUrl: API,
    });
    expect(notice).toContain("NODE_USE_ENV_PROXY=1");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("never adds the generic credential remedy to a network-secret configuration error", async () => {
    const notice = await diagnoseCloudSession({
      env: cloudEnv({ PRIM_M2M_CLIENT_AUTH: "network-secret" }),
      fetch: egress([]),
      siteUrl: API,
    });
    expect(notice).toContain("PRIM_M2M_CLIENT_AUTH=network-secret");
    expect(notice).not.toContain("PRIM_M2M_CLIENT_SECRET in the cloud environment");
  });

  it("reads a refused proxy tunnel as a blocked host", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: (async () =>
        Promise.reject(
          new TypeError("fetch failed", { cause: new Error("Request was cancelled") }),
        )) as typeof fetch,
      siteUrl: API,
    });
    expect(notice).toContain("cannot reach Primitive.");
  });

  it("names the committed declaration before probing when the checkout has no identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "prim-cloud-bundle-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
      const fetchSpy = vi.fn(egress([]));
      const notice = await diagnoseCloudSession({
        env: machineEnv(),
        fetch: fetchSpy,
        siteUrl: API,
        cwd: root,
      });
      expect(notice).toContain("records PRIM_REPOSITORY in .claude/settings.json");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fetches the API config once and reuses it for the sign-in host", async () => {
    const fetchSpy = vi.fn(egress([]));
    await diagnoseCloudSession({ env: machineEnv(), fetch: fetchSpy, siteUrl: API });
    expect(fetchSpy.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "api.getprimitive.ai",
      "signin.getprimitive.ai",
    ]);
  });

  it("names both allowed domains when the API host is blocked", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: egress(["api.getprimitive.ai", "signin.getprimitive.ai"]),
      siteUrl: API,
    });
    expect(notice).toContain("cannot reach Primitive.");
    expect(notice).toContain(
      "add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains",
    );
  });

  it("names the sign-in host when only it is blocked", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: egress(["signin.getprimitive.ai"]),
      siteUrl: API,
    });
    expect(notice).toContain("sign-in service");
  });

  it("points at setup --cloud when the hosts are reachable", async () => {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: egress([]),
      siteUrl: API,
    });
    expect(notice).toContain("prim setup --cloud");
  });

  it("accepts a stored human credential as present", async () => {
    humanCredential.value = { token: "human" };
    const notice = await diagnoseCloudSession({ env: cloudEnv(), fetch: egress([]), siteUrl: API });
    expect(notice).toContain("prim setup --cloud");
  });
});

describe("cloud egress guidance", () => {
  it("names the API host and the sign-in host once each", () => {
    expect(cloudAllowedDomains(API)).toEqual(["api.getprimitive.ai", "signin.getprimitive.ai"]);
    expect(cloudAllowedDomains("https://staging.example.com", "signin.example.com")).toEqual([
      "staging.example.com",
      "signin.example.com",
    ]);
    expect(cloudEgressRemedy(API)).toBe(
      "add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)",
    );
  });
});
