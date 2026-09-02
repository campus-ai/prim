import { type Command, type Redirect, type Statement, type Word, parse } from "unbash";
import { parseApplyPatchTargets } from "./pre-tool-use-scoring.js";
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const READ_ONLY_COMMANDS = new Set(": cat echo false printf pwd test true [".split(" "));
const SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);
const STATIC_PARTS = new Set(["Literal", "SingleQuoted", "AnsiCQuoted"]);
type State = { paths: Set<string>; complete: boolean; mutation: boolean; definiteEdit: boolean };
type OptionSpec = {
  shortFlags?: string;
  shortValues?: string;
  longFlags?: ReadonlySet<string>;
  longValues?: ReadonlySet<string>;
  longOptionalValues?: ReadonlySet<string>;
};
type ParsedOptions = {
  operands: string[];
  seen: Set<string>;
  values: Map<string, string[]>;
};

const set = (values: string) => new Set(values.split(" ").filter(Boolean));
const INFO_OPTIONS = set("--help --version");

const COMMAND_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  rg: {
    shortFlags: "0FHILNPSUabchilnopqsvwx",
    shortValues: "ABCEgjMmrtTef",
    longFlags: set(
      "--binary --case-sensitive --column --count --count-matches --crlf --debug --files --files-with-matches --files-without-match --fixed-strings --follow --heading --hidden --ignore-case --invert-match --json --line-number --line-regexp --multiline --multiline-dotall --no-filename --no-heading --no-hidden --no-ignore --no-ignore-parent --no-ignore-vcs --no-line-number --null --null-data --one-file-system --only-matching --passthru --pcre2 --pretty --quiet --smart-case --stats --text --trim --unrestricted --with-filename --word-regexp",
    ),
    longValues: set(
      "--after-context --before-context --context --dfa-size-limit --encoding --engine --file --glob --iglob --max-columns --max-count --max-depth --path-separator --regexp --regex-size-limit --replace --sort --sortr --threads --type --type-add --type-clear --type-not",
    ),
    longOptionalValues: set("--color"),
  },
  grep: {
    shortFlags: "EFGHIPRTUVabcdhLlnqrsuvwxyZz",
    shortValues: "ABCDefm",
    longFlags: set(
      "--basic-regexp --binary-files-without-match --byte-offset --count --extended-regexp --files-with-matches --files-without-match --fixed-regexp --fixed-strings --help --ignore-case --initial-tab --invert-match --line-buffered --line-number --line-regexp --null --null-data --only-matching --perl-regexp --quiet --recursive --silent --unix-byte-offsets --version --with-filename --word-regexp",
    ),
    longValues: set(
      "--after-context --before-context --binary-files --context --devices --directories --exclude --exclude-dir --exclude-from --file --include --label --max-count --regexp",
    ),
    longOptionalValues: set("--color"),
  },
  head: {
    shortFlags: "qvz",
    shortValues: "cn",
    longFlags: set("--help --quiet --verbose --version --zero-terminated"),
    longValues: set("--bytes --lines"),
  },
  tail: {
    shortFlags: "Fqsvz",
    shortValues: "cn",
    longFlags: set("--help --quiet --retry --silent --verbose --version --zero-terminated"),
    longValues: set("--bytes --lines --max-unchanged-stats --pid --sleep-interval"),
    longOptionalValues: set("--follow"),
  },
  wc: {
    shortFlags: "cLlmw",
    longFlags: set("--bytes --chars --help --lines --max-line-length --version --words"),
    longValues: set("--files0-from"),
  },
  ls: {
    shortFlags: "ABCDFGHILNQRSTUXZabcdfghiklmnopqrstuvwxy",
    shortValues: "ITw",
    longFlags: set(
      "--all --almost-all --author --classify --dereference --directory --dired --file-type --group-directories-first --help --hide-control-chars --human-readable --ignore-backups --inode --kibibytes --literal --no-group --numeric-uid-gid --quote-name --recursive --reverse --show-control-chars --size --version",
    ),
    longValues: set(
      "--block-size --format --hide --ignore --indicator-style --quoting-style --sort --tabsize --time --time-style --width",
    ),
    longOptionalValues: set("--color --hyperlink"),
  },
};

