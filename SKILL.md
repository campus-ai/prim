---
name: prim
description: Use the prim CLI for Primitive’s decision graph. MUST INVOKE before finishing any coding, planning, specification, or review task where the user or agent chose between plausible approaches or established or changed a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction—even when Primitive was not mentioned. Also invoke for Primitive setup, reading decisions, conflict gates, reconcile, rationale confirmations, linking, and team presence. SKIP — do not invoke even to check — when the task shows no fork that should guide future work, for example temporary tactics (a change that is explicitly temporary or to-be-reverted); routine implementation that merely follows an existing decision or a convention already visible in the code or repo instructions; or the word “decision” merely naming code, data, or UI. Such signals need no graph lookup to rule out.
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

A decision worth deliberately recording is a genuine **fork in the road**: the user or agent encountered multiple plausible paths, selected one, and that selection should inform future work. The litmus: does the selection govern future work, or did it merely happen once? A release-scoped choice — what is in or out of one release — reverses at the next release; it is ephemeral, not a decision. Record the chosen behavior, direction, constraint, or tradeoff—not routine implementation needed to finish the task or follow an existing convention. Small design choices made in-flight while implementing—such as edge-case handling, parameter defaults, retry or timeout values, log levels, naming, or the shape of an internal data structure—are implementation details even when you chose between alternatives: never deliberately record them or spend a rationale question on them; passive capture already covers coding activity. A teammate working elsewhere should benefit from knowing it — and that test is a gate, not a nicety. The graph is the team's shared memory: a decision that configures only your own working environment — editor, shell, or terminal tooling, a personal dev box or remote coding machine, which worktree manager, launcher, or TUI you run — is personal, not a team decision, however durable and well-reasoned, even when the setup touches repo-owned helper scripts. Never record a personal-environment decision on your own initiative; record only positions the team's shared work must preserve. An explicit request to record that specific decision still wins — note when honoring it that the record is visible to the whole team.

### Ground the rationale in real sources

Before deliberately recording a decision, actively gather the real context behind **why this path was chosen** — aim to populate the decision with as much genuine, source-grounded rationale as you can find, never a plausible-sounding guess. Start with the current conversation — it is itself a primary source: when the why was stated or is visible in this session, capture it in `--rationale` at create time rather than omitting it. Then reach for every tool, connector, and MCP server available to you to pull from the actual sources the decision or task points to: Slack threads, Granola or other meeting notes, Linear issues, Zoom transcripts, email, and repository docs or skills. Don't limit yourself to that list — use whatever integrations you have. Read the source directly instead of inferring from memory, and target the specific thread, meeting, ticket, or document the user referenced rather than a broad, scattershot search.

Record only rationale supported by those sources. Do not mistake the implementation method, the task request, or a restatement of the decision for its rationale. Write it as plain, impersonal engineering explanation — the reasons, evidence, and tradeoffs behind the choice, in a sentence or three. Rationale is explanatory, never normative: a constraint future work must obey belongs in `--decided` even when the rationale explains why, and reasoning belongs in `--rationale`, never inlined into the intent while `--rationale` sits empty. `--rationale` is not optional: never invent one, but never silently drop it either — when the why cannot be deduced from all available context, ask the user for it with the one focused question below and record their answer.

For proactively identified decisions in an active repo, let confidence in the rationale determine the interaction:

- **Clear and well-supported** — record the decision and rationale silently at the natural task boundary.
- **Plausible but uncertain** — at the task boundary, state the proposed rationale and ask for lightweight confirmation: “I understand the reason for choosing X to be Y. Is that right?” Create the record once they answer, carrying the confirmed or corrected rationale.
- **No supported rationale** — at the task boundary, ask one focused question: “What made you choose X over the other path?” Create the record once they answer, carrying their stated rationale.

The question gates the rationale, not the decision's survival: never fabricate a rationale to fill the gap, and never skip the question to record silently without one. If the user declines to answer, or their next message moves on without answering, record then with `--rationale` absent rather than re-asking or dropping the decision — the only outcome worse than a missing rationale is losing the record entirely.

These questions share the interruption budget below; never ask separate questions for the decision and its rationale. If both are uncertain, combine them into one concise prompt. An explicit request to “add this decision to Primitive” that supplies or implies its rationale records immediately; when it supplies none and none is deducible, ask the one rationale question and create the record with the answer — the request is approval to record, not a substitute for the why.

### Inactive repos: approve each deliberate create

When passive capture is inactive for the current repo, do not silently turn a durable
decision into a write. “Inactive” means Prim's effective repo-capture check is false;
an explicit local `prim.active=false` is always inactive. Every
`prim decisions create` invocation needs fresh user approval:

- An explicit request to record or create that Decision is approval for that one
  invocation; do not ask redundantly.
- For a proactively identified Decision, present the proposed decision and supported
  rationale — folding the single rationale question into the same prompt when none
  was found — then wait for approval before creating it. A previous approval never
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

### Direct requests: record without asking permission

