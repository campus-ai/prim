---
name: prim
description: Use the prim CLI for Primitive specs, contexts, projects, pre-commit hooks, and the decision graph (passive decision capture, the conflict gate, reconcile, and team presence). TRIGGER when the user mentions Primitive, prim, "specs" or "contexts" (in the Primitive sense), or decisions / the decision graph / a conflict gate / reconcile; when the repo's package.json depends on @primitive.ai/prim; when the user asks to sync, map, update, or auto-map a spec; when an edit is denied or warned by a prior decision; when configuring Primitive hooks. SKIP when "spec" means test specs (vitest, jest, rspec), when "context" means React context or an LLM context window, or for unrelated CLIs.
---

# Working with the prim CLI

`prim` is the official CLI for [Primitive](https://app.getprimitive.ai). Use it -- don't reach for shell or curl.

## Mental model

A **spec** captures intent for execution -- it defines what should be done, usually so other agents (or humans) can act on it. A **context** is everything else: supporting material that informs but doesn't define the work -- design docs, references, prior art, shared documentation, examples. When deciding which to create, ask: does this say *what to do*, or does it *inform* whoever's doing it? A project has at most one spec but can link many contexts.

In Primitive, a markdown spec is associated with a **project**. The spec is the source of truth: `npx --yes @primitive.ai/prim spec sync` parses the spec, diffs it against the project, and **applies the diff** -- adding, updating, or **archiving** items in the project to match. Items removed from a spec are soft-archived (recoverable via the dashboard), not deleted -- but they leave the active view, so flag the user before large spec rewrites on projects with work in flight.

A **spec is a kind of context** -- same IDs, same storage. The `npx --yes @primitive.ai/prim spec ...` commands are a focused view onto specs; `npx --yes @primitive.ai/prim context get <id>` works on a spec ID and vice versa. For structured metadata on a spec (review status, root project, sync version, scope, file patterns), use `npx --yes @primitive.ai/prim context get <specId>` -- it returns JSON.

`npx --yes @primitive.ai/prim spec list` returns only spec-type contexts. `npx --yes @primitive.ai/prim context list` returns all contexts regardless of type.

## Auth

Run `npx --yes @primitive.ai/prim auth status` first. It exits **0 if authenticated, 1 if not** -- branch on the exit code, don't parse the message.

Three ways to authenticate, in priority order:

1. **`PRIM_TOKEN` environment variable** -- preferred for agents and CI. Set it before invoking prim and you're done; no interactive flow, no token files.
2. **`npx --yes @primitive.ai/prim auth set-token <token>`** -- saves a bearer token to `~/.config/prim/token`. Use when the user has a long-lived token in hand.
3. **`npx --yes @primitive.ai/prim auth login`** -- opens a browser via WorkOS OAuth. **An agent cannot complete this.** If `auth status` exits non-zero and `PRIM_TOKEN` is unset, **stop and ask the user** to run `npx --yes @primitive.ai/prim auth login` themselves.

The CLI auto-refreshes expired tokens. On unrecoverable expiry it throws `Authentication expired. Run prim auth login to re-authenticate.` -- relay it.

## Ground rules

1. Don't guess IDs. Discover them with `npx --yes @primitive.ai/prim spec list`, `npx --yes @primitive.ai/prim spec list --project-id <pid>`, or `npx --yes @primitive.ai/prim context list`.
2. Every command accepts `--help`. When unsure of flags, run `npx --yes @primitive.ai/prim <cmd> --help` rather than guessing.
3. The CLI prints API errors as one-liners to stderr and exits non-zero. Treat any non-zero exit as actionable. If a command fails with an unrecognized error, re-run with `--help` to check your flags. If auth-related, re-check `auth status`.

## Working with the decision graph

Separate from specs, prim passively captures the decisions you make during a coding session -- which library, which pattern, which config value -- into a queryable decision graph, and actively **gates** edits that would conflict with a load-bearing prior decision. Capture and the gate run automatically through the session hooks installed by `npx --yes @primitive.ai/prim claude install` (Claude Code) or `npx --yes @primitive.ai/prim codex install` (Codex). You never invoke capture; you *respond* to the gate and *read* the graph.

### Heed the conflict gate
Before an edit (Claude Code: Edit/Write/MultiEdit; Codex: apply_patch) a PreToolUse hook scores the target file against the graph:

- **deny** -- the edit is blocked: it conflicts with a load-bearing prior decision. Don't fight it. Read the reason line; it names the decision id. If you genuinely intend to override that decision, run `npx --yes @primitive.ai/prim reconcile dec_<shortId>`, then retry the edit once. Otherwise choose an approach that respects the decision.
- **warn / additional context** -- the edit proceeds, but a relevant prior decision is surfaced. Read it. On Codex a would-be `ask` is delivered as allow-plus-context (Codex can't pause mid-tool), so that context is your only signal -- read it before continuing.
- **"decision check skipped / not verified" or "... partial / truncated"** -- the check could not fully run. Treat constraints as UNKNOWN, not clear; never read silence as approval.

The gate fail-opens on its *own* infrastructure errors (no daemon, network blip, org-unbound token) -- a setup problem never blocks your edit. That is exactly why an "unavailable" note matters: it is the honest signal that the check, not your edit, is what failed.

### Read the graph before large or load-bearing edits
- `npx --yes @primitive.ai/prim decisions check --files "src/a.ts,src/b.ts"` -- which active decisions reference the files you're about to touch (comma-separated paths, one `--files` value). Run it before a big change.
- `npx --yes @primitive.ai/prim decisions recent` -- the team's recent decisions, each row badged by author and agent (`Your Claude Code` / `Your Codex`); `--limit <n>` and `--since <dur>` narrow it.
- `npx --yes @primitive.ai/prim decisions show <idOrShortId>` and `npx --yes @primitive.ai/prim decisions cascade <idOrShortId>` -- full detail, and the downstream blast radius a change would disturb.

### Reconcile and the verdict footer
`npx --yes @primitive.ai/prim reconcile <idOrShortId>` mints a single-use bypass for the named decision -- it prints `[prim] reconcile bypass issued for dec_<short> (expires in ...)` to STDERR, with the bypass JSON on STDOUT. Your *next* edit to the governed file then goes through, and on that edit prim prints a verdict footer to STDERR -- confirmation the override was recorded, not silently dropped:

```
✓ Conflict caught before merge · N decisions saved · <author>'s intent preserved
```

`N` is the reconciled decision's downstream live-dependent count, shown as `N+` when the server caps it.

### Presence
With the daemon running (`npx --yes @primitive.ai/prim daemon start`), `npx --yes @primitive.ai/prim daemon status` includes the live online count in its STDOUT JSON (when presence is fresh); Claude Code surfaces it in the statusline as `team: N online`. Your captured decisions are attributed to your agent automatically -- no flag required.

## Common workflows

### Read a spec's current text (do this before any partial edit)
```
npx --yes @primitive.ai/prim spec get <id> --text-only > spec.md
```
`npx --yes @primitive.ai/prim spec update <id> --file <path>` replaces the entire body. Fetch first if you're only changing part of it.

### Update a spec from a local file and apply to the project
```
npx --yes @primitive.ai/prim spec list --project-id <pid>     # find the spec for a project
npx --yes @primitive.ai/prim spec update <id> --file spec.md  # replaces spec body
npx --yes @primitive.ai/prim spec sync <id>                   # required -- update doesn't apply changes to the project
```
`npx --yes @primitive.ai/prim spec sync` is **async**: it returns immediately with `Triggered sync for spec`, then applies in the background. The project isn't updated when the command returns -- surface that to the user.

Auto-map runs automatically on the server after every `spec update`. Call `npx --yes @primitive.ai/prim spec auto-map <id>` explicitly only to re-run mapping without changing the spec text.

### Map files to a spec (so pre-commit auto-syncs all affected specs)
```
npx --yes @primitive.ai/prim spec map <id> -p "src/auth/**" "src/foo/**"   # multiple patterns at once
npx --yes @primitive.ai/prim spec unmap <id> -p "src/auth/**"              # remove one
npx --yes @primitive.ai/prim spec unmap <id>                               # clear all manual patterns
```

### Create or link a context
```
npx --yes @primitive.ai/prim context create -s project -n "<name>" --file <path> --project-id <pid>   # add --spec to make it a spec
npx --yes @primitive.ai/prim context create -s global -n "<name>" --text "..."                        # filed in the global context pane, not linked to a specific project
npx --yes @primitive.ai/prim context link <ctxId> --project <projectId>                                # works on any scope
npx --yes @primitive.ai/prim context unlink <ctxId> --project <projectId>                              # remove a link
```

### Update or delete a context
```
npx --yes @primitive.ai/prim context update <id> -n "<new name>"           # rename
npx --yes @primitive.ai/prim context update <id> --file <path>             # replace body
npx --yes @primitive.ai/prim context delete <id>                           # permanent -- confirm with the user first
```

### Create a project (optionally with a linked spec)
```
npx --yes @primitive.ai/prim project create -n "<name>" -d "<desc>"
npx --yes @primitive.ai/prim project create -n "<name>" --spec <contextId>     # value is a context ID
```

### Link a spec to a branch (and an optional PR)

Linking is **automatic** once the pre-commit hook is installed and a spec is bound to your branch — every commit refreshes the link's metadata, including the PR number (detected from `gh pr view` when `gh` is on `PATH`). When a spec was authored for the work on this branch, bind it at the right moment so the hook can take over — do this without waiting for the user to ask. When no spec exists for the work, **do not bind one** — see "Decide whether a spec exists for this branch" below.

**At the start of branch work, install the hook** (skip if `.git/hooks/pre-commit` or `.husky/pre-commit` already invokes `prim-pre-commit`):
```
npx --yes @primitive.ai/prim hooks install --yes
```

**When you create a spec for branch-scoped work, always pass `--branch`** (and `--pr` if a PR already exists):
```
br=$(git rev-parse --abbrev-ref HEAD)
pr=$(gh pr view --json number -q .number 2>/dev/null)
npx --yes @primitive.ai/prim spec create -s project -n "<name>" --file <path> --branch "$br" ${pr:+--pr "$pr"}
```
`--branch` requires a GitHub origin; if `git remote get-url origin` isn't GitHub the link is silently dropped (stderr warning). There is no `prim spec link` subcommand in v1 — to rebind a spec to a different branch, edit it from the spec editor UI.

**Decide whether a spec exists for this branch.** A spec is "for this branch" only if one of:
- the user named a spec ID or title in conversation,
- a spec was created with `--branch "$br"` (visible via `npx --yes @primitive.ai/prim spec list --json | jq --arg br "$br" '.[] | select(.linkedBranches[]?.branch == $br)'`, where `$br` is the same shell variable set in the recipe above).

**Do not** browse `prim spec list` and pick the closest- or most-related-sounding spec. Topical proximity is not authorship — two specs that touch the same area of the codebase can describe entirely different intents. An irrelevant link pollutes drift signal and silently misattributes review findings; no link is strictly better than a wrong link.

If neither signal applies, **stop and ask the user**:

> "I couldn't find a spec associated with this branch. Is there one I should link, or should I draft one from the PR description and our conversation?"

Three legitimate answers:
- **User names an existing spec** → proceed to "When the user has identified a spec for this branch" below.
- **User declines a spec entirely** → leave the PR unlinked.
- **User asks you to draft one** →
  - Compose with these sections (drop any that would only restate the obvious): *Goal*, *Requirements / Behavior*, *Technical Approach*, *Key Decisions*, *Out of Scope*. Scope to what the PR actually changed; don't restate the unchanged system. Each fact appears in exactly one section.
  - Voice: plain language; lead with the point; **intent before mechanism** ("users see each other's edits" before "we use WebSocket"); present tense, active voice; one idea per paragraph; cut sentences that don't earn their place.
  - **Key Decisions** is a markdown table — columns *Decision | Rationale | Trade-offs*, one row per non-obvious choice.
  - Title is just the feature name (no `Spec:` prefix); no numbered or parenthetical headers. Match length to PR complexity — a small fix is one screen; a substantial feature warrants the full shape.
  - Do not paste the PR description verbatim — a spec captures *intent*, not a change log. If the rationale behind a non-obvious decision isn't in conversation, ask one or two targeted questions before drafting; do not invent rationale.
  - Show the user the drafted text and wait for go-ahead before running `spec create`.
  - Then create-and-link using the recipe above.

**When the user has identified a spec for this branch, check whether it's bound to your branch** before committing:
```
npx --yes @primitive.ai/prim context get <specId> --json | jq '.linkedBranches[]?.branch'
```
- Your branch appears → done; the hook keeps it fresh.
- Empty or branch absent → the first commit's hook auto-binds it; no CLI step needed.
- Bound only to another branch → the hook silently excludes it from your branch's syncs; rebind via the editor UI before committing.

**After `gh pr create`**, no CLI step is required: the next commit's hook patches `linkedBranches[].prNumber` via `gh pr view`, and GitHub's webhook to Primitive sets the same field server-side within seconds. Confirm with:
```
npx --yes @primitive.ai/prim context get <specId> --json | jq .linkedBranches
```

**On every commit, read the `[synced]` line to verify link state** — it piggybacks the suffix:
- `(auto-linking to <branch>)` — first sync; server is binding now.
- `(linked to <branch> #<n> <state>)` — link is sticky.
- `[skip] <id> — not linked to <branch>` — the spec is bound elsewhere; investigate before continuing.

### Trigger PR Intent Review or dispatch drift-fix against a linked PR

```
npx --yes @primitive.ai/prim spec review <id> --pr <n>             # head SHA defaults to `git rev-parse HEAD`
npx --yes @primitive.ai/prim spec review <id> --pr <n> --sha <s>   # explicit SHA
npx --yes @primitive.ai/prim spec drift  <id> --pr <n>             # dispatch the Claude Code drift-fix workflow against the PR
```

The review bot runs server-side, posts a PR comment with findings, and the outcome surfaces on the **next** pre-commit sync's `[synced]` line as ` (reviewed: <n> finding(s) → <prCommentUrl>)` or ` (review failed)` — don't poll the API yourself.

`spec drift` requires the `primitive-drift-fix.yml` workflow file checked into the repo and the GitHub App's `actions:write` scope granted on the org. The CLI errors out otherwise with a one-liner naming the likely causes.

Neither `spec review` nor `spec drift` accepts `--json` in v1 — they emit a single human-readable line on stdout. Capture it as text or branch on `$?`.

### Inspect a task's auto-completion state

```
npx --yes @primitive.ai/prim spec status <taskId>
```

Reports the task's `status`, whether `auto-complete suppressed: yes/no`, and the timestamp + PR # of the most-recent auto-completion activity (with the bot's explanation). Use this after a merge to verify the auto-complete bot acted — or to see *why* it didn't (suppressed via the dashboard, last activity from a different PR, etc.).

`spec status` operates on a **task ID**, not a context/spec ID. Discover task IDs from `prim project create` output or from the editor URL. No `--json` support in v1; output is a fixed `key: value` block on stdout.

### Install the pre-commit hook
```
npx --yes @primitive.ai/prim hooks install                       # auto-detects Husky and prompts
npx --yes @primitive.ai/prim hooks install --yes                 # confirm Husky (non-interactive)
npx --yes @primitive.ai/prim hooks install --target=git-hooks    # force .git/hooks (skip Husky detection)
npx --yes @primitive.ai/prim hooks uninstall
```
Under `CI=1` (or with `--non-interactive`), `hooks install` fails fast in a Husky repo unless `--yes` or `--target` is set. The error message names both escapes.

**Note:** `hooks uninstall` only removes `.git/hooks/pre-commit`. If the hook was installed into `.husky/pre-commit`, you must remove the prim block from that file manually.

## How the pre-commit hook behaves

`npx --yes @primitive.ai/prim hooks install` adds a hook that, on every commit:

1. Fetches the org's spec-to-file-pattern mappings.
2. Glob-matches staged files against each spec's patterns (`*` and `**` supported).
3. For each affected spec, sends `git diff --cached` to `/api/cli/contexts/:id/sync-diff`. The backend runs an **LLM over (current spec + diff)** to produce edits, updates the spec text, then applies the new spec to the project.
4. Prints `[synced] <id> -- <name>` or `[skip] <id> -- <reason>` per affected spec to stdout, and `[error]` lines to stderr.

What that means:

- **The hook is not `npx --yes @primitive.ai/prim spec sync`.** `npx --yes @primitive.ai/prim spec sync` re-applies the *existing* spec to the project. The hook calls `sync-diff` -- an LLM updates the spec from the code change, then applies the new spec to the project. The casual "just commit and the hook will sync" is ambiguous; when explaining to the user, specify which operation you mean.
- **The hook never blocks the commit.** Failures (auth, network, backend) print `[error]` to stderr but exit 0, so a successful `git commit` doesn't prove the spec changed. Check the hook's `[synced]` / `[error]` / `[skip]` output, or verify with `npx --yes @primitive.ai/prim spec get <id>`.
- **Diffs over 256 KiB are truncated.** The hook logs `(truncated: X KiB -> Y KiB analyzed)`. The LLM only sees the first 256 KiB of the diff.
- **The hook is branch-aware.** It sends `repoFullName`, `branch`, `sha`, and `prNumber` (the last detected from `gh pr view` when `gh` is on `PATH`, silently null otherwise). The server filters mappings to specs linked to the current branch *or* unlinked (auto-link candidates); specs bound to other branches are silently excluded from the affected list — they don't surface as `[skip]` lines, they just don't appear. If you push an explicit `sync-diff` for an other-branch spec via the API, the hook logs `[skip] <id> — <name> — not linked to <branch>` and continues.
- **Link state and review results piggyback on the synced line.** `[synced]` lines carry ` (linked to <branch> #<pr> <state>)` or ` (auto-linking to <branch>)`, and once a PR Intent Review completes they grow ` (reviewed: <n> finding(s) → <prCommentUrl>)` or ` (review failed)`. PR `<state>` (`open` / `closed` / `merged`) tracks GitHub webhook deliveries — give it a few seconds to settle after a state change.
- **To suppress the hook for one commit** (e.g., when intentionally desyncing code from spec, or when committing unrelated changes), use `git commit --no-verify`.

## Output formats

Every data-returning command accepts `--json`. With `--json` set, stdout is a single JSON document — pipe to `jq` instead of parsing text:

- `id=$(npx --yes @primitive.ai/prim context create -s global -n foo --text "x" --json | jq -r ._id)` — capture an ID
- `npx --yes @primitive.ai/prim spec list --json | jq -r '.[]._id'` — list every spec ID
- `npx --yes @primitive.ai/prim auth status --json | jq -r .authenticated` — boolean; the exit code remains the authoritative signal

Without `--json`, mutating commands (`context create/update/delete/link/unlink`, `spec create/update/sync/map/unmap/auto-map`, `project create`) emit the bare resource `_id` to **stdout** (one line, no prefix) and human-readable diagnostics to **stderr**. So this also works as a one-liner without `jq`:

- `id=$(npx --yes @primitive.ai/prim context create -s global -n foo --text "x")`

| Command | Without `--json` | With `--json` |
|---|---|---|
| Mutators above | stdout: bare `_id`; stderr: `Created/Updated/...` prefix (plus secondary lines: `Root project:`, `Linked spec:`, pattern lists) | stdout: `{ "_id": "<id>", … }` with extras where applicable (`spec sync` adds `specRootTaskId`; `context link/unlink` add `project`; `project create --spec` adds `spec`; `spec map/unmap` add `filePatterns`) |
| `context list`, `spec list` (non-empty) | stdout: rows (first token = `_id`); stderr: `N context(s)` / `N spec(s)` summary | stdout: JSON array |
| `context list`, `spec list` (empty) | stdout: (empty); stderr: `No contexts found.` / `No spec documents found.` | stdout: `[]` |
| `spec list --project-id <pid>` | stdout: key:value block (or stdout empty + stderr `No spec document found for this project.` if none) | stdout: single object or `null` |
| `context get <id>` | stdout: pretty-printed JSON (always JSON; `--json` accepted for symmetry) | stdout: pretty-printed JSON |
| `spec get <id>` | stdout: human-readable key:value block (`ID:` line first) | stdout: JSON object |
| `spec get <id> --text-only` | stdout: raw spec markdown, nothing else | stdout: JSON object (`--json` wins over `--text-only`) |
| `auth status` | stdout: human readout; **exit code is the authoritative signal** (0 = authed) | stdout: JSON; exit code unchanged |

## Pitfalls

- **`npx --yes @primitive.ai/prim spec sync` archives anything dropped from the spec.** Removed content is archived (recoverable), not deleted.
- **`npx --yes @primitive.ai/prim spec update` doesn't apply changes to the project.** Always follow with `npx --yes @primitive.ai/prim spec sync <id>`.
- **`npx --yes @primitive.ai/prim spec update --file` replaces the whole body.** Fetch with `npx --yes @primitive.ai/prim spec get <id> --text-only` before any partial edit.
- **`npx --yes @primitive.ai/prim spec sync` rejects non-spec contexts** with "Context is not a spec document. Use `prim context` instead." Use `npx --yes @primitive.ai/prim spec list` to find spec IDs.
- **`npx --yes @primitive.ai/prim context delete` is permanent.** Confirm with the user before deleting.
- **Scope is set at creation.** To change it, delete and recreate the context.
- **The hook silently excludes specs bound to other branches.** If you don't see a spec you expected to sync, check its `linkedBranches[]` via `npx --yes @primitive.ai/prim context get <id>` — it may be bound to a different branch. To re-bind, use the spec editor (no CLI subcommand in v1).

## After each task

Report the names and IDs you touched (spec, context, project) so the user can verify in the dashboard. If you ran `npx --yes @primitive.ai/prim spec sync`, remind the user it's async -- the project settles in the background.