const GIT_INSPECTION_OPTIONS: OptionSpec = {
  shortFlags: "abcdfhiklmnprstuvwz",
  shortValues: "ABCGLMSU",
  longFlags: set(
    "--abbrev-commit --all --binary --branches --cached --check --children --date-order --deduplicate --deleted --error-unmatch --exclude-standard --exit-code --files-with-matches --full-history --full-index --full-name --graph --heading --ignore-all-space --ignore-blank-lines --ignore-space-at-eol --ignore-space-change --ignored --is-bare-repository --is-inside-git-dir --is-inside-work-tree --killed --left-only --line-number --merge-base --merges --modified --name-only --name-status --no-abbrev-commit --no-color --no-decorate --no-ext-diff --no-renames --no-textconv --numstat --objects --oneline --others --patch --quiet --remotes --right-only --root --short --shortstat --show-current --show-toplevel --stage --staged --stat --summary --symbolic-full-name --tags --topo-order --unmerged --verify --zero-commit",
  ),
  longValues: set(
    "--after --author --before --committer --date --decorate-refs-exclude --diff-filter --exclude --format --git-path --grep --max-count --max-depth --max-parents --min-parents --object-format --path-format --pretty --since --skip --sort --until",
  ),
  longOptionalValues: set(
    "--abbrev --batch --batch-check --color --decorate --relative --word-diff",
  ),
};

const GIT_METADATA_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  add: {
    shortFlags: "Afnpuv",
    longFlags: set(
      "--all --dry-run --force --ignore-errors --ignore-missing --intent-to-add --no-all --no-ignore-removal --pathspec-file-nul --refresh --renormalize --sparse --update --verbose",
    ),
    longValues: set("--chmod --pathspec-from-file"),
  },
  commit: {
    shortFlags: "anqsu",
    shortValues: "CFm",
    longFlags: set(
      "--all --allow-empty --allow-empty-message --amend --branch --dry-run --include --long --no-edit --no-post-rewrite --no-status --no-verify --null --only --pathspec-file-nul --porcelain --reset-author --short --signoff --status",
    ),
    longValues: set(
      "--author --cleanup --date --file --fixup --message --pathspec-from-file --reuse-message --squash --trailer --untracked-files",
    ),
  },
  push: {
    shortFlags: "fquv",
    longFlags: set(
      "--all --atomic --delete --dry-run --follow-tags --force --force-if-includes --mirror --no-verify --porcelain --prune --quiet --set-upstream --tags --verbose",
    ),
    longValues: set("--push-option --recurse-submodules"),
    longOptionalValues: set("--force-with-lease"),
  },
  branch: {
    shortFlags: "adfMmrqv",
    longFlags: set(
      "--all --copy --delete --force --ignore-case --list --merged --move --no-color --no-contains --no-merged --remotes --show-current --verbose",
    ),
    longValues: set("--contains --format --points-at --sort"),
    longOptionalValues: set("--color --column --track"),
  },
  "update-index": {
    shortFlags: "q",
    longFlags: set(
      "--add --again --assume-unchanged --force-remove --fsmonitor-valid --ignore-missing --index-info --info-only --no-assume-unchanged --no-fsmonitor-valid --refresh --remove --replace --skip-worktree --unresolve",
    ),
    longValues: set("--cacheinfo --chmod --index-version"),
  },
};

