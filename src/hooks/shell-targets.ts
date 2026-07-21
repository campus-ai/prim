/**
 * Conservative shell-write target extraction.
 *
 * This is intentionally not a shell interpreter. It recognizes only literal
 * targets in a small set of common write shapes and never expands variables,
 * command substitutions, globs, or brace/tilde expressions. A command that
 * looks mutating but cannot be resolved is returned as `unresolved`, allowing
 * the hook to warn without guessing or blocking.
 */

type WordToken = { kind: "word"; value: string; literal: boolean };
type OperatorToken = { kind: "operator"; value: string };
type Token = WordToken | OperatorToken;

export type ShellMutationAnalysis = {
  mutation: "none" | "resolved" | "unresolved";
  paths: string[];
  reason?: "dynamic_target" | "unresolved_mutation";
};

const SEPARATORS = new Set([";", "|", "||", "&&"]);
const OUTPUT_REDIRECTIONS = new Set([">", ">>", ">|"]);
const MUTATING_COMMANDS = new Set([
  "cp",
  "install",
  "mkdir",
  "mv",
  "patch",
  "rm",
  "rmdir",
  "sed",
  "perl",
  "tee",
  "touch",
  "truncate",
]);

type HeredocExtraction = { shell: string; pythonBodies: string; unresolved: boolean };

function heredocOperators(line: string): Array<{ index: number; text: "<<" | "<<-" }> {
  const found: Array<{ index: number; text: "<<" | "<<-" }> = [];
  let quote: "'" | '"' | undefined;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === '"') i += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(line[i - 1]))) break;
    if (char === "<" && line[i - 1] !== "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const text = line[i + 2] === "-" ? "<<-" : "<<";
      found.push({ index: i, text });
      i += text.length - 1;
    }
  }
  return found;
}

