/**
 * The coding agent a prim hook is running under.
 *
 * The installer stamps the agent into each hook command
 * (`prim-pre-tool-use --agent codex`, `… --agent hermes`). Claude Code's
 * install passes no flag, so an absent or unrecognized value resolves to
 * `claude_code` — preserving the original Claude behavior. Hooks branch their
 * tool-shape extraction, output mapping, and move `producer` on this.
 */
export type Agent = "claude_code" | "codex" | "hermes";

export function parseAgent(argv: readonly string[]): Agent {
  const i = argv.indexOf("--agent");
  const value = i !== -1 ? argv[i + 1] : undefined;
  if (value === "codex" || value === "hermes") {
    return value;
  }
  return "claude_code";
}
