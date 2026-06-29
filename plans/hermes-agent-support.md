# Spec — Hermes Agent support for prim

**Status:** Draft for review · **Owner:** @jthodge · **Repos:** `campus-ai/prim` (CLI) + `campus-ai/primitive` (Convex backend)

This spec is a contract. It enumerates every file touched, the exact wire shapes, and checkable acceptance criteria. It gates the implementation PRs.

---

## 0 · Verdict

prim today captures team decisions by registering lifecycle-hook shims into a coding agent's config, behind a one-axis abstraction: `type Agent = "claude_code" | "codex"`, selected by an `--agent` flag stamped at install. Codex was nearly free because it adopted **Claude Code's exact config shape, event names, stdin envelope, and stdout contract** — so it *retargeted* shared code.

**Hermes diverges on all four axes.** It is a Python agent whose shell hooks live in YAML at the global `~/.hermes/config.yaml`, under different event names (`pre_tool_call`, `on_session_start`, …), with a different stdin schema and a different block-response contract, and different edit tools (`write_file`, `patch`). So ~60% of the work follows the Codex template mechanically, and ~40% is genuinely new: a **YAML config writer**, a **stdin normalizer**, a **block-response serializer**, and an **event-name map**.

The integration still reuses prim's existing hook **binaries** (no new bins, no new tsup entrypoints). It plugs in via **one new flag value** (`--agent hermes`), **two adapter seams**, **one new install command**, and **one new dependency** (`yaml`). It ships **lockstep CLI + Convex** because the backend validates `producer` as a closed, fail-closed union.

**Scope (locked):** first-class `producer: "hermes"` · full parity (capture + gate + ingest + session presence) · add the `yaml` dependency · dedicated `.hermes.md` contract file.

---

## 1 · Goals & non-goals

**Goals**
- A `prim hermes install|uninstall|status` command that wires prim's shims into `~/.hermes/config.yaml` without clobbering the user's existing config.
- Full capture parity: every Hermes lifecycle event prim cares about lands in the decision journal, attributed to `producer: "hermes"`.
- The conflict **gate** blocks Hermes `write_file`/`patch` edits that conflict with prior team decisions.
- Synchronous **ingest** + verdict footer on edit completion.
- **Session presence** (daemon-tracked) and a best-effort visible team-count.
- First-class server provenance: `hermes` is a recognized producer with native `write_file`/`patch` tool awareness across the classify/link/cascade/footer pipeline.

**Non-goals**
- Supporting Hermes's gateway/messaging platforms (Telegram/Discord/…) as decision sources. Target is `hermes chat` (the `cli` platform) in a git repo — the Claude Code / Codex analog.
- A project-scoped Hermes config. Hermes reads config only from `$HERMES_HOME/config.yaml` (+ an admin `/etc/hermes` overlay); there is no repo-local config to write.
- Python plugin or gateway (`HOOK.yaml`) hooks. Shell hooks reach every event we need; a Python plugin would drag a second language into a Node CLI for zero parity gain.
- Comment-perfect YAML round-tripping (key-order preservation is required; comment preservation is best-effort).

---

## 2 · How prim integrates an agent today (the spine)

