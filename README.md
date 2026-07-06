# @primitive.ai/prim

The official CLI for [Primitive](https://getprimitive.ai)'s **decision graph**. It
passively captures the decisions your team makes while coding and reports team
presence — from the command line and via session + git hooks.

> [!WARNING]
> This project is in **alpha**. Commands and APIs may change between releases.

> [!NOTE]
> **Conflict Gates** check each edit against the decision graph and surface any
> load-bearing decision it conflicts with; their **Enforcement** tier blocks or pauses
> a conflicting edit until you reconcile and retry. Conflict Gates are **not currently
> enabled** — automatic decision capture runs regardless. To enable them for your team,
> contact **support@getprimitive.ai**.

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
prim setup                 # add --agent codex or --agent hermes, --no-daemon to skip the daemon
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
Install the Primitive CLI: run `npx --yes @primitive.ai/prim@latest setup` and surface its output. It's an agent-first CLI — drive it yourself, don't hand the command back to me. The only thing I'll do is click "Authorize" in the browser if it asks. When it finishes, show me the welcome.
```

That single command runs the whole install in one process (auth → session hooks →
daemon → git hooks → skill → welcome). The detailed step-by-step the agent follows —
and the manual fallback — live in [`setup.md`](./setup.md).

## Commands

### Setup

```bash
prim setup                   # Run the whole install in one shot
prim setup --agent codex     # Same, for OpenAI Codex
prim setup --agent hermes    # Same, for Hermes Agent (global-only config)
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
prim decisions recent                    # Recent decisions feed (--author <name> for one teammate's)
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
prim reconcile <id>    # Mint a single-use bypass for a decision Conflict Gates flagged
```

Part of Conflict Gates **Enforcement**, which is not currently enabled (see the note
at the top). Contact support@getprimitive.ai to enable it.

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
