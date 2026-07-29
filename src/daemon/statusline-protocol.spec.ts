import { describe, expect, it } from "vitest";
import {
  STATUSLINE_PROTOCOL_PREFIX,
  STATUSLINE_REQUEST_MAX_BYTES,
  isStatuslineRequestPrefix,
  parseStatuslineRequest,
} from "./statusline-protocol.js";

function request(cwd = "/work/repo", apiUrl = ""): Buffer {
  return Buffer.concat([
    STATUSLINE_PROTOCOL_PREFIX,
    Buffer.from(cwd),
    Buffer.from([0]),
    Buffer.from(apiUrl),
    Buffer.from([0]),
  ]);
}

describe("statusline socket protocol", () => {
  it("tolerates every fragmented prefix and field boundary", () => {
    const complete = request("/work/repo", "https://api.example.test");
    for (let length = 0; length < complete.length; length++) {
      const partial = complete.subarray(0, length);
      expect(isStatuslineRequestPrefix(partial)).toBe(true);
      expect(parseStatuslineRequest(partial)).toEqual({ state: "incomplete" });
    }
    expect(parseStatuslineRequest(complete)).toEqual({
      state: "complete",
      request: { cwd: "/work/repo", primApiUrl: "https://api.example.test" },
    });
  });

  it("rejects malformed framing, cwd values, UTF-8, and oversized requests", () => {
    expect(parseStatuslineRequest(Buffer.from("not-the-protocol"))).toEqual({
      state: "invalid",
    });
    expect(parseStatuslineRequest(request("relative/path"))).toEqual({ state: "invalid" });
    expect(parseStatuslineRequest(Buffer.concat([request(), Buffer.from("trailing")]))).toEqual({
      state: "invalid",
    });
    expect(
      parseStatuslineRequest(
        Buffer.concat([STATUSLINE_PROTOCOL_PREFIX, Buffer.from([0xff, 0]), Buffer.from([0])]),
      ),
    ).toEqual({ state: "invalid" });
    expect(parseStatuslineRequest(Buffer.alloc(STATUSLINE_REQUEST_MAX_BYTES + 1, "p"))).toEqual({
      state: "invalid",
    });
  });
});