- **`src/hooks/agent.ts`** — the entire abstraction. `type Agent = "claude_code" | "codex"`; `parseAgent(argv)` returns `"codex"` iff `--agent codex` is present, else `"claude_code"`. The installer stamps the flag into each shim command string.
- **Capture** (`src/hooks/prim-hook.ts` + `prim-hook-core.ts`) — reads one hook event off stdin, `toMove()` maps it onto the `Move` envelope (`src/protocol/move.ts`), scrubs the payload (`redact.ts`), resolves org (`binding.ts`), appends NDJSON to the journal (`journal.ts`); on a terminal event `shouldFlushAfter()` spawns a detached drain (`flusher.ts` → `client.ts` → `/api/cli/moves/ingest`). Always exits 0.
- **Gate** (`src/hooks/pre-tool-use.ts` + `pre-tool-use-scoring.ts`) — extracts edited file paths, calls the server conflict-check, emits Claude's `hookSpecificOutput` allow/ask/deny shape. Fails open on its own infra errors.
- **Ingest** (`src/hooks/post-tool-use.ts`) — on edit-tool completion, POSTs the move synchronously to get a verdict footer (STDERR).
- **Presence** (`session-start.ts`, `session-end.ts` → daemon over a Unix socket).
- **Install** — `claude-install.ts` writes `.claude/settings.json`; `codex-install.ts` reuses its JSON merge engine, retargeted to `.codex/hooks.json`, `apply_patch`, `--agent codex`.
- **Producer** — the only agent identity on the wire: `Move.producer?: "claude_code" | "codex"` (`move.ts:34`). Stamped for non-Claude; omitted for Claude (backend defaults absent → `claude_code`). The transport (`journal`/`flusher`/`client`) is producer-agnostic.

**Server (fail-closed):** `convex/moves/ingest.ts:34` validates `producer` as `v.optional(v.union(v.literal("claude_code"), v.literal("codex")))`. A move stamped `"hermes"` fails arg-validation → the whole batch is rejected. Hence the lockstep requirement.

---

## 3 · Hermes facts (source-verified)

Verified against raw bytes of `NousResearch/hermes-agent@main` (the docs-site summarizers were unreliable — confabulated stars/issues — so these come from source).

### 3.1 Shell-hook events (`VALID_HOOKS`, shell-hookable subset)
`pre_tool_call`, `post_tool_call`, `pre_llm_call`, `post_llm_call`, `pre_api_request`, `post_api_request`, `on_session_start`, `on_session_end`, `on_session_finalize`, `on_session_reset`, `subagent_stop`.

### 3.2 Stdin schema (every shell hook)
```json
{ "hook_event_name": "pre_tool_call", "tool_name": "patch",
  "tool_input": { … }, "session_id": "20260629_…", "cwd": "/repo", "extra": { … } }
```
Field names `session_id` / `hook_event_name` / `cwd` / `tool_name` / `tool_input` **coincide with Claude's**, so `toMove()`'s positional reads already work; only the `hook_event_name` **values** differ.

### 3.3 Stdout / block contract — `agent/shell_hooks.py:_parse_response` (552-595)
- **`pre_tool_call`:** block via `{"action":"block","message":…}` (**canonical**) or `{"decision":"block","reason":…}` (translated into canonical). Anything else → `None` → allow.
- **No `ask`/`warn`/soft-confirm tier exists.** Tool gating is **block-or-allow**. (`hooks.md:424`: "Any other return value is ignored.")
- **`pre_llm_call`:** inject context via `{"context":"…"}` (exact key). **Shell hooks must emit a JSON object** — the bare-string affordance is Python-plugin-only.
- Session/subagent/`post_*` hooks are **observer-only** (stdout ignored).

### 3.4 Edit tools — `tools/file_tools.py`
- **`write_file`** (1769): `path` (req), `content` (req), `cross_profile` (opt, ignore). → edited path = `tool_input.path`.
- **`patch`** (1787): **dual-mode**, `mode ∈ {"replace","patch"}` (default `"replace"`, the only required key).
  - `mode:"replace"` → `path`, `old_string`, `new_string`, opt `replace_all`. → edited path = `tool_input.path`.
  - `mode:"patch"` → `tool_input.patch` is a **V4A** blob (`*** Begin Patch` / `*** Update File:` / `*** Add File:` / `*** Delete File:` / `*** Move File: a -> b`). → paths parsed from the body (`tools/patch_parser.py`).
- **`terminal`** — shell; **excluded** from the gate (no checkable file surface, like Codex Bash).

