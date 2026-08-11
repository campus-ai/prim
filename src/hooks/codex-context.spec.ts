import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  daemonRequest: vi.fn(),
  decisionIngestionStatus: vi.fn(),
  fetchRecent: vi.fn(),
  getClient: vi.fn(),
  getSiteUrl: vi.fn(),
  gitToplevel: vi.fn(),
  isSessionEnded: vi.fn(),
  packageVersion: vi.fn(),
}));

vi.mock("../client.js", () => ({
  getClient: mocks.getClient,
  getSiteUrl: mocks.getSiteUrl,
  isSessionEnded: mocks.isSessionEnded,
}));
vi.mock("../daemon/client.js", () => ({ daemonRequest: mocks.daemonRequest }));
vi.mock("../decisions/recent.js", () => ({ fetchRecent: mocks.fetchRecent }));
vi.mock("../lib/activation.js", () => ({
  decisionIngestionStatus: mocks.decisionIngestionStatus,
}));
vi.mock("../lib/bin-path.js", () => ({ packageVersion: mocks.packageVersion }));
vi.mock("../lib/git.js", () => ({ gitToplevel: mocks.gitToplevel }));

import type { DecisionFeedRow } from "../decisions/recent.js";
import {
  CODEX_CONTEXT_TIMEOUT_MS,
  CODEX_DIGEST_LIMIT,
  CODEX_DIGEST_MAX_SEEN_IDS,
  CODEX_DIGEST_STATE_MAX_FILES,
  CODEX_DIGEST_STATE_RETENTION_MS,
  appendCodexContext,
  hasVisibleCodexMessage,
  prepareCodexContext,
  renderDecisionDigest,
} from "./codex-context.js";

let temporaryHome = "";

function stateDirectory(): string {
  return join(temporaryHome, ".config", "prim", "codex", "decision-digests");
}

function healthySnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pid: 7,
    uptimeMs: 1_000,
    sessionId: "daemon-session",
    healthy: true,
    onlineTeammates: [],
    ...overrides,
  };
}

function row(id: string, overrides: Partial<DecisionFeedRow> = {}): DecisionFeedRow {
  return {
    id,
    shortId: undefined,
    intent: `Intent ${id}`,
    rationale: undefined,
    area: "auth",
    producerKind: "codex",
    userId: `user-${id}`,
    authorName: `Author ${id}`,
    authorIsSelf: false,
    classifiedAt: Date.now(),
    status: "active",
    ...overrides,
  };
}

