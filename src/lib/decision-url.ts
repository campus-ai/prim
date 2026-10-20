/** Origin of the Primitive web app that hosts Decision pages. */
export const DECISION_ORIGIN = "https://app.getprimitive.ai";

/**
 * Canonical web URL for a Decision, mirroring the server's `decisionWebUrl()`.
 * Takes the full Convex id: `dec_` short ids do not resolve in the web app.
 * Percent-encoding keeps a malformed server id from breaking out of the path
 * or smuggling terminal control bytes into a human line.
 */
export function decisionWebUrl(decisionId: string): string {
  return `${DECISION_ORIGIN}/decisions/${encodeURIComponent(decisionId)}`;
}

/**
 * A quoted, already terminal-safe headline pointing at its Decision, with the
 * full URL visible so agents can cite it.
 */
export function linkedHeadline(safeHeadline: string, decisionId: string): string {
  return `"${safeHeadline}" → ${decisionWebUrl(decisionId)}`;
}
