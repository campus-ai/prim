---
name: prim
description: Use the prim CLI for Primitive’s decision graph. MUST INVOKE before finishing any coding, planning, specification, or review task where the user or agent chose between plausible approaches or established or changed a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction—even when Primitive was not mentioned. Also invoke for Primitive setup, reading decisions, conflict gates, reconcile, rationale confirmations, linking, and team presence. SKIP routine implementation that merely follows an existing decision, temporary tactics, and unrelated uses of “decision.”
---

# Working with the prim CLI

`prim` is the official CLI for [Primitive](https://app.getprimitive.ai)'s **decision graph**. Use it -- don't reach for shell or curl.

## Mental model

In an active repo, prim passively captures the **decisions** your team makes -- which library, which pattern, which config value -- into a queryable graph, and links them: a decision can depend on earlier decisions (auto-linked from shared files, or related by hand — see *Relate decisions*) and reference the files it touched. **Conflict Gates** can check a later change against that graph and surface any load-bearing decision it conflicts with; with **Enforcement**, prim blocks the edit until you reconcile the decision and retry. Conflict Gates are **not currently enabled** — capture in active repos runs regardless. To enable them for your team, contact support@getprimitive.ai.

Low-level capture runs automatically in active repos through the session hooks installed by `npx --yes @primitive.ai/prim claude install` (Claude Code), `npx --yes @primitive.ai/prim codex install` (Codex), or `npx --yes @primitive.ai/prim hermes install` (Hermes). An inactive repo is not passively captured. Deliberately record higher-order forks in the road through `prim decisions create` as described below. Your job is also to **read** the graph before load-bearing edits and **answer** the occasional rationale confirmation. (Responding to Conflict Gates applies only once Enforcement is enabled — see below.)

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
4. In `npx --yes @primitive.ai/prim ...`, `npx --yes` is npm's flag and only skips npm's package-install confirmation. It is not user consent for a Primitive action. Prim's global flag appears after the package name: `npx --yes @primitive.ai/prim --yes ...`.

## Conflict Gates & Enforcement (not currently enabled)

**Conflict Gates** check each edit against the decision graph before it lands and surface any load-bearing decision it conflicts with. Their **Enforcement** tier goes further -- a conflicting edit is blocked (or paused for confirmation) until you reconcile the decision and retry. **Conflict Gates are not currently enabled** — automatic decision capture in active repos (above) runs regardless. To enable Conflict Gates and Enforcement for your team, contact support@getprimitive.ai.

When Enforcement is enabled, before an edit (Claude Code: Edit/Write/MultiEdit; Codex: apply_patch; Hermes: write_file/patch) a PreToolUse hook scores the target file against the graph:

- **deny** -- the edit is blocked: it conflicts with a load-bearing prior decision. Don't fight it. Read the reason line; it names the decision id. If you genuinely intend to override that decision, run `npx --yes @primitive.ai/prim reconcile dec_<shortId>`, then retry the edit once. Otherwise choose an approach that respects the decision.
- **warn / additional context** -- the edit proceeds, but a relevant prior decision is surfaced. Read it. On Codex a would-be `ask` is delivered as allow-plus-context (Codex can't pause mid-tool), so that context is your only signal -- read it before continuing. Hermes has no soft-confirm tier, so a would-be `ask` arrives as a **deny** carrying the same reconcile directive: reconcile and retry, or set `PRIM_HOOK_MODE=warn` to downgrade it to context-only.
- **"decision check skipped / not verified" or "... partial / truncated"** -- the check could not fully run. Treat constraints as UNKNOWN, not clear; never read silence as approval.

When enabled, the gate fail-opens on its *own* infrastructure errors (no daemon, network blip, org-unbound token) -- a setup problem would not block your edit. That is why an "unavailable" note would matter: it is the honest signal that the check, not your edit, is what failed.

## Read the graph before large or load-bearing edits

- `npx --yes @primitive.ai/prim decisions check --files "src/a.ts,src/b.ts"` -- which active decisions reference the files you're about to touch (comma-separated paths, one `--files` value). Run it before a big change.
- `npx --yes @primitive.ai/prim decisions recent` -- the team's recent decisions, each row badged by author and agent (`Your Claude Code` / `Your Codex` / `Your Hermes`); `--limit <n>` and `--since <dur>` narrow it. `--author "<name>"` filters to one teammate (feed name, `"First Last"`, last name, username, email, or email local-part) -- the way to answer "what has X decided?"; an unknown or ambiguous name comes back as `unavailable` with the reason, and `authorHasDecisions` in the JSON distinguishes "no feed-visible decisions" (false) from "has decisions, none in this window" (true). The page defaults to the 10 most recent, so it can hide older ones: on an author query the JSON's `windowTotal` is how many that teammate has in the window. When `windowTotal` exceeds the rows returned, don't present the page as complete -- tell the user you're showing the most recent N of `windowTotal` and offer to pull the rest, which is a re-run with `--limit <windowTotal>` (capped at 100; `windowTotalCapped` means the count is a floor rendered `N+`, and a window past 100 can't be fetched whole).
- `npx --yes @primitive.ai/prim decisions show <idOrShortId>` and `npx --yes @primitive.ai/prim decisions cascade <idOrShortId>` -- full detail, and the downstream blast radius a change would disturb.

Before presenting decision reads, use the current conversation, task, and available memory to understand what matters to the requester and how they want it delivered. Do not dump the API's chronological rows unchanged. Group related decisions around goals or workstreams, lead with decisions that affect the requester's current work, and surface conflicts, supersessions, or consequential tradeoffs before background activity. Explain why an item is relevant when the connection is supported; do not invent relevance or rationale. Preserve the response's `unavailable`, truncation, and count semantics when reshaping it.

Then tailor the delivery to this requester, not a generic reader. Take your cues from the signals actually present — durable preferences in memory, the format and depth they've used or asked for earlier in the conversation, and the shape of their current goal — and match the form (a one-line answer, a table, grouped headers, or prose), the depth (a bare intent versus full rationale, alternatives, and tradeoffs), the altitude (strategic direction versus specific ids and files), the fields they actually track, and the register of the exchange. Where a preference isn't evidenced, default to a concise, skimmable summary — read taste from signal the way you read rationale, never conjuring a persona from thin air. Tailoring changes how the facts land, never which facts: keep every conflict, supersession, and consequential tradeoff in view even when the requester wants it terse, and never let style override the `unavailable`, truncation, and count semantics above.

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

## Preserve durable user decisions

Capture is automatic for low-level choices made while coding in an active repo. Use the deliberate CLI path for higher-order decisions that emerge in conversation: goals, priorities, principles, invariants, constraints, defaults, commitments, durable tradeoffs, and exceptions.

A decision worth deliberately recording is a genuine **fork in the road**: the user or agent encountered multiple plausible paths, selected one, and that selection should inform future work. Record the chosen behavior, direction, constraint, or tradeoff—not routine implementation needed to finish the task or follow an existing convention. A teammate working elsewhere should benefit from knowing it.

### Ground the rationale in real sources

Before deliberately recording a decision, actively gather the real context behind **why this path was chosen** — aim to populate the decision with as much genuine, source-grounded rationale as you can find, never a plausible-sounding guess. Start with the current conversation, then reach for every tool, connector, and MCP server available to you to pull from the actual sources the decision or task points to: Slack threads, Granola or other meeting notes, Linear issues, Zoom transcripts, email, and repository docs or skills. Don't limit yourself to that list — use whatever integrations you have. Read the source directly instead of inferring from memory, and target the specific thread, meeting, ticket, or document the user referenced rather than a broad, scattershot search.

Record only rationale supported by those sources. Do not mistake the implementation method, the task request, or a restatement of the decision for its rationale. If the rationale remains unclear or the relevant source is unavailable, omit `--rationale` rather than inventing one.

For proactively identified decisions in an active repo, let confidence in the rationale determine the interaction:

- **Clear and well-supported** — record the decision and rationale silently at the natural task boundary.
- **Plausible but uncertain** — at the task boundary, state the proposed rationale and ask for lightweight confirmation: “I understand the reason for choosing X to be Y. Is that right?” Record after confirmation or correction.
- **No supported rationale** — at the task boundary, ask one focused question: “What made you choose X over the other path?” Record after the answer.

These questions share the interruption budget below; never ask separate questions for the decision and its rationale. If both are uncertain, combine them into one concise prompt. An explicit request to “add this decision to Primitive” still records immediately with the information supplied—do not delay it to demand rationale.

### Inactive repos: approve each deliberate create

When passive capture is inactive for the current repo, do not silently turn a durable
decision into a write. “Inactive” means Prim's effective repo-capture check is false;
an explicit local `prim.active=false` is always inactive. Every
`prim decisions create` invocation needs fresh user approval:

- An explicit request to record or create that Decision is approval for that one
  invocation; do not ask redundantly.
- For a proactively identified Decision, present the proposed intent and supported
  rationale, then wait for approval before creating it. A previous approval never
  carries forward to another Decision.
- After approval, pass Prim's global `--yes` for that invocation:
  `npx --yes @primitive.ai/prim --yes decisions create ... --attribution user`.
  The person's approval of the exact proposed choice is user ratification. The
  first `--yes` is npm's package-install flag; the second is Prim's one-time
  confirmation.
- Do not run `prim enable` merely to bypass this boundary or infer permission to
  activate the repo. Activation requires a separate user request (a requested
  `prim setup` counts because setup explicitly activates its current repo). A
  one-time create leaves passive capture inactive; auth approval, npm's
  `npx --yes`, setup's shell-permission grant, and earlier creates do not
  independently change that state.

### Direct requests: record immediately

When the user asks to record a decision—for example, “add this decision to Primitive”—author it directly. Do not ask for another confirmation. In an inactive repo, the request is the one-time approval: use Prim's `--yes` for that create as described above.

### Clear decisions: record without interrupting

When the user clearly makes a durable fork-in-the-road decision without explicitly asking to record it, record it at the next natural task boundary without asking a redundant confirmation question **when passive capture is active**. In an inactive repo, present it and obtain the per-create approval above. Preserve the user's meaning and stated rationale; do not strengthen, broaden, or embellish it. Prefer the governing position over the implementation activity that revealed it.

Examples that qualify:

- “We're prioritizing retention this quarter.”
- “Customer data must remain in the EU.”
- “Authentication state remains server-authoritative.”
- “Do not introduce another frontend framework.”

Treat changes to shared agent instructions and standards—such as `AGENTS.md`, `CLAUDE.md`, repository skills, architecture rules, and design-system guidance—as a high-signal opportunity to preserve a decision. Inspect what rule the change establishes or revises. If it represents a genuine fork in the road, record the durable policy itself, not “updated the docs.” If the edit only documents a decision already present in Primitive, do not create a duplicate.

Apply the same attention during non-code deliberation: planning or “grill me” workflows, spec refinement, behavior design, PR planning or review, and conversations imported from Granola or other connected sources. These workflows can settle important forks before any code changes. Accumulate the confirmed decisions and record them at a natural phase or task boundary; do not interrupt or call Primitive after every answer.

### Onboarding: propose decisions from shared repository memory

When onboarding or `prim welcome` reports `"org": "seed"`, complete this procedure before falling back to the open goals question. Do not treat memory already loaded into the conversation as a substitute for the repository scan. This is a separate decision-proposal pass: do not present repository rules as the user's stated goals or insert them into `$FOUND_GOALS`.

1. From the repository root, discover every Git-tracked shared memory or agent-instruction file with:

   ```
   git ls-files -- \
     'MEMORY.md' ':(glob)**/MEMORY.md' \
     'AGENTS.md' ':(glob)**/AGENTS.md' \
     'CLAUDE.md' ':(glob)**/CLAUDE.md'
   ```

2. Read every path returned before selecting candidates. Never automatically read an untracked or gitignored memory file; use one only when the user explicitly asks to promote it to the team's Primitive graph.
3. Extract at most three explicit, durable positions that appear to remain in force. A candidate must state a genuine fork in the road—such as a goal, priority, principle, invariant, constraint, default, commitment, tradeoff, or exception. Do not infer decisions from code, repository structure, or unstated implications. Do not bulk-import the documents.
4. Run `npx --yes @primitive.ai/prim decisions recent --limit 20` and omit candidates equivalent to existing decisions. If the result is unavailable or too incomplete to rule out a duplicate confidently, do not propose the uncertain candidate; explain the limitation.
5. Present the remaining candidates as proposed decisions. For each one, include the proposed intent, the source path, and only rationale or alternatives explicitly supported by that source. Ask the user to approve or revise the proposals before creating them; do not silently attribute a historical repository decision to the onboarding user.

If the scan returns no matching files or no eligible candidates, say so briefly and continue with the normal open onboarding question. Never invent a proposal to fill the gap.

Outside onboarding, before creating a proactively identified decision, read recent decisions to avoid duplicating an existing position:

```
npx --yes @primitive.ai/prim decisions recent --limit 20
```

If an equivalent decision is already present, do not create or suggest it again. After this duplicate check—or after the user confirms an onboarding proposal—author the decision directly. If the repo is inactive, that confirmation authorizes Prim's `--yes` only for the approved create:

```
npx --yes @primitive.ai/prim decisions create --intent "Adopt prosemirror-collab over Yjs" --attribution user --area data --rationale "Server-authoritative ordering" --alternatives "Yjs,Automerge"
```

Inactive-repo form after approval:

```
npx --yes @primitive.ai/prim --yes decisions create --intent "Adopt prosemirror-collab over Yjs" --attribution user --area data --rationale "Server-authoritative ordering" --alternatives "Yjs,Automerge"
```

Both `--intent` and `--attribution` are required. Set `--attribution user` only when the person directly stated, selected, or confirmed the exact recorded choice. Set `--attribution agent` when you introduced that exact choice while pursuing a broader request. A broad task prompt, implementation permission, or assignment of responsibility does not turn your implementation choice into a user Decision. If the origin is ambiguous, ask the person to confirm the exact choice before creating it; after confirmation, use `user`. Never guess attribution.

Optional: `--kind` (change|exploration|task_execution|unclear, default change), `--rationale`, `--area`, `--decided`, `--alternatives` (comma-separated), `--confidence` (high|medium|low, default high), `--reversibility` (high|low, default high), and `--files` (comma-separated repo-relative paths the decision governs — these are the files Conflict Gates would check on later edits, same path form as `decisions check`; Conflict Gates are not currently enabled). Omit `--files` for broad directions that should not immediately participate in file-based Conflict Gates. STDOUT is the created identity `{ decisionId, shortId, createdAt }`; STDERR prints `[prim] created dec_<short>.` — pass that `dec_<short>` straight into `decisions show` / `cascade` / `confirm`.

### Inferred decisions: finish first, then optionally ask once

When several statements or implementation choices strongly imply a higher-order fork in the road but the user did not state the decision explicitly, do not record it automatically. Complete the requested work first. At the natural stopping point, optionally ask one concise confirmation question that states the synthesized decision:

> A broader direction seemed to emerge: prioritize activation and retention before acquisition work. Should I record that as a team decision?

Record it only after an affirmative response. Consolidate related evidence into one governing decision rather than listing or recording each underlying implementation choice.

### Interruption budget

- Never interrupt active implementation solely to improve Primitive's records.
- Ask at most one Primitive-related confirmation question per task, only after completing the requested work.
- Ask nothing when the inference is weak, local, temporary, already recorded, or unlikely to guide another teammate.
- Do not ask when the user requested a narrow execution task or appears to want a quick result without discussion.
- Drop a rejected suggestion. Do not raise it again unless the user materially changes the decision.
- If ambiguity must already be resolved to perform the task, fold the durable-policy distinction into that necessary question instead of adding a separate Primitive question.
- Do not narrate or record routine edits, syntax, naming, testing, debugging tactics, or branch/commit mechanics; passive hooks already cover coding activity.

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
- **Capture of coding activity is automatic only in active repos; never inject moves by hand.** If an active repo's decisions aren't showing up, check that the session hooks are installed (`claude status` / `codex status` / `hermes status`) and the daemon is running. Deliberately authoring a higher-order fork—either at the user's request or under the conservative proactive policy above—is a separate, supported path through `decisions create`; in an inactive repo, honor the per-invocation approval boundary above.
- **Don't fabricate rationale on a confirmation.** If you don't know why a decision was made, say so rather than guessing.

## After each task

If the user clearly made a durable fork-in-the-road decision, check recent decisions and record it now if it is not already present when capture is active. When capture is inactive, record it only if the user explicitly requested that create; otherwise present it for the per-invocation approval above. If a strong higher-order decision was only inferred, decide whether it clears the interruption budget; if so, ask the single concise confirmation question after reporting the completed work. Otherwise say nothing about Primitive.

If Conflict Gates are enabled and one denied or warned you, report which decision(s) it named and whether you reconciled. If you read the graph before a load-bearing change, note what you found so the user can verify in the dashboard.
