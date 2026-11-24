// The suite runs inside Claude Code cloud sessions too. Commands branch on
// CLAUDE_CODE_REMOTE, so tests start outside one and opt in with vi.stubEnv.
delete process.env.CLAUDE_CODE_REMOTE;
