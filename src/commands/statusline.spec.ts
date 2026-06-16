import { beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { renderStatusline } from "./statusline.js";

vi.mock("../daemon/client.js", () => ({
  daemonRequest: vi.fn(),
}));

const mockDaemonRequest = vi.mocked(daemonRequest);

function snapshot(onlineCount?: number) {
  return {
    pid: 1,
    uptimeMs: 1_000,
    sessionId: "daemon-1",
    lastHeartbeatAt: 1_700_000_000_000,
    onlineCount,
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
});
