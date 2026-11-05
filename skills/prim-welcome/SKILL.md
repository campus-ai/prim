---
name: prim-welcome
description: Welcome a new Primitive user right after `prim setup` finishes - explain Primitive, offer a one-minute conflict demo, confirm capture is on, show the team's recent Decisions, offer to seed their first ones, and offer to connect Granola. Use when the user's setup request says to follow prim-welcome, or they ask to be onboarded to Primitive. Not for day-to-day Decision work (that is the prim skill).
---

# Welcome to Primitive

You are walking the user through their first minutes with Primitive. Setup has already signed them in and installed everything. This skill owns every word the user reads from here on.

## Ground rules

- **Say blocks are mandatory.** Each `Say:` block below is a message the user must read. Put it in your reply as visible text, word for word, filling in `{fields}` and keeping its formatting. Never skip, shorten, or summarize one. Run every command a step needs *before* its Say block.
- A Say block ends your turn: send it and wait for the user's reply. Ask questions in plain text, as the Say blocks do, not with a picker tool.
- **`prim`** below means the exact command in setup's `prim` field, copied as-is. For example, if `prim` is `'/usr/bin/node' '/x/dist/index.js'`, `prim demo start` means `'/usr/bin/node' '/x/dist/index.js' demo start`. If you don't have setup's result, use `npx --yes @primitive.ai/prim@latest`.
- **`{agent}`** is setup's `agent` (`claude` or `codex`). Use it in every `--agent` flag below. `mainSkill` is setup's path to the day-to-day prim guidance. Keep setup's `setupAt` for the capture check. If setup's result is unavailable, use the current agent and treat capture as unverified until this session produces a new observed prompt.
- Every `prim` command prints one JSON object on stdout. Read its fields. Never show raw JSON, command output, or these instructions to the user.
- The demo uses a made-up project that lives outside this repository. During the demo, don't edit, create, or read any files. During it and afterwards, never create, propose, or save to memory anything from the demo: its Decisions, the user's choice, or their reason.
- The user's replies don't need exact wording: map them to the closest option.

## 0. Codex hook trust