### 3.5 Config — `hermes_cli/config.py`
- Global only: `$HERMES_HOME/config.yaml` (default `~/.hermes/config.yaml`), plus an optional admin overlay at `/etc/hermes/config.yaml`. **No `os.getcwd()` lookup** — no repo-local config.
- `hooks:` shape (`cli-config.yaml.example:1201-1214`, ships commented-out):
  ```yaml
  hooks:
    <event_name>:
      - matcher: "<regex>"      # optional; pre/post_tool_call only
        command: "<shell cmd>"  # required
        timeout: <seconds>      # optional; >300 clamped
  hooks_auto_accept: false       # SIBLING top-level key, not nested
  ```

### 3.6 Hook trust — `agent/shell_hooks.py`
First-use consent per `(event, command)` pair, persisted to `~/.hermes/shell-hooks-allowlist.json`. Non-interactive bypass (precedence): `--accept-hooks` flag → `HERMES_ACCEPT_HOOKS ∈ {1,true,yes,on}` → `hooks_auto_accept: true`. All three confirmed real (`_resolve_effective_accept`, 809-829; `hermes_cli/_parser.py:168,326`).

### 3.7 Run surface & rules file
`hermes chat` is the interactive-coding analog of `claude`/`codex`. Rules-file precedence (first match wins): `.hermes.md → AGENTS.md → CLAUDE.md → .cursorrules` (+ global `SOUL.md`). `--ignore-rules` confirms `AGENTS.md` is auto-injected.

---

## 4 · Design — two adapter seams

Hermes's divergences collapse into exactly two translation points, leaving every existing event-name guard and the whole capture pipeline untouched:

```
Hermes shell hook ── stdin {hook_event_name:"pre_tool_call", tool_name:"patch", …}
   │
   ▼  ❶ normalizeEnvelope(parsed, agent)      ← NEW src/hooks/normalize.ts
   │     rewrites parsed.hook_event_name: Hermes name → internal Claude name (in place)
   ▼
  existing hook body (guards, toMove, extractFilePaths, daemon, journal …)
   │  ❷ producer:"hermes" stamped in toMove (generalized conditional spread)
   ▼  ❸ serialize output BY AGENT  ← buildHermesOutput / failOpenHermes
  stdout  {"action":"block","message":…}  (gate)  |  {"context":…}  (pre_llm_call)  |  {} (rest)
```

❶ is called immediately after `JSON.parse`, before the event-name guard, in all five entry bins. It also fixes `shouldFlushAfter` for free (`on_session_end`→`SessionEnd`).
❸ is the only place the Claude output shape can't be reused.

### 4.1 Event map (`normalize.ts`)

| Internal (Claude) name | Hermes event | Role |
|---|---|---|
| `SessionStart` | `on_session_start` | daemon presence + capture |
| `SessionEnd` | `on_session_end` | daemon presence + capture + **drain trigger** |
| `UserPromptSubmit` | `pre_llm_call` | capture + statusline-analog context |
| `Stop` | `post_llm_call` | capture |
| `PreToolUse` | `pre_tool_call` | **gate** + capture |
| `PostToolUse` | `post_tool_call` | ingest/verdict + capture |
| `SubagentStop` | `subagent_stop` | capture |

`on_session_finalize`, `on_session_reset`, `pre/post_api_request` are **not** registered (no decision-graph analog).

### 4.2 Tool map & path extraction
Edit tools `write_file | patch`; `terminal` excluded. Extraction (identical logic in CLI `pre-tool-use-scoring.ts` and backend `fileRefs.helpers.ts`):
```
write_file                       → [tool_input.path]
patch, mode "replace"|absent     → [tool_input.path]
patch, mode "patch"              → parseApplyPatchPaths(tool_input.patch)   // shared V4A parser
terminal / other                 → []   (fail-open)
```
`parseApplyPatchPaths` (already in `pre-tool-use-scoring.ts`, used for Codex `apply_patch`) is reused for Hermes patch-mode, with its regex extended once to also capture `*** Move File: a -> b` (both src and dst). One V4A parser then serves Codex `apply_patch` (`tool_input.command`) and Hermes patch-mode (`tool_input.patch`).

