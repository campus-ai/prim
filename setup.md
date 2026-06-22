<!-- PRIMITIVE_SETUP_V1 -->
# Primitive CLI setup (v1)

You are an AI coding agent setting up the Primitive CLI for the user. Run every
step yourself via `npx` and surface the output — do not hand a command back to
the user to run. The one action only the user can take is clicking "Authorize"
in the browser during step 1; everything else is yours to drive. Each command
pins `@latest`, so the user never installs or manages a prim version and always
runs the newest CLI. If a command exits non-zero, stop and report.

First, identify which agent you are — **Claude Code** or **OpenAI Codex**. Steps
2 and 6 branch on it; every other step is identical.

## 1. Authenticate
You drive this end to end. The only thing the user does is click "Authorize" in
the browser — never hand them a command to run, and never substitute asking them
to authenticate for doing it yourself.

1. Check first: `npx --yes @primitive.ai/prim@latest auth status --json` exits 0
   when already authenticated — if so, skip to step 2.
2. Headless / CI (no browser, or `PRIM_TOKEN` already set): export `PRIM_TOKEN`,
   or run `npx --yes @primitive.ai/prim@latest auth set-token <token>`, re-check
   status, and skip the browser flow.
3. Otherwise run `npx --yes @primitive.ai/prim@latest auth login`. It opens a
   browser, prints the authorize URL on STDERR, then BLOCKS for up to 2 minutes
   waiting for the user to approve. That wait is expected — not a hang, not a
   failure. Run it in the background so your turn stays responsive, surface the
   authorize URL to the user ("Approve in the browser to continue — if it didn't
   open, click: <url>"), then poll
   `npx --yes @primitive.ai/prim@latest auth status --json` every few seconds
   until it exits 0. On success `auth login` also prints
   `{"authenticated":true,...}` on STDOUT and exits 0.
4. If the 2-minute window lapses before the user clicks, login exits non-zero —
   start it again and re-surface the URL. Keep driving until status is
   authenticated; do not give up and ask the user to run it.

## 2. Install the session integration (decision capture + conflict gate + presence)
- **Claude Code** — run: `npx --yes @primitive.ai/prim@latest claude install`
- **OpenAI Codex** — run: `npx --yes @primitive.ai/prim@latest codex install`,
  then tell the user: "Run `/hooks` in Codex and trust the prim hooks — until you
  do, decision capture and the conflict gate stay inert."

This wires the session hooks that capture the decisions you make into
Primitive's decision graph, gate edits that conflict with prior team decisions,
and report team presence. Each hook self-resolves the CLI at run time (PATH, then
a local install, then `npx --yes @latest`), so the hooks keep working with no
global install. It is separate from the pre-commit hook in step 4.

## 3. Start the companion daemon (latency + team presence)
Run: `npx --yes @primitive.ai/prim@latest daemon start`

It blocks until the daemon answers on its socket, then exits 0 — or non-zero if
the daemon could not come up. The daemon accelerates the in-session decision
checks and powers the "team: N online" presence count. Recommended but optional:
if it fails, continue — the hooks fall back to direct calls and never block on it.

## 4. Install the git hooks (decision check + commit capture)
Run: `npx --yes @primitive.ai/prim@latest hooks install`

This installs two git hooks: a **pre-commit** hook that checks your staged files
against the live decision graph and warns about conflicting prior decisions
(warn-only — it never blocks the commit), and a **post-commit** hook that records
each commit as a capture boundary so the server can classify the surrounding
work into decisions. It is separate from the session hooks in step 2.

## 5. Install the skill into the project's rules file
Run: `npx --yes @primitive.ai/prim@latest skill install`

This writes a managed block — teaching you how to work with the decision graph —
to the rules file your agent reads: CLAUDE.md for Claude Code, AGENTS.md for
Codex, plus .cursor/rules, .windsurfrules, and
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
