import { supportsColor } from "./ansi.js";
import { stripControlChars, terminalSafeLine } from "./terminal-safe.js";

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

/** Return a terminal-safe, production Primitive Decision URL, if valid. */
export function validDecisionUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string" || stripControlChars(value) !== value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.origin !== DECISION_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/decisions\/[^/]+$/u.test(url.pathname)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Wrap `label` in an OSC 8 hyperlink to a valid Decision URL, styled blue +
 * underlined so it reads as clickable. `plain` (or an invalid URL) returns
 * the bare label. Callers own the gating: the presence statusline links
 * unconditionally (Claude Code renders it; there is no TTY to check), while
 * CLI STDERR lines gate on {@link supportsDecisionHyperlinks}. The reset
 * lands before the OSC 8 close, keeping the style off trailing separators.
 */
export function decisionLink(
  label: string,
  decisionUrl: string | undefined,
  plain: boolean,
): string {
  const url = validDecisionUrl(decisionUrl);
  if (plain || !url) {
    return label;
  }
  return `\x1b]8;;${url}\x07\x1b[34;4m${label}\x1b[0m\x1b]8;;\x07`;
}

/**
 * Whether a STDERR line may carry an OSC 8 link in place of the visible URL:
 * an interactive terminal with color allowed, excluding Terminal.app, which
 * ignores OSC 8 and would silently drop the link.
 */
export function supportsDecisionHyperlinks(): boolean {
  return supportsColor() && process.env.TERM_PROGRAM !== "Apple_Terminal";
}

/**
 * A Decision's headline, sanitized and quoted, pointing at its web page. On a
 * hyperlink-capable TTY the headline itself is the link; everywhere else
 * (agent Bash tools, pipes) the full URL stays visible so agents can cite it.
 */
export function linkedHeadline(headline: string, decisionId: string): string {
  const url = decisionWebUrl(decisionId);
  const quoted = `"${terminalSafeLine(headline)}"`;
  return supportsDecisionHyperlinks() ? decisionLink(quoted, url, false) : `${quoted} → ${url}`;
}