### 4.3 Output / block contract (the serializer)

| Internal verdict | Claude | Codex | **Hermes (`buildHermesOutput`)** |
|---|---|---|---|
| `deny` | `permissionDecision:"deny"`+reason | same | `{"action":"block","message": reason}` |
| `ask` | `permissionDecision:"ask"`+reason | demote→allow+`additionalContext` | `{"action":"block","message": reason}` — incl. the `prim reconcile …` directive (no Hermes soft tier) |
| `allow`/`warn` | allow (+context) | same | `{}` (allow; advisory cannot ride `pre_tool_call`) |
| fail-open | `permissionDecision:"allow"` | same | `{}` |

`ask`→`block` is stricter than Claude's soft confirm; it is the protective default for the full-parity scope and remains tunable via `PRIM_HOOK_MODE=warn` (demotes ask/deny→allow) and `PRIM_BYPASS=1`. See §11 R1.

### 4.4 Presence
- **P1 (core):** `on_session_start`/`on_session_end` → `daemonRequest("session_start"/"session_end")`. These are observer events; no stdout. `session-end.ts` gains `parseAgent` + normalize.
- **P2 (visible count, best-effort):** Hermes session hooks can't inject context, so the team-count rides `pre_llm_call`. `prim-hook`'s Hermes branch, on normalized `UserPromptSubmit` only, queries the daemon snapshot and emits `{"context":"[prim] team: N online"}` when the count is fresh, else `{}`. Separable from P1; see §11 R5 for the cold-path EV note.

---

## 5 · CLI changes (`campus-ai/prim`)

**New files**
- `src/commands/hermes-install.ts` — `registerHermesCommands` (`install`/`uninstall`/`status`). Global-only target `~/.hermes/config.yaml`; YAML merge engine (§7). Reuses `makeRegistration`/`hookShimCommand` from `claude-install.ts` for the shim commands; does **not** reuse the JSON `readSettings`/`atomicWrite`.
- `src/hooks/normalize.ts` — `normalizeEnvelope(parsed, agent)` + the event map (§4.1). Pure, unit-pinned.
- `src/commands/hermes-install.spec.ts`, `src/hooks/normalize.spec.ts`.

**Edited files**

| File | Change |
|---|---|
| `src/hooks/agent.ts` | `Agent` union `+ "hermes"`; `parseAgent` recognizes `--agent hermes`. |
| `src/protocol/move.ts:34` | `producer?` union `+ "hermes"`. |
| `src/hooks/prim-hook-core.ts:35` | generalize stamp → `...(agent !== "claude_code" ? { producer: agent } : {})`. |
| `src/hooks/prim-hook.ts` | `normalizeEnvelope` post-parse; P2 presence (Hermes + normalized `UserPromptSubmit` → `{"context":…}`). |
| `src/hooks/pre-tool-use.ts` | normalize post-parse; dispatch serializer by agent (`buildHermesOutput`/`failOpenHermes`). |
| `src/hooks/pre-tool-use-scoring.ts` | `extractHermesFilePaths` + Hermes branch in `extractFilePaths`; extend `parseApplyPatchPaths` for `*** Move File:`; `buildHermesOutput` + `failOpenHermes`. |
| `src/hooks/post-tool-use.ts` | normalize; `HERMES_EDITING_TOOLS = {write_file, patch}` dispatched by agent. |
| `src/hooks/session-start.ts` | normalize; daemon notify as-is (drop the Codex `additionalContext` path for Hermes — observer event). |
| `src/hooks/session-end.ts` | add `parseAgent` + normalize so `on_session_end` notifies the daemon and drains. |
| `src/commands/skill.ts` | `TARGET_CANDIDATES` `+ ".hermes.md", ".cursorrules"`. |
| `src/commands/setup.ts` | `SetupAgent + "hermes"`; widen `--agent` guard (95) and help (89); name the `hermes` group; suppress `scopeArgs` (global-only); pass `--target .hermes.md` to the skill step; preauth stays Claude-only. |
| `src/decisions/recent.ts:141` | feed badge `case "hermes": return "Your Hermes"`. |
| `src/index.ts` | import + `registerHermesCommands(program)`. |
| `package.json` | `+ "yaml"` dependency. |
| `SKILL.md` / `README.md` / `setup.md` | Hermes identity beat, `--agent hermes`, trust note, edit-tool enumeration, `prim hermes …`. |

