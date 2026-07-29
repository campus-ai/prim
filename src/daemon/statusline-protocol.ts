import { isAbsolute } from "node:path";

export const STATUSLINE_PROTOCOL_PREFIX = Buffer.from("prim-statusline-v1\0", "utf8");
export const STATUSLINE_REQUEST_MAX_BYTES = 64 * 1024;

export interface StatuslineRequest {
  cwd: string;
  primApiUrl: string;
}

export type StatuslineParseResult =
  | { state: "incomplete" }
  | { state: "invalid" }
  | { state: "complete"; request: StatuslineRequest };

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** True while undecided socket bytes could still become a statusline request. */
export function isStatuslineRequestPrefix(buffer: Buffer): boolean {
  const compared = Math.min(buffer.length, STATUSLINE_PROTOCOL_PREFIX.length);
  return buffer.subarray(0, compared).equals(STATUSLINE_PROTOCOL_PREFIX.subarray(0, compared));
}

/** Parse one bounded, NUL-delimited statusline request. */
export function parseStatuslineRequest(buffer: Buffer): StatuslineParseResult {
  if (buffer.length > STATUSLINE_REQUEST_MAX_BYTES || !isStatuslineRequestPrefix(buffer)) {
    return { state: "invalid" };
  }
  if (buffer.length < STATUSLINE_PROTOCOL_PREFIX.length) {
    return { state: "incomplete" };
  }

  const cwdEnd = buffer.indexOf(0, STATUSLINE_PROTOCOL_PREFIX.length);
  if (cwdEnd === -1) {
    return { state: "incomplete" };
  }
  const apiUrlEnd = buffer.indexOf(0, cwdEnd + 1);
  if (apiUrlEnd === -1) {
    return { state: "incomplete" };
  }
  if (apiUrlEnd !== buffer.length - 1) {
    return { state: "invalid" };
  }

  try {
    const cwd = utf8Decoder.decode(buffer.subarray(STATUSLINE_PROTOCOL_PREFIX.length, cwdEnd));
    const primApiUrl = utf8Decoder.decode(buffer.subarray(cwdEnd + 1, apiUrlEnd));
    if (!cwd || !isAbsolute(cwd)) {
      return { state: "invalid" };
    }
    return { state: "complete", request: { cwd, primApiUrl } };
  } catch {
    return { state: "invalid" };
  }
}