function heredocPythonAssociation(
  line: string,
  operatorIndex: number,
): "python" | "other" | "ambiguous" {
  const segments = commandSegments(tokenize(line.slice(0, operatorIndex)));
  const info = commandName(segments.at(-1) ?? []);
  if (!info.wrapperUnresolved && info.name && /^python(?:3(?:\.\d+)?)?$/.test(info.name)) {
    return "python";
  }
  return /(?:^|[\s|;&(])(?:[^/\s]+\/)?python(?:3(?:\.\d+)?)?(?:\s|$)/.test(line)
    ? "ambiguous"
    : "other";
}

/** Remove literal heredoc bodies from shell-token analysis without discarding
 * them from the separately-gated Python literal scan. */
function extractHeredocs(command: string): HeredocExtraction {
  const lines = command.split(/\r?\n/);
  const shell: string[] = [];
  const pythonBodies: string[] = [];
  let unresolved = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const operators = heredocOperators(line);
    if (operators.length === 0) {
      shell.push(line);
      continue;
    }
    if (operators.length !== 1) {
      shell.push(line.slice(0, operators[0]?.index ?? 0));
      unresolved = true;
      break;
    }
    const op = operators[0];
    const rest = line.slice(op.index + op.text.length);
    const delimiter = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(rest);
    if (!delimiter) {
      shell.push(line.slice(0, op.index));
      unresolved = true;
      break;
    }
    const marker = delimiter[1] ?? delimiter[2] ?? delimiter[3];
    const stripTabs = op.text === "<<-";
    shell.push(line);
    const body: string[] = [];
    let found = false;
    for (i += 1; i < lines.length; i += 1) {
      const candidate = stripTabs ? lines[i].replace(/^\t+/, "") : lines[i];
      if (candidate === marker) {
        found = true;
        break;
      }
      body.push(lines[i]);
    }
    if (!found) {
      unresolved = true;
      break;
    }
    const bodyText = body.join("\n");
    const quotedDelimiter = delimiter[1] !== undefined || delimiter[2] !== undefined;
    if (!quotedDelimiter && /[$`]/.test(bodyText)) {
      // Unquoted heredocs expand parameters and command substitutions before
      // the child process sees them. Never predict that expansion.
      unresolved = true;
    } else {
      const association = heredocPythonAssociation(line, op.index);
      if (association === "python") pythonBodies.push(bodyText);
      else if (association === "ambiguous") unresolved = true;
    }
  }
  return {
    shell: shell.join("\n"),
    pythonBodies: pythonBodies.join("\n"),
    unresolved,
  };
}

function tokenize(command: string): Token[] {
  const out: Token[] = [];
  let value = "";
  let literal = true;
  let quote: "'" | '"' | undefined;

  const flush = () => {
    if (value.length > 0) out.push({ kind: "word", value, literal });
    value = "";
    literal = true;
  };

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote) {
      if (char === quote) {
        quote = undefined;
        continue;
      }
      if (quote === '"' && (char === "$" || char === "`")) literal = false;
      if (char === "\\" && quote === '"' && i + 1 < command.length) {
        value += command[i + 1];
        i += 1;
      } else {
        value += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\\" && i + 1 < command.length) {
      value += command[i + 1];
      i += 1;
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      if (char === "\n" || char === "\r") out.push({ kind: "operator", value: ";" });
      continue;
    }
    if (char === "#" && value.length === 0) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i += 1;
      continue;
    }
    if (char === ";" || char === "|" || char === "&" || char === ">" || char === "<") {
      flush();
      const pair = command.slice(i, i + 2);
      if (["||", "&&", ">>", ">|", "<<", "<<<"].includes(pair)) {
        let operator = pair;
        if (pair === "<<" && command[i + 2] === "<") {
          operator = "<<<";
          i += 1;
        }
        out.push({ kind: "operator", value: operator });
        i += 1;
      } else {
        out.push({ kind: "operator", value: char });
      }
      continue;
    }
    if (
      char === "$" ||
      char === "`" ||
      char === "*" ||
      char === "?" ||
      char === "[" ||
      char === "(" ||
      char === ")"
    ) {
      literal = false;
    }
    if ((char === "~" && value.length === 0) || char === "{") literal = false;
    value += char;
  }
  flush();
  return out;
}

function safePath(token: Token | undefined): string | undefined {
  if (!token || token.kind !== "word" || !token.literal) return undefined;
  const value = token.value;
  if (value !== value.trim()) return undefined;
  if (!value || value === "-" || value.startsWith("/dev/") || /^&\d+$/.test(value)) {
    return undefined;
  }
  return value;
}

type CommandInfo = {
  name?: string;
  args: WordToken[];
  wrapperUnresolved?: boolean;
  cwdChanges?: boolean;
};

function commandName(words: WordToken[]): CommandInfo {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index].value)) index += 1;
  let cwdChanges = false;
  while (words[index]?.value === "env") {
    index += 1;
    let optionsEnded = false;
    while (index < words.length) {
      const value = words[index].value;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(value)) {
        index += 1;
        continue;
      }
      if (optionsEnded || !value.startsWith("-") || value === "-") break;
      if (value === "--") {
        optionsEnded = true;
        index += 1;
        continue;
      }
      if (["-i", "--ignore-environment", "-0", "--null", "-v", "--debug"].includes(value)) {
        index += 1;
        continue;
      }
      if (value === "-C" || value === "--chdir") {
        cwdChanges = true;
        if (!words[index + 1]) {
          return { args: [], wrapperUnresolved: true, cwdChanges };
        }
        index += 2;
        continue;
      }
      if (value.startsWith("--chdir=")) {
        cwdChanges = true;
        if (value.length === "--chdir=".length) {
          return { args: [], wrapperUnresolved: true, cwdChanges };
        }
        index += 1;
        continue;
      }
      if (value === "-u" || value === "--unset") {
        if (!words[index + 1]) {
          return { args: [], wrapperUnresolved: true, cwdChanges };
        }
        index += 2;
        continue;
      }
      if (value.startsWith("-u") || value.startsWith("--unset=")) {
        index += 1;
        continue;
      }
      // Split-string and unknown env options can synthesize or consume the
      // command token. Never guess where the wrapped command begins.
      return { args: [], wrapperUnresolved: true, cwdChanges };
    }
  }
  while (words[index]?.value === "sudo" || words[index]?.value === "command") {
    index += 1;
    if (words[index]?.value.startsWith("-")) {
      return { args: [], wrapperUnresolved: true, cwdChanges };
    }
  }
  const command = words[index];
  if (!command) return { args: [], cwdChanges };
  return {
    name: command.value.split("/").at(-1),
    args: words.slice(index + 1),
    cwdChanges,
  };
}

