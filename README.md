# @primitive.ai/prim

The official CLI for [Primitive](https://getprimitive.ai)'s **decision graph**. It
passively captures the decisions your team makes while coding, gates edits that
conflict with prior team decisions, and reports team presence — from the command
line and via session + git hooks.

> [!WARNING]
> This project is in **alpha**. Commands and APIs may change between releases.

## Installation

Requires Node.js 20+.

```bash
npm install -g @primitive.ai/prim
```

Or run directly without installing:

```bash
npx @primitive.ai/prim
```

## Quick Start

One command does the whole install — auth, session hooks, daemon, git hooks,
skill, and the welcome:

```bash
prim setup                 # add --agent codex for Codex, --no-daemon to skip the daemon
```

Or run the steps individually:

```bash
# 1. Authenticate via browser (WorkOS OAuth)
prim auth login

# 2. Wire the session hooks (decision capture + conflict gate + presence)
prim claude install        # or: prim codex install

# 3. Start the companion daemon (latency + team presence)
prim daemon start

# 4. Install the git hooks (pre-commit decision check + post-commit capture)
prim hooks install
```

`prim claude install` also writes a scoped `Bash(npx --yes @primitive.ai/prim:*)`
allow-rule into `.claude/settings.json` (covering both the `@latest` onboarding form
and the bare day-to-day form), so an agent's prim calls don't stall on a permission
prompt.

An AI coding agent can drive the setup itself — see [`setup.md`](./setup.md).

## Commands

### Setup

```bash
prim setup                   # Run the whole install in one shot
prim setup --agent codex     # Same, for OpenAI Codex
prim setup --no-daemon       # Skip the companion daemon
```

Orchestrates auth → session hooks → daemon → git hooks → skill → welcome,
re-running each underlying command so every step behaves exactly as if run by
hand (including the browser login). Idempotent — safe to re-run.

### Auth

```bash
prim auth login              # Authenticate via browser
prim auth set-token <token>  # Save a bearer token (e.g. for CI)
prim auth clear              # Remove saved tokens
prim auth status             # Check authentication status
```

### Session integration

Wires the agent's session hooks so the decisions you make are captured into the
graph, conflicting edits are gated, and presence is reported. Each hook
self-resolves the CLI at run time (PATH, then a local install, then
`npx --yes @latest`), so it keeps working with no global install.

Installs into the current project by default — the repo's `.claude/settings.json`
/ `.codex/hooks.json`, resolved from the git root (so any subdirectory works);
pass `--scope user` to install machine-wide.

```bash
prim claude install                # Install Claude Code hooks (project scope; uninstall / status)
prim claude install --scope user   # Install machine-wide instead
prim codex install                 # Install OpenAI Codex hooks (project scope)
```

### Daemon

A long-lived companion process that accelerates the in-session decision checks
and powers the "team: N online" presence count. Optional — hooks fall back to
direct calls if it is down.

```bash
prim daemon start      # start (stop / restart / status)
```

### Decisions

Read and respond to the decision graph.

```bash
prim decisions recent                    # Recent decisions feed
prim decisions show <id>                 # Drill into one decision
prim decisions cascade <id>              # Blast radius of a decision
prim decisions check --files <…>         # Active decisions referencing files (warn-only)
prim decisions confirm <id>              # Answer a rationale-confirmation prompt
prim decisions create --intent <…>       # Author a decision directly (flags-only)
prim decisions link <child> --on <parent>    # Relate: <child> depends on <parent>
prim decisions unlink <child> --on <parent>  # Remove that dependency
```

`<id>` accepts a full decision ID or its short ID. STDOUT is machine-readable
JSON; human-readable status goes to STDERR.

`link` / `unlink` curate the dependency edges the automatic linker would otherwise
own — `<child>` depends on `<parent>`. Both are idempotent and refuse any link that
would create a cycle (exit 2); an unresolved id exits 4.

### Reconcile

```bash
prim reconcile <id>    # Mint a single-use bypass for a decision a gate flagged
```

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

### Welcome

```bash
prim welcome           # Brief orientation to the decision graph (shown after setup)
```

### Session & journal

Lower-level plumbing for the capture pipeline — org binding and the local move
journal. Capture works automatically once the session hooks are installed; these
are for inspecting and steering it (e.g. multi-org machines).

```bash
prim session start <id>   # Pin a Claude Code session to an org   (list / drop <id>)
prim moves bind           # Pin the current directory to an org via .prim/workspace.json (drop)
prim moves status         # Per-bucket pending stats for the local journal
prim moves tail           # Pretty-print recent journal entries
prim moves flush          # Drain the local journals to the server (also runs from hooks)
```

### Skill

```bash
prim skill install     # Install the decision-graph agent guide into your rules file
prim skill uninstall   # Remove the managed block
prim skill status      # Report whether the block is installed
```

Writes a managed block teaching your agent how to work with the decision graph
into the rules file it reads (CLAUDE.md, AGENTS.md, .cursor/rules, …).

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
