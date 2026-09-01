# @primitive.ai/prim

The official CLI for [Primitive](https://getprimitive.ai)'s **decision graph**. It
passively captures the decisions your team makes while coding and reports team
presence — from the command line and via session + git hooks.

> [!WARNING]
> This project is in **alpha**. Commands and APIs may change between releases.

> [!NOTE]
> **Conflict Gates** check each edit against the decision graph and surface any
> load-bearing decision it conflicts with. When **Enforcement** is enabled for your
> organization, gates can warn, pause, or block a conflicting edit until you reconcile
> the decision and retry. Automatic decision capture in active repositories is separate.

## Installation

Requires Node.js 20+.

```bash
npm install -g @primitive.ai/prim
```

Or run directly without installing:

```bash
npx @primitive.ai/prim
```

In commands such as `npx --yes @primitive.ai/prim@latest ...`, the first `--yes`
belongs to **npm**: it skips npm's package-install confirmation. It does not approve a
Primitive action. Prim's own global `--yes` comes after the package name, for example
`npx --yes @primitive.ai/prim@latest --yes decisions create ... --attribution user`,
and applies only to that Prim invocation.

## Quick Start

One command does the whole install — auth, session hooks, daemon, git hooks,
skill, and the welcome:

```bash
prim setup                 # add --agent codex or --agent hermes; --no-daemon explicitly opts out
```

Or run the steps individually:

```bash
# 1. Authenticate via browser (WorkOS OAuth)
prim auth login

# 2. Wire the session hooks (decision capture + presence)
prim claude install        # or: prim codex install / prim hermes install

# 3. Start the companion daemon (latency + team presence)
prim daemon start

# 4. Install the git hooks (pre-commit decision check + post-commit capture)
prim hooks install
```

`prim setup` (and `prim claude preauth`) also pre-authorize prim so an agent's own
calls never stall on a permission prompt: a scoped `Bash(npx --yes @primitive.ai/prim*)`
allow-rule for default mode (it covers both the `@latest` onboarding form and the bare
day-to-day form), plus an `autoMode.environment` trust line so auto mode's safety
classifier treats prim as trusted tooling rather than untrusted downloaded code.

### Set up with your coding agent

Paste this into Claude Code (or any coding agent). The command is in **your** message,
so the agent runs it directly — instead of fetching a doc and executing a command from
it, which an auto-mode safety classifier blocks as untrusted-origin code:

```text
Install the Primitive CLI and activate passive decision capture for this repository: run `npx --yes @primitive.ai/prim@latest setup` and surface its output. Drive it yourself; I'll only click Authorize in the browser. This request authorizes setup's built-in activation of this repository and an idempotent retry of that step, but not activation in another repository or creation of a Decision. If enable or health fails, surface the actual error; do not claim fresh activation approval is required. Then show me the welcome.
```

That single command runs the whole install and current-repository activation in one
process (auth → session hooks → daemon → git hooks → skill → welcome). The detailed
step-by-step the agent follows — and the manual fallback — live in
[`setup.md`](./setup.md).

## Commands

### Setup

```bash
prim setup                   # Run the whole install in one shot
prim setup --agent codex     # Same, for OpenAI Codex
prim setup --agent hermes    # Same, for Hermes Agent (global-only config)
prim setup --no-daemon       # Stop it and persistently opt out of supervised delivery
```

Orchestrates auth → session hooks → supervised daemon → capture-health gate → git hooks → skill → welcome,
re-running each underlying command so every step behaves exactly as if run by
hand (including the browser login). Idempotent — safe to re-run.

### Uninstall

```bash
prim uninstall
```

Stops the companion daemon, removes the current repository's Prim-owned agent
and Git-hook surfaces when run inside a Git repository, removes the user-scoped
Claude, Codex, Hermes, and Git-hook surfaces, then deletes only schema-valid
Prim runtime bytes. Foreign configuration is retained; ambiguous ownership
makes the command fail closed and retain the runtimes. If a removal races or
fails after one runtime changes, its JSON result reports each runtime's exact
state so rerunning can safely finish cleanup. Authentication,
undelivered journals, repository bindings, and agent skill guidance are kept.
Use `prim skill uninstall --agent <claude|codex|hermes> --scope <project|user>`
when you also want to remove a known skill target.

### Auth

```bash
prim auth login              # Authenticate via browser
prim auth set-token <token>  # Save a bearer token (e.g. for CI)
prim auth clear              # Remove saved tokens
prim auth status             # Check authentication status
prim auth api-keys mint --name <name> [--expires-at <epoch-ms>] # Mint a user key; secret prints once
prim auth api-keys list [--limit <count>] [--after <api-key-id>] # List user-key metadata
prim auth api-keys revoke <api-key-id> # Revoke a user key
```

### GitHub

```bash
prim github connect              # Install or reuse the Primitive GitHub App for this checkout
prim github connect --no-browser # Print the installation URL without opening it
```

The command first reuses existing repository access. When access is missing, it creates a
server-owned GitHub App installation intent, opens its installation URL unless browser opening is
suppressed, polls the same intent, then verifies and persists this checkout's binding. A completed
installation without admin access to this repository remains truthfully unbound.

### Session integration

Wires the agent's session hooks so the decisions you make are captured into the
graph, and presence is reported. Each hook
self-resolves the CLI at run time (PATH, then a local install, then
`npx --yes @latest`), so it keeps working with no global install.

Installs into the current project by default — the repo's `.claude/settings.json`
/ `.codex/hooks.json`, resolved from the git root (so any subdirectory works);
pass `--scope user` to install machine-wide. Hermes is the exception: it reads
shell hooks only from the global `~/.hermes/config.yaml`, so `prim hermes install`
is always user-scoped — and prim merges in place, leaving the rest of that file
(providers, models, your own hooks) untouched.

```bash
prim claude install                # Install Claude Code hooks (project scope; uninstall / status)
prim claude install --scope user   # Install machine-wide instead
prim codex install                 # Install OpenAI Codex hooks (project scope)
prim hermes install                # Install Hermes Agent hooks (global ~/.hermes/config.yaml)
```

Passive capture is repo-scoped even when these integrations are installed at user
scope. `prim enable` marks the current Git repo active; `prim disable` makes it
inactive. A project-scoped install activates its repo automatically. In an inactive
repo, session content is not passively captured. Here “inactive” means Prim's normal
effective capture check is false, including an explicit local `prim.active=false`.

An agent may still deliberately record one Decision from an inactive repo with
`prim decisions create`, but each invocation needs its own user approval. An explicit
request such as “record this Decision” supplies that approval for that one create; for
a proactive suggestion, the agent must show the proposed Decision and ask first. The
agent then passes Prim's global `--yes` for that invocation. This one-time approval does
not activate passive capture, and neither npm's `npx --yes`, setup approval, nor an
earlier create counts as approval for another Decision.

When a person runs `prim decisions create` interactively in an inactive repo, Prim
asks for that one-time approval itself. In non-interactive use it creates nothing
unless Prim's global `--yes` is present.

#### Claude decision feedback

Claude Code receives eventual, human-visible feedback when automatic capture
creates a `change` Decision. A later Claude `Stop` or fresh
`SessionStart` in the same Git worktree can display:

```text
[prim] response → created Decision (dec_a1b2c3d4): Use the stable API (https://app.getprimitive.ai/decisions/r571n1dqjdrtyxxpf0fnzee4gn8aed6q)
```

An author-private draft uses an actionable publish prompt instead:

```text
[prim] publish this Decision draft (dec_a1b2c3d4)? Use the stable API (https://app.getprimitive.ai/decisions/r571n1dqjdrtyxxpf0fnzee4gn8aed6q) Run `prim decisions publish decision-full-1` to share it with your team.
```

This is a hook `systemMessage` for the person using Claude Code; it is not
injected into the model's context. Delivery is at-least-once at the stdout
handoff boundary: prim acknowledges only after writing the hook response, so a
failed acknowledgment can show the same notification again. Notifications are
eligible for 24 hours. The originating session gets limited preference, but any
concurrent Claude session in the same worktree may consume the backlog. A hook
claims at most 40 notifications and renders at most 8,000 Unicode code points;
`hasMore` work is left for a later Stop or SessionStart rather than extending
the current hook.

Worktree scope comes from an opaque UUID stored under the worktree's Git
metadata (equivalent to `git rev-parse --git-path prim/workspace-id`), never an
absolute repository path. Linked worktrees receive distinct IDs, moving a
worktree preserves its ID, and a clone creates a new one. A corrupt or
unwritable identity is never silently replaced: capture falls back to the
legacy envelope. Disable/uninstall does not delete the identity.

Feedback uses the invoking CLI's credentials for direct HTTPS calls rather
than the daemon, avoiding cross-organization token ambiguity. One absolute
three-second in-process budget covers token refresh, lease, parsing, rendering,
and acknowledgment. This is not a hard three-second wall clock: it cannot
preempt shell/PATH or `npx` resolution, Node startup, Claude's own hook
scheduling, or synchronous filesystem work. The Git fallback has a separate
short timeout.

Alternatives considered:

| Option | Benefit | Limitation |
| --- | --- | --- |
| Existing hooks + direct HTTPS (current) | No new install surface; uses the invoking credentials | In-process budget is not a host-enforced wall clock |
| Claude's native hook timeout | Host-enforced termination | Settings migration; may kill a cold `npx` startup |
| Daemon routing | Lower steady-state latency | Daemon token/org may not match a concurrent session |
| Dedicated feedback binary | Lower startup overhead | New distribution and install migration |
| Synchronous pre-Stop classification | Stronger same-turn immediacy | Adds model latency and cost to the hook path |
| Detached delivery | Does not block Stop | Cannot return the current hook's `systemMessage` |

Run `prim claude status` to verify both existing feedback handlers are installed
and `prim doctor` to inspect server capability. No new
hook registration or binary is required when upgrading an existing correct
installation.

### Daemon

A supervised long-lived companion process that continuously drains captured
Moves, accelerates decision-graph reads, and powers the "team: N online"
presence count. `prim setup` requires it to become healthy unless the explicit
`--no-daemon` opt-out is supplied; hooks still fail soft if it later degrades.

```bash
prim daemon start      # start (stop / restart / status)
```

### Decisions

Read and respond to the decision graph.

```bash
prim decisions recent                    # Recent decisions feed (--author <name> for one teammate's)
prim decisions show <id>                 # Drill into one decision
prim decisions cascade <id>              # Blast radius of a decision
prim decisions check --files <…>         # Active decisions referencing files (warn-only)
prim decisions confirm <id>              # Answer a rationale-confirmation prompt
prim decisions create --intent <…> --attribution <user|agent>  # Record with explicit origin
prim decisions link <child> --on <parent>    # Relate: <child> depends on <parent>
prim decisions unlink <child> --on <parent>  # Remove that dependency
```

`<id>` accepts a full decision ID or its short ID. STDOUT is machine-readable
JSON; human-readable status goes to STDERR.

When passive capture is inactive in the current repo, an approved one-time create is:

```bash
npx --yes @primitive.ai/prim@latest --yes decisions create --intent "…" --attribution user
```

Here npm's first `--yes` only permits package resolution; Prim's second `--yes`
confirms this create. It does not enable the repo or authorize a later create.

Every create requires `--attribution user|agent`. Use `user` only when the person
directly stated, selected, or confirmed the exact recorded choice. Use `agent` when
the agent introduced that exact choice while pursuing a broader request. A broad task
prompt or permission to implement does not make the resulting agent choice a user
Decision. If the origin is ambiguous, confirm the exact choice with the person before
creating it; do not guess.

`link` / `unlink` curate the dependency edges the automatic linker would otherwise
own — `<child>` depends on `<parent>`. Both are idempotent and refuse any link that
would create a cycle (exit 2); an unresolved id exits 4.

### Reconcile

```bash
prim reconcile <id>    # Mint a single-use bypass for a decision Conflict Gates flagged
```

When Conflict Gates **Enforcement** is enabled for your organization, this command
authorizes one retry for the named decision.

### Hooks

```bash
prim hooks install     # Install git hooks (pre-commit decision check + post-commit capture)
prim hooks uninstall   # Remove the prim git hooks
```

The pre-commit hook checks staged files against the live decision graph
(warn-only — it never blocks the commit). The post-commit hook records each
commit as a capture boundary for classification. Supports
[Husky](https://typicode.github.io/husky/) — `prim hooks install` detects Husky
and offers to install into `.husky/`.

### Presence statusline

```bash
prim statusline        # Render the team-presence statusline (reads the daemon)
```

Claude Code has one custom status-line slot. Installation uses a staged,
lightweight Primitive renderer when that slot is empty or already Primitive's;
an existing custom status line is preserved and reported explicitly. Use
`prim daemon status` or `prim doctor` for the same health signal in that case.

### Welcome

```bash
prim welcome           # Brief orientation to the decision graph (shown after setup)
```

### Session & journal

Lower-level plumbing for the capture pipeline — org binding and the local move
journal. Capture works automatically once the session hooks are installed **and the
repo is active**; these are for inspecting and steering it (e.g. multi-org machines).

```bash
prim session start <id>   # Pin a Claude Code session to an org   (list / drop <id>)
prim moves bind           # Pin the current directory to an org via .prim/workspace.json (drop)
prim moves status         # Per-bucket pending stats for the local journal
prim moves tail           # Pretty-print recent journal entries
prim moves flush          # Drain the local journals to the server (also runs from hooks)
```

### Skill

```bash
prim skill install --agent claude   # Install the decision-graph guide for Claude Code
prim skill install --agent codex    # …or write the guide into another agent's rules file
prim skill uninstall --agent claude # Remove it
prim skill status --agent claude    # Report whether it's installed
```

Teaches your agent how to work with the decision graph. For **Claude Code**
(`--agent claude`) this installs a skills-directory plugin at
`<repo>/.claude/skills/prim/` (or `~/.claude/skills/prim/` with `--scope user`)
— a `.claude-plugin/plugin.json` + `SKILL.md` that auto-loads as the model-invoked
`prim@skills-dir` skill, no marketplace step; restart Claude Code or run
`/reload-plugins` after installing. For every other agent it writes a managed
block into the rules file that agent reads (`--agent codex` → AGENTS.md,
`--agent hermes` → .hermes.md, or an auto-detected .cursor/rules, …). A bare
`prim skill install` (no `--agent`) auto-detects a rules file and writes the
block; pass `--target <path>` for an explicit file.

## Development

```bash
pnpm install
pnpm dev          # Build in watch mode
pnpm build        # Production build
pnpm test         # Run tests
pnpm typecheck    # Type-check
pnpm lint         # Lint
```

## License

[MIT](LICENSE)
