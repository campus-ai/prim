<!-- PRIMITIVE_SETUP_V1 -->
# Primitive CLI setup (v1)

You are an AI coding agent setting up the Primitive CLI for the user. Run each
step and surface the output. Do not guess; if a command exits non-zero, stop and
report. Each command pins `@latest` so `npx`'s local resolution cache cannot
serve a stale version of the CLI between releases.

First, identify which agent you are — **Claude Code** or **OpenAI Codex**. Steps
2 and 6 branch on it; every other step is identical.

## 1. Authenticate
Run: `npx --yes @primitive.ai/prim@latest auth login`

`auth login` opens a browser and an agent cannot complete it. If you are a
headless or CI agent, set `PRIM_TOKEN` in the environment and skip the browser
flow instead — `npx --yes @primitive.ai/prim@latest auth status` exits 0 when
authenticated. If `auth status` exits non-zero and `PRIM_TOKEN` is unset, ask
the user to run `auth login` themselves, then continue.

## 2. Install the session integration (decision capture + conflict gate + presence)
- **Claude Code** — run: `npx --yes @primitive.ai/prim@latest claude install`
- **OpenAI Codex** — run: `npx --yes @primitive.ai/prim@latest codex install`, then
  tell the user: "Run `/hooks` in Codex and trust the prim hooks — until you do,
  decision capture and the conflict gate stay inert."

This wires the session hooks that capture the decisions you make into
Primitive's decision graph, gate edits that conflict with prior team decisions,
and report team presence. It is separate from the pre-commit hook in step 4.

## 3. Start the companion daemon (latency + team presence)
Run: `npx --yes @primitive.ai/prim@latest daemon start`

Optional but recommended — it accelerates the in-session decision checks and
powers the "team: N online" presence count. If it fails, continue: the hooks
fall back to direct calls and never block on the daemon.

## 4. Install the pre-commit hook (spec sync)
Run: `npx --yes @primitive.ai/prim@latest hooks install`

## 5. Install the skill into the project's rules file
Run: `npx --yes @primitive.ai/prim@latest skill install`

This writes a managed block — teaching you both the spec workflow and the
decision graph — to the rules file your agent reads: CLAUDE.md for Claude Code,
AGENTS.md for Codex, plus .cursor/rules, .windsurfrules, and
.github/instructions/primitive.md. The CLI handles target detection. If
ambiguous, it prints discovered candidates and exits non-zero — pass
`--target <path>` to disambiguate.

## 6. Confirm
Verify, then print a one-paragraph summary of what was installed, which rules
file received the skill block, and (Codex only) the `/hooks` trust reminder:
- `npx --yes @primitive.ai/prim@latest auth status`
- `npx --yes @primitive.ai/prim@latest claude status` — or `codex status` if you are Codex
- `npx --yes @primitive.ai/prim@latest daemon status`
- `npx --yes @primitive.ai/prim@latest skill status`
