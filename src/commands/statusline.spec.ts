import { beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { renderStatusline } from "./statusline.js";

vi.mock("../daemon/client.js", () => ({
  daemonRequest: vi.fn(),
}));

const mockDaemonRequest = vi.mocked(daemonRequest);

function snapshot(onlineCount?: number, onlineNames?: string[]) {
  return {
    pid: 1,
    uptimeMs: 1_000,
    sessionId: "daemon-1",
    lastHeartbeatAt: 1_700_000_000_000,
    onlineCount,
    onlineNames,
  };
}

describe("renderStatusline", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
  });

  it("renders the org-wide online count from the daemon snapshot", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(2));
    const line = await renderStatusline();
    expect(line).toContain("daemon: live");
    expect(line).toContain("team: 2 online");
  });

  it("renders teammate names when the snapshot carries them", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot(3, ["Alex", "Maya"]));
    const line = await renderStatusline();
    expect(line).toContain("team: Alex, Maya");
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
  });

  it("shows 'presence: other env' (never another deployment's team) on an env mismatch", async () => {
    // Daemon alive but bound to a different deployment than this statusline
    // targets: it withholds the roster and flags envMismatch, so we render the
    // honest cross-env state — not its team, and not a misleading "down".
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(undefined),
      envMismatch: true,
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: live");
    expect(line).toContain("presence: other env");
    expect(line).not.toContain("team:");
  });

  it("renders 'presence: stale' (never a frozen count) when the daemon flags staleness", async () => {
    // Daemon alive but heartbeats failing: it drops the count and sets
    // presenceStale, so the statusline must not render a confident "team: N".
    mockDaemonRequest.mockResolvedValue({
      ...snapshot(undefined),
      presenceStale: true,
    });
    const line = await renderStatusline();
    expect(line).toContain("daemon: live");
    expect(line).toContain("presence: stale");
    expect(line).not.toContain("team:");
  });
});