**Untouched (load-bearing):** transport (`journal.ts`, `flusher.ts`, `client.ts`), env partitioning/binding, daemon protocol, `redact.ts`, `verdict-footer.ts`, `decisions-check.ts`.

---

## 6 · Backend changes (`campus-ai/primitive`, lockstep)

**A · Admit the producer value** — extend each closed union / type with `hermes`:
1. `convex/schema.ts:1068` (moves `producer`)
2. `convex/schema.ts:1208-1211` (`decisions.producerKind`)
3. `convex/moves/ingest.ts:34` (`appendBatch` validator — the fail-closed boundary)
4. `convex/moves/classifier.ts:360` (classifier validator)
5. `convex/moves/store/EventStore.ts:104` (TS type)

No change at `classifier.ts:423` (`?? "claude_code"` passthrough) or the store plumbers (`convexStore.ts`/`memoryStore.ts` forward `producer` verbatim).

**B · Native `write_file`/`patch` awareness** — mirrors the Codex `apply_patch` rollout (PR #1005):
6. `convex/moves/fileRefs.helpers.ts:77-90` — **load-bearing** path extractor; add `write_file`→`path` and `patch` mode-dispatch (mirror §4.2). Without it, Hermes edits produce zero `decisionFileRefs` → invisible to gate/cascade.
7. `convex/cli/footer.helpers.ts:21` — `EDIT_TOOL_NAMES` += `write_file`, `patch`.
8. `convex/moves/cascade.ts:37` — `EDIT_TOOLS` += `write_file`, `patch`.
9. `convex/moves/linker.ts:53` — `EDIT_TOOLS` += `write_file`, `patch`.
10. `convex/moves/cascadeGate.helpers.ts:209-230` — input summarizer: add `write_file`/`patch` branch.

> Items 6 & 10 need the dual-mode `patch` parse, not just a set insertion. Keep the V4A parsing logic identical to the CLI's (§4.2) — ideally a shared helper or a faithfully-mirrored copy with a cross-repo test pin.

---

## 7 · The YAML install command (`hermes-install.ts`)

The single biggest new piece — Codex reused the JSON engine; Hermes cannot.

**Target & scope.** Global only: `~/.hermes/config.yaml` (honor `HERMES_HOME`). `--scope project` → **hard error** (don't fabricate a layer Hermes never reads). `--scope user` is the implicit default; accepted for symmetry but is the only option.

**Read/merge/write.** Use the `yaml` package:
1. Parse the existing file (or empty doc). Preserve all foreign top-level keys (`model`, `agent`, `terminal`, …) and key order.
2. Merge only the top-level `hooks:` map and (optionally) `hooks_auto_accept`. Merge is **identity-matched on `(event, bin)`** like the Claude engine: re-install upgrades a drifted prim entry in place; a user's own non-prim hook under the same event survives; uninstall strips only prim's commands and drops an emptied event key.
3. Atomic write (tmp + fsync + rename), mirroring `claude-install.ts:atomicWrite`.

**Registration table** (`HERMES_REGISTRATIONS`, serialized to the YAML in §A.1). Commands are `hookShimCommand(bin, "--agent hermes")`. The gate/ingest carry `matcher: "write_file|patch"`; session/llm entries carry no matcher.

**Trust.** Hooks need consent. On install, print the trust beat (Codex `/hooks` analog) naming the three levers: `hooks_auto_accept: true`, `HERMES_ACCEPT_HOOKS=1`, or `hermes --accept-hooks chat`. Offer `prim hermes install --auto-accept` to set `hooks_auto_accept: true` in the same write (opt-in; never flip it silently).

**AX contract** (matches `prim claude`/`prim codex`): STDOUT = the JSON result; STDERR = the human verdict + trust beat.

---

## 8 · Rollout sequencing

Backend producer validation is fail-closed, so order matters:
1. **Backend PR first** — admit `hermes` + `write_file`/`patch` awareness. Purely additive; nothing emits `hermes` yet, so it's a safe solo land.
2. **CLI PRs** — emit `producer:"hermes"`. `ENVELOPE_VERSION` already lets a stale server tolerate new producers, but landing backend first means a **zero** rejection window.
3. Release + update `setup.md`/`v1` onboarding (note the `v1`-tag-serves-`setup.md` drift footgun — move the tag after merge).

**Suggested PRs** (each independently reviewable):
- BE: `feat: admit hermes producer + write_file/patch tool awareness`
- CLI 1: `feat(hermes): --agent hermes, normalizer, gate/ingest/capture/presence`
- CLI 2: `feat(hermes): YAML install command + setup/skill wiring`
- CLI 3: `docs(hermes): SKILL/README/setup`

---

## 9 · Test plan / acceptance criteria

**CLI**
- `normalize.spec` — every Hermes event → internal name; identity for Claude/Codex; `shouldFlushAfter(normalize("on_session_end"))` is true.
- `pre-tool-use-scoring.spec` — `extractHermesFilePaths`: `write_file`→`path`; `patch` replace→`path`; `patch` patch-mode→V4A paths incl. `*** Move File:`; CRLF-safe (the `192c9a2` lesson). `buildHermesOutput`: deny/ask→`{"action":"block","message":…}` (directive present on ask); allow/fail-open→`{}`.
- `hermes-install.spec` — merge preserves foreign top-level keys + order; idempotent; uninstall strips only prim and drops emptied events; non-prim sibling hook under a shared event survives; `--scope project` exits non-zero; `--auto-accept` sets `hooks_auto_accept: true`.
- `move-envelope.spec` / `prim-hook-core.spec` — `producer:"hermes"` wire pin; Claude bytes unchanged.

**Backend**
- ingest accepts `producer:"hermes"` (was a 400/500 before).
- `fileRefs` extracts `write_file`/`patch` (both modes) paths; cross-repo V4A pin matches the CLI.

**Acceptance (definition of done)**
- `prim hermes install` registers all shims in `~/.hermes/config.yaml`, preserving the user's config, and prints the trust beat.
- A `hermes chat` session in a prim-bound repo: edits are captured as `producer:"hermes"` moves; a conflicting `write_file`/`patch` is blocked with the reconcile directive; presence reflects the session.
- `prim hermes uninstall` returns `~/.hermes/config.yaml` to its pre-prim shape.
- Claude Code and Codex behavior byte-for-byte unchanged.

---

## 10 · Verification trail (to attach to each PR)
`pnpm lint` · `pnpm typecheck` · `pnpm test` · `git diff` review. Backend: Convex typecheck + affected tests.

---

## 11 · Risk register

| ID | Risk | Mitigation |
|---|---|---|
| R1 | `ask`→`block` is stricter than Claude's soft confirm (no Hermes soft tier exists) | Documented default; `PRIM_HOOK_MODE=warn` / `PRIM_BYPASS=1` escape hatches; revisit a stateful "warn-on-next-`pre_llm_call`" design post-v1 if users find it heavy. |
| R2 | YAML round-trip writer could reformat/clobber a hand-maintained `~/.hermes/config.yaml` | `yaml` lib preserves key order; merge touches only `hooks:`/`hooks_auto_accept`; atomic write; merge/round-trip tests on a realistic `cli-config.yaml.example`. |
| R3 | Dual-mode `patch` parsing must match in both repos | One shared V4A parser concept; cross-repo test pin; mirror logic exactly. |
| R4 | Fail-closed backend coupling | Land backend first (§8); `ENVELOPE_VERSION` tolerance as belt-and-suspenders. |
| R5 | P2 presence adds a daemon query to `prim-hook`'s cold path (every `pre_llm_call`) | 250ms timeout, best-effort, Hermes-only, `UserPromptSubmit`-only; P2 is separable and may be dropped if it muddies the cold path without changing P1 parity. |
| R6 | Global-only install isn't committable for teammates like `.codex/hooks.json` | Each teammate runs `prim hermes install` once (user scope); document in `setup.md`. Inherent to Hermes's design, not a prim choice. |

---

## 12 · Deferred / out of scope
`on_session_finalize`/`on_session_reset`/`pre/post_api_request` capture; Hermes gateway platforms as decision sources; Python plugin hooks; comment-preserving YAML; a `prim hermes` statusLine (Hermes has none).

---

## Appendix A — exact artifacts

### A.1 YAML block written to `~/.hermes/config.yaml`
(`<shim>` = `hookShimCommand(bin, "--agent hermes")`: PATH → local → `npx --yes @primitive.ai/prim@latest`.)
```yaml
hooks:
  on_session_start:
    - command: "<prim-session-start --agent hermes>"   # daemon presence
    - command: "<prim-hook --agent hermes>"            # capture
  pre_llm_call:
    - command: "<prim-hook --agent hermes>"            # capture + team-count context (P2)
  pre_tool_call:
    - command: "<prim-hook --agent hermes>"            # capture
    - matcher: "write_file|patch"
      command: "<prim-pre-tool-use --agent hermes>"    # conflict gate
      timeout: 10
  post_tool_call:
    - command: "<prim-hook --agent hermes>"            # capture
    - matcher: "write_file|patch"
      command: "<prim-post-tool-use --agent hermes>"   # ingest + verdict footer
  post_llm_call:
    - command: "<prim-hook --agent hermes>"            # capture (Stop analog)
  on_session_end:
    - command: "<prim-session-end --agent hermes>"     # daemon presence + drain
    - command: "<prim-hook --agent hermes>"            # capture
  subagent_stop:
    - command: "<prim-hook --agent hermes>"            # capture
# hooks_auto_accept: true   # only when `--auto-accept` is passed
```

### A.2 Hermes source citations
`tools/file_tools.py` — `WRITE_FILE_SCHEMA`:1769, `PATCH_SCHEMA`:1787, handlers:1863-1898 · `tools/patch_parser.py` — V4A:8-19, `parse_v4a_patch`:89-164 · `agent/shell_hooks.py` — stdout contract:41-51, `_parse_response`:552-595, `_resolve_effective_accept`:809-829 · `hermes_cli/config.py` — `get_config_path`:675, merge:6312-6340 · `hermes_cli/managed_scope.py` — `/etc/hermes`:33 · `cli-config.yaml.example` — hooks:1201-1214 · `website/docs/user-guide/features/hooks.md` — block/observer:381-424, context:532, levers:1381-1383.

### A.3 prim / backend touch-point index
CLI: `agent.ts`, `normalize.ts`(new), `protocol/move.ts:34`, `prim-hook-core.ts:35`, `prim-hook.ts`, `pre-tool-use.ts`, `pre-tool-use-scoring.ts`, `post-tool-use.ts`, `session-start.ts`, `session-end.ts`, `commands/hermes-install.ts`(new), `commands/skill.ts:29`, `commands/setup.ts:32,89,95,150`, `decisions/recent.ts:141`, `index.ts`, `package.json`.
Backend: `schema.ts:1068,1208`, `moves/ingest.ts:34`, `moves/classifier.ts:360`, `moves/store/EventStore.ts:104`, `moves/fileRefs.helpers.ts:77`, `cli/footer.helpers.ts:21`, `moves/cascade.ts:37`, `moves/linker.ts:53`, `moves/cascadeGate.helpers.ts:209`.
