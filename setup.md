<!-- PRIMITIVE_SETUP_V1 -->
# Primitive CLI setup (v1)

You are an AI coding agent setting up the Primitive CLI for the user. Run every
step yourself via `npx` and surface the output — do not hand a command back to
the user to run. The one action only the user can take is clicking "Authorize"
in the browser during step 1; everything else is yours to drive. Each command
pins `@latest`, so the user never installs or manages a prim version and always
runs the newest CLI. If a command in a **required** step (1, 2, 4, 5) exits
non-zero, stop and report. The daemon (step 3) is **optional** — if it doesn't
come up, keep going. Step 6 always finishes by delivering the welcome message
(the required final deliverable); its status confirmations are informational, and
a non-zero there must never stop you from showing the welcome.

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
and report team presence. It installs into the **current project** by default
(the repo's `.claude/settings.json` / `.codex/hooks.json`, resolved from the git
root, so any subdirectory works) — run it from inside the user's repo; add
`--scope user` to install machine-wide instead. Each hook self-resolves the
CLI at run time (PATH, then a local install, then `npx --yes @latest`), so the
hooks keep working with no global install. It is separate from the pre-commit
hook in step 4.

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

## 6. Welcome (always), confirm, then the seeding question — last
The welcome message is a **required deliverable** of setup: once the install
steps above succeeded, the user must always see it. Run it first and never skip
it, summarize it away, or gate it behind the checks below.

Run `npx --yes @primitive.ai/prim@latest welcome` and surface its **orientation**
— the canonical "here's how Primitive works". It adapts to you: if **you** have
recorded decisions it inlines the team's latest decisions; if you haven't yet, it
also prints a reverse-prompt — a ruled "Your turn" callout — to seed the graph,
with the team's recent decisions above it for context when the org has any. It
always exits 0 (a failed decisions fetch degrades gracefully).

If the output ends with that "Your turn" callout, **hold it back here** — surface
only the orientation above it for now; you'll reproduce the callout once, at the
very end, as the closing call-to-action. Showing it now and again later buries the
first copy in the middle of your message, which is exactly what we're avoiding.

Then **run the four confirmations** and surface their results — informational (a
non-zero must NOT abort the run or retract the welcome), but run them so the user
sees the live post-install state:
- `npx --yes @primitive.ai/prim@latest auth status`
- `npx --yes @primitive.ai/prim@latest claude status` — or `codex status` if you are Codex
- `npx --yes @primitive.ai/prim@latest daemon status` — optional; a non-zero just means the daemon isn't running, which is fine
- `npx --yes @primitive.ai/prim@latest skill status`

Add one line of setup specifics: which rules file received the skill block, and
(Codex only) the `/hooks` trust reminder. The daemon confirm is expected to vary;
an unexpected non-zero from auth or skill is worth a note — but never retract the
welcome.

**Then close:**

**If welcome's STDOUT shows `"org": "seed"`** — you haven't recorded a decision
yet (this fires even in an org that already has decisions). Make the seeding
question the LAST thing you say: end your message with it as a single, emphasized
block addressed to the user — render it the way welcome did, as the "Your turn"
callout (the question text is on STDOUT as `reversePrompt`) — with **nothing after
it**: no confirmations, no orientation, no sign-off. Then **stop and wait** for
their answer; a question buried above other text reads as if no answer is expected,
and this one must be unmistakably theirs to answer.
When the user replies (your next turn), break their answer into **one decision per
goal** they name (infer the best `--kind`; map a goal to `--intent` / `--decided`,
and what they're *not* focusing on to `--alternatives`), show the drafted
decisions, **confirm before creating**, then record each:
`npx --yes @primitive.ai/prim@latest decisions create --intent "…" [--decided "…"] [--alternatives "…"] [--area …] [--kind …]`.

**If STDOUT shows `"org": "active"` or `"org": "unknown"`** — there's no seeding
question; the setup-specifics line is your close.