beforeEach(() => {
  temporaryHome = mkdtempSync(join(tmpdir(), "prim-codex-context-"));
  vi.stubEnv("HOME", temporaryHome);
  vi.resetAllMocks();
  mocks.getClient.mockReturnValue({});
  mocks.getSiteUrl.mockReturnValue("https://app.getprimitive.ai");
  mocks.gitToplevel.mockReturnValue("/repo");
  mocks.isSessionEnded.mockReturnValue(false);
  mocks.packageVersion.mockReturnValue("1.2.3");
  mocks.decisionIngestionStatus.mockReturnValue("enabled");
  mocks.daemonRequest.mockResolvedValue(healthySnapshot());
  mocks.fetchRecent.mockResolvedValue({ decisions: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(temporaryHome, { recursive: true, force: true });
});

describe("renderDecisionDigest", () => {
  it("renders three safe author/intent entries with bounded overflow", () => {
    const rows = [
      row("1", { authorName: "Maya\u001b[31m", intent: "Choose auth\nflow" }),
      row("2", { authorName: "Alex", intent: "Choose data" }),
      row("3", { authorName: "Sam", intent: "Choose API" }),
      row("4", { authorName: "Jules", intent: "Choose UI" }),
    ];

    expect(renderDecisionDigest(rows)).toBe(
      "[prim] Decisions since last message: Maya[31m — Choose authflow; Alex — Choose data; Sam — Choose API +1",
    );
  });

  it("returns no line for an empty feed", () => {
    expect(renderDecisionDigest([])).toBeUndefined();
  });
});

describe("Codex hook context", () => {
  it("includes the initial 24-hour all-change backlog and advances only after handoff", async () => {
    const rows = [
      row("1", {
        authorName: "Maya",
        intent: "Use passkeys",
        producerKind: "cli",
        intentKind: "change",
      }),
      row("2", { authorName: "Alex", intent: "Keep audit logs", intentKind: "change" }),
      row("3", { authorName: "Sam", intent: "Move billing", intentKind: "change" }),
      row("4", { authorName: "Jules", intent: "Ship docs", intentKind: "change" }),
      row("5", { authorName: "Ignored", intent: "A question", intentKind: "question" }),
    ];
    mocks.fetchRecent.mockResolvedValueOnce({ decisions: rows });

    const result = await prepareCodexContext({
      cwd: "/repo",
      sessionId: "session-1",
      startup: true,
    });

    expect(result.context).toContain(
      "primitive 1.2.3 (daemon: live, Decision ingestion enabled · team: just you)",
    );
    expect(result.context).toContain(
      "[prim] Decisions since last message: Maya — Use passkeys; Alex — Keep audit logs; Sam — Move billing +1",
    );
    expect(result.context).not.toContain("Ignored");
    expect(mocks.fetchRecent).toHaveBeenCalledWith(
      { limit: CODEX_DIGEST_LIMIT, since: "24h" },
      expect.objectContaining({ getClient: mocks.getClient, timeoutMs: CODEX_CONTEXT_TIMEOUT_MS }),
    );

    await result.acknowledge(false);
    expect(existsSync(stateDirectory())).toBe(false);

    await result.acknowledge(true);
    const files = readdirSync(stateDirectory()).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(1);
    const statePath = join(stateDirectory(), files[0]);
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      seenIds: string[];
      watermarkMs: number;
    };
    expect(state.seenIds).toEqual(["1", "2", "3", "4"]);
    expect(state.watermarkMs).toBeGreaterThan(0);
    expect(statSync(stateDirectory()).mode & 0o777).toBe(0o700);
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
  });

  it("uses an overlap watermark while suppressing already-seen Decision IDs", async () => {
    const first = [row("1"), row("2")];
    const second = [...first, row("3", { intent: "Only the new row" })];
    mocks.fetchRecent
      .mockResolvedValueOnce({ decisions: first })
      .mockResolvedValueOnce({ decisions: second })
      .mockResolvedValueOnce({ decisions: second });

    const initial = await prepareCodexContext({
      cwd: "/repo",
      sessionId: "session-2",
      startup: true,
    });
    await initial.acknowledge(true);
    const later = await prepareCodexContext({ cwd: "/repo", sessionId: "session-2" });

    expect(mocks.fetchRecent).toHaveBeenNthCalledWith(
      2,
      { limit: CODEX_DIGEST_LIMIT, since: expect.stringMatching(/^\d+$/) },
      expect.objectContaining({ timeoutMs: CODEX_CONTEXT_TIMEOUT_MS }),
    );
    expect(later.context).toBe("[prim] Decisions since last message: Author 3 — Only the new row");
    await later.acknowledge(true);

    const repeated = await prepareCodexContext({ cwd: "/repo", sessionId: "session-2" });
    expect(repeated.context).toBeUndefined();
  });

  it("retains the initial cursor when the feed is unavailable so the next try retries 24 hours", async () => {
    mocks.fetchRecent.mockResolvedValueOnce({ decisions: [], unavailable: "offline" });
    const unavailable = await prepareCodexContext({
      cwd: "/repo",
      sessionId: "session-3",
      startup: true,
    });
    expect(unavailable.feedAvailable).toBe(false);
    expect(unavailable.context).toContain("Decision ingestion enabled");
    await unavailable.acknowledge(true);
    expect(existsSync(stateDirectory())).toBe(false);

    mocks.fetchRecent.mockResolvedValueOnce({ decisions: [row("new")] });
    const recovered = await prepareCodexContext({ cwd: "/repo", sessionId: "session-3" });
    expect(mocks.fetchRecent).toHaveBeenLastCalledWith(
      { limit: CODEX_DIGEST_LIMIT, since: "24h" },
      expect.objectContaining({ timeoutMs: CODEX_CONTEXT_TIMEOUT_MS }),
    );
    expect(recovered.context).toContain("Author new — Intent new");
  });

  it("synthesizes the canonical paused report after terminal authentication ends", async () => {
    mocks.isSessionEnded.mockReturnValue(true);
    const result = await prepareCodexContext({
      cwd: "/repo",
      sessionId: "session-auth",
      startup: true,
    });

    expect(result.context).toBe(
      "primitive 1.2.3 (daemon: paused · run `prim auth login` · Decision ingestion enabled)",
    );
    expect(result.feedAvailable).toBe(false);
    expect(mocks.fetchRecent).not.toHaveBeenCalled();
    await result.acknowledge(true);
    expect(existsSync(stateDirectory())).toBe(false);
  });

  it("refreshes the situation report only when its rendered state changes", async () => {
    mocks.fetchRecent.mockResolvedValue({ decisions: [] });
    const initial = await prepareCodexContext({
      cwd: "/repo",
      sessionId: "session-4",
      startup: true,
    });
    await initial.acknowledge(true);

    mocks.daemonRequest.mockResolvedValue(healthySnapshot({ presenceStale: true }));
    const changed = await prepareCodexContext({ cwd: "/repo", sessionId: "session-4" });
    expect(changed.context).toBe(
      "primitive 1.2.3 (daemon: live, Decision ingestion enabled · presence: stale)",
    );
    await changed.acknowledge(true);

    const unchanged = await prepareCodexContext({ cwd: "/repo", sessionId: "session-4" });
    expect(unchanged.context).toBeUndefined();
  });

  it("keeps state bounded and removes stale records", async () => {
    const directory = stateDirectory();
    const stalePath = join(directory, "stale.json");
    const old = new Date(Date.now() - CODEX_DIGEST_STATE_RETENTION_MS - 1_000);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(stalePath, "{}\n", { encoding: "utf8", mode: 0o600 });
    utimesSync(stalePath, old, old);

    for (let index = 0; index <= CODEX_DIGEST_STATE_MAX_FILES; index += 1) {
      const result = await prepareCodexContext({
        cwd: "/repo",
        sessionId: `bounded-${index}`,
        startup: true,
      });
      await result.acknowledge(true);
    }

    const files = readdirSync(directory);
    expect(files).not.toContain("stale.json");
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(
      CODEX_DIGEST_STATE_MAX_FILES,
    );
    expect(files.some((name) => name.includes(".tmp-") || name.endsWith(".lock"))).toBe(false);
    expect(CODEX_DIGEST_MAX_SEEN_IDS).toBeGreaterThan(0);
  });
});

describe("Codex message composition", () => {
  it("adds context to visible messages without changing enforcement or duplicating warnings", () => {
    const deny = appendCodexContext(
      {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "keep this reason",
        },
      },
      "report",
    );
    expect(deny).toMatchObject({
      systemMessage: "report",
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: "keep this reason",
      },
    });

    const warning = appendCodexContext(
      {
        systemMessage: "warning",
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          additionalContext: "warning",
        },
      },
      "report",
    );
    expect(warning.systemMessage).toBe("warning\n\nreport");
    expect(warning.hookSpecificOutput?.additionalContext).toBe("warning");
    expect(hasVisibleCodexMessage({})).toBe(false);
    expect(hasVisibleCodexMessage(warning)).toBe(true);
  });
});
