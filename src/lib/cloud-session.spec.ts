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
    if (blocked.includes(url.hostname)) throw new TypeError("fetch failed");
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
    expect(notice).toContain("incomplete");
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
