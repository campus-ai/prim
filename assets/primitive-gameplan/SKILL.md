---
name: primitive-gameplan
description: Use alongside write-gameplan and write-workstream to bring applicable Primitive Decisions into architectural discussion, review plans for unsupported architectural additions, and preserve engineer-approved resolutions. Does not replace either public skill or authorize implementation.
---

# Primitive companion for gameplanning

Use the public planning skill unchanged. This companion adds decision context to
its existing architecture discussion and final review; it adds no schema fields
or human checkpoints between execution patches. Codex is the primary host:
discover this companion under `.agents/skills`, make the public skills available
to Codex, and use `$write-gameplan` or `$write-workstream`.
`prim gameplan install --agent codex` places a dispatcher
in the user's Codex hooks to load this companion for explicit invocations;
`AGENTS.md` also binds implicit planning-skill use.
Claude retains `/write-gameplan` and `/write-workstream` through
[the Claude hook configuration](claude-hooks.json), merged into
`.claude/settings.json` without replacing existing hooks.

## Before choosing architecture

Inspect the requested behavior and its existing code path. Identify both the
intended code files and the plan/workstream path, even if the plan does not exist
yet. From the target repository root, use the installed `prim` CLI, or
`npx --yes @primitive.ai/prim` when there is no `prim` executable:

```sh
prim auth status
prim decisions check --files "src/billing/export.ts,gameplans/billing-export.yaml"
prim decisions show dec_123
```

Replace the example paths and ID with real ones. `check` accepts comma-separated
repo-relative paths and emits JSON without a `--json` flag. Check intended code
paths as well as the artifact: a decision scoped to billing may not govern the
gameplans directory. Repeat the lookup if the planned footprint expands. Use
`show` on decisions you will rely on to inspect their full constraints, rationale,
source/attribution, status, and scope. A path match alone does not settle a choice.

Give a short brief before patch decomposition: relevant settled choices,
explicitly rejected approaches, and remaining architectural questions. Cite the
Decision IDs and explain their bearing on this change. Do not invent a blanket
ban on validators, workers, or persistence from an example of overengineering.

An empty successful lookup means no matching decisions were returned, not that
the proposed architecture is approved. Nonzero exits, `unavailable`, partial or
truncated responses, and missing provenance mean coverage is unknown or limited.
Report that limitation and use available engineer-supplied constraints. Do not
claim Primitive clearance, start an authentication flow, enable capture, or change
enforcement settings merely to finish planning.

## Resolve choices in the existing format

Use `architectureDesign.decisions[].resolution` in the public gameplan schema:

- `engineer_approved`: an actual engineer answer or identifiable engineer-approved
  source covers this exact choice and scope. Evidence includes the Primitive ID,
  substantive constraint, source of approval, and why it applies here.
- `constrained`: binding requirements eliminate meaningful alternatives; explain
  that reasoning, including the applicable Decision when one supplies a constraint.
- `delegated`: the engineer explicitly delegated this choice within a stated
  scope; retain that delegation. The agent's resulting selection is not a new
  user-originated decision without ratification.
- `unresolved`: the remaining choice needs an answer. Keep it in `openQuestions`
  too, and leave dependent patches/specs provisional until it is resolved.

Keep rationale in `resolution.rationale`. A captured agent suggestion, an author
name, adoption status alone, an existing implementation, or a broad milestone is
not evidence that an engineer approved a new mechanism. For example, approval of
PostgreSQL does not approve another durable ledger. Conflicting or ambiguous
Decisions require clarification; do not silently prefer the newest one.

When alternatives remain, present the minimal approach, credible alternatives,
and relevant prior constraints before choosing. Ask one question at a time when
answers depend on each other. Do not repeat a question already answered within
the same scope. For a workstream, use its existing decisions/open-questions prose
rather than introducing gameplan fields.

## Review the complete artifact before handoff

Read the solution, operational considerations, every patch, and every formal spec
against the resolved architecture. Look for consequential choices introduced as
implementation details: another source of truth, validation boundary, state
lifetime, worker, scheduler, retry protocol, or cross-runtime data flow. Check
each against its actual evidence and scope, not merely whether an ID is present.
This is a semantic review by the planning agent: `prim decisions check` is a
lookup, not that review.

For an unsupported addition, identify the patch and concrete choice. Remove an
unnecessary agent-added mechanism consistently from the artifact, or present it
as an unresolved exception with alternatives before finalizing dependent work.
Discussion of a rejected option is allowed; adopting it without resolution is not.
Re-run the public skill's schema/spec validation after changes. A validator PASS
does not verify that a human approved the design.

## Preserve the answers

At a natural planning boundary, retain durable engineer resolutions in Primitive
when recording is authorized. Check the applicable records and
`prim decisions recent --limit 20` to avoid duplicates. Use the installed Prim
recording policy when available; a request to draft a plan alone does not grant
permission to publish decisions into an inactive repository.

Before a create, check `prim decisions create --help`. Record the exact approved
choice with `--intent`, `--attribution user`, source-grounded `--rationale`, one
`--decided` per binding constraint, and `--alternatives` only for options actually
rejected. An agent selection under delegation uses `--attribution agent` unless
the engineer ratifies that selection. Missing rationale is a question, not a
license to invent one. Apply only the approved scope using `--files`,
`--scope-dir`, or `--scope-repo`; include the plan path when that scope governs it.
Do not silently broaden a code-only constraint to all plans or the whole repo.

Honor existing recording authorization without asking again. For an inactive repo,
Prim's global `--yes` is appropriate only for a specifically authorized create;
npm's `npx --yes` is merely package-install confirmation. Preserve returned IDs
in the existing evidence fields. Report failed writes as unsaved, retaining the
approved wording in the plan for recovery; after an ambiguous failure, check for
an existing record before retrying. Never invent an ID or a successful save.

For parent workstreams, follow the public skill's write-back procedure: present
the concrete edits and obtain its required approval before applying them. Saving
a Primitive Decision does not authorize a workstream edit.

## Enforcement boundary

Existing Conflict Gates may inspect saved plans when enabled and in scope. This
companion neither installs nor enables gates. It does not guarantee detection of
every architectural implication or cryptographically verify approval. Chat-only
plans bypass file-write gates, and infrastructure failures may fail open.

If a gate flags a conflict, surface the governing Decision and resolve the
architectural choice with the engineer. Do not run `prim reconcile`, weaken gate
mode, or change/supersede the Decision merely to make the plan pass. A bypass or
change of constraint needs explicit engineer authorization for that action.
