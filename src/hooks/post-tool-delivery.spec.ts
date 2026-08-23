import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "../client.js";
import { IngestAcknowledgementError } from "../ingest-response.js";
import { appendMove } from "../journal.js";
import type { Move } from "../protocol/move.js";
import { deliverPostToolMove } from "./post-tool-delivery.js";

vi.mock("../client.js", () => ({ getClient: vi.fn() }));
vi.mock("../journal.js", () => ({ appendMove: vi.fn() }));

const move: Move = {
  moveId: "move-1",
  capturedAt: 1,
  sessionId: "session-1",
  eventType: "PostToolUse",
  payload: { ok: true },
  env: { cwd: "/repo", cliVersion: "1", osPlatform: "darwin" },
  envelopeVersion: 1,
};

describe("deliverPostToolMove", () => {
  const post = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getClient).mockReturnValue({ get: vi.fn(), post });
  });

  it("journals before posting the exact same move identity", async () => {
    post.mockResolvedValue({ disposition: "persisted", acknowledged: 1, accepted: 1 });

    await expect(deliverPostToolMove(move, "org-1")).resolves.toMatchObject({
      disposition: "persisted",
      acknowledged: 1,
    });
    expect(appendMove).toHaveBeenCalledWith(move, "org-1");
    expect(post).toHaveBeenCalledWith(
      "/api/cli/moves/ingest",
      { batch: [move] },
      { signal: expect.any(AbortSignal) },
    );
    expect(vi.mocked(appendMove).mock.invocationCallOrder[0]).toBeLessThan(
      post.mock.invocationCallOrder[0],
    );
  });

  it("leaves the write-ahead journal as recovery when durable ack is absent", async () => {
    post.mockResolvedValue({ accepted: 1 });

    await expect(deliverPostToolMove(move, undefined)).rejects.toBeInstanceOf(
      IngestAcknowledgementError,
    );
    expect(appendMove).toHaveBeenCalledWith(move, undefined);
  });

  it("leaves a direct 409 in the journal for the replay flusher to quarantine", async () => {
    post.mockRejectedValue(Object.assign(new Error("move_id_conflict"), { status: 409 }));

    await expect(deliverPostToolMove(move, "org-1")).rejects.toMatchObject({ status: 409 });
    expect(appendMove).toHaveBeenCalledWith(move, "org-1");
  });
});
