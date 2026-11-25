import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Session identity end to end against a local fixture of Primitive's server
 * and a local bare repository standing in for GitHub. The fixture plays the
 * GitHub App too: a challenge verifies once the session branch exists in the
 * bare repository at the challenge's base commit, which is what the push
 * webhook's sender proves in production.
 */

const environment = vi.hoisted(() => ({ token: "env_token_1", acquisitions: 0 }));
// The environment credential comes from the token broker in a real VM; here it
// is a fixed token the fixture accepts for the session-identity routes only.
vi.mock("./machine-broker.js", () => ({
  acquireBrokerCredential: vi.fn(
    async (options: {
      apiUrl: string;
      environment: { clientId: string; generation: string };
    }) => {
      environment.acquisitions++;
      return {
        issuer: "https://auth.example.test",
        audience: "client_audience",
        machineId: "machine_env",
        clientId: options.environment.clientId,
        organizationId: "org_1",
        workosOrganizationId: "org_workos",
        displayName: "Team cloud",
        scopes: ["cli:session-identity"],
        accessToken: environment.token,
        expiresAt: Date.now() + 3_600_000,
        apiUrl: options.apiUrl,
        generation: options.environment.generation,
        storage: "environment",
      };
    },
  ),
  forwardBrokerRequest: vi.fn(),
}));
vi.mock("./workos-connect.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./workos-connect.js")>()),
  discoverWorkosConnect: vi.fn(async () => ({
    state: "available",
    configuration: {
      issuer: "https://signin.example.test",
      clientId: "client_connect",
      scopes: [],
    },
  })),
  requestWorkosDeviceAuthorization: vi.fn(async () => ({
    deviceCode: "device-code",
    userCode: "WXYZ-1234",
    verificationUri: "https://signin.example.test/device",
    verificationUriComplete: "https://signin.example.test/device?user_code=WXYZ-1234",
    expiresIn: 600,
    interval: 1,
  })),
  pollWorkosDeviceAuthorization: vi.fn(async () => ({
    accessToken: "human_token",
    refreshToken: "human_refresh",
    expiresIn: 300,
  })),
}));
vi.mock("../flusher.js", () => ({ flush: vi.fn(async () => ({ flushed: 0, quarantined: 0 })) }));

const CLIENT_ID = "client_env";
const BRANCH = "claude/fervent-test-abc123";
const USER = { id: "user_jane", displayName: "Jane Doe" };

