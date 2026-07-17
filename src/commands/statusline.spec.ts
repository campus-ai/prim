import { beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { decisionIngestionStatus } from "../lib/activation.js";
import type { Teammate } from "../lib/presence.js";
import { renderStatusline } from "./statusline.js";

vi.mock("../daemon/client.js", () => ({
  daemonRequest: vi.fn(),
}));

vi.mock("../lib/activation.js", () => ({
  decisionIngestionStatus: vi.fn(() => "enabled"),
}));

const mockDaemonRequest = vi.mocked(daemonRequest);
const mockDecisionIngestionStatus = vi.mocked(decisionIngestionStatus);

function snapshot(onlineCount?: number, onlineNames?: string[], onlineTeammates?: Teammate[]) {
  return {
    pid: 1,
    uptimeMs: 1_000,
    sessionId: "daemon-1",
    lastHeartbeatAt: 1_700_000_000_000,
    onlineCount,
    onlineNames,
    onlineTeammates,
  };
}

describe("renderStatusline", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
    mockDecisionIngestionStatus.mockReset();
    mockDecisionIngestionStatus.mockReturnValue("enabled");
  });

  it("renders enabled decision ingestion with the org-wide online count", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(2));
    const line = await renderStatusline();
    expect(line).toContain("daemon: live, Decision ingestion enabled");
    expect(line).toContain("team: 2 online");
    expect(mockDecisionIngestionStatus).toHaveBeenCalledWith(process.cwd());
  });

  it("renders disabled decision ingestion in a healthy location where capture is inactive", async () => {
    mockDecisionIngestionStatus.mockReturnValue("disabled");
    mockDaemonRequest.mockResolvedValue(snapshot(2));
    expect(await renderStatusline()).toContain("daemon: live, Decision ingestion disabled");
  });

  it("renders teammate names when the snapshot carries them", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(3, ["Alex", "Maya"]));
    const line = await renderStatusline();
    expect(line).toContain("team: Alex, Maya");
  });

  it("annotates teammates with their area when the snapshot carries teammates", async () => {
    mockDaemonRequest.mockResolvedValue(
      snapshot(3, ["Kasey", "Sam"], [{ name: "Kasey", area: "auth" }, { name: "Sam" }]),
    );
    const line = await renderStatusline();
    expect(line).toContain("team: Kasey - auth, Sam");
  });

  it("renders the whole teammate label as an OSC 8 Decision link", async () => {
    mockDaemonRequest.mockResolvedValue(
      snapshot(2, undefined, [
        {
          name: "Kasey",
          area: "auth",
          decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
        },
      ]),
    );
    const line = await renderStatusline();
    expect(line).toContain(
      "team: \x1b]8;;https://app.getprimitive.ai/decisions/kasey-decision\x07\x1b[34;4mKasey - auth\x1b[0m\x1b]8;;\x07",
    );
  });

  it("prefers teammates(+area) over the bare names when both are present", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(2, ["Sam"], [{ name: "Sam", area: "data" }]));
    const line = await renderStatusline();
    expect(line).toContain("team: Sam - data");
  });

  it("truncates an annotated teammate list with an overflow marker", async () => {
    mockDaemonRequest.mockResolvedValue(
      snapshot(5, undefined, [
        { name: "Alex", area: "ui" },
        { name: "Maya" },
        { name: "Sam", area: "data" },
        { name: "Tom", area: "infra" },
      ]),
    );
    const line = await renderStatusline();
    expect(line).toContain("team: Alex - ui, Maya, Sam - data +1");
  });

  it("truncates a long teammate list with an overflow marker", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(5, ["Alex", "Maya", "Sam", "Tom"]));
    const line = await renderStatusline();
    expect(line).toContain("team: Alex, Maya, Sam +1");
  });

  it("renders 'team: just you' when online with no teammates", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(1, []));
    const line = await renderStatusline();
    expect(line).toContain("team: just you");
  });

  it("renders 'team: just you' via the teammates branch when onlineTeammates is empty", async () => {
    // [] is not undefined, so the preferred onlineTeammates branch is taken.
    mockDaemonRequest.mockResolvedValue(snapshot(1, undefined, []));
    const line = await renderStatusline();
    expect(line).toContain("team: just you");
  });

  it("falls back to the bare count when the server sent no names (rollout)", async () => {
    // onlineNames undefined but a count is present — an older server that
    // predates names: keep "team: N online" rather than regress to "—".
    mockDaemonRequest.mockResolvedValue(snapshot(4, undefined));
    const line = await renderStatusline();
    expect(line).toContain("team: 4 online");
  });

  it("renders an honest team: — when the daemon has no count yet (or org-unbound)", async () => {
    // onlineCount undefined — daemon up, but no accepted heartbeat ack has
    // populated the count; show "—", never a false "team: 1".
    mockDaemonRequest.mockResolvedValue(snapshot(undefined));
    const line = await renderStatusline();
    expect(line).toContain("daemon: live");
    expect(line).toContain("team: —");
    expect(line).not.toContain("team: 1");
  });

  it("reports the daemon down — and no team marker — when no snapshot returns", async () => {
    mockDaemonRequest.mockResolvedValue(null);
    const line = await renderStatusline();
    expect(line).toContain("daemon: down");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("Decision ingestion");
    expect(mockDecisionIngestionStatus).not.toHaveBeenCalled();
  });

  it("surfaces the one-command re-auth fix when the daemon is in reauth-hold", async () => {
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(2, ["Sam"]),
      healthy: false,
      needsReauth: true,
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: paused");
    expect(line).toContain("run `prim auth login`");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("Decision ingestion");
    expect(mockDecisionIngestionStatus).not.toHaveBeenCalled();
  });

  it("prioritizes re-auth over the derived delivery/presence states it halts", async () => {
    // A reauth-hold stops both loops, so heartbeat/ingestion may also read
    // unhealthy — the actionable root cause is auth, so it must win.
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(2, ["Sam"]),
      healthy: false,
      needsReauth: true,
      heartbeat: { healthy: false },
      ingestion: { healthy: false, pendingCount: 9 },
    });
    const line = await renderStatusline();
    expect(line).toContain("run `prim auth login`");
    expect(line).not.toContain("delivery: stalled");
    expect(line).not.toContain("presence: unavailable");
  });

  it("surfaces a stalled delivery queue instead of masking it with presence", async () => {
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(2, ["Sam"]),
      healthy: false,
      heartbeat: { healthy: true },
      ingestion: { healthy: false, pendingCount: 4 },
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: degraded");
    expect(line).toContain("delivery: stalled");
    expect(line).toContain("4 pending");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("Decision ingestion");
    expect(mockDecisionIngestionStatus).not.toHaveBeenCalled();
  });

  it("labels a sampled pending count as a lower bound", async () => {
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(2, ["Sam"]),
      healthy: false,
      ingestion: { healthy: false, pendingCount: 64, pendingSampled: true },
    });
    expect(await renderStatusline()).toContain("at least 64 pending");
  });

  it("surfaces heartbeat failure without rendering a frozen team", async () => {
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(2, ["Sam"]),
      healthy: false,
      heartbeat: { healthy: false },
      ingestion: { healthy: true, pendingCount: 0 },
    });
    const line = await renderStatusline();
    expect(line).toContain("presence: unavailable");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("Decision ingestion");
    expect(mockDecisionIngestionStatus).not.toHaveBeenCalled();
  });

  it("shows 'presence: other env' (never another deployment's team) on an env mismatch", async () => {
    // Daemon alive but bound to a different deployment than this statusline
    // targets: it withholds the roster and flags envMismatch, so we render the
    // honest cross-env state — not its team, and not a misleading "down".
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(undefined, undefined, [
        {
          name: "Kasey",
          decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
        },
      ]),
      envMismatch: true,
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: live, Decision ingestion enabled");
    expect(line).toContain("presence: other env");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("\x1b]8;;");
  });

  it("renders 'presence: stale' (never a frozen count) when the daemon flags staleness", async () => {
    // Daemon alive but heartbeats failing: it drops the count and sets
    // presenceStale, so the statusline must not render a confident "team: N".
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(undefined, undefined, [
        {
          name: "Kasey",
          decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
        },
      ]),
      presenceStale: true,
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: live, Decision ingestion enabled");
    expect(line).toContain("presence: stale");
    expect(line).not.toContain("team:");
    expect(line).not.toContain("\x1b]8;;");
  });
});
