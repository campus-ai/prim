import { readFileSync } from "node:fs";

const event = JSON.parse(readFileSync(0, "utf8"));
let name;
if (event.hook_event_name === "UserPromptSubmit") {
  name = event.prompt?.match(
    /^\s*[$/](write-(?:gameplan|workstream))(?=\s|$)/
  )?.[1];
} else if (
  event.hook_event_name === "UserPromptExpansion" &&
  event.expansion_type === "slash_command"
) {
  name = event.command_name;
} else if (
  event.hook_event_name === "PreToolUse" &&
  event.tool_name === "Skill"
) {
  name = event.tool_input?.skill;
}

if (
  typeof name === "string" &&
  /^(?:[^:]+:)*write-(?:gameplan|workstream)$/.test(name)
) {
  const companion = readFileSync(
    new URL("../SKILL.md", import.meta.url),
    "utf8"
  );
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: event.hook_event_name,
        additionalContext: `This repository uses the Primitive planning companion alongside ${name}. Its local skill follows:\n\n${companion}`,
      },
    })}\n`
  );
}
