---
name: prim
description: Use the prim CLI for Primitive's decision graph — passive decision capture, the conflict gate, reconcile, rationale confirmations, and team presence. TRIGGER when the user mentions Primitive, prim, decisions / the decision graph / a conflict gate / reconcile; when an edit is denied or warned by a prior decision; when the repo's package.json depends on @primitive.ai/prim; when configuring Primitive session or git hooks. SKIP when "decision" is unrelated to Primitive, or for unrelated CLIs.
---

# Working with the prim CLI

`prim` is the official CLI for [Primitive](https://app.getprimitive.ai)'s **decision graph**. Use it -- don't reach for shell or curl.

## Mental model

As your team codes, prim passively captures the **decisions** you make -- which library, which pattern, which config value -- into a queryable graph, and links them: a decision can depend on earlier decisions (auto-linked from shared files, or related by hand — see *Relate decisions*) and reference the files it touched. **Conflict Gates** can check a later change against that graph and surface any load-bearing decision it conflicts with; with **Enforcement**, prim blocks the edit until you reconcile the decision and retry. Conflict Gates are **not currently enabled** — capture runs regardless. To enable them for your team, contact support@getprimitive.ai.

You never invoke capture. It runs automatically through the session hooks installed by `npx --yes @primitive.ai/prim claude install` (Claude Code), `npx --yes @primitive.ai/prim codex install` (Codex), or `npx --yes @primitive.ai/prim hermes install` (Hermes). Your job is to **read** the graph before load-bearing edits and **answer** the occasional rationale confirmation. (Responding to Conflict Gates applies only once Enforcement is enabled — see below.)

## Auth

Run `npx --yes @primitive.ai/prim auth status` first. It exits **0 if authenticated, 1 if not** -- branch on the exit code, don't parse the message.

Three ways to authenticate, in priority order:

1. **`PRIM_TOKEN` environment variable** -- preferred for agents and CI. Set it before invoking prim and you're done; no interactive flow, no token files.
2. **`npx --yes @primitive.ai/prim auth set-token <token>`** -- saves a bearer token to `~/.config/prim/token`. Use when the user has a long-lived token in hand.
3. **`npx --yes @primitive.ai/prim auth login`** -- opens a browser via WorkOS OAuth. **Drive this yourself; do not hand it to the user.** It blocks up to 2 minutes waiting for approval -- that wait is expected, not a failure. The user's only action is clicking "Authorize". Run it in the background, surface the authorize URL it prints on STDERR so the user can click it if the browser didn't open, then poll `auth status` until it exits 0. If it times out before they click, run it again -- never fall back to asking them to run it.

The CLI auto-refreshes a still-valid session from the stored refresh token (proactively ~60s before expiry, and again on a 401), so a short access-token "expires in 2m" is normal -- not a reason to re-authenticate or warn the user. Only an absent refresh token, or an explicit `Authentication expired. Run prim auth login to re-authenticate.`, warrants a re-login -- which you then drive yourself, per the above. Relay that message if it appears.

## Ground rules

1. Every command accepts `--help`. When unsure of flags, run `npx --yes @primitive.ai/prim <cmd> --help` rather than guessing.
2. The CLI prints API errors as one-liners to stderr and exits non-zero. Treat any non-zero exit as actionable. If auth-related, re-check `auth status`.
3. `<idOrShortId>` arguments accept either a full decision ID or the short ID shown in feeds (and gate reasons, when Conflict Gates are enabled).

## Conflict Gates & Enforcement (not currently enabled)

**Conflict Gates** check each edit against the decision graph before it lands and surface any load-bearing decision it conflicts with. Their **Enforcement** tier goes further -- a conflicting edit is blocked (or paused for confirmation) until you reconcile the decision and retry. **Conflict Gates are not currently enabled** — automatic decision capture (above) runs regardless. To enable Conflict Gates and Enforcement for your team, contact support@getprimitive.ai.

When Enforcement is enabled, before an edit (Claude Code: Edit/Write/MultiEdit; Codex: apply_patch; Hermes: write_file/patch) a PreToolUse hook scores the target file against the graph:

- **deny** -- the edit is blocked: it conflicts with a load-bearing prior decision. Don't fight it. Read the reason line; it names the decision id. If you genuinely intend to override that decision, run `npx --yes @primitive.ai/prim reconcile dec_<shortId>`, then retry the edit once. Otherwise choose an approach that respects the decision.
- **warn / additional context** -- the edit proceeds, but a relevant prior decision is surfaced. Read it. On Codex a would-be `ask` is delivered as allow-plus-context (Codex can't pause mid-tool), so that context is your only signal -- read it before continuing. Hermes has no soft-confirm tier, so a would-be `ask` arrives as a **deny** carrying the same reconcile directive: reconcile and retry, or set `PRIM_HOOK_MODE=warn` to downgrade it to context-only.
- **"decision check skipped / not verified" or "... partial / truncated"** -- the check could not fully run. Treat constraints as UNKNOWN, not clear; never read silence as approval.

When enabled, the gate fail-opens on its *own* infrastructure errors (no daemon, network blip, org-unbound token) -- a setup problem would not block your edit. That is why an "unavailable" note would matter: it is the honest signal that the check, not your edit, is what failed.

## Read the graph before large or load-bearing edits

- `npx --yes @primitive.ai/prim decisions check --files "src/a.ts,src/b.ts"` -- which active decisions reference the files you're about to touch (comma-separated paths, one `--files` value). Run it before a big change.
- `npx --yes @primitive.ai/prim decisions recent` -- the team's recent decisions, each row badged by author and agent (`Your Claude Code` / `Your Codex` / `Your Hermes`); `--limit <n>` and `--since <dur>` narrow it. `--author "<name>"` filters to one teammate (feed name, `"First Last"`, last name, username, email, or email local-part) -- the way to answer "what has X decided?"; an unknown or ambiguous name comes back as `unavailable` with the reason, and `authorHasDecisions` in the JSON distinguishes "no feed-visible decisions" (false) from "has decisions, none surfaced on this page" (true) -- on that empty page, raise `--limit` to reach past non-decision captures before widening `--since`.
- `npx --yes @primitive.ai/prim decisions show <idOrShortId>` and `npx --yes @primitive.ai/prim decisions cascade <idOrShortId>` -- full detail, and the downstream blast radius a change would disturb.

## Reconcile and the verdict footer

Reconcile and the verdict footer are part of Conflict Gates **Enforcement**, which is **not currently enabled** (contact support@getprimitive.ai to turn it on); the `reconcile` command stays available regardless. When Enforcement is on:

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

## Author a decision deliberately

Capture is automatic for the decisions you *make while coding*. When the user instead asks you to **record a decision explicitly** — one that didn't fall out of an edit (a design call, a convention, a choice settled in discussion) — author it directly:

```
npx --yes @primitive.ai/prim decisions create --intent "Adopt prosemirror-collab over Yjs" --area data --rationale "Server-authoritative ordering" --alternatives "Yjs,Automerge"
```

Only `--intent` is required. Optional: `--kind` (change|exploration|task_execution|unclear, default change), `--rationale`, `--area`, `--decided`, `--alternatives` (comma-separated), `--confidence` (high|medium|low, default high), `--reversibility` (high|low, default high), and `--files` (comma-separated repo-relative paths the decision governs — these are the files Conflict Gates would check on later edits, same path form as `decisions check`; Conflict Gates are not currently enabled). STDOUT is the created identity `{ decisionId, shortId, createdAt }`; STDERR prints `[prim] created dec_<short>.` — pass that `dec_<short>` straight into `decisions show` / `cascade` / `confirm`. Author on the user's behalf only when they ask for a decision to be recorded; don't narrate your own routine edits into the graph (the hooks already do that).

## Relate decisions (link / unlink)

prim links decisions automatically when their files overlap, but that heuristic misses real connections and occasionally invents wrong ones. When the user asks you to **relate two existing decisions** — "B depends on A", "these are connected", wiring up two orphans — or to **cut a wrong link**, do it by hand:

```
npx --yes @primitive.ai/prim decisions link <child> --on <parent>      # record that <child> depends on <parent>
npx --yes @primitive.ai/prim decisions unlink <child> --on <parent>    # remove that dependency
```

Direction is **`<child>` depends on `<parent>`** — the parent is the prerequisite. Read the echoed verdict to confirm you got the arrow right: `[prim] <child> now depends on <parent>.` After linking, `decisions show <child>` lists `<parent>` upstream and `decisions cascade <parent>` shows `<child>` in its downstream blast radius; after unlinking they drop. Both ids accept `dec_<short>` or a full id and may be any two decisions in your org, regardless of status.

Safe to run repeatedly:

- **Idempotent** — re-linking an existing edge (or unlinking a missing one) is a no-op that still exits 0 (`already_linked` / `not_linked`).
- **Acyclic** — a self-loop, or any link that would close a dependency cycle, is refused with exit 2 (with the offending chain when it's short enough to render); the graph stays a DAG.
- **Exit codes** (treat non-zero as actionable): `0` success or no-op; `2` a refused link (self-loop, cycle, or an ambiguous short id — retry with the full id); `4` an id that doesn't resolve. After a non-zero exit, branch on the exit code and the `[prim]` STDERR verdict, **not** on STDOUT keys: only the exit-0 outcomes carry the full `{ outcome, childId, childShortId, parentId, parentShortId }`; a refused link prints a smaller `{ outcome, … }`, and an unresolved id (exit 4) prints nothing to STDOUT.

Like authoring, relate only what the user asks for — don't invent relationships they didn't state.

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

These git hooks are separate from the **session hooks** (`claude install` / `codex install` / `hermes install`) that drive in-session capture (and Conflict Gates, when enabled).

## Output formats

The CLI keeps STDOUT machine-readable and STDERR human-readable. The `decisions` and `reconcile` commands **always** emit a single JSON document on STDOUT — no flag needed; pipe straight to `jq`. The `decisions` commands have **no** `--json` flag and reject one; `reconcile` accepts a reserved no-op `--json`. `auth status` and `skill status` default to human-readable STDOUT and take `--json` to switch to JSON.

- **STDOUT is machine-readable** — JSON (one document per invocation). `decisions` reads project lean shapes, not raw rows.
- **STDERR is human-readable** — a verdict-first line, plus presence notes (and, when Conflict Gates are enabled, the gate/verdict-footer notes).
- **Exit code is authoritative** where it carries meaning — `auth status` exits 0 when authenticated; `decisions show`/`cascade`/`confirm` exit non-zero (e.g. 4 not-found) on a missing or unauthorized id.

Examples:

- `npx --yes @primitive.ai/prim auth status --json | jq -r .authenticated` — boolean; the exit code remains the authoritative signal
- `npx --yes @primitive.ai/prim decisions recent | jq -r '.decisions[].shortId'` — list recent decision short ids (STDOUT is already JSON)
- `npx --yes @primitive.ai/prim decisions recent --author "Maya" | jq -r 'if .unavailable then "UNAVAILABLE: \(.unavailable)" else .decisions[].intent end'` — one teammate's latest decisions (check `.unavailable` first; empty output alone is not "no decisions")
- `npx --yes @primitive.ai/prim decisions show <id> | jq .` — full decision detail

## Pitfalls

- **An "unavailable" / "not verified" decision check is not an all-clear.** Treat constraints as UNKNOWN and proceed deliberately; never read the silence as approval — the same holds for Conflict Gates once enabled.
- **When Enforcement is enabled, a `deny` means a real prior decision conflicts.** Reconcile only when you genuinely intend to override it; otherwise pick an approach that respects it.
- **Reconcile bypasses are single-use and short-lived.** One bypass clears your *next* edit to the governed file; it is not a standing override.
- **Capture of your coding activity is automatic, never manual.** If decisions aren't showing up, check that the session hooks are installed (`claude status` / `codex status` / `hermes status`) and the daemon is running — don't try to inject moves by hand. (Deliberately *authoring* a decision the user asks you to record is a separate, supported path — `decisions create`, above.)
- **Don't fabricate rationale on a confirmation.** If you don't know why a decision was made, say so rather than guessing.

## After each task

If Conflict Gates are enabled and one denied or warned you, report which decision(s) it named and whether you reconciled. If you read the graph before a load-bearing change, note what you found so the user can verify in the dashboard.
