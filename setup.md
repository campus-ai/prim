<!-- PRIMITIVE_SETUP_V1 -->
# Primitive CLI setup (v1)

You are setting up the Primitive CLI for the user. Run each step and surface the
output. Do not guess; if a command exits non-zero, stop and report.

## 1. Authenticate
Run: `npx --yes @primitive.ai/prim auth login`

## 2. Install the pre-commit hook
Run: `npx --yes @primitive.ai/prim hooks install`

## 3. Install the skill into the project's rules file
Run: `npx --yes @primitive.ai/prim skill install`

This writes a managed block to the user's rules file (CLAUDE.md, .cursor/rules,
.windsurfrules, or .github/instructions/primitive.md). The CLI handles target
detection. If ambiguous, the CLI prints discovered candidates and exits
non-zero — pass `--target <path>` to disambiguate.

## 4. Confirm
Print a one-paragraph summary of what was installed and which file received the
skill block.
