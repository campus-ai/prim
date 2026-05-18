---
name: prim
description: Use the prim CLI for managing Primitive specs, contexts, projects, and pre-commit hooks. TRIGGER when the user mentions Primitive, prim, "specs" (in the Primitive sense), or "contexts" (in the Primitive sense); when the repo's package.json depends on @primitive.ai/prim; when the user asks to sync, map, update, or auto-map a spec; when configuring Primitive pre-commit hooks. SKIP when "spec" means test specs (vitest, jest, rspec), when "context" means React context or LLM context window, or for unrelated CLIs.
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

Linking is **automatic** once the pre-commit hook is installed and a spec is bound to your branch — every commit refreshes the link's metadata, including the PR number (detected from `gh pr view` when `gh` is on `PATH`). Your job is to bind the spec at the right moment so the hook can take over. Do this for every branch — never wait for the user to ask.

Two ways to bind a spec to a branch:

```
npx --yes @primitive.ai/prim spec create -s project -n "<name>" --file <path> --branch <branch> --pr <n>   # explicit at creation; --pr is optional
```

Or implicitly: the pre-commit hook **auto-links an unlinked spec to the current branch** the first time it sees a sync on that branch — no flag needed. The `[synced]` line on that first sync prints ` (auto-linking to <branch>)`; subsequent syncs print ` (linked to <branch> #<pr> <state>)` once the link sticks.

Inspect a spec's bindings via `npx --yes @primitive.ai/prim context get <id>`. The `linkedBranches[]` field lists every `(branch, prNumber, prState, prReviewDecision)` the spec is bound to. The editor UI surfaces the same data as a status pill.

- **`--branch` requires a GitHub origin.** With `--branch`, the CLI reads `repoFullName` from `git remote get-url origin`. If origin isn't GitHub, the link is silently dropped with a warning on stderr — the spec is still created, just unlinked — fix it later from the editor UI.
- **There is no `prim spec link` subcommand in v1.** To re-link a spec to a different branch, edit it from the spec editor. The CLI only ever auto-links on first sync or accepts `--branch` at creation.

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