type Call = { method: string; path: string; auth?: string; body?: Record<string, unknown> };
type Fixture = {
  url: string;
  server: Server;
  calls: Call[];
  challenges: Map<string, { branch: string; baseSha: string; expiresAt: number }>;
  linked: Set<string>;
  login: string;
  connected: boolean;
  webhook: boolean;
  reject?: string;
  refreshFails: boolean;
  /** The refresh route's error when it refuses; the server's is invalid_session_token. */
  refreshError: string;
  /** Canned refusals, as the server words them. */
  tokenRefusal?: { status: number; body: Record<string, unknown> };
  linkRefusal?: { status: number; body: Record<string, unknown> };
  challengeRefusal?: { status: number; body: Record<string, unknown> };
  refreshAfterMs: number;
  tokens: Map<string, number>;
  issued: number;
  bare: string;
};

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}
function remoteBranch(bare: string, branch = BRANCH): string | undefined {
  try {
    return git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : undefined;
}

function sessionStatus() {
  return {
    authenticated: true,
    organizationBindingVersion: 3,
    captureAuthorityKind: "workos_m2m",
    organizationId: "org_1",
    workosOrganizationId: "org_workos",
    principal: {
      kind: "machine",
      machineId: "machine_env",
      clientId: CLIENT_ID,
      displayName: "Team cloud",
      scopes: ["cli:read", "cli:capture"],
      authorizedUserId: USER.id,
    },
  };
}

async function startFixture(bare: string): Promise<Fixture> {
  const fixture = {
    calls: [] as Call[],
    challenges: new Map(),
    linked: new Set<string>(["octojane"]),
    login: "octojane",
    connected: true,
    webhook: true,
    refreshFails: false,
    refreshError: "invalid_session_token",
    refreshAfterMs: 6 * 3_600_000,
    tokens: new Map<string, number>(),
    issued: 0,
    bare,
  } as Omit<Fixture, "url" | "server">;
  const issue = () => {
    const token = `prim_sess_${++fixture.issued}`;
    const expiresAt = Date.now() + 12 * 3_600_000;
    fixture.tokens.set(token, expiresAt);
    return {
      accessToken: token,
      expiresAt,
      refreshAfter: Date.now() + fixture.refreshAfterMs,
      user: USER,
      organizationId: "org_1",
    };
  };
  const server = createServer(async (request, response) => {
    const path = request.url ?? "/";
    const auth = request.headers.authorization;
    const body = await readBody(request);
    fixture.calls.push({ method: request.method ?? "GET", path, auth, body });
    const reply = (status: number, value: unknown) => {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(value));
    };
    const environmentAuth = auth === `Bearer ${environment.token}`;
    const session = auth?.startsWith("Bearer prim_sess_")
      ? fixture.tokens.get(auth.slice("Bearer ".length))
      : undefined;
    const sessionValid = session !== undefined && session > Date.now();
    if (
      path.startsWith("/api/cli/session-identity/") &&
      !path.endsWith("/link") &&
      !environmentAuth
    )
      return reply(401, { error: "unauthorized" });
    if (path === "/api/cli/session-identity/challenge" && request.method === "POST") {
      if (!fixture.connected) return reply(404, { error: "repository_not_connected" });
      if (fixture.challengeRefusal)
        return reply(fixture.challengeRefusal.status, fixture.challengeRefusal.body);
      // Like the server: one open (unpushed, unexpired) challenge per branch.
      const open = [...fixture.challenges.values()].some(
        (row) =>
          row.branch === body?.branch &&
          row.expiresAt > Date.now() &&
          remoteBranch(bare, row.branch) === undefined,
      );
      if (open) return reply(409, { error: "challenge_already_open" });
      const id = `challenge_${fixture.challenges.size + 1}`;
      const expiresAt = Date.now() + 300_000;
      fixture.challenges.set(id, {
        branch: String(body?.branch),
        baseSha: String(body?.baseSha),
        expiresAt,
      });
      return reply(200, { challengeId: id, ref: `refs/heads/${String(body?.branch)}`, expiresAt });
    }
    const status = /^\/api\/cli\/session-identity\/challenge\/(.+)$/u.exec(path);
    if (status && request.method === "GET") {
      const challenge = fixture.challenges.get(decodeURIComponent(status[1] ?? ""));
      if (!challenge) return reply(404, { error: "not_found" });
      // GitHub's push webhook, as the bare repository records it.
      const pushed = fixture.webhook && remoteBranch(bare, challenge.branch) === challenge.baseSha;
      if (!pushed) return reply(200, { status: "pending" });
      if (fixture.reject) return reply(200, { status: "rejected", reason: fixture.reject });
      return reply(200, {
        status: "verified",
        githubLogin: fixture.login,
        linked: fixture.linked.has(fixture.login),
      });
    }
    if (path === "/api/cli/session-identity/token") {
      if (fixture.tokenRefusal)
        return reply(fixture.tokenRefusal.status, fixture.tokenRefusal.body);
      if (!fixture.linked.has(fixture.login))
        return reply(409, { error: "github_account_not_linked", githubLogin: fixture.login });
      return reply(200, issue());
    }
    if (path === "/api/cli/session-identity/token/refresh") {
      if (fixture.refreshFails || !fixture.tokens.has(String(body?.accessToken)))
        return reply(401, { error: fixture.refreshError });
      return reply(200, issue());
    }
    if (path === "/api/cli/session-identity/link") {
      if (auth !== "Bearer human_token") return reply(401, { error: "unauthorized" });
      if (fixture.linkRefusal) return reply(fixture.linkRefusal.status, fixture.linkRefusal.body);
      fixture.linked.add(fixture.login);
      return reply(200, { linked: true, githubLogin: fixture.login });
    }
    if (path === "/api/cli/auth/status")
      return sessionValid ? reply(200, sessionStatus()) : reply(401, { error: "unauthorized" });
    if (path === "/api/cli/decisions/recent")
      return sessionValid ? reply(200, { decisions: [] }) : reply(401, { error: "unauthorized" });
    if (path === "/api/cli/repositories/bind") return reply(404, { error: "not_connected" });
    reply(404, { error: "unexpected" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no address");
  return Object.assign(fixture, { url: `http://127.0.0.1:${address.port}`, server }) as Fixture;
}

let fixture: Fixture;
let work: string;
let config: string;
let baseSha: string;
let hookMarker: string;

async function fresh() {
  vi.resetModules();
  return {
    identity: await import("./session-identity.js"),
    machine: await import("./machine-credentials.js"),
    client: await import("../client.js"),
    journal: await import("../journal-organization.js"),
  };
}

const quick = { pollBudgetMs: 4_000 };
const identifyNow = async (modules?: Awaited<ReturnType<typeof fresh>>) =>
  (modules ?? (await fresh())).identity.ensureSessionIdentity({ cwd: work, explicit: true }, quick);

const challengeCalls = () =>
  fixture.calls.filter(
    (call) => call.method === "POST" && call.path === "/api/cli/session-identity/challenge",
  );
const apiCalls = () =>
  fixture.calls.filter(
    (call) =>
      !call.path.startsWith("/api/cli/session-identity/") && call.path !== "/api/cli/auth/status",
  );

beforeEach(async () => {
  const bare = temp("prim-identity-remote-");
  git(bare, "init", "--bare", "--quiet");
  work = temp("prim-identity-work-");
  config = temp("prim-identity-config-");
  git(work, "init", "--quiet", "-b", "main");
  git(work, "config", "user.email", "jane@example.com");
  git(work, "config", "user.name", "Jane");
  git(work, "commit", "--quiet", "--allow-empty", "-m", "base");
  git(work, "remote", "add", "origin", "https://github.com/acme/widgets.git");
  // origin names the GitHub repository; its pushes and fetches land in `bare`.
  git(work, "config", `url.${bare}.insteadOf`, "https://github.com/acme/widgets.git");
  git(work, "push", "--quiet", "origin", "main");
  git(work, "checkout", "--quiet", "-b", BRANCH);
  baseSha = git(work, "rev-parse", "HEAD");
  // Any hook that ran for the identity push would leave this marker and fail it.
  hookMarker = join(temp("prim-identity-hook-"), "ran");
  const hook = join(work, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\ntouch '${hookMarker}'\nexit 1\n`);
  chmodSync(hook, 0o755);

  fixture = await startFixture(bare);
  environment.acquisitions = 0;
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
  vi.stubEnv("PRIM_CLOUD_IDENTITY", "session");
  vi.stubEnv("PRIM_M2M_CLIENT_ID", CLIENT_ID);
  vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "environment-secret");
  vi.stubEnv("PRIM_M2M_CLIENT_AUTH", undefined);
  vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "session_01");
  vi.stubEnv("CLAUDE_CODE_USER_EMAIL", "jane@example.com");
  vi.stubEnv("PRIM_API_URL", fixture.url);
  vi.stubEnv("PRIM_CONFIG_DIR", config);
  vi.stubEnv("PRIM_TOKEN", undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mode detection", () => {
  it("needs a cloud session, PRIM_CLOUD_IDENTITY=session, and the environment credential", async () => {
    const { identity } = await fresh();
    const env = {
      CLAUDE_CODE_REMOTE: "true",
      PRIM_CLOUD_IDENTITY: "session",
      PRIM_M2M_CLIENT_ID: CLIENT_ID,
    };
    expect(identity.sessionIdentityMode({ env })).toBe(true);
    expect(identity.sessionIdentityMode({ env: { ...env, CLAUDE_CODE_REMOTE: "" } })).toBe(false);
    expect(identity.sessionIdentityMode({ env: { ...env, PRIM_CLOUD_IDENTITY: "" } })).toBe(false);
    expect(identity.sessionIdentityMode({ env: { ...env, PRIM_M2M_CLIENT_ID: undefined } })).toBe(
      false,
    );
  });

  it("leaves a cloud session without PRIM_CLOUD_IDENTITY on the environment credential", async () => {
    vi.stubEnv("PRIM_CLOUD_IDENTITY", undefined);
    const { machine } = await fresh();
    expect((await machine.acquireMachineCredential())?.accessToken).toBe(environment.token);
    expect(machine.cachedMachineCredential()?.session).toBeUndefined();
    expect(fixture.calls).toEqual([]);
    expect(remoteBranch(fixture.bare)).toBeUndefined();
  });
});

describe("identifying a session", () => {
  it("creates the session branch, waits for GitHub's notice, and sends every API call as the member", async () => {
    const modules = await fresh();
    // Before identity is known, a capture names no one and waits.
    expect(modules.machine.machineContext()).toBeUndefined();
    const pendingActor = modules.machine.machineCaptureActor();
    expect(pendingActor && modules.machine.identityPending(pendingActor)).toBe(true);

    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({
      status: "ok",
      displayName: "Jane Doe",
      githubLogin: "octojane",
    });

    // The session branch now exists on "GitHub", at the starting commit, and
    // no hook ran for that push.
    expect(remoteBranch(fixture.bare)).toBe(baseSha);
    expect(existsSync(hookMarker)).toBe(false);
    expect(challengeCalls()).toHaveLength(1);
    expect(challengeCalls()[0]?.body).toEqual({
      repositoryFullName: "acme/widgets",
      claudeSessionId: "session_01",
      branch: BRANCH,
      baseSha,
      userEmailHint: "jane@example.com",
    });
    expect(challengeCalls()[0]?.auth).toBe(`Bearer ${environment.token}`);

    // Cached owner-only, keyed to the session, never in the clear elsewhere.
    const cached = readdirSync(config).filter((name) => name.startsWith("session_identity_"));
    expect(cached).toHaveLength(1);
    expect(statSync(join(config, cached[0] ?? "")).mode & 0o777).toBe(0o600);

    const client = modules.client.getClient();
    expect(await client.get("/api/cli/decisions/recent")).toEqual({ decisions: [] });
    const recent = fixture.calls.filter((call) => call.path === "/api/cli/decisions/recent");
    expect(recent.map((call) => call.auth)).toEqual(["Bearer prim_sess_1"]);
    // The environment credential is used only for the session-identity routes.
    expect(
      fixture.calls
        .filter((call) => call.auth === `Bearer ${environment.token}`)
        .every((call) => call.path.startsWith("/api/cli/session-identity/")),
    ).toBe(true);

    // Captures are now attributed to the member, and what was captured before
    // identity was known is delivered under the same member.
    const actor = modules.machine.machineCaptureActor();
    expect(actor).toMatchObject({ clientId: CLIENT_ID, authorizedUserId: USER.id });
    const pendingBucket = modules.machine.machinePendingBucket(pendingActor as never);
    const memberBucket = modules.machine.machineJournalBucket(actor as never);
    const inspection = await modules.journal.inspectJournalDelivery([pendingBucket, memberBucket]);
    expect(inspection.binding).toMatchObject({ authorizedUserId: USER.id, clientId: CLIENT_ID });
    expect([...inspection.deliverableBuckets].sort()).toEqual([pendingBucket, memberBucket].sort());
  });

  it("pushes only the session branch, whatever the checkout's push settings", async () => {
    // Settings that would otherwise send more than the branch with it.
    git(work, "config", "push.followTags", "true");
    git(work, "config", "push.gpgSign", "if-asked");
    git(work, "tag", "-a", "local-only", "-m", "not for GitHub");
    const refs = () => git(fixture.bare, "for-each-ref", "--format=%(refname)").split("\n");
    const before = refs();

    expect(await identifyNow()).toMatchObject({ status: "ok" });

    expect(refs()).toEqual([...before, `refs/heads/${BRANCH}`].sort());
    expect(git(fixture.bare, "tag", "--list")).toBe("");
    expect(remoteBranch(fixture.bare)).toBe(baseSha);
  });

  it("keeps prim's credentials out of every git process the push starts", async () => {
    // A local remote runs its hooks with the pushing git's environment.
    const dump = join(temp("prim-identity-env-"), "env");
    const hook = join(fixture.bare, "hooks", "post-receive");
    writeFileSync(hook, `#!/bin/sh\nenv > '${dump}'\n`);
    chmodSync(hook, 0o755);
    vi.stubEnv("PRIM_TEST_MARKER", "visible");

    // Only the push matters here, not how long the notice takes under load.
    await identifyNow();
    expect(remoteBranch(fixture.bare)).toBe(baseSha);

    const seen = readFileSync(dump, "utf8");
    expect(seen).toContain("PRIM_TEST_MARKER=visible");
    expect(seen).not.toContain("environment-secret");
    expect(seen).not.toMatch(/^PRIM_M2M_|^PRIM_TOKEN=/mu);
    const { gitChildEnvironment } = await import("./git.js");
    expect(
      gitChildEnvironment({
        PATH: "/bin",
        PRIM_TOKEN: "t",
        PRIM_M2M_CLIENT_ID: "c",
        PRIM_M2M_CLIENT_SECRET: "s",
        PRIM_M2M_CLIENT_AUTH: "network-secret",
        PRIM_API_URL: "https://api.example.test",
      }),
    ).toEqual({ PATH: "/bin", PRIM_API_URL: "https://api.example.test" });
  });

  it("reports the member in auth status and doctor, and why not before", async () => {
    await fresh();
    const before = await (await import("../commands/auth.js")).verifyAuthStatus();
    expect(before).toMatchObject({
      authenticated: false,
      principalKind: "session",
      identity: "github",
      recoveryReason: "not_identified",
    });
    expect(challengeCalls()).toHaveLength(0);

    await identifyNow();
    await fresh();
    const { verifyAuthStatus } = await import("../commands/auth.js");
    const { classifySessionAuth } = await import("../commands/doctor.js");
    const status = await verifyAuthStatus();
    expect(status).toMatchObject({
      authenticated: true,
      status: "valid",
      principalKind: "session",
      identity: "github",
      displayName: "Jane Doe",
      githubLogin: "octojane",
      authorizedUserId: USER.id,
      organizationId: "org_1",
    });
    expect(JSON.stringify(status)).not.toContain("prim_sess_");
    expect(classifySessionAuth(status)).toEqual({
      name: "auth",
      status: "ok",
      detail: expect.stringMatching(
        /^session attributed to Jane Doe \(GitHub @octojane\) · identified through GitHub · expires in \d+s$/u,
      ),
    });
  });

  it("reuses the cached token in later processes without a second push", async () => {
    await identifyNow();
    const later = await fresh();
    expect(await identifyNow(later)).toMatchObject({ status: "ok", reused: true });
    const credential = await later.machine.acquireMachineCredential();
    expect(credential?.accessToken).toBe("prim_sess_1");
    expect(credential?.session).toMatchObject({ displayName: "Jane Doe" });
    expect(challengeCalls()).toHaveLength(1);
  });

  it("runs one challenge when several processes start at once", async () => {
    const processes = await Promise.all([fresh(), fresh(), fresh()].map((p) => p));
    const outcomes = await Promise.all(processes.map((modules) => identifyNow(modules)));
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok"]);
    expect(challengeCalls()).toHaveLength(1);
    expect(new Set(outcomes.map((o) => o.status === "ok" && o.credential.accessToken))).toEqual(
      new Set(["prim_sess_1"]),
    );
  });

  it("refreshes before refreshAfter passes, and only once across processes", async () => {
    fixture.refreshAfterMs = 1_000;
    await identifyNow();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 2_000);
    const processes = [await fresh(), await fresh()];
    const credentials = await Promise.all(
      processes.map((modules) => modules.machine.acquireMachineCredential()),
    );
    expect(credentials.map((credential) => credential?.accessToken)).toEqual([
      "prim_sess_2",
      "prim_sess_2",
    ]);
    expect(
      fixture.calls.filter((call) => call.path === "/api/cli/session-identity/token/refresh"),
    ).toHaveLength(1);
    expect(challengeCalls()).toHaveLength(1);
  });

  it("after a refused refresh of an expired token, names it and pushes nothing", async () => {
    fixture.refreshAfterMs = 1_000;
    await identifyNow();
    fixture.refreshFails = true;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 13 * 3_600_000);
    const outcome = await identifyNow();
    expect(outcome).toMatchObject({ status: "failed", code: "session_revoked" });
    expect(challengeCalls()).toHaveLength(1);
  });
});

describe("when the session cannot be identified", () => {
  it("asks the person to link once, then links with a device sign-in", async () => {
    fixture.linked.clear();
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "link_required", githubLogin: "octojane" });
    if (outcome.status !== "link_required") throw new Error("expected link_required");
    expect(modules.identity.sessionIdentityMessage(outcome)).toBe(
      "GitHub account @octojane started this Claude Code cloud session but is not linked to a Primitive account yet. To link it once, run `prim auth link` and sign in at the URL it prints with the code it shows; later sessions then identify you automatically.",
    );
    // Nothing is sent as anyone in the meantime.
    await expect(modules.client.getClient().get("/api/cli/decisions/recent")).rejects.toMatchObject(
      { status: 503 },
    );
    expect(apiCalls()).toEqual([]);

    // `prim auth link`, as the agent runs it.
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value: string) => {
      stderr.push(String(value));
    });
    vi.spyOn(console, "log").mockImplementation((value: string) => {
      stdout.push(String(value));
    });
    const linker = await fresh();
    const { registerAuthCommands } = await import("../commands/auth.js");
    const program = new Command();
    registerAuthCommands(program);
    const cwd = process.cwd();
    process.chdir(work);
    try {
      await program.parseAsync(["node", "prim", "auth", "link"]);
    } finally {
      process.chdir(cwd);
    }
    expect(stderr.join("\n")).toContain(
      "Authenticate at:\nhttps://signin.example.test/device?user_code=WXYZ-1234",
    );
    expect(stderr.join("\n")).toContain("Verification code: WXYZ-1234");
    expect(stderr.join("\n")).toContain(
      "Linked GitHub account @octojane to Jane Doe. This session's work is now attributed to Jane Doe",
    );
    expect(JSON.parse(stdout.join("\n"))).toMatchObject({
      status: "ok",
      linked: true,
      identity: "github",
      displayName: "Jane Doe",
    });
    const link = fixture.calls.find((call) => call.path === "/api/cli/session-identity/link");
    expect(link).toMatchObject({
      auth: "Bearer human_token",
      body: { challengeId: "challenge_1" },
    });
    // The human sign-in is used once and stored nowhere; no token is printed.
    for (const name of readdirSync(config))
      if (statSync(join(config, name)).isFile())
        expect(readFileSync(join(config, name), "utf8")).not.toContain("human_");
    expect([...stderr, ...stdout].join("\n")).not.toMatch(/prim_sess_|human_token/u);
    // One push for the whole flow, and the member's token works.
    expect(challengeCalls()).toHaveLength(1);
    expect(await linker.client.getClient().get("/api/cli/decisions/recent")).toEqual({
      decisions: [],
    });
  });

  it("reports a refused push with the fix, and gets no token", async () => {
    const refuse = join(fixture.bare, "hooks", "pre-receive");
    writeFileSync(
      refuse,
      "#!/bin/sh\necho 'remote: Permission to acme/widgets denied' >&2\nexit 1\n",
    );
    chmodSync(refuse, 0o755);
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code: "push_refused" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).toMatch(
      /^Primitive could not identify who started this Claude Code cloud session: creating the session branch claude\/fervent-test-abc123 on acme\/widgets was refused \(.*\)\. To fix it, check that the GitHub account that started this session can push to acme\/widgets/u,
    );
    expect(fixture.calls.some((call) => call.path.endsWith("/token"))).toBe(false);
    // Hook processes never retry the push, even after the pause.
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000);
    const later = await fresh();
    await expect(later.machine.acquireMachineCredential()).rejects.toMatchObject({
      code: "push_refused",
    });
    expect(challengeCalls()).toHaveLength(1);
  });

  it("fails clearly when GitHub's notice never arrives, delivers nothing, and recovers if it does", async () => {
    fixture.webhook = false;
    const modules = await fresh();
    const outcome = await modules.identity.ensureSessionIdentity(
      { cwd: work, explicit: true },
      { pollBudgetMs: 1_200 },
    );
    expect(outcome).toMatchObject({ status: "failed", code: "webhook_timeout" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).toBe(
      "Primitive could not identify who started this Claude Code cloud session: GitHub's notice of the identity push to acme/widgets did not reach Primitive within 1 s. To fix it, check that Primitive's GitHub App is installed with access to acme/widgets, then run `prim setup --cloud` to try again.",
    );
    // No capture is delivered as anyone: the drain cannot bind an identity.
    const pending = modules.machine.machineCaptureActor();
    const bucket = modules.machine.machinePendingBucket(pending as never);
    const inspection = await modules.journal.inspectJournalDelivery([bucket]);
    expect(inspection.deliverableBuckets.size).toBe(0);
    expect(inspection.retainedBuckets).toEqual([{ bucket, reason: "identity_unavailable" }]);
    // A hook process honors the pause instead of pushing again.
    await expect(modules.machine.acquireMachineCredential()).rejects.toMatchObject({
      code: "webhook_timeout",
    });
    expect(apiCalls()).toEqual([]);
    expect(challengeCalls()).toHaveLength(1);

    // The notice arrives late: an explicit retry polls the same challenge.
    fixture.webhook = true;
    expect(await identifyNow()).toMatchObject({ status: "ok" });
    expect(challengeCalls()).toHaveLength(1);
  });

  it("pushes nothing when the session branch is already on GitHub", async () => {
    git(work, "push", "--quiet", "--no-verify", "origin", `HEAD:refs/heads/${BRANCH}`);
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code: "branch_exists" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).toBe(
      `Primitive could not identify who started this Claude Code cloud session: the session branch ${BRANCH} already exists on GitHub, so this session cannot prove who started it. To fix it, start a new cloud session.`,
    );
    expect(challengeCalls()).toHaveLength(0);
  });

  it("pushes no local commit: the branch is created only at a commit GitHub has", async () => {
    // The agent committed before the session was identified.
    git(work, "commit", "--quiet", "--allow-empty", "-m", "local work");
    const local = git(work, "rev-parse", "HEAD");
    const outcome = await identifyNow();
    expect(outcome).toMatchObject({ status: "failed", code: "unpublished_commits" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.cause).toBe(
      `this checkout's commit ${local.slice(0, 12)} is not on GitHub yet, and creating the session branch at it would publish it, so prim pushed nothing`,
    );
    expect(remoteBranch(fixture.bare)).toBeUndefined();
    expect(() => git(fixture.bare, "cat-file", "-e", local)).toThrow();
    expect(challengeCalls()).toHaveLength(0);
  });

  it("retries at the commit the session started from, not at later local work", async () => {
    const refuse = join(fixture.bare, "hooks", "pre-receive");
    writeFileSync(refuse, "#!/bin/sh\nexit 1\n");
    chmodSync(refuse, 0o755);
    expect(await identifyNow()).toMatchObject({ status: "failed", code: "push_refused" });
    rmSync(refuse);
    git(work, "commit", "--quiet", "--allow-empty", "-m", "local work");
    expect(await identifyNow()).toMatchObject({ status: "ok" });
    expect(remoteBranch(fixture.bare)).toBe(baseSha);
  });

  it("pushes nothing from a checkout that is not on a claude/ branch", async () => {
    git(work, "checkout", "--quiet", "main");
    const outcome = await identifyNow();
    expect(outcome).toMatchObject({ status: "failed", code: "not_session_branch" });
    expect(challengeCalls()).toHaveLength(0);
    expect(remoteBranch(fixture.bare)).toBeUndefined();
  });

  it("names a mismatch between the GitHub account and the Claude account's member", async () => {
    fixture.reject = "identity_mismatch";
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code: "identity_mismatch" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).toBe(
      "Primitive could not identify who started this Claude Code cloud session: the session branch was created by a GitHub account linked to a different Primitive member than the one signed in to Claude, so Primitive attributes this session to no one. To fix it, start a new cloud session; if it happens again, ask an organization admin to check members' GitHub links.",
    );
    expect(fixture.calls.some((call) => call.path.endsWith("/token"))).toBe(false);
  });

  it("names the connection fix for a repository Primitive does not know", async () => {
    fixture.connected = false;
    const outcome = await identifyNow();
    expect(outcome).toMatchObject({
      status: "failed",
      code: "repository_not_connected",
      cause: "acme/widgets is not connected to Primitive",
    });
    expect(remoteBranch(fixture.bare)).toBeUndefined();
  });
});