When the user asks to record a decision—for example, “add this decision to Primitive”—author it directly. Do not ask whether to record; the only question that may accompany a direct request is the single rationale question above, when the request supplies no rationale and none is deducible. In an inactive repo, the request is the one-time approval: use Prim's `--yes` for that create as described above.

### Clear decisions: record without interrupting

When the user clearly makes a durable fork-in-the-road decision without explicitly asking to record it, record it at the next natural task boundary without asking a redundant confirmation question **when passive capture is active**. An explicit ratification of a direction—“agreed,” “ship it that way,” or any equivalent affirmation—is such a decision even when the ratified option was your own proposal: the ratification is the approval, so record it and do not ask whether to record. That rule is general: in an active repository, never ask permission to record — the only question the budget permits is the single rationale question, which is required, not optional, when no rationale was stated or found. In an inactive repo, present it and obtain the per-create approval above. Preserve the user's meaning and stated rationale; do not strengthen, broaden, or embellish it. Prefer the governing position over the implementation activity that revealed it.

Examples that qualify:

- “We're prioritizing retention this quarter.”
- “Customer data must remain in the EU.”
- “Authentication state remains server-authoritative.”
- “Do not introduce another frontend framework.”

And one that never qualifies, however deliberate and well-reasoned: “Use my preferred worktree manager, not the alternative I evaluated, on my dev machine” — a personal-environment choice that binds no teammate.

Treat changes to shared agent instructions and standards—such as `AGENTS.md`, `CLAUDE.md`, repository skills, architecture rules, and design-system guidance—as a high-signal opportunity to preserve a decision. Inspect what rule the change establishes or revises. If it represents a genuine fork in the road, record the durable policy itself, not “updated the docs.” If the edit only documents a decision already present in Primitive, do not create a duplicate.

Apply the same attention during non-code deliberation: planning or “grill me” workflows, spec refinement, behavior design, PR planning or review, and conversations imported from Granola or other connected sources. These workflows can settle important forks before any code changes. Accumulate the confirmed decisions and record them at a natural phase or task boundary; do not interrupt or call Primitive after every answer.

### Onboarding: seed the graph from memory, one proposal at a time

When onboarding or `prim welcome` reports `"org": "seed"`, seed the viewer's graph by proposing decisions mined from memory. There is no open goals question: the proposals are the whole seeding pass. Propose **one decision per message**, wait for the user's verdict, and only then present the next — never present the candidates as a batch.

1. Gather candidates from the repo's Git-tracked shared memory and agent-instruction files (`git ls-files -- 'MEMORY.md' ':(glob)**/MEMORY.md' 'AGENTS.md' ':(glob)**/AGENTS.md' 'CLAUDE.md' ':(glob)**/CLAUDE.md'` from the repository root; read every path returned) and from your own memory and conversation context — positions the user has already *stated*; the setup guide names each agent's memory surface. Never automatically read an untracked, gitignored, or un-shared memory source; use one only when the user explicitly asks to promote it. Only their words count: never infer a position from the repo's code or history, and never invent one they didn't state.
2. A candidate must state an explicit, durable position that appears to remain in force — a genuine fork in the road such as a goal, priority, principle, invariant, constraint, default, commitment, tradeoff, or exception. Do not infer decisions from code, repository structure, or unstated implications, and do not bulk-import the documents. The personal-environment exclusion above applies: never propose a position that binds no teammate.
3. Run `npx --yes @primitive.ai/prim decisions recent --limit 20` and drop candidates equivalent to existing decisions. If the result is unavailable or too incomplete to rule out a duplicate confidently, drop the uncertain candidate; explain the limitation.
4. Propose the strongest candidates one at a time — **at most six in total**, fewer when the material runs out (never invent a proposal to fill the quota), stopping early if the user declines to continue. Each proposal carries the proposed decision, its source (file path or the stated context), and only rationale or alternatives explicitly supported by that source; when the source yields no rationale, fold the single rationale question into the same prompt. In this and any user-facing presentation, label the position **Decision**, never "Intent" — intent is `--intent` flag vocabulary, not user copy — and label the rejected options **Alternatives rejected**, never "alternatives considered". Make clear, at least on the first proposal, that approved decisions join the team's shared decision graph, visible to any teammates — not a private list. Ask the user to approve, revise, or reject it — do not silently attribute a historical repository position to the onboarding user — and create each approved decision (per the wording and flag rules below) before presenting the next.
5. After the final proposal's verdict — or immediately, when there are no viable candidates (say so briefly) — close with the standing guidance from welcome's STDOUT `seedGuidance` field: the user can tell their agent to add any decision to the Primitive decision graph at any time; otherwise, once the agent's prim hooks are active, Primitive passively captures decisions in the background while they work; and other repositories are captured only after `prim enable` is run in each. On an older CLI without that field, state those three points yourself.

Outside onboarding, before creating a proactively identified decision, read recent decisions to avoid duplicating an existing position:

```
npx --yes @primitive.ai/prim decisions recent --limit 20
```

If an equivalent decision is already present, do not create or suggest it again. After this duplicate check—or after the user confirms an onboarding proposal—author the decision directly. If the repo is inactive, that confirmation authorizes Prim's `--yes` only for the approved create:

