# @primitive.ai/prim

The official CLI for [Primitive](https://getprimitive.ai)'s **decision graph**. It
passively captures the decisions your team makes while coding and reports team
presence — from the command line and via session + git hooks.

> [!WARNING]
> This project is in **alpha**. Commands and APIs may change between releases.

> [!NOTE]
> **Conflict Gates** check each edit against the decision graph and surface any
> load-bearing decision it conflicts with. When **Enforcement** is enabled for your
> organization, gates can warn, pause, or block a conflicting edit until you resolve
> the decision and retry. Automatic decision capture in active repositories is separate.

This release restores **bounded V3 checks for Claude Code**. Each automatic check
uses one V3 request with a **12-second request timeout**, inside a **15-second supervisor budget** and **20-second Claude hook
timeout**. Completed conflicts retain block/warn mode. Failed checks allow the
tool with visible “change was not verified” feedback, including supervisor failure,
missing binding, and unresolved shell targets. Unresolved targets never trigger
an exhaustive repository-wide scan. V3 checking can omit candidates or evidence;
it does not promise exhaustive coverage, sub-two-second completion, or V4 Slack alerts.

Other agents retain automatic V4 checks that wait at most **two seconds**.
Confirmed conflicts found in that window retain the existing review/warning
behavior. Otherwise work proceeds silently, including on timeout, incomplete
coverage, authentication problems, or service failure. Admitted evaluations
continue in the backend for internal review; later results cannot stop or undo
an edit and do not send a user notification.

Explicit inspection and recovery retain their longer wait:

```bash
prim decisions preflight status <checkId>
prim decisions preflight resume <checkId>
```

Re-run `prim <agent> install` and `prim doctor` to repair
the agent's hook timeout and fail-open settings. Claude uses its default
failure behavior, Cursor uses `failClosed: false`, and Hermes uses
`fail_closed: false`. Codex also permits the action if the hook fails. Reload or
restart the host as directed by the installer. Older installations retain their
blocking behavior until upgraded and repaired.

## Installation

Requires Node.js 22.23.4+, 24.22.1+, or 26.12.1+ within those major versions.
Node.js 20 is no longer supported. After updating Node.js, restart the daemon
with `prim daemon restart` and rerun your agent's `prim <agent> install` command
and `prim hooks install` to repin their runtimes to the updated executable.

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
prim setup                 # add --agent cursor, codex, or hermes; --no-daemon explicitly opts out
```

After successful setup, the optional **author story** puts you in a new engineer's
shoes in a disposable project:

```text
Implement CSV export → Your earlier Decision blocks email → Accept or Supercede
                                                        → Real outcome email
```

Enter the feature prompt in the same agent chat. The real semantic evaluator checks
it against your private, fictional prior Decision. Choose a name-only export or
approve the displayed replacement with your own short reason. A real email explains
what your Decision protected or why it changed. Continue once that email is queued;
queued and provider-accepted do not mean delivered to your inbox.

The compact diagrams and actual file evidence live in each JSON `presentation`.
Your agent renders them once. After owned-file cleanup, participants without real
Decisions enter the existing individually approved creation flow. Existing Decisions
remain intact; unavailable history is not treated as an empty graph.

Use `prim setup --skip-demo` to remember a skip, or
`prim demo --agent <claude|codex|cursor|hermes>` to replay. Direct terminal `prim demo`
uses the same prompts. Setup defaults to compact diagnostics; `prim setup --details`
shows full child output. Default agent setup returns one JSON result with `welcome`,
`onboarding`, and its `nextAction`. In Claude Code and user-scope Codex sessions,
setup instead returns `welcomeSkill`, the path of the prim-welcome skill that runs
the welcome and demo (see below).
Existing completed tours do not replay automatically.

In the earlier tour used by other agents and project-scope Codex, agent hooks
acknowledge isolation before any sample is shown; capture resumes in a new session.
The prim-welcome tour pauses capture for the repository and resumes at the next
user prompt after the demo when its hooks are running. Synthetic records never
join the team's graph.
This exercises a real evaluator and demo-only blocking policy, not native production
Enforcement or live ingestion. Backend/email unavailability leaves the optional
story pending while successful setup remains successful.

Or run the steps individually:

```bash
# 1. Authenticate via browser (WorkOS OAuth)
prim auth login

# 2. Wire the session hooks (decision capture + presence)
prim claude install        # or: prim cursor install / prim codex install / prim hermes install

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

In Claude Code or Codex, paste this. The command is in **your** message, so the agent runs it
directly — instead of fetching a doc and executing a command from it, which an
auto-mode safety classifier blocks as untrusted-origin code:

```text
Set up Primitive for this repo: run `npx --yes @primitive.ai/prim@latest setup`, then read the file at its `welcomeSkill` path and follow it. If setup fails, show me its actual error.
```

In any other coding agent, paste this:

```text
Install the Primitive CLI and activate passive decision capture for this repository: run `npx --yes @primitive.ai/prim@latest setup` and show concise progress plus actionable warnings. Drive setup and its onboarding nextAction yourself; I'll handle browser authorization and any hook-trust review the agent requires. This request authorizes setup's built-in activation of this repository and an idempotent retry of that step, but not activation in another repository or creation of a Decision. If enable or health fails, surface the actual error; do not claim fresh activation approval is required. Then show me the welcome.
```

That single command runs the whole install and current-repository activation in one
process (auth → session hooks → daemon → skill → activate this repository and wire its git hooks → welcome). The detailed
step-by-step the agent follows — and the manual fallback — live in
[`setup.md`](./setup.md).

### Claude Code cloud environments

Prim runs in [Claude Code cloud sessions](https://code.claude.com/docs/en/claude-code-on-the-web).
Configure it once; each session then connects without manual steps. The repository must
already be connected to Primitive (`npx --yes @primitive.ai/prim@latest github connect`
in a clone of it, from your own machine).

1. **Mint credentials for the environment** on your own machine. This signs you in once,
   enrolls a separate installation in your name, and prints its credentials. Nothing is
   stored locally, and your machine's own credentials are untouched:

   ```bash
   npx --yes @primitive.ai/prim@latest auth enroll --new-installation "Claude Code cloud" --print-env
   ```

2. **Configure the [cloud environment](https://code.claude.com/docs/en/cloud-environments)**:
   - **Network access**: Limited, with `api.getprimitive.ai` and `signin.getprimitive.ai`
     under Allowed domains (both are blocked by default), and **Allow package managers**
     left on so the setup script can fetch prim. A change to Allowed domains reaches
     prim only in sessions started after it: a running session keeps the network rules
     it started with.
   - **Credentials**: give the secret to the environment's proxy, which no session can
     read back. Under **Network secrets**, add a **Username and password** secret for host
     `signin.getprimitive.ai`: the `PRIM_M2M_CLIENT_ID` value step 1 printed as the
     username, the `PRIM_M2M_CLIENT_SECRET` value as the password. Then set these
     **Environment variables**, leaving the `PRIM_M2M_CLIENT_SECRET` line out and
     keeping any other line step 1 printed, such as `PRIM_API_URL`:

     ```text
     PRIM_M2M_CLIENT_ID=client_...
     PRIM_M2M_CLIENT_AUTH=network-secret
     ```

     The simpler alternative is to paste every line step 1 printed into the variables.
     Anyone who uses the environment can read its variables, so do that only in an
     environment you keep to yourself.
   - **Setup script**:

     ```bash
     #!/bin/bash
     set -euo pipefail
     npx --yes @primitive.ai/prim@latest setup --cloud --prepare
     ```

     No global install is needed: the hooks run from a runtime `--prepare` stages in
     the image, and in a session prim's commands run as
     `npx --yes @primitive.ai/prim@latest ...`. To have `prim` on the VM's PATH as well,
     use `npm install -g @primitive.ai/prim@latest` followed by
     `prim setup --cloud --prepare` instead.

     `--prepare` needs no credentials or network to Primitive. It wires prim into the
     VM's user-scope Claude Code settings, which every session reads at startup, so
     repositories need no commit. It marks the environment so sessions activate the
     repositories they open, and turns the daemon off: the VM pauses between messages, so
     capture delivers directly instead. `prim disable` opts a repository out for the rest of
     that session only, because each session starts from a fresh clone. To keep prim out of
     a repository for good, run `prim disable --scope project` in it and commit
     `.claude/settings.json` (with `git add -f` where the repository ignores `.claude`;
     prim says so): that records `PRIM_ACTIVE=false` there, every clone carries
     it, and prim then stays off in that repository unless someone turns it on themselves
     (`prim enable` in their own clone). `prim enable --scope project` removes it again.

With the network secret, the proxy adds the secret to prim's token request as HTTP Basic
authentication, so no process in the session can read the secret or carry it out of the
VM; processes in the
session can still obtain short-lived tokens through the proxy, as prim does. Keep
`signin.getprimitive.ai` under Allowed domains. Prim's token broker, the one process
that requests tokens, sends its own requests through that proxy; nothing else in the VM
has to. An environment set up for an earlier prim may still carry `NODE_USE_ENV_PROXY=1`
(and `NODE_NO_WARNINGS=1`) in its variables: both are harmless and can be removed.

To keep the tokens out of the VM as well, let the proxy request them. In the settings
of an existing environment (the New environment dialog offers only the simpler secret
types), add a **Network secret** of type **OAuth 2.0 client credentials** in place of
the username-and-password secret:

- **Allowed websites**: `api.getprimitive.ai`
- **Token URL**: `https://signin.getprimitive.ai/oauth2/token`
- **Client ID** and **Client secret**: the `PRIM_M2M_CLIENT_ID` and
  `PRIM_M2M_CLIENT_SECRET` values step 1 printed
- **Scopes**, **Resource** and **Audience**: leave empty

and set the variables to:

```text
PRIM_M2M_CLIENT_ID=client_...
PRIM_M2M_CLIENT_AUTH=network-token
```

The proxy then obtains the tokens itself and attaches one to each request for
`api.getprimitive.ai`. Prim requests no token and sends no credential: its commands and
hooks hand their API requests to prim's broker, the one process that sends through the
proxy, and `prim auth status` verifies the identity the proxy authenticates as. No
process in the session can read the secret or a token, though any process in it can
still reach Primitive through the proxy as that installation, so keep the environment
personal. Only `api.getprimitive.ai` has to be under Allowed domains in this mode, and
`prim setup --cloud` names the network secret's fields if the proxy's token is refused.

Running plain `prim setup` inside a cloud session (for example through the agent prompt
above) detects the session and does the cloud setup; browser sign-in, the daemon, and
onboarding are skipped there, and `prim auth login` explains why it cannot run.
`--prepare` belongs in the setup script: Claude Code reads its hooks when it starts, and
new sessions start from the environment's image. Run inside a session, it wires only
that VM and says the image was not prepared by that run (a VM the image had already
prepared stays prepared).

Each session, prim's SessionStart hook activates the repository the session was started
on and connects it to Primitive. If the hook cannot connect it, it says why: missing
credentials, a blocked domain, or a checkout that does not identify its repository. The
git pre-commit check is not wired automatically; run `prim setup --cloud` in a session to
verify it step by step and install it. A second repository the agent clones during the
session is not connected or given git hooks at session start; run `prim setup --cloud`
from that clone to set it up. Decisions captured in the environment belong to you; an
organization admin can revoke the installation in Settings → Developer installations.

Prim identifies the repository from its GitHub origin. A session started with
`claude --cloud` from a checkout the Claude GitHub App cannot clone receives an upload
with no origin. For those, commit prim's project install from a clone whose origin is on
GitHub; besides the hooks, it records the repository declaration (`PRIM_REPOSITORY`) in
`.claude/settings.json`:

```bash
prim claude install --scope project
git add .claude/settings.json && git commit -m "chore: enable prim in Claude Code"
```

A repository that commits prim's project install keeps using it: the user-scope hooks
step aside there, so nothing fires twice. Committed hooks run for everyone who opens the
repository in Claude Code; where prim is not installed they do nothing. Upgrade prim
across a team before committing a new project install: older releases fail `prim doctor`
on such a file, and the reinstall they suggest restores the earlier text.

#### An environment your organization shares

The credentials above belong to one person: in an environment several people use, every
session's work would be attributed to whoever minted them. For an environment the whole
organization shares, an organization admin creates an environment credential instead.
It can do one thing: identify sessions. Each session's work is then attributed to the
member who started it.

1. **The admin creates the credential once**, on their own machine:

   ```bash
   npx --yes @primitive.ai/prim@latest auth enroll --new-environment "Team cloud" --print-env
   ```

   It prints `PRIM_M2M_CLIENT_ID`, `PRIM_M2M_CLIENT_SECRET`, and
   `PRIM_CLOUD_IDENTITY=session` (plus `PRIM_API_URL` for a non-default deployment).

2. **The admin configures the shared environment** as in the steps above, with these
   differences:
   - **Credentials**: every member can read a shared environment's variables, so hold
     the secret as a **Username and password** network secret for host
     `signin.getprimitive.ai` (username: the client ID, password: the client secret).
     Set these **Environment variables**, keeping any other line the command printed
     except `PRIM_M2M_CLIENT_SECRET`:

     ```text
     PRIM_M2M_CLIENT_ID=client_...
     PRIM_M2M_CLIENT_AUTH=network-secret
     PRIM_CLOUD_IDENTITY=session
     ```

     Put `PRIM_M2M_CLIENT_SECRET` in the variables only in an environment no one else
     uses.
   - **Network access** and the **Setup script** are the same as above:
     `api.getprimitive.ai` and `signin.getprimitive.ai` under Allowed domains, and
     `npx --yes @primitive.ai/prim@latest setup --cloud --prepare`.

3. **Each member links their GitHub account once**, in their first session. Session
   start tells them their GitHub account is not linked yet; the agent runs
   `prim auth link`, which prints a sign-in URL and a code. The member signs in to
   Primitive as themselves, and the session is attributed to them from then on. The
   sign-in is used for the link alone and is not stored.

After that, every session identifies its member with no action. At the start of each
session, prim creates the session's `claude/…` branch on GitHub at its starting commit
(Claude Code would create the same branch when it first pushes); Claude Code pushes as
the GitHub account of the person who started the session, which is how Primitive learns
whose session it is. Prim never force-pushes it, sets no upstream, and pushes nothing
else. The member's token stays in the session's VM (owner-only, in prim's config
directory) and lasts 12 hours, renewed while the session runs; a new session identifies
again. Until a session is identified, nothing it captures is sent to Primitive, and a
session that never identifies sends nothing as anyone.

`prim setup --cloud` reports this as its `identity` step, `prim auth status` names the
member the session acts as, and `prim doctor`'s `auth` line names the person the
session is attributed to. Identification fails, with the fix named, when the session's
checkout is not on its `claude/…` branch, when that branch is already on GitHub (a
resumed session whose token lapsed, or one whose branch was pushed first: start a new
session), when the push is refused, when GitHub's notice of the push does not reach
Primitive within 15 seconds (check that Primitive's GitHub App has access to the
repository), or when the repository is not connected to Primitive.

## Commands

### Setup

```bash
prim setup                   # Run the whole install in one shot
prim setup --agent cursor    # Same, for Cursor IDE and Cursor CLI
prim setup --agent codex     # Same, for OpenAI Codex
prim setup --agent hermes    # Same, for Hermes Agent (global-only config)
prim setup --no-daemon       # Stop it and persistently opt out of supervised delivery
prim setup --global-hooks-path  # Also route every repository's git hooks through prim
prim setup --cloud --prepare # Claude Code cloud setup script: stage the hook runtime
prim setup --cloud           # Claude Code cloud session: verify credentials, wire git hooks, activate
```

Orchestrates auth → session hooks → supervised daemon → git hooks (`--scope project`, or `--global-hooks-path`) → skill → activate this repo (which wires its git hooks) → capture-health gate → welcome,
re-running each underlying command so every step behaves exactly as if run by
hand (including the browser login). Idempotent — safe to re-run.

Setup wires the current repository's git hooks and never changes git's global
config on its own: a global `core.hooksPath` reroutes every repository on the
machine. Pass `--global-hooks-path` to opt in; `prim --yes setup` does not.

### Uninstall

```bash
prim uninstall
```

Stops the companion daemon, removes the current repository's Prim-owned agent
and Git-hook surfaces when run inside a Git repository, removes the user-scoped
Claude, Cursor, Codex, Hermes, and Git-hook surfaces, then deletes only schema-valid
Prim runtime bytes. Foreign configuration is retained; ambiguous ownership
makes the command fail closed and retain the runtimes. If a removal races or
fails after one runtime changes, its JSON result reports each runtime's exact
state so rerunning can safely finish cleanup. Authentication,
undelivered journals, repository bindings, and agent skill guidance are kept.
Use `prim skill uninstall --agent <claude|cursor|codex|hermes> --scope <project|user>`
when you also want to remove a known skill target.

### Auth

```bash
prim auth login              # Authenticate via browser
prim auth set-token <token>  # Save a bearer token (e.g. for CI)
prim auth clear              # Remove saved tokens
prim auth status             # Check authentication status
prim auth enroll --new-installation <name> --print-env # Credentials for a cloud environment
prim auth enroll --new-environment <name> --print-env # Organization credential for a shared cloud environment
prim auth identify           # Identify who started this cloud session (shared environments)
prim auth link               # Link your GitHub account to Primitive, once, from a cloud session
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
or `.cursor/hooks.json`, resolved from the git root (so any subdirectory works);
pass `--scope user` to install machine-wide. Codex defaults to user scope
(`~/.codex/hooks.json`): Codex reads a project `.codex/hooks.json` only from the
checkout it lives in and trusts it by absolute path, so a project install covers
that checkout only, not the repo's other worktrees. Hermes is the exception: it reads
shell hooks only from the global `~/.hermes/config.yaml`, so `prim hermes install`
is always user-scoped — and prim merges in place, leaving the rest of that file
(providers, models, your own hooks) untouched.

```bash
prim claude install                # Install Claude Code hooks (project scope; uninstall / status)
prim claude install --scope user   # Install machine-wide instead
prim cursor install                # Install native Cursor hooks (project scope)
prim cursor install --scope user   # Install hooks, skill, and CLI footer machine-wide
prim codex install                 # Install OpenAI Codex hooks (user scope; --scope project for this checkout only)
prim hermes install                # Install Hermes Agent hooks (global ~/.hermes/config.yaml)
```

For `$write-gameplan` or `$write-workstream` authoring in Codex, install the
separate Primitive planning companion from the target repository after the
public `$write-gameplan` skill is available:

```bash
prim setup --agent codex
prim gameplan install --agent codex
prim gameplan status
```

`gameplan install` adds the companion to this repository and a prompt dispatcher
to the user's Codex hooks, including linked worktrees. It does not replace the
public planning skill or install Conflict Gates; `setup` handles the latter.
Review `/hooks` in Codex and start a fresh session. `prim gameplan uninstall`
removes this repository's companion and leaves the shared user hook in place;
pass `--remove-user-hook` only when no other repository needs it. A Decision
scoped only to a code path named inside a gameplan is surfaced during planning,
but the edit gate sees the changed gameplan path.

Passive capture is repo-scoped even when these integrations are installed at user
scope. `prim enable` marks the current Git repo active; `prim disable` makes it
inactive. A project-scoped install activates its repo automatically. Both commands
act on your clone alone. `prim disable --scope project` also records the repository's
own opt-out, `PRIM_ACTIVE=false` under `env` in `.claude/settings.json`, for you to
commit: prim reads it from that file (never from the environment), and it turns off
automatic activation in every clone, including a project-scoped install's and a
prepared Claude Code cloud environment's. A `prim.active=true` you set yourself still
wins: `prim enable` in a clone, or the global flag for every repository. A clone that
prim had already activated automatically is turned off at its next agent session
after it receives the opt-out; one activated that way by an earlier prim version
cannot be told apart from `prim enable` and stays on until `prim disable`.
`prim enable --scope project` removes the opt-out. In an inactive
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
presence count. `prim setup` requires it to be live on the current version with
an authenticated, healthy heartbeat unless the explicit `--no-daemon` opt-out is
supplied. Hooks still fail soft if it later degrades.

`prim daemon start` (and `restart`/`ensure`) does not gate on delivery. While
Moves are past the 30s delivery SLA it reports them as draining in the
background when the daemon's last sweep recorded no failure, or when the drains
that failed acknowledged Moves before failing; another bucket delivering in the
same sweep does not count. Journal buckets the daemon holds back (unbound,
another organization, identity unavailable) read as delivery held back, and a
failure with no progress reads as delivery failing; both are a ⚠ warning,
still exit 0. Its JSON adds `draining`, `deliveryRetained`, `deliveryFailing`,
and `ingestion` in those states. Start's JSON `healthy` means the start
succeeded, so it can differ from `daemon status --json`, which stays degraded
until the backlog drains. Setup's own health check reports a backlog the
daemon is draining as a warning and fails on held-back buckets and on failures
recorded without progress; standalone `prim doctor` still fails a missed SLA.

```bash
prim daemon start      # start (stop / restart / status)
```

Ordinary commands may upgrade an older daemon in the background. When an
installed CLI runs an attended, allowlisted command (for example `auth`,
`decisions`, `moves`, `skill`, or an agent's `install`/`status`) on macOS and
finds the launchd daemon on an older version, or on its own version but unable
to run (say, after a Node upgrade deleted the binary it pinned), it starts a
detached `prim daemon ensure`, at most once an hour whatever version it
targets. It never downgrades, never repoints the daemon at another deployment
or config root, and never runs from hooks or their background drains, `daemon`,
`doctor`, `setup` or its steps, `auth clear`, removal commands, a development
checkout, or as root. Set `PRIM_DAEMON_DRIFT_HEAL=0` to turn it off.

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

`<id>` uses the canonical `dec_<8 hex>` Decision ID; bare short IDs and legacy full IDs remain accepted as inputs. STDOUT is machine-readable
JSON; human-readable status goes to STDERR.

`decisions show` prints the maker and decided date. Imported seeds retain the
historical date's qualification (`on or about` or `no later than`) and precision;
day-only evidence stays on its original calendar day in every timezone. Missing
metadata, including seeds from older servers, reads `Decision maker unknown` or
`date unknown`. When available, the import timestamp and operational importer
appear separately. `decisions recent` uses calendar dates for older rows and
keeps the server's existing ordering and recency-window behavior.

`decisions check` uses the checkout's current Primitive repository binding and
Git branch. Paths are relative to the repository root, including from a
subdirectory; paths for files that do not exist yet are supported. Discovery
includes exact file, directory, glob, and repository scopes and applies each
Decision's effective window and audience. It does not run the Conflict Gate.
Missing bindings, older servers that cannot confirm repository-scoped discovery,
and bounded partial results report `unavailable` or `truncated`; they are not a
verified empty result. Reconnect a missing or stale binding with `prim enable`.

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

### Bash script coverage

Conflict Gates also inspect Bash writes expressed as Python `-c`, Node.js
`-e`/`--eval`, or quoted stdin heredocs. Static paths passed to Python `Path`
writes or writable `open`, and Node.js `fs`/`fs.promises` writeFile/appendFile
calls, participate in the existing preflight check. Simple path variables and
direct import aliases are supported. Analysis never executes the script.

Script coverage remains unverified: dynamic paths, reassignment, nested scopes,
directory changes, wrappers, external scripts, and unsupported syntax can hide
other writes. Unknown commands display a “not verified” warning in active repos;
recognized read-only commands stay quiet. Known conflicts still prompt or block
according to the existing policy. Embedded parsing stops at 64 KiB, targets are
bounded to 32, and shell proposal truncation at 6,144 bytes is disclosed.

### Reconcile

```bash
prim reconcile <id>    # Rejected: human_approval_required (exit 2)
```

Record what happened after resolving a specific conflict:

```bash
prim reconcile <id> --check <checkId> --outcome followed
prim reconcile <id> --check <checkId> --outcome superseded
```

Use `followed` when you retained the Decision. Use `superseded` only after a
replacement Decision has been persisted with `prim decisions supersede`.
The conflict output supplies the check ID. Only the person whose edit was
checked can resolve that check. Repeating the same outcome is safe; changing an
already recorded outcome is rejected. These declarations do not issue a bypass.

Bypasses are disabled until an agent host can supply verifiable human approval.
Bare `prim reconcile <id>` rejects locally, including with `--yes`,
`--non-interactive`, or `--flag`. Sandbox escalation and automatic approval
review do not authorize an override. A blocked edit must remain blocked or be
changed to respect the governing Decisions.

### Hooks

```bash
prim hooks install                # Wire the pre-commit, post-commit, and post-rewrite hooks
prim hooks install --scope user --global-hooks-path  # Route every repository through prim (exits 3, with the reason on STDERR, if it installs nothing; 1 if prim's hook runtime is not staged)
prim hooks snippet post-commit    # Print the block that wires one hook, to place by hand
prim hooks uninstall              # Remove prim's blocks (and any hook file prim created)
```

The pre-commit hook checks staged files against the live decision graph
(warn-only — it never blocks the commit). The post-commit and post-rewrite hooks
record each commit and each amend/rebase as capture boundaries for
classification. All three act only in repos where prim is active (`prim enable`).
Supports [Husky](https://typicode.github.io/husky/) — `prim hooks install`
detects Husky and offers to install into `.husky/`.

Each hook file gets one short block, inserted right after the shebang so it runs
before any `exit` or `exec`. The block names no version and no machine path: it
runs prim's staged entrypoint (`~/.config/prim/prim-git-hook-v1`) and does
nothing on a machine without prim, so a tracked `.husky/*` file never changes
across prim releases. `prim enable` and `prim hooks install` write it once and
never move or rewrite a current block, reformatted or not. Agent session hooks
only repair Git-private hook files under `.git` and prim's own hooks dir, and
never add the pre-commit check. prim never edits a hooks dir outside the
repository, such as a global `core.hooksPath` every repository shares, unless
you run `prim hooks install --scope user --global-hooks-path` or answer yes at
its terminal prompt. In a Husky v8 hook the block goes
after the `husky.sh` line, so it runs once and honors `HUSKY=0`. `prim doctor`
only reports; it never rewrites a hook.

`prim doctor` also checks evidence rather than file contents: each post-commit
run that reaches prim leaves a stamp in the checkout's git dir, and doctor's
`hook-fired` check fails when a local commit made since the hooks were wired
never reached prim. That catches an `exit` before prim's block, hand wiring
that broke, or a git client whose environment cannot find prim. The check
applies in manual mode too: once a repository is enabled, doctor expects your
own wiring to reach prim. `prim disable` ends the expectation, so commits made
while disabled are never judged. Turning prim off with `git config prim.active
false` directly ends it too, once an agent session starts while it is off; if
doctor still flags a commit made while it was off, run `prim disable` then
`prim enable`.

To wire the hooks yourself (lefthook, a custom Husky layout, …), run
`git config prim.gitHooks manual` (or `--global`) first: prim then never writes
a hook file. That setting is the only signal prim honors. It does not guess
from a hook that already mentions prim, so without it, `prim enable` adds its
block. Paste the block from `prim hooks snippet <hook>`, or have your hook
manager run `~/.config/prim/prim-git-hook-v1 <hook> "$@"` (post-rewrite also
needs Git's stdin).

### Presence statusline

```bash
prim statusline        # Render the team-presence statusline (reads the daemon)
```

Claude Code and Cursor CLI each have one custom status-line slot. Their user-scope
installations use a staged, lightweight Primitive renderer when that slot is empty
or already Primitive's; an existing custom status line is preserved even with
`--force` and reported explicitly. Cursor's Primitive footer replaces Cursor's
default footer and requires a Cursor CLI restart after installation or removal. Use
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

Any other command except `uninstall`, `demo`, `migration`, and a `setup` that starts the daemon (or
one of its steps) that finds Moves waiting over a minute (or cannot tell how
long) hands them to a detached background `prim moves flush` and never waits for
it. It starts none while a live daemon on the same version and deployment, with
a healthy heartbeat and no recorded ingestion failure, already owns the drain.

Move uploads include `X-Prim-Uploader-Version` (the uploader process's version)
and `X-Prim-Client-Instance-Id` (the opaque installation ID also used by presence
heartbeats). These let server traces distinguish the uploader from the version
that originally captured a replayed move. The ID is stored in
`client_instance_id` under the Prim config directory (`~/.config/prim` by default,
or `PRIM_CONFIG_DIR` / `XDG_CONFIG_HOME/prim`). Compare that file with the trace's
`uploaderClientInstanceId` to correlate an installation; it contains no hostname.
If the identity cannot be read or created immediately, uploads omit that header
and continue. Invalid stored identities are never silently replaced. Older
clients remain unattributed until updated and their uploader process restarted.

### Drain-first migration preparation

End all coding-agent sessions and legacy hook invocations before starting. Deploy
and verify a release containing the maintenance commands in every legacy runtime
that can write this profile, including the daemon and staged hook runtimes. Stop
older daemons. A stopped daemon alone does not stop hooks from appending journals.
Older cached sessions and direct invocations of older `npx` releases do not honor
the pause; they must stay closed throughout handoff and rollback. The immutable
runtime selector does not replace a staged runtime merely because source bytes
changed at the same package version and Node path. This source change does not
publish a new CLI version or repair installed runtimes automatically.

With the original API configuration and authority still available:

```bash
prim migration pause                      # Retain maintenanceId from JSON
prim migration status --id <maintenanceId>
prim migration drain --id <maintenanceId>
prim migration ready --id <maintenanceId>
```

These commands print one JSON object to stdout and narration to stderr. The
version-1 status includes the canonical `configRoot`, `maintenanceId`, `paused`,
`quiescent`, `inventoryComplete`, `drained`, `ready`, `activeLeases`,
`handoffReserved`, and bounded `blockers` containing relative paths, reasons, and byte counts, never journal
bodies or credential values. `scope` is `cooperative-runtime-only` and
`legacySessionsMustBeClosed` is always true. `ready` exits nonzero unless the
matching pause holds, every admitted operation has finished, and the complete
journal tree is clear. A status snapshot is advisory; the handoff coordinator must
recheck under the shared maintenance lock before its local configuration changes.

Pause persists across process exit. `pause --timeout-ms 0..30000` bounds its wait
for earlier admitted operations (default 5000 ms); a nonzero exit leaves the pause
in place. New appends, direct uploads, and ordinary drains refuse admission.
Already admitted HTTP deliveries remain tracked through response or timeout;
pausing does not cancel them or acknowledge uncaptured work. Hook failures retain
the host's existing fail-soft behavior and print a maintenance warning to stderr.
This fence does not suspend other Decision checks or presence traffic.

Drain uses the existing uploader and original authority for the current API only.
Repeat it under each original API/authority as necessary without editing journal
identities. The readiness inventory walks every API and organization partition,
including `_unbound` and older unpartitioned layouts. Pending data, retained
rotations, quarantine, checkpoints, unknown files, symlinks, unsafe permissions,
and incomplete or over-bound inventories block handoff. A zero flush count or a
contended drain lock is never a certificate that queues are empty. Do not delete,
move, or discard retained data to force readiness; resolve delivery under its
original authority or keep migration blocked.

Control records are private and bounded (4096 bytes each, at most 512 activity
leases); journal inventory is bounded to 4096 entries and five levels beneath
`moves`. Status performs dead-process lease housekeeping under the admission lock
but does not modify journal data. A live PID, including PID reuse, is never
expired by age. Malformed control records fail closed. Existing directories must
be owned by the current user and not writable by group/other; permissions are
never silently changed. The durable marker is `migration-maintenance.json`, with
short-lived leases in `migration-activity` and the existing file-lock protocol at
`.migration-maintenance.lock`.

Keep the pause while authenticating the native app afresh and switching hooks
through the handoff coordinator. No credential import is part of this sequence.
Retain legacy journals, credentials, and installation for rollback. If abandoning
preparation, explicitly resume only after confirming hooks still target legacy:

```bash
prim migration resume --id <maintenanceId>
```

The coordinator durably reserves the pause before switching configuration, using
`migration-handoff-reservation.json` with a transaction ID and canonical directory
reference. This reservation survives a coordinator crash and remains after native
commit. Only the guarded coordinator can release it after verified safe rollback
or abort. Plain `resume` has no reservation bypass.

Resume refuses while admitted activity or a handoff reservation remains and
removes only its matching pause. Neither preparation nor resume switches hooks,
clears credentials, or removes retained data. Run `pnpm build && pnpm test:migration-maintenance` for the
isolated process E2E, using private temporary profiles and a loopback HTTP server.
Add `node scripts/check-migration-maintenance.mjs --staged` to exercise the CLI
copied by the production immutable-runtime stager into that temporary profile.
It covers protocol behavior and concurrency; it does not qualify legacy capture
latency, power-loss recovery, older binaries, or a real installed cutover.

### Skill

```bash
prim skill install --agent claude   # Install the decision-graph guide for Claude Code
prim skill install --agent cursor   # Install the native Cursor skill
prim skill install --agent codex    # …or write the guide into another agent's rules file
prim skill uninstall --agent claude # Remove it
prim skill status --agent claude    # Report whether it's installed
```

Teaches your agent how to work with the decision graph. For **Claude Code**
(`--agent claude`) this installs a skills-directory plugin at
`<repo>/.claude/skills/prim/` (or `~/.claude/skills/prim/` with `--scope user`)
— a `.claude-plugin/plugin.json` + `SKILL.md` that auto-loads as the model-invoked
`prim@skills-dir` skill, no marketplace step; restart Claude Code or run
`/reload-plugins` after installing. For **Cursor**, it installs an owned `SKILL.md`
at `<repo>/.cursor/skills/prim/` (or `~/.cursor/skills/prim/` with `--scope user`)
without overwriting foreign or locally edited files. For the remaining agents it
writes a managed block into the rules file that agent reads (`--agent codex` →
AGENTS.md or `--agent hermes` → .hermes.md). A bare
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

Validate seed metadata presentation and real CLI output against a local fixture
server after building:

```bash
pnpm check:seed-metadata-golden --cli dist/index.js
pnpm check:seed-metadata-golden --cli dist/index.js --server-dir /path/to/client
```

The second form also checks the candidate server's response fixtures against
the currently locked CLI validators, and old response fixtures against the
candidate server schema. It does not change contract provenance. The lock pins
the published backend commit containing the additive seed metadata contract.
For future contract changes, refresh the locked artifacts with
`pnpm contracts:update --revision <full-client-commit>`, then run
`pnpm contracts:generate`, `pnpm contracts:check`, and
`pnpm contracts:provenance`. Do not point the lock at a revision that lacks the
vendored bytes.

### Actual host validation

After `pnpm build`, optional E2E checks drive a real host's tool loop against a
local deterministic model provider. They use temporary HOME/configuration and a
sentinel file, synthetic credentials, and no real model requests or user account.
They never install or upgrade the host or change your host settings.

```bash
pnpm test:preflight-host          # Installed Codex
pnpm test:preflight-host:claude   # Claude 2.1.284+ on PATH
pnpm test:preflight-host:claude --binary /path/to/compatible/claude
# CLI_CLAUDE_BIN also selects the Claude binary.
```

Each check covers completed allow, confirmed conflict, paused evaluation, malformed
backend JSON, CLI deadline expiry, hook crash, and host watchdog expiry. Only the
confirmed conflict in block mode prevents the sentinel write. Claude checks also
cover conflicts arriving after two seconds and warn-mode demotion, using the real
12-second request, 15-second supervisor, and 20-second host budgets. Other agents
retain their two-second budget. Unsupported Claude versions fail before
the fixture runs.
The separate `pnpm test:preflight-v4 --schema /path/to/cli-http-v1.schema.json`
check validates the built CLI against a supplied authoritative backend contract.
Use `pnpm test:preflight-v3 --schema /path/to/cli-http-v1.schema.json` for Claude's
V3 path. Pass `--package-root /path/to/installed/package` to test an installed
tarball, including its managed launcher, against that same contract.

## License

[MIT](LICENSE)

### Decision identifiers

Decision IDs printed by prim are `dec_` followed by eight lowercase hexadecimal
characters. Use the same ID in commands and at
`https://app.getprimitive.ai/decisions/dec_<short>`. Public JSON fields such as
`id`, `decisionId`, and relationship references use this prefixed ID; the
`shortId` compatibility field contains the eight characters without the prefix.
Existing full record IDs remain accepted as inputs. Upgrade the backend before
this CLI; an unavailable identity produces an error rather than a storage ID.

### Machine credentials

An administrator issues a separate WorkOS M2M application for each installation
or workload. Configure its application client ID and enter the secret at the
hidden prompt:

```sh
prim auth configure-machine --client-id client_APPLICATION
prim auth status --json
prim setup
```

For automated secret delivery, pipe the secret to
`prim auth configure-machine --client-id client_APPLICATION --client-secret-stdin`.
Never pass a secret as a command-line argument. CI can instead inject both
`PRIM_M2M_CLIENT_ID` and `PRIM_M2M_CLIENT_SECRET`, along with the selected
`PRIM_API_URL`. A complete environment pair overrides saved credentials;
partial pairs and a conflicting `PRIM_TOKEN` fail explicitly. Injected
credentials and tokens are never saved. Prim shares only verified identity
metadata with local hooks, tied to that credential generation and token expiry.

Injected credentials share access tokens through an authenticated, memory-only
local broker. Provider retry delays are shared across processes and survive
restarts without saving secrets or tokens. The broker runs from the copied
runtime and exits after five minutes without authenticated requests.

On macOS, launchd cannot inherit credentials from your terminal. Stop any
existing daemon and run `prim daemon start --foreground` in the environment
that supplies the machine credentials. Restart it with the new environment when
rotating credentials. Prim rejects launchd configuration in environment mode;
use saved machine credentials for a daemon that starts across logins.

Prim verifies the exchange and the API's protected machine identity before
activating credentials. It uses the OS credential store by default (persistent
Secret Service on Linux). If that store is unavailable on initial configuration,
Prim uses owner-only files in its private configuration directory. Once a store
is selected, a locked or failing keychain produces a recovery error rather than
falling back to an old credential. `prim auth clear` removes saved credentials;
unset injected environment variables separately.

Tokens renew with another client-credentials exchange, without refresh tokens.
Auth status reports identity, organization, effective scopes, storage, and expiry.
Use `prim doctor` for journal and daemon recovery details (JSON on stdout). Machine access
covers capture, checks, presence, organization-visible Decision reads, and the
machine's own Decision lifecycle. Manage GitHub App installation and human API
keys in the web application; the personal onboarding demo is not a machine task.

Flush pending activity under its original credentials before migration where
possible (`prim moves flush`). Machine capture uses separate, identity-bound
journals. Legacy activity and activity from another machine are retained rather
than reassigned. Terminal credential failures pause delivery while local capture
continues. Ask the administrator to enable or rotate the same machine, then run
`configure-machine` again. Do not edit or move journal records between identities.
For injected credentials, restart with the replacement environment. After
verifying the replacement, the administrator must revoke the old WorkOS client
secret; clearing local storage does not revoke it.

For concurrent backend/CLI development, `pnpm contracts:update --worktree <path>`
imports an explicitly unpublished backend contract. Canonical provenance remains
blocked until the backend is published and imported with
`pnpm contracts:update --revision <full-commit>`. Production releases must pass
`pnpm contracts:provenance`.

### Developer installation enrollment

When automatic enrollment is enabled by your organization, run `prim setup`.
Sign in once and select your organization; Prim registers this installation and
stores its machine credentials in the OS credential store (or the existing private
file fallback). Repeated setup reuses the installation. No WorkOS dashboard access
or copying of client secrets is required. `prim auth enroll` also enrolls an already
signed-in installation.

The installation authenticates the request while your account owns the Decisions.
Your private drafts, existing Decisions, and normal lifecycle permissions remain
available. Human/agent attribution and adoption rules stay the same. The installation
is recorded as provenance. Administrators can manage enrollment policy and revoke
installations in the web application's Settings → Developer installations.

Setup attempts to deliver pending legacy captures before changing credentials.
Any remaining activity stays under its original authorization; inspect it with
`prim moves status`. It is never uploaded under newly assigned authorship.
`prim auth status` reports the installation, authorized user, storage backend, and
expiry without revealing credentials. If older-secret retirement is pending, rerun
`prim auth enroll` to retry it.

On a server without enrollment, setup retains legacy authentication. Existing
manually configured machines and CI credentials remain service identities; routine
setup does not convert them into developer installations. GitHub installation and
API-key administration remain available in the web application.
