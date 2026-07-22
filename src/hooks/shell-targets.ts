import { type Command, type Redirect, type Statement, type Word, parse } from "unbash";
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const READ_ONLY_COMMANDS = new Set(": cat echo false printf pwd test true [".split(" "));
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const STATIC_PARTS = new Set(["Literal", "SingleQuoted", "AnsiCQuoted"]);
type State = { paths: Set<string>; complete: boolean; mutation: boolean };
function staticPart(part: NonNullable<Word["parts"]>[number]): boolean {
  return (
    STATIC_PARTS.has(part.type) || (part.type === "DoubleQuoted" && part.parts.every(staticPart))
  );
}
function staticWord(word: Word | undefined): string | undefined {
  if (!word || !word.value || word.value.includes("\0") || word.value.includes("\n")) return;
  if (
    word.parts
      ? !word.parts.every(staticPart)
      : word.value.startsWith("~") || /[*?\[$`]/.test(word.text)
  )
    return;
  return word.value;
}
function unknown(state: State): void {
  state.complete = false;
  state.mutation = true;
}
function recordTarget(word: Word | undefined, state: State): void {
  const path = staticWord(word);
  if (path === "-" || (path && (SINKS.has(path) || path.startsWith("/dev/fd/")))) return;
  state.mutation = true;
  if (path) state.paths.add(path);
  else state.complete = false;
}
function visitRedirect(redirect: Redirect, state: State): void {
  const target = staticWord(redirect.target);
  if (redirect.operator === ">&" && (target === "-" || /^\d+$/.test(target ?? ""))) return;
  if (OUTPUT_REDIRECTS.has(redirect.operator) || redirect.operator === ">&")
    recordTarget(redirect.target, state);
  else unknown(state);
}
function operands(words: Word[], short = "", long: ReadonlySet<string> = new Set()) {
  const result: string[] = [];
  let optionsEnded = false;
  for (const word of words) {
    const value = staticWord(word);
    if (value === undefined) return;
    if (optionsEnded || value === "-" || !value.startsWith("-")) result.push(value);
    else if (value === "--") optionsEnded = true;
    else if (
      value.startsWith("--")
        ? !long.has(value)
        : [...value.slice(1)].some((c) => !short.includes(c))
    )
      return;
  }
  return result;
}
function visitCommand(command: Command, state: State): void {
  for (const redirect of command.redirects) visitRedirect(redirect, state);
  const name = staticWord(command.name);
  if (!name || name.includes("/") || command.suffix.some((word) => !staticWord(word))) {
    unknown(state);
  } else if (!READ_ONLY_COMMANDS.has(name)) {
    state.mutation = true;
    let targets: string[] | undefined;
    if (name === "tee") {
      targets = operands(command.suffix, "ai", new Set(["--append", "--ignore-interrupts"]));
    } else if (name === "touch") {
      targets = operands(command.suffix);
    } else if (name === "rm") {
      targets = operands(
        command.suffix,
        "fivI",
        new Set(["--force", "--interactive", "--interactive=once", "--verbose"]),
      );
    } else if (name === "cp" || name === "mv") {
      const pair = operands(command.suffix);
      if (pair?.length === 2) targets = name === "cp" ? [pair[1]] : pair;
    }
    if (!targets?.length) state.complete = false;
    else for (const target of targets) state.paths.add(target);
  }
  visitNested([command.name, command.prefix, command.suffix, command.redirects], state);
}
const CONTAINERS = new Set(["Script", "Pipeline", "AndOr", "CompoundList"]);
function visitNested(value: unknown, state: State): void {
  if (Array.isArray(value)) {
    for (const child of value) visitNested(child, state);
  } else if (value && typeof value === "object") {
    const child = value as Record<string, unknown>;
    if (child.type === "Command") {
      visitCommand(child as unknown as Command, state);
    } else if (child.type === "Statement") {
      visitStatement(child as unknown as Statement, state);
    } else if ("parts" in child) {
      for (const part of (value as Word).parts ?? []) visitNested(part, state);
    } else {
      const node = typeof child.type === "string" && "pos" in child && "end" in child;
      if (node && !CONTAINERS.has(child.type as string)) unknown(state);
      if (child.type === "Function") return;
      for (const nested of Object.values(child)) visitNested(nested, state);
    }
  }
}
function visitStatement(statement: Statement, state: State): void {
  if (statement.background) unknown(state);
  for (const redirect of statement.redirects) visitRedirect(redirect, state);
  visitNested([statement.redirects, statement.command], state);
}
export function analyzeShellTargets(source: string) {
  if (!source.trim())
    return { paths: [], coverage: "complete" as const, mutation: "none" as const };
  try {
    const script = parse(source);
    const state: State = { paths: new Set(), complete: !script.errors?.length, mutation: false };
    for (const statement of script.commands) visitStatement(statement, state);
    if (script.errors?.length) state.mutation = true;
    return {
      paths: [...state.paths],
      coverage: state.complete ? ("complete" as const) : ("unverified" as const),
      mutation: state.mutation ? ("present" as const) : ("none" as const),
    };
  } catch {
    return { paths: [], coverage: "unverified" as const, mutation: "present" as const };
  }
}