```
npx --yes @primitive.ai/prim decisions create --intent "Adopt prosemirror-collab over Yjs" --attribution user --area data --rationale "Server-authoritative ordering" --alternatives "Yjs,Automerge" --decided "Collaborative editing state syncs through prosemirror-collab","The server is the single authority for step ordering"
```

Inactive-repo form after approval:

```
npx --yes @primitive.ai/prim --yes decisions create --intent "Adopt prosemirror-collab over Yjs" --attribution user --area data --rationale "Server-authoritative ordering" --alternatives "Yjs,Automerge" --decided "Collaborative editing state syncs through prosemirror-collab","The server is the single authority for step ordering"
```

Both `--intent` and `--attribution` are required. Set `--attribution user` only when the person directly stated, selected, or confirmed the exact recorded choice. Set `--attribution agent` when you introduced that exact choice while pursuing a broader request. A broad task prompt, implementation permission, or assignment of responsibility does not turn your implementation choice into a user Decision. If the origin is ambiguous, ask the person to confirm the exact choice before creating it; after confirmation, use `user`. Never guess attribution.

Word `--intent` as a short sentence-case normative headline — ideally 4–12 words, no terminal period — stating the standing constraint future work must follow, not a report of the action taken: "Consume AADT and safety data from street_export, not gps_probes_osm", never "Migrate AADT and safety data managers off gps_probes_osm". A one-time-action verb (Migrate, Backfill, Publish) headlines a task execution: restate the ongoing constraint the action implies, and when none exists, do not record a decision at all. Make the intent self-contained for a reader who wasn't in the session — name the release, artifact, or system explicitly, and state what a referenced change does rather than citing a PR or ticket number, which is itself session context; "limit this release" and "keep the GitHub surface (PR 1102)" are failures. Carry one governing decision per intent — a reader of the intent alone must see which option is now in force. Expand every binding specific the choice adopts — scope boundaries, defaults, invariants, schema or API shapes, exceptions, required mechanisms — into `--decided`, and move non-binding reasoning into `--rationale`; a paragraph-length intent that inlines its constraints and reasons is a failure.

Other flags: `--kind` (change|exploration|task_execution|unclear, default change), `--rationale` (required by the recording policy above — the CLI accepts its absence, but only for the declined/unanswered fallback), `--area` (a single short lowercase noun — `auth`, `billing`, `infra`), `--decided`, `--alternatives`, `--confidence` (high|medium|low, default high), `--reversibility` (high|low, default high), and `--files` (comma-separated repo-relative paths the decision governs — these are the files Conflict Gates would check on later edits, same path form as `decisions check`; Conflict Gates are not currently enabled). Omit `--files` for broad directions that should not immediately participate in file-based Conflict Gates. STDOUT is the created identity `{ decisionId, shortId, createdAt }`; STDERR prints `[prim] created dec_<short>.` — pass that `dec_<short>` straight into `decisions show` / `cascade` / `confirm`.

`--decided` carries the enforceable detail as standalone bullets — one per independently adopted constraint, the core choice first, with exact names and values. Each bullet states what must remain true and makes sense by itself: never narrate the session ("Chose to document the behavior" is a failure) and never pack independent rules into one semicolon-delimited entry. `--alternatives` takes one concise entry per option actually considered and rejected; omitting it when none were named is normal. The decision's own negation is never an alternative — restating the prohibited or displaced behavior adds nothing; list only options a source or the conversation actually names as considered. Both flags split their value on commas with no escape, so keep each entry comma-free — rephrase around colons, dashes, or "and".

### Inferred decisions: finish first, then optionally ask once

When several statements or implementation choices strongly imply a higher-order fork in the road but the user did not state the decision explicitly, do not record it automatically. Complete the requested work first. At the natural stopping point, optionally ask one concise confirmation question that states the synthesized decision:

> A broader direction seemed to emerge: prioritize activation and retention before acquisition work. Should I record that as a team decision?

Record it only after an affirmative response. Consolidate related evidence into one governing decision rather than listing or recording each underlying implementation choice.

### Interruption budget

- Never interrupt active implementation solely to improve Primitive's records.
- Ask at most one Primitive-related confirmation question per task, only after completing the requested work.
- Ask nothing when the inference is weak, local, temporary, already recorded, or unlikely to guide another teammate.
- Do not ask the optional inferred-decision question when the user requested a narrow execution task or appears to want a quick result without discussion; the required rationale question for a clearly made decision still applies at the task boundary.
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

If the user clearly made a durable fork-in-the-road decision, check recent decisions and record it now if it is not already present when capture is active — asking the single rationale question first when the why is not deducible from available context. When capture is inactive, record it only if the user explicitly requested that create; otherwise present it for the per-invocation approval above. If a strong higher-order decision was only inferred, decide whether it clears the interruption budget; if so, ask the single concise confirmation question after reporting the completed work. Otherwise say nothing about Primitive.

If Conflict Gates are enabled and one denied or warned you, report which decision(s) it named and whether you reconciled. If you read the graph before a load-bearing change, note what you found so the user can verify in the dashboard.
