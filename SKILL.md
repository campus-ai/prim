---
name: prim
description: Use the prim CLI for managing Primitive specs, contexts, projects, and pre-commit hooks. TRIGGER when the user mentions Primitive, prim, "specs" (in the Primitive sense), or "contexts" (in the Primitive sense); when the repo's package.json depends on @primitive.ai/prim; when the user asks to sync, map, update, or auto-map a spec; when configuring Primitive pre-commit hooks. SKIP when "spec" means test specs (vitest, jest, rspec), when "context" means React context or LLM context window, or for unrelated CLIs.
---

# Working with the prim CLI

`prim` is the official CLI for [Primitive](https://app.getprimitive.ai). Use it — don't reach for shell or curl.

## Mental model

A **spec** captures intent for execution — it defines what should be done, usually so other agents (or humans) can act on it. A **context** is everything else: supporting material that informs but doesn't define the work — design docs, references, prior art, shared documentation, examples. When deciding which to create, ask: does this say *what to do*, or does it *inform* whoever's doing it? A project has at most one spec but can link many contexts.

In Primitive, a markdown spec is associated with a **project**. The spec is the source of truth: `npx --yes @primitive.ai/prim spec sync` parses the spec, diffs it against the project, and **applies the diff** — adding, updating, or **archiving** items in the project to match. Items removed from a spec are soft-archived (recoverable via the dashboard), not deleted — but they leave the active view, so flag the user before large spec rewrites on projects with work in flight.

A **spec is a kind of context** — same IDs, same storage. The `npx --yes @primitive.ai/prim spec ...` commands are a focused view onto specs; `npx --yes @primitive.ai/prim context get <id>` works on a spec ID and vice versa.

## Auth

Run `npx --yes @primitive.ai/prim auth status` first. It exits **0 if authenticated, 1 if not** — branch on the exit code, don't parse the message.

Three ways to authenticate, in priority order:

1. **`PRIM_TOKEN` environment variable** — preferred for agents and CI. Set it before invoking prim and you're done; no interactive flow, no token files.
2. **`npx --yes @primitive.ai/prim auth set-token <token>`** — saves a bearer token to `~/.config/prim/token`. Use when the user has a long-lived token in hand.
3. **`npx --yes @primitive.ai/prim auth login`** — opens a browser via WorkOS OAuth. **An agent cannot complete this.** If `auth status` exits non-zero and `PRIM_TOKEN` is unset, **stop and ask the user** to run `npx --yes @primitive.ai/prim auth login` themselves.

The CLI auto-refreshes expired tokens. On unrecoverable expiry it throws `Authentication expired. Run prim auth login to re-authenticate.` — relay it.

## Before doing anything else

1. Don't guess IDs. Discover them with `npx --yes @primitive.ai/prim spec list`, `npx --yes @primitive.ai/prim spec list --project-id <pid>`, or `npx --yes @primitive.ai/prim context list`.
2. Every command accepts `--help`. When unsure of flags, run `npx --yes @primitive.ai/prim <cmd> --help` rather than guessing.
3. The CLI prints API errors as one-liners to stderr and exits non-zero. Treat any non-zero exit as actionable.

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
npx --yes @primitive.ai/prim spec sync <id>                   # required — update doesn't apply changes to the project
```
`npx --yes @primitive.ai/prim spec sync` is **async**: it returns immediately with `Triggered sync for spec`, then applies in the background. The project isn't updated when the command returns — surface that to the user.

### Map files to a spec (so pre-commit auto-syncs all affected specs)
```
npx --yes @primitive.ai/prim spec map <id> -p "src/auth/**" "src/foo/**"   # multiple patterns at once
npx --yes @primitive.ai/prim spec unmap <id> -p "src/auth/**"              # remove one
npx --yes @primitive.ai/prim spec unmap <id>                               # clear all manual patterns
```
`npx --yes @primitive.ai/prim spec auto-map <id>` runs after every `spec update` on a spec — call it explicitly only to re-run without a text change.

### Create or link a context
```
npx --yes @primitive.ai/prim context create -s project -n "<name>" --file <path> --project-id <pid>   # add --spec to make it a spec
npx --yes @primitive.ai/prim context create -s global -n "<name>" --text "..."                        # filed in the global context pane, not linked to a specific project
npx --yes @primitive.ai/prim context link <ctxId> --project <projectId>                                # works on any scope
```

### Create a project (optionally with a linked spec)
```
npx --yes @primitive.ai/prim project create -n "<name>" -d "<desc>"
npx --yes @primitive.ai/prim project create -n "<name>" --spec <contextId>     # value is a context ID
```

### Install the pre-commit hook
```
npx --yes @primitive.ai/prim hooks install     # auto-detects Husky and prompts
npx --yes @primitive.ai/prim hooks uninstall
```

## How the pre-commit hook behaves

`npx --yes @primitive.ai/prim hooks install` adds a hook that, on every commit:

1. Fetches the org's spec→file-pattern mappings.
2. Glob-matches staged files against each spec's patterns (`*` and `**` supported).
3. For each affected spec, sends `git diff --cached` to `/api/cli/contexts/:id/sync-diff`. The backend runs an **LLM over (current spec + diff)** to produce edits, updates the spec text, then applies the new spec to the project.
4. Prints `[synced] <id> — <name>` or `[skip]` per affected spec to stdout, and `[error]` lines to stderr.

What that means:

- **The hook is not `npx --yes @primitive.ai/prim spec sync`.** `npx --yes @primitive.ai/prim spec sync` re-applies the *existing* spec to the project. The hook calls `sync-diff` — an LLM updates the spec from the code change, then applies the new spec to the project. The casual "just commit and the hook will sync" is ambiguous; when explaining to the user, specify which operation you mean.
- **The hook never blocks the commit.** Failures (auth, network, backend) print `[error]` to stderr but exit 0, so a successful `git commit` doesn't prove the spec changed. Check the hook's `[synced]` / `[error]` / `[skip]` output, or verify with `npx --yes @primitive.ai/prim spec get <id>`.
- **Diffs over 256 KiB are truncated.** The hook logs `(truncated: X KiB → Y KiB analyzed)`. The LLM only sees the first 256 KiB of the diff.
- **To suppress the hook for one commit** (e.g., when intentionally desyncing code from spec, or when committing unrelated changes), use `git commit --no-verify`.

## Output formats

| Command | Output | Where the ID is |
|---|---|---|
| `npx --yes @primitive.ai/prim context create` | `Created context: <id>` | Match `^Created context: (\S+)` |
| `npx --yes @primitive.ai/prim project create` | `Created project: <id>` | Match `^Created project: (\S+)` |
| `npx --yes @primitive.ai/prim spec update` | `Updated spec: <id>` | Match `^Updated spec: (\S+)` |
| `npx --yes @primitive.ai/prim spec sync` | `Triggered sync for spec: <id>` | Match `^Triggered sync for spec: (\S+)` |
| `npx --yes @primitive.ai/prim context list`, `npx --yes @primitive.ai/prim spec list` | Table, ID is the first whitespace-delimited column | First token of each row |
| `npx --yes @primitive.ai/prim spec list --project-id <pid>` | Single-spec block (key:value) | `ID:` line |
| `npx --yes @primitive.ai/prim context get <id>` | Pretty-printed JSON | `._id` field |
| `npx --yes @primitive.ai/prim spec get <id>` | Human-readable key:value block | `ID:` line |
| `npx --yes @primitive.ai/prim spec get <id> --text-only` | Raw spec markdown, nothing else | n/a |

For structured metadata on a spec (review status, root project, sync version, scope, file patterns), use `npx --yes @primitive.ai/prim context get <specId>` — it returns JSON.

## Pitfalls

- **`npx --yes @primitive.ai/prim spec sync` archives anything dropped from the spec.** Removed content is archived (recoverable), not deleted.
- **`npx --yes @primitive.ai/prim spec update` doesn't apply changes to the project.** Always follow with `npx --yes @primitive.ai/prim spec sync <id>`.
- **`npx --yes @primitive.ai/prim spec update --file` replaces the whole body.** Fetch with `npx --yes @primitive.ai/prim spec get <id> --text-only` before any partial edit.
- **`npx --yes @primitive.ai/prim spec sync` rejects non-spec contexts** with "Context is not a spec document." Use `npx --yes @primitive.ai/prim spec list` to find spec IDs.
- **Scope is set at creation.** To change it, delete and recreate the context.

## After each task

Report the names and IDs you touched (spec, context, project) so the user can verify in the dashboard. If you ran `npx --yes @primitive.ai/prim spec sync`, remind the user it's async — the project settles in the background.