function commandSegments(tokens: Token[]): WordToken[][] {
  const segments: WordToken[][] = [];
  let segment: WordToken[] = [];
  const flush = () => {
    if (segment.length > 0) segments.push(segment);
    segment = [];
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "operator" && SEPARATORS.has(token.value)) {
      flush();
    } else if (
      token.kind === "operator" &&
      [">", ">>", ">|", "<", "<<", "<<<"].includes(token.value)
    ) {
      if (tokens[i + 1]?.kind === "operator" && tokens[i + 1].value === "&") i += 2;
      else if (tokens[i + 1]?.kind === "word") i += 1;
    } else if (token.kind === "word") {
      const next = tokens[i + 1];
      // A numeric word immediately before a redirection is its file
      // descriptor, not part of the invoked command.
      if (!(next?.kind === "operator" && /^\d+$/.test(token.value))) segment.push(token);
    }
  }
  flush();
  return segments;
}

const DIRECTORY_CHANGERS = new Set(["cd", "pushd", "popd"]);
const SHELL_COMMAND_PREFIXES = new Set(["!", "(", "{", "builtin", "do", "elif", "if", "then"]);

function changesWorkingDirectory(segments: WordToken[][]): boolean {
  for (const words of segments) {
    const { name, cwdChanges } = commandName(words);
    if (cwdChanges) return true;
    if (name && DIRECTORY_CHANGERS.has(name.replace(/^[({]+/, ""))) return true;
    for (let i = 0; i < words.length; i += 1) {
      const value = words[i].value.replace(/^[({]+/, "");
      const previous = i > 0 ? words[i - 1].value.replace(/^[({]+/, "") : undefined;
      if (
        DIRECTORY_CHANGERS.has(value) &&
        (i === 0 || (previous !== undefined && SHELL_COMMAND_PREFIXES.has(previous)))
      ) {
        return true;
      }
    }
  }
  return false;
}

type OperandRules = {
  booleanShort?: string;
  valueShort?: string;
  booleanLong?: ReadonlySet<string>;
  valueLong?: ReadonlySet<string>;
};

function parseOperands(
  args: WordToken[],
  rules: OperandRules,
): { operands: WordToken[]; ambiguous: boolean } {
  const operands: WordToken[] = [];
  let optionsEnded = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (optionsEnded || arg.value === "-" || !arg.value.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.value.startsWith("--")) {
      const [name, attached] = arg.value.split("=", 2);
      if (rules.booleanLong?.has(name)) {
        if (attached !== undefined) return { operands: [], ambiguous: true };
        continue;
      }
      if (rules.valueLong?.has(name)) {
        if (attached === undefined) {
          if (!args[i + 1]) return { operands: [], ambiguous: true };
          i += 1;
        }
        continue;
      }
      return { operands: [], ambiguous: true };
    }
    const flags = arg.value.slice(1);
    for (let j = 0; j < flags.length; j += 1) {
      const flag = flags[j];
      if (rules.booleanShort?.includes(flag)) continue;
      if (rules.valueShort?.includes(flag)) {
        if (j === flags.length - 1) {
          if (!args[i + 1]) return { operands: [], ambiguous: true };
          i += 1;
        }
        break;
      }
      return { operands: [], ambiguous: true };
    }
  }
  return { operands, ambiguous: false };
}

type SegmentTargets = { targets: WordToken[]; mutating: boolean; unresolved?: boolean };

function hasRecursiveRmOption(args: WordToken[]): boolean {
  let optionsEnded = false;
  for (const arg of args) {
    if (optionsEnded) continue;
    if (arg.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.value === "--recursive" || /^-[^-]*[rR]/.test(arg.value)) return true;
  }
  return false;
}

function sedTargets(args: WordToken[]): SegmentTargets {
  let inPlace = false;
  let programSupplied = false;
  let ambiguous = false;
  let optionsEnded = false;
  const operands: WordToken[] = [];
  const booleanLong = new Set([
    "--debug",
    "--follow-symlinks",
    "--null-data",
    "--posix",
    "--quiet",
    "--regexp-extended",
    "--sandbox",
    "--separate",
    "--silent",
    "--unbuffered",
  ]);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (optionsEnded || arg.value === "-" || !arg.value.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.value === "--in-place" || arg.value.startsWith("--in-place=")) {
      inPlace = true;
      continue;
    }
    if (arg.value === "--expression" || arg.value === "--file" || arg.value === "--line-length") {
      if (!args[i + 1]) ambiguous = true;
      else i += 1;
      if (arg.value !== "--line-length") programSupplied = true;
      continue;
    }
    if (
      arg.value.startsWith("--expression=") ||
      arg.value.startsWith("--file=") ||
      arg.value.startsWith("--line-length=")
    ) {
      if (!arg.value.slice(arg.value.indexOf("=") + 1)) ambiguous = true;
      if (!arg.value.startsWith("--line-length=")) programSupplied = true;
      continue;
    }
    if (booleanLong.has(arg.value)) continue;
    if (arg.value.startsWith("--")) {
      ambiguous = true;
      continue;
    }

    const flags = arg.value.slice(1);
    for (let j = 0; j < flags.length; j += 1) {
      const flag = flags[j];
      if ("nErsuzb".includes(flag)) continue;
      if (flag === "i") {
        inPlace = true;
        // Any remainder is the optional backup suffix, not more flags.
        break;
      }
      if (flag === "e" || flag === "f" || flag === "l") {
        if (flag !== "l") programSupplied = true;
        if (j === flags.length - 1) {
          if (!args[i + 1]) ambiguous = true;
          else i += 1;
        }
        // Any remainder is the attached option value.
        break;
      }
      ambiguous = true;
      break;
    }
  }

  const targets = programSupplied ? operands : operands.slice(1);
  return {
    targets: inPlace ? targets : [],
    mutating: inPlace,
    unresolved: ambiguous || (inPlace && targets.length === 0),
  };
}

function targetsForSegment(words: WordToken[]): SegmentTargets {
  const { name, args } = commandName(words);
  if (!name) return { targets: [], mutating: false };
  switch (name) {
    case "tee": {
      const parsed = parseOperands(args, {
        booleanShort: "ai",
        booleanLong: new Set(["--append", "--ignore-interrupts"]),
        valueLong: new Set(["--output-error"]),
      });
      return { targets: parsed.operands, mutating: true, unresolved: parsed.ambiguous };
    }
    case "mkdir": {
      const parsed = parseOperands(args, {
        booleanShort: "pv",
        valueShort: "mZ",
        booleanLong: new Set(["--parents", "--verbose"]),
        valueLong: new Set(["--mode", "--context"]),
      });
      return { targets: parsed.operands, mutating: true, unresolved: parsed.ambiguous };
    }
    case "rm":
    case "rmdir": {
      const parsed = parseOperands(args, {
        booleanShort: "dfiIrvR",
        booleanLong: new Set([
          "--force",
          "--interactive",
          "--one-file-system",
          "--recursive",
          "--verbose",
        ]),
      });
      return {
        targets: parsed.operands,
        mutating: true,
        // A directory removal can mutate governed descendants that an exact
        // path preflight cannot enumerate safely from command text alone.
        unresolved: parsed.ambiguous || (name === "rm" && hasRecursiveRmOption(args)),
      };
    }
    case "touch": {
      const parsed = parseOperands(args, {
        booleanShort: "acfmh",
        valueShort: "drt",
        booleanLong: new Set(["--no-create", "--no-dereference"]),
        valueLong: new Set(["--date", "--reference", "--time"]),
      });
      return { targets: parsed.operands, mutating: true, unresolved: parsed.ambiguous };
    }
    case "truncate": {
      const parsed = parseOperands(args, {
        booleanShort: "cr",
        valueShort: "os",
        booleanLong: new Set(["--no-create"]),
        valueLong: new Set(["--io-blocks", "--reference", "--size"]),
      });
      return { targets: parsed.operands, mutating: true, unresolved: parsed.ambiguous };
    }
    case "cp":
    case "install":
      if (
        args.some(
          (arg) =>
            arg.value === "-t" ||
            (arg.value.startsWith("-t") && arg.value !== "-T") ||
            arg.value === "--target-directory" ||
            arg.value.startsWith("--target-directory="),
        )
      ) {
        return { targets: [], mutating: true, unresolved: true };
      }
      {
        const parsed = parseOperands(args, {
          booleanShort: name === "cp" ? "abdfHiLlnprRstTuvxP" : "CDdpstv",
          valueShort: name === "cp" ? "S" : "gmoS",
          booleanLong: new Set([
            "--archive",
            "--force",
            "--interactive",
            "--link",
            "--no-clobber",
            "--parents",
            "--recursive",
            "--symbolic-link",
            "--verbose",
          ]),
          valueLong: new Set(["--backup", "--context", "--group", "--mode", "--owner", "--suffix"]),
        });
        const destination = parsed.operands.length > 1 ? parsed.operands.at(-1) : undefined;
        return {
          targets: destination ? [destination] : [],
          mutating: true,
          // Even one literal destination may be an existing directory, in
          // which case the actual writes are destination/basename(source).
          unresolved: true,
        };
      }
    case "mv": {
      if (
        args.some(
          (arg) =>
            arg.value === "-t" ||
            (arg.value.startsWith("-t") && arg.value !== "-T") ||
            arg.value.startsWith("--target-directory"),
        )
      ) {
        return { targets: [], mutating: true, unresolved: true };
      }
      const parsed = parseOperands(args, {
        booleanShort: "finTv",
        valueShort: "S",
        booleanLong: new Set(["--force", "--interactive", "--no-clobber", "--verbose"]),
        valueLong: new Set(["--backup", "--suffix"]),
      });
      return {
        targets: parsed.operands,
        mutating: true,
        unresolved: true,
      };
    }
    case "sed":
      return sedTargets(args);
    case "perl": {
      const inPlace = args.some((arg) => /^-[^-]*i/.test(arg.value));
      let hasInlineProgram = false;
      let ambiguous = false;
      const targets: WordToken[] = [];
      let optionsEnded = false;
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i];
        if (optionsEnded || !arg.value.startsWith("-") || arg.value === "-") {
          targets.push(arg);
          continue;
        }
        if (arg.value === "--") {
          optionsEnded = true;
          continue;
        }
        if (arg.value === "-e" || arg.value === "-E") {
          hasInlineProgram = true;
          if (!args[i + 1]) ambiguous = true;
          else i += 1;
        } else if (arg.value.startsWith("-e") || arg.value.startsWith("-E")) {
          hasInlineProgram = arg.value.length > 2;
        } else if (arg.value === "-M" || arg.value === "-m") {
          if (!args[i + 1]) ambiguous = true;
          else i += 1;
        }
      }
      return {
        targets: inPlace && hasInlineProgram ? targets : [],
        mutating: inPlace,
        unresolved: ambiguous || (inPlace && !hasInlineProgram),
      };
    }
    case "patch":
      // `patch` may infer a target from diff headers, which is intentionally not
      // parsed here. Flag it as unverified unless an explicit literal file is
      // present after the options.
      return { targets: [], mutating: true, unresolved: true };
    default:
      return { targets: [], mutating: MUTATING_COMMANDS.has(name) };
  }
}

function pythonCodeMask(source: string): boolean[] {
  const mask = Array.from({ length: source.length }, () => true);
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "#") {
      while (i < source.length && source[i] !== "\n") {
        mask[i] = false;
        i += 1;
      }
      continue;
    }
    const quote = source[i];
    if (quote !== "'" && quote !== '"') continue;
    const triple = source.slice(i, i + 3) === quote.repeat(3);
    const delimiterLength = triple ? 3 : 1;
    for (let j = 0; j < delimiterLength; j += 1) mask[i + j] = false;
    i += delimiterLength;
    while (i < source.length) {
      mask[i] = false;
      if (source[i] === "\\") {
        if (i + 1 < source.length) mask[i + 1] = false;
        i += 2;
        continue;
      }
      if (source.slice(i, i + delimiterLength) === quote.repeat(delimiterLength)) {
        for (let j = 0; j < delimiterLength; j += 1) mask[i + j] = false;
        i += delimiterLength - 1;
        break;
      }
      i += 1;
    }
  }
  return mask;
}

