---
name: prim
description: Use the prim CLI for Primitive's decision graph — passive decision capture, the conflict gate, reconcile, rationale confirmations, and team presence. TRIGGER when the user mentions Primitive, prim, decisions / the decision graph / a conflict gate / reconcile; when an edit is denied or warned by a prior decision; when the repo's package.json depends on @primitive.ai/prim; when configuring Primitive session or git hooks. SKIP when "decision" is unrelated to Primitive, or for unrelated CLIs.
---

# Working with the prim CLI

`prim` is the official CLI for [Primitive](https://app.getprimitive.ai)'s **decision graph**. Use it -- don't reach for shell or curl.

## Mental model

As your team codes, prim passively captures the **decisions** you make -- which library, which pattern, which config value -- into a queryable graph, and links them: a decision can depend on earlier decisions and reference the files it touched. When a later change conflicts with a load-bearing prior decision, prim **gates** the edit and surfaces the decision for review.

You never invoke capture. It runs automatically through the session hooks installed by `npx --yes @primitive.ai/prim claude install` (Claude Code) or `npx --yes @primitive.ai/prim codex install` (Codex). Your job is to **respond** to the gate, **read** the graph before load-bearing edits, and **answer** the occasional rationale confirmation.

## Auth

Run `npx --yes @primitive.ai/prim auth status` first. It exits **0 if authenticated, 1 if not** -- branch on the exit code, don't parse the message.

Three ways to authenticate, in priority order:

1. **`PRIM_TOKEN` environment variable** -- preferred for agents and CI. Set it before invoking prim and you're done; no interactive flow, no token files.
2. **`npx --yes @primitive.ai/prim auth set-token <token>`** -- saves a bearer token to `~/.config/prim/token`. Use when the user has a long-lived token in hand.
3. **`npx --yes @primitive.ai/prim auth login`** -- opens a browser via WorkOS OAuth. **An agent cannot complete this.** If `auth status` exits non-zero and `PRIM_TOKEN` is unset, **stop and ask the user** to run `npx --yes @primitive.ai/prim auth login` themselves.

The CLI auto-refreshes expired tokens. On unrecoverable expiry it throws `Authentication expired. Run prim auth login to re-authenticate.` -- relay it.

## Ground rules

1. Every command accepts `--help`. When unsure of flags, run `npx --yes @primitive.ai/prim <cmd> --help` rather than guessing.
2. The CLI prints API errors as one-liners to stderr and exits non-zero. Treat any non-zero exit as actionable. If auth-related, re-check `auth status`.
3. `<idOrShortId>` arguments accept either a full decision ID or the short ID shown in feeds and gate reasons.

## Heed the conflict gate

Before an edit (Claude Code: Edit/Write/MultiEdit; Codex: apply_patch) a PreToolUse hook scores the target file against the graph:

- **deny** -- the edit is blocked: it conflicts with a load-bearing prior decision. Don't fight it. Read the reason line; it names the decision id. If you genuinely intend to override that decision, run `npx --yes @primitive.ai/prim reconcile dec_<shortId>`, then retry the edit once. Otherwise choose an approach that respects the decision.
- **warn / additional context** -- the edit proceeds, but a relevant prior decision is surfaced. Read it. On Codex a would-be `ask` is delivered as allow-plus-context (Codex can't pause mid-tool), so that context is your only signal -- read it before continuing.
- **"decision check skipped / not verified" or "... partial / truncated"** -- the check could not fully run. Treat constraints as UNKNOWN, not clear; never read silence as approval.

The gate fail-opens on its *own* infrastructure errors (no daemon, network blip, org-unbound token) -- a setup problem never blocks your edit. That is exactly why an "unavailable" note matters: it is the honest signal that the check, not your edit, is what failed.

## Read the graph before large or load-bearing edits

- `npx --yes @primitive.ai/prim decisions check --files "src/a.ts,src/b.ts"` -- which active decisions reference the files you're about to touch (comma-separated paths, one `--files` value). Run it before a big change.
- `npx --yes @primitive.ai/prim decisions recent` -- the team's recent decisions, each row badged by author and agent (`Your Claude Code` / `Your Codex`); `--limit <n>` and `--since <dur>` narrow it.
- `npx --yes @primitive.ai/prim decisions show <idOrShortId>` and `npx --yes @primitive.ai/prim decisions cascade <idOrShortId>` -- full detail, and the downstream blast radius a change would disturb.

## Reconcile and the verdict footer

`npx --yes @primitive.ai/prim reconcile <idOrShortId>` mints a single-use bypass for the named decision -- it prints `[prim] reconcile bypass issued for dec_<short> (expires in ...)` to STDERR, with the bypass JSON on STDOUT. Your *next* edit to the governed file then goes through, and on that edit prim prints a verdict footer to STDERR -- confirmation the override was recorded, not silently dropped:

```
✓ Conflict caught before merge · N decisions saved · <author>'s intent preserved
```

`N` is the reconciled decision's downstream live-dependent count, shown as `N+` when the server caps it.

## Answer rationale confirmations

Occasionally the graph asks you (or the user) to confirm *why* a decision was made — a low-friction yes/no, never a paragraph. Answer it with:

```
npx --yes @primitive.ai/prim decisions confirm <idOrShortId>
```

Confirmations are author-targeted and rare by design; answering keeps the graph's rationale trustworthy. Don't manufacture rationale — if you don't know why a decision was made, say so.

## Presence

With the daemon running (`npx --yes @primitive.ai/prim daemon start`), `npx --yes @primitive.ai/prim daemon status` includes the live online count in its STDOUT JSON (when presence is fresh); Claude Code surfaces it in the statusline as `team: N online`. Your captured decisions are attributed to your agent automatically -- no flag required.

## The git hooks

`npx --yes @primitive.ai/prim hooks install` installs two git hooks:

```
npx --yes @primitive.ai/prim hooks install                       # auto-detects Husky and prompts
npx --yes @primitive.ai/prim hooks install --yes                 # confirm Husky (non-interactive)
npx --yes @primitive.ai/prim hooks install --target=git-hooks    # force .git/hooks (skip Husky detection)
npx --yes @primitive.ai/prim hooks uninstall
```

- **pre-commit** -- checks staged files against the live decision graph and prints any active decisions that reference them to stderr. It is **warn-only**: failures (auth, network, backend) or matches never block the commit; a successful `git commit` doesn't prove the check ran clean. When the check can't complete it says so ("not verified" / "truncated") rather than implying all-clear.
- **post-commit** -- records each commit as a capture boundary so the server can classify the surrounding work into decisions. It never blocks and runs in the background.

Under `CI=1` (or with `--non-interactive`), `hooks install` fails fast in a Husky repo unless `--yes` or `--target` is set; the error names both escapes. `hooks uninstall` only removes the `.git/hooks` copies — if a hook was installed into `.husky/`, remove the prim block from that file manually. To suppress the hooks for one commit, use `git commit --no-verify`.

These git hooks are separate from the **session hooks** (`claude install` / `codex install`) that drive in-session capture and the conflict gate.

## Output formats

The CLI keeps STDOUT machine-readable and STDERR human-readable. The `decisions` and `reconcile` commands **always** emit a single JSON document on STDOUT — no flag needed; pipe straight to `jq`. `--json` is an explicit opt-in only on `auth status` and `skill status`, whose default STDOUT is human-readable.

- **STDOUT is machine-readable** — JSON (one document per invocation). `decisions` reads project lean shapes, not raw rows.
- **STDERR is human-readable** — a verdict-first line, plus the gate/verdict-footer/presence notes.
- **Exit code is authoritative** where it carries meaning — `auth status` exits 0 when authenticated; `decisions show`/`cascade`/`confirm` exit non-zero (e.g. 4 not-found) on a missing or unauthorized id.

Examples:

- `npx --yes @primitive.ai/prim auth status --json | jq -r .authenticated` — boolean; the exit code remains the authoritative signal
- `npx --yes @primitive.ai/prim decisions recent | jq -r '.decisions[].shortId'` — list recent decision short ids (STDOUT is already JSON)
- `npx --yes @primitive.ai/prim decisions show <id> | jq .` — full decision detail

## Pitfalls

- **An "unavailable" / "not verified" gate or check is not an all-clear.** Treat constraints as UNKNOWN and proceed deliberately; never read the silence as approval.
- **A `deny` means a real prior decision conflicts.** Reconcile only when you genuinely intend to override it; otherwise pick an approach that respects it.
- **Reconcile bypasses are single-use and short-lived.** One bypass clears your *next* edit to the governed file; it is not a standing override.
- **Capture is automatic, never manual.** If decisions aren't showing up, check that the session hooks are installed (`claude status` / `codex status`) and the daemon is running — don't try to inject moves by hand.
- **Don't fabricate rationale on a confirmation.** If you don't know why a decision was made, say so rather than guessing.

## After each task

If the conflict gate denied or warned you, report which decision(s) it named and whether you reconciled. If you read the graph before a load-bearing change, note what you found so the user can verify in the dashboard.