describe("the server's refusals, by name", () => {
  const UPDATE_PRIM = /update prim/u;
  async function runAuth(...args: string[]) {
    const stderr: string[] = [];
    const stdout: string[] = [];
    vi.spyOn(console, "error").mockImplementation((value: string) => {
      stderr.push(String(value));
    });
    vi.spyOn(console, "log").mockImplementation((value: string) => {
      stdout.push(String(value));
    });
    await fresh();
    const { registerAuthCommands } = await import("../commands/auth.js");
    const program = new Command();
    registerAuthCommands(program);
    const cwd = process.cwd();
    process.chdir(work);
    try {
      await program.parseAsync(["node", "prim", "auth", ...args]);
    } finally {
      process.chdir(cwd);
      vi.restoreAllMocks();
    }
    return { stderr: stderr.join("\n"), stdout: stdout.join("\n") };
  }

  it.each([
    ["identity_mismatch", { error: "identity_mismatch" }, "identity_mismatch"],
    [
      "a rejected challenge's reason",
      { error: "challenge_rejected", reason: "identity_mismatch" },
      "identity_mismatch",
    ],
    [
      "a conflicting push",
      { error: "challenge_rejected", reason: "conflicting_push" },
      "conflicting_push",
    ],
    ["the 30-minute window", { error: "challenge_expired" }, "challenge_expired"],
    [
      "an exchanged challenge",
      { error: "challenge_already_exchanged" },
      "challenge_already_exchanged",
    ],
    ["a notice not received yet", { error: "challenge_pending" }, "webhook_timeout"],
  ])("names %s at token exchange instead of asking to update prim", async (_name, body, code) => {
    fixture.tokenRefusal = { status: 409, body };
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).not.toMatch(UPDATE_PRIM);
  });

  it("keeps a late link's expiry, rather than calling it a missing branch", async () => {
    fixture.linked.clear();
    expect(await identifyNow()).toMatchObject({ status: "link_required" });
    // The person took longer than the server's exchange window to link.
    fixture.tokenRefusal = { status: 409, body: { error: "challenge_expired" } };
    fixture.linkRefusal = { status: 409, body: { error: "challenge_expired" } };
    const { stdout } = await runAuth("link");
    expect(JSON.parse(stdout)).toMatchObject({ error: "challenge_expired" });
    expect(JSON.parse(stdout).detail).toContain("for 30 minutes");
    expect(challengeCalls()).toHaveLength(1);
  });

  it.each([
    ["push_after_expiry", "push_after_expiry"],
    ["repository_mismatch", "repository_mismatch"],
    ["conflicting_push", "conflicting_push"],
    ["unsupported_sender", "unsupported_sender"],
    ["a reason this prim does not know", "challenge_rejected"],
  ])("names a challenge rejected for %s", async (reason, code) => {
    fixture.reject = reason;
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code });
    expect(fixture.calls.some((call) => call.path.endsWith("/token"))).toBe(false);
  });

  it("retries a refused push with the challenge it opened, not a second one", async () => {
    const refuse = join(fixture.bare, "hooks", "pre-receive");
    writeFileSync(refuse, "#!/bin/sh\nexit 1\n");
    chmodSync(refuse, 0o755);
    expect(await identifyNow()).toMatchObject({ status: "failed", code: "push_refused" });
    rmSync(refuse);
    // The server refuses a second open challenge for the branch.
    expect(await identifyNow()).toMatchObject({ status: "ok" });
    expect(challengeCalls()).toHaveLength(1);
  });

  it("asks whether a push it lost track of landed, instead of calling the branch taken", async () => {
    const refuse = join(fixture.bare, "hooks", "pre-receive");
    writeFileSync(refuse, "#!/bin/sh\nexit 1\n");
    chmodSync(refuse, 0o755);
    expect(await identifyNow()).toMatchObject({ status: "failed", code: "push_refused" });
    rmSync(refuse);
    // The branch reached GitHub after all, at the session's base commit.
    git(work, "push", "--quiet", "--no-verify", "origin", `${baseSha}:refs/heads/${BRANCH}`);
    expect(await identifyNow()).toMatchObject({ status: "ok" });
    expect(challengeCalls()).toHaveLength(1);
  });

  it.each([
    [409, "challenge_already_open", "challenge_open"],
    [429, "too_many_open_challenges", "too_many_challenges"],
  ])("names a challenge start refused with %i %s", async (status, error, code) => {
    fixture.challengeRefusal = { status, body: { error } };
    const modules = await fresh();
    const outcome = await identifyNow(modules);
    expect(outcome).toMatchObject({ status: "failed", code });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(modules.identity.sessionIdentityMessage(outcome)).not.toMatch(UPDATE_PRIM);
    expect(remoteBranch(fixture.bare)).toBeUndefined();
  });

  it.each(["jane", "jane@localhost", "jane@example.com "])(
    "leaves out an email hint Primitive would refuse: %j",
    async (email) => {
      vi.stubEnv("CLAUDE_CODE_USER_EMAIL", email);
      expect(await identifyNow()).toMatchObject({ status: "ok" });
      const body = challengeCalls()[0]?.body ?? {};
      if (email.trim() === "jane@example.com") expect(body.userEmailHint).toBe("jane@example.com");
      else expect(body).not.toHaveProperty("userEmailHint");
    },
  );

  it("refuses a session ID Primitive would refuse, before pushing", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE_SESSION_ID", "session 01/../x");
    expect(await identifyNow()).toMatchObject({ status: "failed", code: "session_id_missing" });
    expect(remoteBranch(fixture.bare)).toBeUndefined();
  });

  it("ends a revoked session's token for good, with the reason, and sends nothing", async () => {
    await identifyNow();
    // An admin removes the member's GitHub link: every token stops working.
    fixture.tokens.clear();
    fixture.refreshError = "session_revoked";
    const modules = await fresh();
    await expect(modules.client.getClient().get("/api/cli/decisions/recent")).rejects.toThrow(
      /no longer accepts this session's member token/u,
    );
    expect(
      readdirSync(config).filter((name) => /^session_identity_\w+\.json$/u.test(name)),
    ).toEqual([]);
    expect(modules.machine.machineContext()).toBeUndefined();
    // Neither hooks nor an explicit retry push or open anything.
    expect(await identifyNow()).toMatchObject({ status: "failed", code: "session_revoked" });
    const status = await (await import("../commands/auth.js")).verifyAuthStatus();
    expect(status).toMatchObject({ authenticated: false, recoveryReason: "session_revoked" });
    expect(challengeCalls()).toHaveLength(1);
    expect(
      fixture.calls.filter(
        (call) => call.path === "/api/cli/decisions/recent" && call.auth !== "Bearer prim_sess_1",
      ),
    ).toEqual([]);
  });

  it("names the session token, not the environment's credentials, in auth status", async () => {
    await identifyNow();
    fixture.tokens.clear();
    await fresh();
    const status = await (await import("../commands/auth.js")).verifyAuthStatus();
    expect(status).toMatchObject({ authenticated: false, recoveryReason: "session_revoked" });
    expect(status.recoveryDetail).not.toMatch(/--new-installation/u);
  });

  it("names the environment credential when refresh is refused at authentication", async () => {
    fixture.refreshAfterMs = 1_000;
    await identifyNow();
    fixture.refreshFails = true;
    fixture.refreshError = "Unauthorized";
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2_000);
    const outcome = await identifyNow();
    expect(outcome).toMatchObject({ status: "failed", code: "environment_credential_rejected" });
    if (outcome.status !== "failed") throw new Error("expected failure");
    expect(outcome.remedy).toContain("--new-environment");
  });

  it.each([
    [
      "member_already_linked",
      { error: "member_already_linked", linkedGithubLogin: "jane-old" },
      /already linked to GitHub account @jane-old.*remove that link in Primitive's settings first/su,
    ],
    [
      "github_account_linked_to_another_member",
      { error: "github_account_linked_to_another_member" },
      /@octojane is already linked to another member/u,
    ],
    [
      "identity_mismatch",
      { error: "identity_mismatch" },
      /different Primitive member than the one signed in to Claude.*sign in as yourself/su,
    ],
  ])("explains a link refused with %s", async (code, body, message) => {
    fixture.linked.clear();
    expect(await identifyNow()).toMatchObject({ status: "link_required" });
    fixture.linkRefusal = { status: 409, body };
    const { stdout } = await runAuth("link");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ authenticated: false, error: code });
    expect(result.detail).toMatch(message);
    expect(result.detail).not.toMatch(UPDATE_PRIM);
  });
});