function callStartsInPythonCode(
  mask: readonly boolean[],
  match: RegExpMatchArray,
  callPattern: RegExp,
): boolean {
  const offset = match[0].search(callPattern);
  return offset >= 0 && mask[(match.index ?? 0) + offset] === true;
}

function pythonLiteralTargets(command: string): {
  paths: string[];
  mutating: boolean;
  dynamic: boolean;
} {
  const paths: string[] = [];
  const codeMask = pythonCodeMask(command);
  let resolvedOccurrences = 0;
  const add = (path: string | undefined) => {
    if (path && path !== "-" && !path.startsWith("/dev/")) {
      paths.push(path);
      resolvedOccurrences += 1;
    }
  };
  const isWriteMode = (mode: string): boolean => /[wax+]/.test(mode);

  const pathWrite =
    /(?:^|[;\n])\s*(?:(?:await\s+)|(?:[A-Za-z_]\w*\s*=\s*))?(?:pathlib\.)?Path\(\s*(["'])(.*?)\1\s*\)\.(?:write_text|write_bytes|touch|unlink)\s*\(/g;
  for (const match of command.matchAll(pathWrite)) {
    if (callStartsInPythonCode(codeMask, match, /(?:pathlib\.)?Path\s*\(/)) add(match[2]);
  }

  const builtInOpen =
    /(?:^|[;\n])\s*(?:(?:with\s+)|(?:[A-Za-z_]\w*\s*=\s*))?open\(\s*(["'])(.*?)\1\s*,\s*(["'])([^"']*)\3/g;
  for (const match of command.matchAll(builtInOpen)) {
    if (callStartsInPythonCode(codeMask, match, /\bopen\s*\(/) && isWriteMode(match[4])) {
      add(match[2]);
    }
  }
  const builtInOpenKeyword =
    /(?:^|[;\n])\s*(?:(?:with\s+)|(?:[A-Za-z_]\w*\s*=\s*))?open\(\s*(["'])(.*?)\1\s*,\s*mode\s*=\s*(["'])([^"']*)\3/g;
  for (const match of command.matchAll(builtInOpenKeyword)) {
    if (callStartsInPythonCode(codeMask, match, /\bopen\s*\(/) && isWriteMode(match[4])) {
      add(match[2]);
    }
  }
  const builtInOpenNamed =
    /(?:^|[;\n])\s*(?:(?:with\s+)|(?:[A-Za-z_]\w*\s*=\s*))?open\(\s*file\s*=\s*(["'])(.*?)\1\s*,\s*mode\s*=\s*(["'])([^"']*)\3/g;
  for (const match of command.matchAll(builtInOpenNamed)) {
    if (callStartsInPythonCode(codeMask, match, /\bopen\s*\(/) && isWriteMode(match[4])) {
      add(match[2]);
    }
  }
  const builtInOpenNamedReversed =
    /(?:^|[;\n])\s*(?:(?:with\s+)|(?:[A-Za-z_]\w*\s*=\s*))?open\(\s*mode\s*=\s*(["'])([^"']*)\1\s*,\s*file\s*=\s*(["'])(.*?)\3/g;
  for (const match of command.matchAll(builtInOpenNamedReversed)) {
    if (callStartsInPythonCode(codeMask, match, /\bopen\s*\(/) && isWriteMode(match[2])) {
      add(match[4]);
    }
  }

  const pathOpen =
    /(?:^|[;\n])\s*(?:[A-Za-z_]\w*\s*=\s*)?(?:pathlib\.)?Path\(\s*(["'])(.*?)\1\s*\)\.open\(\s*(["'])([^"']*)\3/g;
  for (const match of command.matchAll(pathOpen)) {
    if (
      callStartsInPythonCode(codeMask, match, /(?:pathlib\.)?Path\s*\(/) &&
      isWriteMode(match[4])
    ) {
      add(match[2]);
    }
  }
  const pathOpenKeyword =
    /(?:^|[;\n])\s*(?:[A-Za-z_]\w*\s*=\s*)?(?:pathlib\.)?Path\(\s*(["'])(.*?)\1\s*\)\.open\(\s*mode\s*=\s*(["'])([^"']*)\3/g;
  for (const match of command.matchAll(pathOpenKeyword)) {
    if (
      callStartsInPythonCode(codeMask, match, /(?:pathlib\.)?Path\s*\(/) &&
      isWriteMode(match[4])
    ) {
      add(match[2]);
    }
  }

  const pathMutationCount = [...command.matchAll(/\.(?:write_text|write_bytes|touch|unlink)\s*\(/g)]
    .length;
  let openMutationCount = 0;
  for (const call of command.matchAll(/(?:\bopen|\.open)\s*\(([^)\n]*)\)/g)) {
    const strings = [...call[1].matchAll(/(["'])(.*?)\1/g)].map((match) => match[2]);
    if (strings.some((value) => /^[rwaxtb+]+$/.test(value) && isWriteMode(value))) {
      openMutationCount += 1;
    }
  }
  const mutationCount = pathMutationCount + openMutationCount;
  return {
    paths,
    mutating: mutationCount > 0,
    dynamic: mutationCount > resolvedOccurrences,
  };
}

/** Analyze literal shell targets without evaluating any shell syntax. */
export function analyzeShellMutation(command: string): ShellMutationAnalysis {
  if (!command.trim()) return { mutation: "none", paths: [] };
  const heredocs = extractHeredocs(command);
  const tokens = tokenize(heredocs.shell);
  const candidates: Token[] = [];
  let mutationSeen = heredocs.unresolved;
  let unresolvedSeen = heredocs.unresolved;

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.kind === "operator" && OUTPUT_REDIRECTIONS.has(token.value)) {
      const target = tokens[i + 1];
      const fdDuplication =
        target?.kind === "operator" &&
        target.value === "&" &&
        tokens[i + 2]?.kind === "word" &&
        /^\d+$/.test(tokens[i + 2].value);
      const sink =
        target?.kind === "word" &&
        target.literal &&
        (target.value === "/dev/null" ||
          target.value === "/dev/stdout" ||
          target.value === "/dev/stderr");
      if (fdDuplication || sink) continue;
      mutationSeen = true;
      if (safePath(target)) candidates.push(target);
      else unresolvedSeen = true;
    }
  }

  const segments = commandSegments(tokens);
  const cwdChanges = changesWorkingDirectory(segments);
  for (const segment of segments) {
    const commandInfo = commandName(segment);
    const result = targetsForSegment(segment);
    if (commandInfo.wrapperUnresolved) {
      mutationSeen = true;
      unresolvedSeen = true;
    }
    mutationSeen ||= result.mutating;
    if (result.unresolved || (result.mutating && result.targets.length === 0))
      unresolvedSeen = true;
    for (const target of result.targets) {
      if (safePath(target)) candidates.push(target);
      else unresolvedSeen = true;
    }
  }

  const pythonSources: string[] = [];
  let hasPythonInvocation = false;
  let unresolvedPythonSource = false;
  for (const words of segments) {
    const { name, args } = commandName(words);
    if (!name || !/^python(?:3(?:\.\d+)?)?$/.test(name)) continue;
    hasPythonInvocation = true;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg.value === "-c") {
        const source = args[i + 1];
        if (!source || !source.literal) unresolvedPythonSource = true;
        else pythonSources.push(source.value);
        break;
      }
      if (arg.value.startsWith("-c") && arg.value.length > 2) {
        if (arg.literal) pythonSources.push(arg.value.slice(2));
        else unresolvedPythonSource = true;
        break;
      }
      // A module, script, or stdin marker ends interpreter option parsing.
      // Its contents are not present in deterministic command text.
      if (arg.value === "-m" || arg.value === "-" || !arg.value.startsWith("-")) break;
    }
  }
  if (hasPythonInvocation && heredocs.pythonBodies) {
    pythonSources.push(heredocs.pythonBodies);
  }
  const python = hasPythonInvocation
    ? pythonLiteralTargets(pythonSources.join("\n"))
    : { paths: [], mutating: false, dynamic: false };
  mutationSeen ||= python.mutating;
  if (unresolvedPythonSource) mutationSeen = true;
  unresolvedSeen ||= python.dynamic || unresolvedPythonSource;
  const paths = new Set<string>();
  for (const candidate of candidates) {
    const path = safePath(candidate);
    if (path) paths.add(path);
  }
  for (const path of python.paths) paths.add(path);

  if (!mutationSeen) return { mutation: "none", paths: [] };
  if (cwdChanges) {
    // A single envelope cwd cannot represent targets before and after a shell
    // directory change. Returning no refs prevents both a false preflight and
    // a wrongly attached canonical Decision scope.
    return { mutation: "unresolved", paths: [], reason: "unresolved_mutation" };
  }
  if (unresolvedSeen || paths.size === 0) {
    return {
      mutation: "unresolved",
      paths: [...paths],
      reason: unresolvedSeen ? "dynamic_target" : "unresolved_mutation",
    };
  }
  return { mutation: "resolved", paths: [...paths] };
}