const GH_PR_OPTIONS: Readonly<Record<string, OptionSpec>> = {
  view: {
    longFlags: set("--comments"),
    longValues: set("--jq --json --template"),
  },
  list: {
    longFlags: set("--draft"),
    longValues: set(
      "--app --assignee --author --base --head --jq --json --label --limit --search --state --template",
    ),
  },
  status: {},
  checks: {
    longFlags: set("--fail-fast --required --watch"),
    longValues: set("--interval --jq --json --template"),
  },
  diff: {
    longFlags: set("--name-only --patch"),
    longValues: set("--color"),
  },
  create: {
    longFlags: set("--draft --fill --fill-first --fill-verbose --no-maintainer-edit"),
    longValues: set(
      "--assignee --base --body --body-file --head --label --milestone --project --recover --reviewer --template --title",
    ),
  },
  edit: {
    longValues: set(
      "--add-assignee --add-label --add-project --add-reviewer --base --body --body-file --milestone --remove-assignee --remove-label --remove-milestone --remove-project --remove-reviewer --title",
    ),
  },
  close: {
    longValues: set("--comment"),
  },
  reopen: {
    longValues: set("--comment"),
  },
  ready: {
    longFlags: set("--undo"),
  },
  review: {
    longFlags: set("--approve --comment --request-changes"),
    longValues: set("--body --body-file"),
  },
  merge: {
    shortFlags: "mdrs",
    longFlags: set("--admin --auto --disable-auto --merge --rebase --squash"),
    longValues: set("--author-email --body --body-file --match-head-commit --subject"),
  },
  comment: {
    longFlags: set("--delete-last --edit-last"),
    longValues: set("--body --body-file"),
  },
  lock: {
    longValues: set("--reason"),
  },
  unlock: {},
};
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
function parseOptions(args: string[], spec: OptionSpec): ParsedOptions | undefined {
  const result: ParsedOptions = {
    operands: [],
    seen: new Set(),
    values: new Map(),
  };
  let optionsEnded = false;
  const recordValue = (option: string, value: string) => {
    result.seen.add(option);
    result.values.set(option, [...(result.values.get(option) ?? []), value]);
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (optionsEnded || arg === "-" || !arg.startsWith("-")) {
      result.operands.push(arg);
      continue;
    }
    if (arg === "--") {
      optionsEnded = true;
      continue;
    }
    if (arg.startsWith("--")) {
      const separator = arg.indexOf("=");
      const option = separator === -1 ? arg : arg.slice(0, separator);
      const attached = separator === -1 ? undefined : arg.slice(separator + 1);
      if (spec.longValues?.has(option)) {
        const value = attached ?? args[++index];
        if (!value) return;
        recordValue(option, value);
      } else if (spec.longOptionalValues?.has(option)) {
        result.seen.add(option);
        if (attached !== undefined) recordValue(option, attached);
      } else if (spec.longFlags?.has(option) && attached === undefined) {
        result.seen.add(option);
      } else {
        return;
      }
      continue;
    }
    for (let offset = 1; offset < arg.length; offset += 1) {
      const option = `-${arg[offset]}`;
      if (spec.shortValues?.includes(arg[offset])) {
        const attached = arg.slice(offset + 1);
        const value = attached || args[++index];
        if (!value) return;
        recordValue(option, value);
        break;
      }
      if (!spec.shortFlags?.includes(arg[offset])) return;
      result.seen.add(option);
    }
  }
  return result;
}
function staticArgs(words: Word[]): string[] | undefined {
  const args: string[] = [];
  for (const word of words) {
    const value = staticWord(word);
    if (value === undefined) return;
    args.push(value);
  }
  return args;
}
function safeSedProgram(program: string): boolean {
  if (
    /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?[dDpPqQnN=]$/.test(program) ||
    /^\/(?:\\.|[^/])*\/[dDpPqQnN=]$/.test(program)
  )
    return true;
  const match = /^(?:(?:\d+|\$)(?:,(?:\d+|\$))?)?s(.)(.*)$/s.exec(program);
  if (!match || /[\\\nA-Za-z0-9]/.test(match[1])) return false;
  const delimiter = match[1];
  const tail = match[2];
  let offset = 0;
  for (let section = 0; section < 2; section += 1) {
    let closed = false;
    while (offset < tail.length) {
      if (tail[offset] === "\\") {
        offset += 2;
      } else if (tail[offset] === delimiter) {
        offset += 1;
        closed = true;
        break;
      } else {
        offset += 1;
      }
    }
    if (!closed) return false;
  }
  return /^[0-9gIpMm]*$/.test(tail.slice(offset));
}
function safeSed(args: string[]): boolean {
  if (args.length === 1 && INFO_OPTIONS.has(args[0])) return true;
  const parsed = parseOptions(args, {
    shortFlags: "Enrsu",
    shortValues: "e",
    longFlags: set("--quiet --regexp-extended --separate --silent --unbuffered"),
    longValues: set("--expression"),
  });
  if (!parsed) return false;
  const optionPrograms = [
    ...(parsed.values.get("-e") ?? []),
    ...(parsed.values.get("--expression") ?? []),
  ];
  const programs =
    optionPrograms.length > 0
      ? optionPrograms
      : parsed.operands.length > 0
        ? [parsed.operands.shift() as string]
        : [];
  return programs.length > 0 && programs.every(safeSedProgram);
}
function safeFind(args: string[]): boolean {
  if (args.length === 1 && INFO_OPTIONS.has(args[0])) return true;
  const noValue = set(
    "! ( ) -a -and -daystart -empty -executable -false -follow -ignore_readdir_race -ls -mount -noignore_readdir_race -not -o -or -print -print0 -prune -readable -true -writable -xdev",
  );
  const oneValue = set(
    "-amin -anewer -atime -cmin -cnewer -ctime -fstype -gid -group -ilname -iname -inum -ipath -iregex -iwholename -links -lname -maxdepth -mindepth -mmin -mtime -name -newer -path -perm -printf -regex -regextype -samefile -size -type -uid -used -user -wholename -xtype",
  );
  let expressionStarted = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!expressionStarted && (arg === "-H" || arg === "-L" || arg === "-P" || /^-O\d+$/.test(arg)))
      continue;
    if (!expressionStarted && !arg.startsWith("-") && arg !== "!" && arg !== "(") continue;
    expressionStarted = true;
    if (noValue.has(arg)) continue;
    if (/^-newer(?:a|B|c|m)t$/.test(arg) || /^-newer[acm][acm]$/.test(arg) || oneValue.has(arg)) {
      if (!args[++index]) return false;
      continue;
    }
    return false;
  }
  return true;
}
function withLongOptions(spec: OptionSpec, flags: string, values: string): OptionSpec {
  return {
    ...spec,
    longFlags: new Set([...(spec.longFlags ?? []), ...flags.split(" ").filter(Boolean)]),
    longValues: new Set([...(spec.longValues ?? []), ...values.split(" ").filter(Boolean)]),
  };
}
function safeGit(args: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "--no-pager" || arg === "--paginate") {
      index += 1;
    } else if (arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      if (!args[index + 1]) return false;
      index += 2;
    } else if (arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      if (!arg.slice(arg.indexOf("=") + 1)) return false;
      index += 1;
    } else {
      break;
    }
  }
  const subcommand = args[index++];
  if (!subcommand) return args.length === 1 && INFO_OPTIONS.has(args[0]);
  const rest = args.slice(index);
  if (
    new Set([
      "blame",
      "cat-file",
      "describe",
      "diff",
      "for-each-ref",
      "grep",
      "log",
      "ls-files",
      "ls-tree",
      "merge-base",
      "name-rev",
      "rev-list",
      "rev-parse",
      "shortlog",
      "show",
      "status",
    ]).has(subcommand)
  )
    return parseOptions(rest, GIT_INSPECTION_OPTIONS) !== undefined;
  const metadata = GIT_METADATA_OPTIONS[subcommand];
  if (metadata) {
    const parsed = parseOptions(rest, metadata);
    if (!parsed) return false;
    if (subcommand !== "commit") return true;
    return [
      "-C",
      "-F",
      "-m",
      "--dry-run",
      "--file",
      "--message",
      "--no-edit",
      "--reuse-message",
    ].some((option) => parsed.seen.has(option));
  }
  if (subcommand === "reset") {
    const parsed = parseOptions(rest, {
      shortFlags: "Npq",
      longFlags: set("--intent-to-add --mixed --no-refresh --pathspec-file-nul --quiet --soft"),
      longValues: set("--pathspec-from-file"),
    });
    return parsed !== undefined;
  }
  if (subcommand === "restore") {
    const parsed = parseOptions(rest, {
      shortFlags: "pq",
      longFlags: set(
        "--ignore-skip-worktree-bits --no-overlay --overlay --pathspec-file-nul --staged",
      ),
      longValues: set("--pathspec-from-file --source"),
    });
    return parsed?.seen.has("--staged") === true;
  }
  if (subcommand === "rm") {
    const parsed = parseOptions(rest, {
      shortFlags: "fnqr",
      longFlags: set(
        "--cached --dry-run --force --ignore-unmatch --pathspec-file-nul --quiet --recursive",
      ),
      longValues: set("--pathspec-from-file"),
    });
    return parsed?.seen.has("--cached") === true;
  }
  if (subcommand === "update-ref")
    return (
      parseOptions(rest, {
        shortFlags: "d",
        longFlags: set("--create-reflog --delete --no-deref --stdin"),
        longValues: set("--reason"),
      }) !== undefined
    );
  return false;
}
function safeGh(args: string[]): boolean {
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === "-R" || arg === "--repo" || arg === "--hostname") {
      if (!args[index + 1]) return false;
      index += 2;
    } else if (arg.startsWith("--repo=") || arg.startsWith("--hostname=")) {
      if (!arg.slice(arg.indexOf("=") + 1)) return false;
      index += 1;
    } else {
      break;
    }
  }
  if (args[index++] !== "pr") return false;
  const subcommand = args[index++];
  if (!subcommand) return args.length === index && args.at(-1) === "--help";
  const spec = GH_PR_OPTIONS[subcommand];
  if (!spec) return false;
  const common = withLongOptions(spec, "--help", "--hostname --repo");
  const parsed = parseOptions(args.slice(index), {
    ...common,
    shortValues: `${common.shortValues ?? ""}R`,
  });
  if (!parsed) return false;
  if (subcommand === "create") {
    const filled = ["--fill", "--fill-first", "--fill-verbose", "--recover"].some((option) =>
      parsed.seen.has(option),
    );
    return (
      filled ||
      (parsed.seen.has("--title") && (parsed.seen.has("--body") || parsed.seen.has("--body-file")))
    );
  }
  if (subcommand === "comment" && parsed.seen.has("--edit-last"))
    return parsed.seen.has("--body") || parsed.seen.has("--body-file");
  if (subcommand === "merge")
    return ["--disable-auto", "--merge", "--rebase", "--squash", "-m", "-r", "-s"].some((option) =>
      parsed.seen.has(option),
    );
  return true;
}
function knownNoWorktreeMutation(name: string, args: string[]): boolean {
  const options = COMMAND_OPTIONS[name];
  if (options)
    return (
      (args.length === 1 && INFO_OPTIONS.has(args[0])) || parseOptions(args, options) !== undefined
    );
  if (name === "sed") return safeSed(args);
  if (name === "find") return safeFind(args);
  if (name === "git") return safeGit(args);
  if (name === "gh") return safeGh(args);
  return false;
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
function visitApplyPatch(command: Command, state: State): void {
  state.mutation = true;
  state.definiteEdit = true;
  let hasBody = false;
  if (command.suffix.length > 0) state.complete = false;
  for (const redirect of command.redirects) {
    if (redirect.operator !== "<<") {
      visitRedirect(redirect, state);
      continue;
    }
    if (typeof redirect.content !== "string") {
      state.complete = false;
      continue;
    }
    hasBody = true;
    if (redirect.heredocQuoted !== true && redirect.body !== undefined) {
      state.complete = false;
      continue;
    }
    const targets = parseApplyPatchTargets(redirect.content);
    for (const path of targets.paths) state.paths.add(path);
    if (!targets.complete) state.complete = false;
  }
  if (!hasBody) state.complete = false;
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
  const name = staticWord(command.name);
  // unbash preserves tabs in `<<-` bodies, so leave those on the conservative
  // generic path rather than treating their apparent patch headers as exact.
  const literalApplyPatch =
    name === "apply_patch" && !command.redirects.some((redirect) => redirect.operator === "<<-");
  if (literalApplyPatch) {
    visitApplyPatch(command, state);
  } else {
    for (const redirect of command.redirects) visitRedirect(redirect, state);
  }
  if (
    !name ||
    name.includes("/") ||
    (!literalApplyPatch && command.suffix.some((word) => !staticWord(word)))
  ) {
    unknown(state);
  } else if (literalApplyPatch) {
    // visitApplyPatch handles its heredoc payload and deliberately marks
    // argv-delivered forms incomplete.
  } else if (
    !READ_ONLY_COMMANDS.has(name) &&
    !knownNoWorktreeMutation(name, staticArgs(command.suffix) as string[])
  ) {
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
    const state: State = {
      paths: new Set(),
      complete: !script.errors?.length,
      mutation: false,
      definiteEdit: false,
    };
    for (const statement of script.commands) visitStatement(statement, state);
    if (script.errors?.length) state.mutation = true;
    return {
      paths: [...state.paths],
      coverage: state.complete ? ("complete" as const) : ("unverified" as const),
      mutation: state.mutation ? ("present" as const) : ("none" as const),
      ...(state.definiteEdit ? { definiteEdit: true as const } : {}),
    };
  } catch {
    return { paths: [], coverage: "unverified" as const, mutation: "present" as const };
  }
}
