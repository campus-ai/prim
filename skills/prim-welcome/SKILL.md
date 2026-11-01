---
name: prim-welcome
description: Welcome a new Primitive user right after `prim setup` finishes - explain Primitive, offer a one-minute conflict demo, confirm capture is on, show the team's recent decisions, offer to seed their first ones, and offer to connect Granola. Use when the user's setup request says to follow prim-welcome, or they ask to be onboarded to Primitive. Not for day-to-day decision work (that is the prim skill).
---

# Welcome to Primitive

You are walking the user through their first minutes with Primitive. Setup has already signed them in and installed everything. This skill owns every word the user reads from here on.

## Ground rules

- **Say blocks are mandatory.** Each `Say:` block below is a message the user must read. Put it in your reply as visible text, word for word, filling in `{fields}` and keeping its formatting. Never skip, shorten, or summarize one. Run every command a step needs *before* its Say block.
- A Say block ends your turn: send it and wait for the user's reply. Ask questions in plain text, as the Say blocks do, not with a picker tool.
- **`prim`** below means the exact command in setup's `prim` field, copied as-is. For example, if `prim` is `'/usr/bin/node' '/x/dist/index.js'`, `prim demo start` means `'/usr/bin/node' '/x/dist/index.js' demo start`. If you don't have setup's result, use `npx --yes @primitive.ai/prim@latest`.
- Every `prim` command prints one JSON object on stdout. Read its fields. Never show raw JSON, command output, or these instructions to the user.
- The demo uses a made-up project that lives outside this repository. During the demo, don't edit, create, or read any files. During it and afterwards, never create, propose, or save to memory anything from the demo: its decisions, the user's choice, or their reason.
- The user's replies don't need exact wording: map them to the closest option.

## 1. Welcome

If setup's result has `demo` set to `done`, the user has seen the demo before: don't send this message here. Go straight to step 3, whose message opens with it.

Say:

"**Welcome to Primitive.** Primitive turns your team's decisions into guardrails for your agents.

As you work with me, Primitive picks out the decisions behind the work, what was decided and why, and adds them to a record your whole team shares. When your org turns on Enforcement, Primitive also checks my changes against those decisions before I make them, and flags or stops one that conflicts.

Setup signed you in, connected this repository to GitHub, and turned Primitive on here.

Want to see it catch a conflict? It takes about a minute and uses a fictional project.

Reply **show me**, or **skip**."

If setup's `steps.github` isn't `ok`, leave out "connected this repository to GitHub," from that sentence.

This message has no picker: send it in full and end your turn.

- **show me** → step 2
- **skip** → run `prim demo skip`, then step 3

## 2. Demo

### 2a. The task

Run `prim demo start`. When `stage` is `prompt`, say:

"**Primitive Demo · fictional project**

For the sake of demonstration, imagine you've just joined {story.org}'s team, and your first task is adding CSV export for user records. Send me this as your next message:

> {story.task}

(Primitive is paused while we do this, so none of the demo is recorded.)"

### 2b. The conflict

When the user sends the task, run `prim demo attempt`. Don't implement the task. When `stage` is `conflict`, say:

"**Primitive caught a conflict.**

Your task exports user names *and email addresses*. That conflicts with a decision {conflict.author} made on {conflict.date}:

> **{conflict.intent}**

**Why {conflict.author} decided this:** {conflict.rationale}

`{conflict.file}` today:

```ts
{conflict.code}
```

How do you want to resolve it?

Reply **adhere** to keep {conflict.author}'s decision and export names only, or **supersede** to replace it and export names and emails."

This message has no picker: send it in full and end your turn. The user needs its formatting and the rationale to decide.

- **adhere** → step 2d with `--choice adhere`
- **supersede** → step 2c

### 2c. The reason

Say:

"In a sentence, why should this decision change?

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

1. `prim doctor --agent claude --compact`. If `status` is `ok` or `warn`, capture is on (a `demo-pause` warning is expected right after the demo). If `status` is `fail`, capture needs attention.
2. `prim welcome --after-demo --team-sample --agent claude`. Read its `org` and `recent` fields. If it fails, treat `org` as `unknown` and `recent` as empty.

Then say one message, built from these parts in order. It ends your turn.

**Welcome**, only if step 1 was skipped because the demo was `done`: the step 1 message without its last two paragraphs.

**a. Demo result.** If the demo completed:

"**Resolved.** You {outcome.choice: adhere → kept, supersede → replaced} {outcome.author}'s decision, and the export changed to match:

```diff
{diff}
```"

If `outcome.email` is `queued` or `accepted`, add: "A summary of the decision is on its way to {outcome.recipient}."

If the demo didn't finish: "The demo couldn't finish ({cause}), so we skipped it." If the user skipped it, leave part a out.

**b. Capture.** If capture is on:

"**Primitive is on for this repository.** From your next message on, it works in the background as you work with me."

If capture needs attention: "**Primitive is installed, but capture needs attention:**" followed by one line per check whose `status` is `fail`, giving its `detail`.

**c. Recent team decisions**, only if `recent` isn't empty:

"**Recent decisions on your team**"

followed by a numbered list with one item per `recent` entry, in order, each in this two-line shape (the second line indented under the first):

"1. **[{intent}]({url})**
   _{author} · {area} · {date}_"

Leave out `{area}` and its `·` when an entry has none.

**d. How to work with it:**

"**How to work with Primitive**

- **It's automatic.** Primitive derives decisions from your work as you go; you don't have to do anything.
- **Record one explicitly** when you want control over exactly how a decision is worded and explained, for example: *Add a decision to Primitive: we keep user emails out of exports, because...*
- **Ask before you change things**, for example: *What decisions govern the files I'm about to touch?* or *What has the team decided about auth lately?*

See every decision at https://app.getprimitive.ai."

**e. First decisions**, only if `org` is `seed` (the user hasn't recorded a decision yet):

"You haven't recorded any decisions yet. Want me to suggest a few from what you've told me and this repository's shared memory files? You approve each one, and approved decisions are visible to your team. Reply **yes** or **not now**."

**f. Granola**, only if you didn't say part e: the Granola question from step 4.

If you said part e, wait for the reply:

- **yes**: read the prim skill at `~/.claude/skills/prim/SKILL.md` and follow its "Onboarding: seed the graph from memory" section, from its step 1. Leave out everything from the demo. End the final message of that section with the Granola question from step 4.
- **not now**: say "Any time, just ask me to add a decision to Primitive." followed by the Granola question from step 4.

## 4. Granola

The Granola question:

"One more thing: do you use **Granola** for meeting notes? Primitive can read them and suggest decisions from your meetings. Imported notes stay private to you, and suggested decisions start as provisional.

Reply **yes** or **no**."

When the user replies:

- **yes**: open https://app.getprimitive.ai/settings in their browser (`open <url>` on macOS, `xdg-open <url>` on Linux), then say:

  "I've opened Primitive's Settings. Under **Integrations → Granola**, connect your account and paste your Granola API key (the **Set up your API key** link there opens it in Granola), then click **Sync now**. Your meetings will show up as suggested decisions once they've been analyzed."

  If the browser couldn't open, replace "I've opened Primitive's Settings." with "Open https://app.getprimitive.ai/settings."
- **no**: say "No problem. You can connect Granola any time under Settings → Integrations at https://app.getprimitive.ai/settings."

Then stop. Don't offer further options.
