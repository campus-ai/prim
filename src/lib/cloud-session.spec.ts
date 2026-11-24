import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudAllowedDomains, cloudEgressRemedy, diagnoseCloudSession } from "./cloud-session.js";
import { tunnelCheckedFetch } from "./proxy-tunnel.js";

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

/**
 * Diagnose from a process whose requests ride a proxy, as one started with
 * NODE_USE_ENV_PROXY=1 does, against a stand-in proxy that answers every
 * CONNECT with `answer`. `reached` is the request itself, were one sent.
 */
async function diagnoseThroughProxy(answer: number | "close") {
  const proxy = createServer();
  proxy.on("connect", (_request, socket: Duplex) => {
    if (answer === "close") socket.destroy();
    else socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const reached = vi.fn(egress([]));
  try {
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: tunnelCheckedFetch({
        env: {
          NODE_USE_ENV_PROXY: "1",
          HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
        },
        fetch: reached,
      }),
      siteUrl: API,
    });
    return { notice, reached };
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "prim-cloud-session-"));
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

  it.each([
    ["its own 502", 502, "(502)"],
    ["its own 503", 503, "(503)"],
    ["a demand for credentials", 407, "(407)"],
    ["hanging up without an answer", "close", "(closed)"],
  ] as const)(
    "blames the proxy, not the allowlist, for %s to a CONNECT",
    async (_name, answer, detail) => {
      const { notice, reached } = await diagnoseThroughProxy(answer);
      expect(notice).toBe(
        `Primitive is not connected in this Claude Code cloud session: the cloud environment's proxy could not open a connection to Primitive ${detail}. That is a fault in the proxy, not the Allowed domains list; retry shortly.`,
      );
      // No instruction to add a domain the user may already have allowed.
      expect(notice).not.toContain("add api.getprimitive.ai");
      expect(notice).not.toContain("cannot reach");
      expect(reached).not.toHaveBeenCalled();
    },
  );

  it("never probes the sign-in service when the proxy holds the token", async () => {
    // In network-token mode the proxy requests tokens from outside the VM, so
    // a blocked sign-in host is not a fault.
    const fetchSpy = vi.fn(egress(["signin.getprimitive.ai"]));
    const notice = await diagnoseCloudSession({
      env: cloudEnv({ PRIM_M2M_CLIENT_ID: "client_cloud", PRIM_M2M_CLIENT_AUTH: "network-token" }),
      fetch: fetchSpy,
      siteUrl: API,
    });
    expect(notice).not.toContain("sign-in service");
    expect(notice).toContain("prim setup --cloud");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("asks only for the API host when the proxy holds the token", async () => {
    const notice = await diagnoseCloudSession({
      env: cloudEnv({ PRIM_M2M_CLIENT_ID: "client_cloud", PRIM_M2M_CLIENT_AUTH: "network-token" }),
      fetch: egress(["api.getprimitive.ai"]),
      siteUrl: API,
    });
    expect(notice).toContain("add api.getprimitive.ai to the cloud environment's Allowed domains");
    expect(notice).not.toContain("signin.getprimitive.ai");
  });

  it("asks nothing of the VM's Node settings in network-secret mode", async () => {
    // The token broker routes itself through the proxy; a session whose
    // variables lack NODE_USE_ENV_PROXY is configured correctly.
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
    expect(notice).not.toContain("NODE_USE_ENV_PROXY");
    expect(notice).toContain("prim setup --cloud");
    expect(fetchSpy).toHaveBeenCalled();
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

  it("reads the proxy's 403 to a CONNECT as a blocked host", async () => {
    const { notice, reached } = await diagnoseThroughProxy(403);
    expect(notice).toContain("cannot reach Primitive.");
    expect(notice).toContain(
      "add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains",
    );
    expect(reached).not.toHaveBeenCalled();
  });

  it("does not take the text of a failed request for the proxy's verdict", async () => {
    // Node's fetch says this of every CONNECT answer but 200, outage or refusal.
    const notice = await diagnoseCloudSession({
      env: machineEnv(),
      fetch: (async () =>
        Promise.reject(
          new TypeError("fetch failed", { cause: new Error("Request was cancelled.") }),
        )) as typeof fetch,
      siteUrl: API,
    });
    expect(notice).toContain("could not be reached (network error)");
    expect(notice).not.toContain("cannot reach");
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
    writeFileSync(join(configDir, "token"), "human\n", { mode: 0o600 });
    const notice = await diagnoseCloudSession({ env: cloudEnv(), fetch: egress([]), siteUrl: API });
    expect(notice).toContain("prim setup --cloud");
  });
});

describe("diagnoseCloudSession where prim's requests ride the environment's proxy", () => {
  const PROXY = "http://127.0.0.1:3128";
  const routedEnv = (extra: NodeJS.ProcessEnv = {}) => ({
    ...machineEnv(),
    HTTPS_PROXY: PROXY,
    ...extra,
  });
  const IN_SESSION = "; the change takes effect in this session within about a minute";
  // What this process's own connections do in a session created before the
  // hosts were allowed: direct DNS never learns of the edit.
  const directDns = vi.fn(egress(["api.getprimitive.ai", "signin.getprimitive.ai"]));

  beforeEach(() => {
    directDns.mockClear();
    vi.stubGlobal("fetch", directDns);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("does not report a host as blocked that only direct DNS cannot resolve", async () => {
    const brokerProbe = vi.fn(async () => ({
      api: "ok",
      signIn: { host: "signin.getprimitive.ai", result: "ok" },
    }));
    const env = routedEnv();
    const notice = await diagnoseCloudSession({ env, brokerProbe, siteUrl: API });
    expect(notice).toBe(
      "Primitive is not connected in this Claude Code cloud session: the repository could not be connected. Run `prim setup --cloud` for details.",
    );
    expect(brokerProbe).toHaveBeenCalledExactlyOnceWith({ env });
    expect(directDns).not.toHaveBeenCalled();
  });

  it("still reports a host the proxy refuses, and says the fix reaches this session", async () => {
    const notice = await diagnoseCloudSession({
      env: routedEnv(),
      brokerProbe: async () => ({ api: "blocked" }),
      siteUrl: API,
    });
    expect(notice).toBe(
      `Primitive is not connected in this Claude Code cloud session: this environment cannot reach Primitive. To fix it, add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)${IN_SESSION}.`,
    );
    expect(notice).not.toMatch(/new (cloud )?session/u);
    expect(directDns).not.toHaveBeenCalled();
  });

  it("names the sign-in host the proxy refuses", async () => {
    const notice = await diagnoseCloudSession({
      env: routedEnv(),
      brokerProbe: async () => ({
        api: "ok",
        signIn: { host: "signin.example.com", result: "blocked" },
      }),
      siteUrl: API,
    });
    expect(notice).toContain("cannot reach Primitive's sign-in service.");
    expect(notice).toContain(
      `add api.getprimitive.ai and signin.example.com to the cloud environment's Allowed domains (Network access: Limited)${IN_SESSION}.`,
    );
  });

  it("keeps a timeout and an outage apart from the allowlist", async () => {
    const report = (api: string) =>
      diagnoseCloudSession({ env: routedEnv(), brokerProbe: async () => ({ api }), siteUrl: API });
    expect(await report("timeout")).toContain("Primitive did not answer in time.");
    expect(await report("ECONNRESET")).toContain("Primitive could not be reached (ECONNRESET).");
    // What the broker reports when the proxy itself fails a CONNECT.
    for (const failure of ["PROXY_502", "PROXY_CLOSED"]) {
      const notice = await report(failure);
      expect(notice).toContain("That is a fault in the proxy, not the Allowed domains list");
      expect(notice).not.toContain("add api.getprimitive.ai");
    }
    const signInFailure = await diagnoseCloudSession({
      env: routedEnv(),
      brokerProbe: async () => ({
        api: "ok",
        signIn: { host: "signin.getprimitive.ai", result: "PROXY_503" },
      }),
      siteUrl: API,
    });
    expect(signInFailure).toContain(
      "the cloud environment's proxy could not open a connection to Primitive's sign-in service (503).",
    );
  });

  it("asks the broker in every credential mode, and only for the API host when the proxy holds the token", async () => {
    for (const auth of ["network-secret", "network-token"]) {
      const brokerProbe = vi.fn(async () => ({ api: "blocked" }));
      const notice = await diagnoseCloudSession({
        env: cloudEnv({
          PRIM_M2M_CLIENT_ID: "client_cloud",
          PRIM_M2M_CLIENT_AUTH: auth,
          HTTPS_PROXY: PROXY,
        }),
        brokerProbe,
        siteUrl: API,
      });
      expect(brokerProbe).toHaveBeenCalledOnce();
      expect(notice).toContain(
        auth === "network-token"
          ? `add api.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)${IN_SESSION}.`
          : `add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)${IN_SESSION}.`,
      );
    }
    expect(directDns).not.toHaveBeenCalled();
  });

  it("claims no blocked host when the broker cannot be asked", async () => {
    const notice = await diagnoseCloudSession({
      env: routedEnv(),
      brokerProbe: async () => {
        throw new Error("broker unavailable");
      },
      siteUrl: API,
    });
    expect(notice).toContain("Run `prim setup --cloud` for details.");
    expect(notice).not.toContain("Allowed domains");
    expect(directDns).not.toHaveBeenCalled();
  });

  it("probes from this process where prim connects directly: no proxy, or a credential that is not the environment's", async () => {
    const brokerProbe = vi.fn(async () => ({ api: "ok" }));
    const BLOCKED =
      "Primitive is not connected in this Claude Code cloud session: this environment cannot reach Primitive. To fix it, add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited).";
    // Machine credentials with no proxy to route through.
    expect(await diagnoseCloudSession({ env: machineEnv(), brokerProbe, siteUrl: API })).toBe(
      BLOCKED,
    );
    // PRIM_TOKEN and a stored sign-in still connect directly, proxy or not.
    expect(
      await diagnoseCloudSession({
        env: cloudEnv({ PRIM_TOKEN: "human", HTTPS_PROXY: PROXY }),
        brokerProbe,
        siteUrl: API,
      }),
    ).toBe(BLOCKED);
    writeFileSync(join(configDir, "token"), "human\n", { mode: 0o600 });
    expect(
      await diagnoseCloudSession({
        env: cloudEnv({ HTTPS_PROXY: PROXY }),
        brokerProbe,
        siteUrl: API,
      }),
    ).toBe(BLOCKED);
    expect(brokerProbe).not.toHaveBeenCalled();
    expect(directDns).toHaveBeenCalledTimes(3);
  });
});

describe("cloud egress guidance", () => {
  it("says a domain edit reaches the running session only where prim's requests ride the proxy", () => {
    const routed = {
      CLAUDE_CODE_REMOTE: "true",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      PRIM_M2M_CLIENT_ID: "client_cloud",
      PRIM_M2M_CLIENT_SECRET: "secret",
    };
    const plain =
      "add api.getprimitive.ai and signin.getprimitive.ai to the cloud environment's Allowed domains (Network access: Limited)";
    expect(cloudEgressRemedy(API, undefined, routed)).toBe(
      `${plain}; the change takes effect in this session within about a minute`,
    );
    const { HTTPS_PROXY: _proxy, ...unproxied } = routed;
    expect(cloudEgressRemedy(API, undefined, unproxied)).toBe(plain);
    expect(
      cloudEgressRemedy(API, undefined, {
        CLAUDE_CODE_REMOTE: "true",
        HTTPS_PROXY: "http://127.0.0.1:3128",
        PRIM_TOKEN: "human",
      }),
    ).toBe(plain);
  });

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
