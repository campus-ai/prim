/**
 * The coding agent a prim hook is running under.
 *
 * The installer stamps the agent into each hook command
 * (`prim-pre-tool-use --agent codex`). Claude Code's install passes no
 * flag, so an absent or unrecognized value resolves to `claude_code` —
 * preserving the original Claude behavior. Hooks branch their tool-shape
 * extraction, output mapping, and move `producer` on this.
 */
export type Agent = "claude_code" | "codex";

export function parseAgent(argv: readonly string[]): Agent {
  const i = argv.indexOf("--agent");
  return i !== -1 && argv[i + 1] === "codex" ? "codex" : "claude_code";
}