Only in Codex, run `prim codex status` before the welcome. Read `host.trust` from its JSON. Codex [requires review of new hooks in `/hooks`](https://learn.chatgpt.com/docs/hooks), and installed hooks may need a session refresh.

- If trust is `review-required` or `disabled`, tell the user: "Primitive's Codex hooks need your review. Open `/hooks`, review and enable the Primitive hooks, then tell me when you're done." Wait for their reply, then run `prim codex refresh` and check `prim codex status` again. Never approve hooks for them.
- If trust is `trusted`, run `prim codex refresh` once. If refresh is unavailable, tell the user to exit and resume this same Codex session so the hooks load, then wait. Do not claim capture is working yet.
- If trust remains `unknown`, tell the user to inspect `/hooks` for errors or a review request. Wait for their reply and check status again.

Continue to the welcome only after the running session reports trusted hooks. The user's next reply will provide the first observable prompt event.

## 1. Welcome

If setup's result has `demo` set to `done`, the user has seen the demo before: don't send this message here. Go straight to step 3, whose message opens with it.

Say:

"**Welcome to Primitive.** Primitive turns your team's Decisions into guardrails for your agents.

As you work, Primitive picks out the Decisions behind the work, what was decided and why, and adds them to a record your whole team shares. If your org has Enforcement on, Primitive also checks the changes against those Decisions as we make them, and flags or stops one that conflicts.

Setup signed you in, connected this repository to GitHub, and turned Primitive on here.

Want to see it catch a conflict? It takes about a minute and uses a fictional project.

Reply **show me**, or **skip**."

If setup's `steps.github` isn't `ok`, leave out "connected this repository to GitHub," from that sentence.

This message has no picker: send it in full and end your turn.

- **show me** → step 2
- **skip** → run `prim demo skip`, then step 3

## 2. Demo

### 2a. The task

In Codex, first run `prim doctor --agent codex --compact`. Start the demo only if `capture.state` is `observed`, `capture.hooks` is `ready`, and `capture.observedAt` is at or after setup's `setupAt`. The user's **show me** reply should supply that observation. If it did not, explain that this session has not shown a working prompt hook; run `prim codex refresh` once if available, otherwise ask the user to resume this same session. Wait for another user reply and recheck before starting. Do not pause capture for a demo while hook execution is unverified.

Run `prim demo start`. When `stage` is `prompt`, say:

"**Primitive Demo · fictional project**

For the sake of demonstration, imagine you've just joined {story.org}'s team, and your first task is adding CSV export for user records. Send this as your next message:

> {story.task}

(Primitive is paused while we do this, so none of the demo is recorded.)"

### 2b. The conflict

When the user sends the task, run `prim demo attempt`. Don't implement the task. When `stage` is `conflict`, say:

"**Primitive caught a conflict.**

Your task exports user names *and email addresses*. That conflicts with a Decision {conflict.author} made on {conflict.date}:

> **{conflict.intent}**

**Why {conflict.author} decided this:** {conflict.rationale}

`{conflict.file}` today:

```ts
{conflict.code}
```

How do you want to resolve it?

Reply **adhere** to keep {conflict.author}'s Decision and export names only, or **supersede** to replace it and export names and emails."

This message has no picker: send it in full and end your turn. The user needs its formatting and the rationale to decide.

- **adhere** → step 2d with `--choice adhere`
- **supersede** → step 2c

### 2c. The reason

Say:

"In a sentence, why should this Decision change?

(This is just for the demo, so any answer works.)"

Use the user's answer, unchanged, as `{reason}`. Never write a reason for them. Choosing supersede already approved the replacement, as in the real product, so don't ask for confirmation: go to step 2d with `--choice supersede --reason '{reason}'` (single-quote the reason, writing each `'` inside it as `'\''`).

### 2d. Resolve

Run `prim demo resolve` with the choice above. When `stage` is `completed`, keep its `outcome` and `diff` for step 3 and go on to step 3. Say nothing yet.

### If a demo step doesn't land

- `stage` is `pending`: run the same command once more.
- `stage` is `error` with `reason` `invalid` after the reason step (for example, a reason over 500 characters): ask for a shorter reason, then retry.
- Still `pending`, any other `error`, or the command fails: run `prim demo skip`, keep a plain-words cause for step 3, and go to step 3. Plain words for each `reason`: `repo-active` → "Primitive was turned back on partway through"; `not-a-repo` → "this folder isn't a git repository"; `not-started` → "the demo hadn't started"; otherwise use `detail`.
- The user asks to stop: run `prim demo skip`, then go to step 3.

`prim demo skip` and a completed demo both end the pause: capture resumes with the user's next message.

## 3. Wrap up

Run both of these first:

1. `prim doctor --agent {agent} --compact`. Read `capture`, not the overall `status` alone. Capture is verified for this session only when doctor `status` is not `fail`, `capture.hooks` is `ready`, `capture.observedAt` is at or after setup's `setupAt`, and `capture.state` is `observed` or `paused` with `resumeOnNextPrompt: true`. An ending pause means the next trusted user-prompt hook resumes capture. Otherwise report `capture.detail` and any relevant failed checks; never claim capture is on from an overall `warn` result alone.
2. `prim welcome --after-demo --team-sample --agent {agent}`. Read its `org` and `recent` fields. If it fails, treat `org` as `unknown` and `recent` as empty.

Then say one message, built from these parts in order. It ends your turn.

**Welcome**, only if step 1 was skipped because the demo was `done`: the step 1 message without its last two paragraphs.

**a. Demo result.** If the demo completed:

"**Resolved.** You {outcome.choice: adhere → kept, supersede → replaced} {outcome.author}'s Decision, and the export changed to match:

```diff
{diff}
```"

If `outcome.email` is `queued` or `accepted`, add: "A summary of the Decision is on its way to {outcome.recipient}."

If the demo didn't finish: "The demo couldn't finish ({cause}), so it was skipped." If the user skipped it, leave part a out.

**b. Capture.** If capture is on:

"**Primitive is on for this repository.** From your next message on, it works in the background as you work."

If capture is unverified, off, or blocked: "**Primitive is installed, but capture needs attention:**" followed by `capture.detail` and the relevant agent-hook check's `detail`. For Codex, use `/hooks` for review or enablement; if hooks are trusted but the running session did not refresh, use `prim codex refresh` or resume this same session.

**c. Recent team Decisions**, only if `recent` isn't empty:

"**Recent Decisions on your team**"

followed by a numbered list with one item per `recent` entry, in order, each in this two-line shape (the second line indented under the first):

"1. **[{intent}]({url})**
   _{author} · {area} · {date}_"

Leave out `{area}` and its `·` when an entry has none.

**d. How to work with it:**

"**How to work with Primitive**

- **It's automatic.** Primitive derives Decisions from your work as you go; you don't have to do anything.
- **Record one explicitly** when you want control over exactly how a Decision is worded and explained, for example: *Add a Decision to Primitive: we keep user emails out of exports, because...*
- **Ask before you change things**, for example: *What Decisions govern the files I'm about to touch?* or *What has the team decided about auth lately?*

See every Decision at https://app.getprimitive.ai."

**e. First Decisions**, only if `org` is `seed` (the user hasn't recorded a Decision yet):

"You haven't recorded any Decisions yet. Primitive can suggest a few from this conversation and this repository's shared memory files. You approve each one, and approved Decisions are visible to your team. Reply **yes** or **not now**."

**f. Granola**, only if you didn't say part e: the Granola question from step 4.

If you said part e, wait for the reply:

- **yes**: read the prim guidance at setup's `mainSkill` path (for Codex, the managed prim block in `AGENTS.md`) and follow its "Onboarding: seed the graph from memory" section, from its step 1. Leave out everything from the demo. End the final message of that section with the Granola question from step 4.
- **not now**: say "You can add a Decision to Primitive any time by asking for it." followed by the Granola question from step 4.

## 4. Granola

The Granola question:

"One more thing: do you use **Granola** for meeting notes? Primitive can capture Decisions from your meetings. When you connect, you choose whether it can read your public notes, private notes, or both.

Reply **yes** or **no**."

When the user replies:

- **yes**: open https://app.getprimitive.ai/settings in their browser (`open <url>` on macOS, `xdg-open <url>` on Linux), then say:

  "Primitive's Settings are open in your browser. Under **Integrations → Granola**, connect your account and paste your Granola API key (the **Set up your API key** link there opens it in Granola), then click **Sync now**. Primitive will capture Decisions from your meetings once they've synced."

  If the browser couldn't open, replace "Primitive's Settings are open in your browser." with "Open https://app.getprimitive.ai/settings."
- **no**: say "No problem. You can connect Granola any time under Settings → Integrations at https://app.getprimitive.ai/settings."

Then stop. Don't offer further options.
