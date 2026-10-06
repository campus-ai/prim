import { execFileSync } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { packageVersion, pinnedNpxCommand } from "./bin-path.js";
import { primConfigDirectory } from "./paths.js";
import {
  PRIM_POST_COMMIT_BLOCK_END,
  PRIM_POST_COMMIT_BLOCK_START,
  ensureEffectivePostCommitHook,
  ensurePostCommitHookAtPath,
  gitHookScript,
  gitHookScriptPath,
  inspectEffectivePostCommitHook,
  managedHookBlock,
  postCommitHookBlock,
  resolveEffectivePostCommitHook,
  uninstallEffectivePostCommitHook,
  uninstallProjectPostCommitHook,
  writeGitHookScripts,
} from "./post-commit-hook.js";

const roots: string[] = [];
const PINNED_INVOCATION =
  "{ if [ -x '/opt/prim/node' ] && [ -f '/opt/prim/dist/hooks/post-commit.js' ]; then '/opt/prim/node' '/opt/prim/dist/hooks/post-commit.js'; else npx --yes -p @primitive.ai/prim@0.1.0-alpha.60 prim-post-commit; fi; } || true";
const HUSKY_V9_H = `#!/usr/bin/env sh
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

if [ -f "$HOME/.huskyrc" ]; then
\techo "husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh"
fi
i="\${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "\${HUSKY-}" = "0" ] && exit 0

export PATH="node_modules/.bin:$PATH"
sh -e "$s" "$@"
c=$?

[ $c != 0 ] && echo "husky - $n script failed (code $c)"
[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
exit $c
`;
const HUSKY_V9_1_0_H = `#!/usr/bin/env sh
# shellcheck disable=SC1090
[ "$HUSKY" = "2" ] && set -x
n=$(basename "$0")
s=$(dirname "$(dirname "$0")")/$n

[ ! -f "$s" ] && exit 0

if [ -f "$HOME/.huskyrc" ]; then
\techo "husky - '~/.huskyrc' is DEPRECATED, please move your code to ~/.config/husky/init.sh"
fi
i="\${XDG_CONFIG_HOME:-$HOME/.config}/husky/init.sh"
[ -f "$i" ] && . "$i"

[ "\${HUSKY-}" = "0" ] && exit 0

c=0
h() {
\t[ $c = 0 ] && return
\t[ $c != 0 ] && echo "husky - $n script failed (code $c)"
\t[ $c = 127 ] && echo "husky - command not found in PATH=$PATH"
\texit 1
}
trap 'c=$?; h' EXIT
set -e
PATH=node_modules/.bin:$PATH
. "$s"`;

function temp(name: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), `prim-${name}-`)));
  roots.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(name: string): string {
  const root = temp(name);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Prim Test");
  git(root, "config", "user.email", "prim@example.test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

// The block a release before git-hook scripts inlined (version-pinned).
const LEGACY_INLINE_BLOCK = `${PRIM_POST_COMMIT_BLOCK_START}
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
  npx --yes --ignore-scripts -p @primitive.ai/prim@0.1.0-alpha.93 prim-post-commit
fi
${PRIM_POST_COMMIT_BLOCK_END}`;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  vi.stubEnv("PRIM_CONFIG_DIR", temp("config"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("effective post-commit hook", () => {
  it("resolves and installs the normal Git hooks directory", () => {
    const root = repository("normal");
    const result = ensureEffectivePostCommitHook(root);
    expect(result.path).toBe(join(root, ".git", "hooks", "post-commit"));
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: true,
      executable: true,
      current: true,
      kind: "direct",
    });
  });

  it("honors repository-local relative and absolute core.hooksPath overrides", () => {
    const relativeRoot = repository("relative");
    git(relativeRoot, "config", "--local", "core.hooksPath", "custom-hooks");
    expect(ensureEffectivePostCommitHook(relativeRoot).path).toBe(
      join(relativeRoot, "custom-hooks", "post-commit"),
    );

    const absoluteRoot = repository("absolute");
    const absoluteHooks = temp("absolute-hooks");
    git(absoluteRoot, "config", "--local", "core.hooksPath", absoluteHooks);
    expect(ensureEffectivePostCommitHook(absoluteRoot).path).toBe(
      join(absoluteHooks, "post-commit"),
    );
  });

  it("uses Git's linked-worktree hook path", () => {
    const root = repository("main-worktree");
    writeFileSync(join(root, "README.md"), "worktree\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "root");
    const linked = temp("linked-worktree");
    rmSync(linked, { recursive: true });
    git(root, "worktree", "add", "-qb", "linked-test", linked);

    const expectedHooks = git(linked, "rev-parse", "--git-path", "hooks");
    const result = ensureEffectivePostCommitHook(linked);
    expect(result.path).toBe(join(expectedHooks, "post-commit"));
    expect(inspectEffectivePostCommitHook(linked).covered).toBe(true);
  });

  it("maps Husky v9 dispatchers to the public tracked hook without editing generated files", () => {
    const root = repository("husky");
    const generated = join(root, ".husky", "_", "post-commit");
    mkdirSync(join(root, ".husky", "_"), { recursive: true });
    writeFileSync(generated, '#!/bin/sh\nexec sh "$(dirname "$0")/../post-commit"\n', {
      mode: 0o755,
    });
    const originalDispatcher = readFileSync(generated);
    git(root, "config", "--local", "core.hooksPath", ".husky/_");

    const resolved = resolveEffectivePostCommitHook(root);
    expect(resolved).toMatchObject({
      kind: "husky_v9",
      hookPath: join(root, ".husky", "post-commit"),
      dispatcherPath: generated,
    });
    ensureEffectivePostCommitHook(root);
    expect(readFileSync(generated)).toEqual(originalDispatcher);
    expect(readFileSync(join(root, ".husky", "post-commit"), "utf8")).toContain(
      PRIM_POST_COMMIT_BLOCK_START,
    );

    chmodSync(join(root, ".husky", "post-commit"), 0o644);
    expect(() => ensureEffectivePostCommitHook(root)).not.toThrow();
    expect(lstatSync(join(root, ".husky", "post-commit")).mode & 0o777).toBe(0o644);
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: true,
      executable: true,
      kind: "husky_v9",
    });
  });

  it("recognizes the shipped Husky v9 dispatcher only when its runtime delegates publicly", () => {
    const root = repository("husky-v9");
    const generatedDir = join(root, ".husky", "_");
    const generated = join(generatedDir, "post-commit");
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(generated, '#!/usr/bin/env sh\n. "$(dirname "$0")/h"', { mode: 0o755 });
    writeFileSync(join(generatedDir, "h"), HUSKY_V9_H, { mode: 0o755 });
    writeFileSync(join(root, ".husky", "post-commit"), "printf 'foreign husky\\n'\n", {
      mode: 0o644,
    });
    git(root, "config", "--local", "core.hooksPath", ".husky/_");

    expect(() => ensureEffectivePostCommitHook(root)).not.toThrow();
    expect(readFileSync(join(root, ".husky", "post-commit"), "utf8")).toBe(
      `printf 'foreign husky\\n'\n${postCommitHookBlock()}\n`,
    );
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: true,
      kind: "husky_v9",
    });

    writeFileSync(join(generatedDir, "h"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    expect(() => ensureEffectivePostCommitHook(root)).toThrow(/unrecognized Husky v9/);
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: false,
      reason: "husky_dispatcher_invalid",
    });
  });

  it("recognizes the earlier Husky v9 dispatcher and runtime", () => {
    const root = repository("husky-v9-legacy");
    const generatedDir = join(root, ".husky", "_");
    mkdirSync(generatedDir, { recursive: true });
    writeFileSync(join(generatedDir, "post-commit"), '#!/usr/bin/env sh\n. "${0%/*}/h"', {
      mode: 0o755,
    });
    writeFileSync(join(generatedDir, "h"), HUSKY_V9_1_0_H, { mode: 0o755 });
    git(root, "config", "--local", "core.hooksPath", ".husky/_");

    expect(() => ensureEffectivePostCommitHook(root)).not.toThrow();
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: true,
      kind: "husky_v9",
    });
  });

  it.each(["", "#!/bin/sh\nexit 0\n"])(
    "rejects an executable Husky dispatcher that does not delegate (%s)",
    (dispatcher) => {
      const root = repository("husky-invalid");
      const generatedDir = join(root, ".husky", "_");
      mkdirSync(generatedDir, { recursive: true });
      writeFileSync(join(generatedDir, "post-commit"), dispatcher, { mode: 0o755 });
      git(root, "config", "--local", "core.hooksPath", ".husky/_");

      expect(() => ensureEffectivePostCommitHook(root)).toThrow(/Husky/);
      expect(inspectEffectivePostCommitHook(root)).toMatchObject({
        covered: false,
        reason: "husky_dispatcher_invalid",
      });
    },
  );

  it("preserves foreign bytes and modes while refreshing only Prim's marked block", () => {
    const root = repository("preserve");
    const path = join(root, ".git", "hooks", "post-commit");
    const foreign = Buffer.from("#!/bin/sh\nprintf 'foreign\\n'\r\n");
    writeFileSync(path, foreign, { mode: 0o740 });
    ensureEffectivePostCommitHook(root);
    const installed = readFileSync(path);
    expect(
      Buffer.from(installed.toString("utf8").replace(`${postCommitHookBlock()}\n`, "")),
    ).toEqual(foreign);
    expect(lstatSync(path).mode & 0o777).toBe(0o740);

    const stale = installed.toString("utf8").replace(postCommitHookBlock(), LEGACY_INLINE_BLOCK);
    writeFileSync(path, stale, { mode: 0o740 });
    ensureEffectivePostCommitHook(root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed).toBe(installed.toString("utf8"));
    expect(refreshed.replace(`${postCommitHookBlock()}\n`, "")).toBe(foreign.toString("utf8"));
  });

  it("replaces a pre-script inline block once, in place, then never rewrites it", () => {
    const root = repository("migrate-inline");
    const path = join(root, ".git", "hooks", "post-commit");
    const head = "#!/bin/sh\n";
    const tail = "printf 'foreign tail\\n'\n";
    writeFileSync(path, `${head}${LEGACY_INLINE_BLOCK}\n${tail}`, { mode: 0o755 });
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: false,
      reason: "stale_block",
    });

    expect(ensureEffectivePostCommitHook(root).changed).toBe(true);
    const migrated = readFileSync(path, "utf8");
    expect(migrated).toBe(`${head}${postCommitHookBlock()}\n${tail}`);
    expect(ensureEffectivePostCommitHook(root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(migrated);
  });

  it("rejects malformed markers, binary files, symlinks, and missing Husky dispatchers", () => {
    const malformed = repository("malformed");
    const malformedPath = join(malformed, ".git", "hooks", "post-commit");
    writeFileSync(malformedPath, `#!/bin/sh\n${PRIM_POST_COMMIT_BLOCK_START}\n`, { mode: 0o755 });
    expect(() => ensureEffectivePostCommitHook(malformed)).toThrow(/malformed/);

    const binary = repository("binary");
    writeFileSync(join(binary, ".git", "hooks", "post-commit"), Buffer.from([35, 0, 10]), {
      mode: 0o755,
    });
    expect(() => ensureEffectivePostCommitHook(binary)).toThrow(/binary/);

    const linked = repository("symlink");
    const outside = temp("outside-hook");
    const destination = join(outside, "post-commit");
    writeFileSync(destination, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(destination, join(linked, ".git", "hooks", "post-commit"));
    expect(() => ensureEffectivePostCommitHook(linked)).toThrow(/unsafe/);

    const husky = repository("missing-dispatcher");
    mkdirSync(join(husky, ".husky", "_"), { recursive: true });
    git(husky, "config", "--local", "core.hooksPath", ".husky/_");
    expect(() => ensureEffectivePostCommitHook(husky)).toThrow(/dispatcher/);
  });

  it("does not chmod or edit a non-executable foreign direct hook", () => {
    const root = repository("non-executable");
    const path = join(root, ".git", "hooks", "post-commit");
    const foreign = Buffer.from("#!/bin/sh\nprintf foreign\n");
    writeFileSync(path, foreign, { mode: 0o640 });
    expect(() => ensureEffectivePostCommitHook(root)).toThrow(/not executable/);
    expect(readFileSync(path)).toEqual(foreign);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
  });

  it("refuses to modify an executable hook with an unsupported interpreter", () => {
    const root = repository("foreign-unreachable");
    const path = join(root, ".git", "hooks", "post-commit");
    const source = "#!/usr/bin/env python3\nprint('foreign')\n";
    writeFileSync(path, source, { mode: 0o755 });

    expect(() => ensureEffectivePostCommitHook(root)).toThrow(/unsupported/);
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it.each([
    ["exit", "#!/bin/sh\nprintf foreign\nexit 0\n"],
    ["exec", '#!/bin/sh\nexec other-hook "$@"\n'],
    ["no trailing newline", "#!/bin/sh\nprintf foreign"],
  ])("appends after foreign content (%s) and uninstalls cleanly", (_label, source) => {
    const root = repository("foreign-append");
    const path = join(root, ".git", "hooks", "post-commit");
    writeFileSync(path, source, { mode: 0o755 });

    ensureEffectivePostCommitHook(root);
    const separator = source.endsWith("\n") ? "" : "\n";
    expect(readFileSync(path, "utf8")).toBe(`${source}${separator}${postCommitHookBlock()}\n`);
    expect(inspectEffectivePostCommitHook(root).covered).toBe(true);

    uninstallEffectivePostCommitHook(root);
    expect(readFileSync(path, "utf8")).toBe(`${source}${separator}`);
  });

  it("accepts a current block anywhere and never moves it", () => {
    const root = repository("late-block");
    const path = join(root, ".git", "hooks", "post-commit");
    const content = `#!/bin/sh\nprintf foreign\n${postCommitHookBlock()}\nprintf after\n`;
    writeFileSync(path, content, { mode: 0o755 });
    writeGitHookScripts();

    expect(inspectEffectivePostCommitHook(root).covered).toBe(true);
    expect(ensureEffectivePostCommitHook(root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("leaves hook files untouched and reports manual under prim.gitHooks=manual", () => {
    const root = repository("manual");
    const path = join(root, ".git", "hooks", "post-commit");
    const source = "#!/bin/sh\nprintf foreign\n";
    writeFileSync(path, source, { mode: 0o755 });
    git(root, "config", "--local", "prim.gitHooks", "manual");

    expect(ensureEffectivePostCommitHook(root)).toMatchObject({ changed: false, manual: true });
    expect(readFileSync(path, "utf8")).toBe(source);
    expect(readFileSync(gitHookScriptPath("post-commit"), "utf8")).toBe(
      gitHookScript("post-commit"),
    );
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: false,
      reason: "manual",
    });
  });

  it("reports script_missing when the sourced script is absent", () => {
    const root = repository("script-missing");
    ensureEffectivePostCommitHook(root);
    expect(inspectEffectivePostCommitHook(root).covered).toBe(true);
    rmSync(gitHookScriptPath("post-commit"));
    expect(inspectEffectivePostCommitHook(root)).toMatchObject({
      covered: false,
      reason: "script_missing",
    });
  });

  it("publishes rewrites atomically without leaving temporary files", () => {
    const root = repository("atomic");
    const hooks = join(root, ".git", "hooks");
    const path = join(hooks, "post-commit");
    writeFileSync(path, "#!/bin/sh\nprintf foreign\n", { mode: 0o751 });

    ensureEffectivePostCommitHook(root);

    expect(readFileSync(path, "utf8")).toContain("printf foreign");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);
    expect(readdirSync(hooks).filter((name) => name.includes(".prim-"))).toEqual([]);
  });

  it("uses a trusted owned scaffold only on creation and preserves later foreign bytes", () => {
    const hooks = temp("owned-initial");
    const path = join(hooks, "post-commit");
    const initial = `#!/bin/sh
${postCommitHookBlock()}
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
`;
    ensurePostCommitHookAtPath(path, initial);
    expect(readFileSync(path, "utf8")).toBe(initial);

    writeFileSync(path, `${initial}printf 'foreign tail\\n'\n`, { mode: 0o750 });
    chmodSync(path, 0o750);
    ensurePostCommitHookAtPath(path, `${initial}printf 'replacement\\n'\n`);
    expect(readFileSync(path, "utf8")).toBe(`${initial}printf 'foreign tail\\n'\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o750);
  });

  it("snapshots rapid sequential commits before launching background capture", async () => {
    const root = repository("rapid-commits");
    const cacheRoot = temp("rapid-cache");
    const observedRoot = temp("rapid-observed");
    const bin = join(cacheRoot, "prim", "bin");
    const output = join(temp("rapid-output"), "captures");
    const capture = join(bin, "capture.sh");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "node"), "/bin/sh\n");
    writeFileSync(join(bin, "prim-post-commit"), `${capture}\n`);
    writeFileSync(
      capture,
      `files=$(git diff-tree --no-commit-id --name-only -r --root "$PRIM_COMMIT_SHA")
marker=missing
if [ -f "$PRIM_COMMIT_OBSERVED_FILE" ]; then marker=present; fi
printf '%s|%s|%s\\n' "$PRIM_COMMIT_SHA" "$files" "$marker" >> "$PRIM_CAPTURE_OUTPUT"
`,
    );
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    vi.stubEnv("TMPDIR", observedRoot);
    vi.stubEnv("PRIM_CAPTURE_OUTPUT", output);
    git(root, "config", "--local", "prim.active", "true");
    ensureEffectivePostCommitHook(root);

    writeFileSync(join(root, "first.ts"), "first\n");
    git(root, "add", "first.ts");
    git(root, "commit", "-qm", "first");
    const firstSha = git(root, "rev-parse", "HEAD");
    writeFileSync(join(root, "second.ts"), "second\n");
    git(root, "add", "second.ts");
    git(root, "commit", "-qm", "second");
    const secondSha = git(root, "rev-parse", "HEAD");

    let lines: string[] = [];
    await vi.waitFor(
      () => {
        try {
          lines = readFileSync(output, "utf8").trim().split("\n");
        } catch {
          lines = [];
        }
        expect(lines).toHaveLength(2);
      },
      { timeout: 5_000, interval: 20 },
    );
    expect(lines.sort()).toEqual(
      [`${firstSha}|first.ts|present`, `${secondSha}|second.ts|present`].sort(),
    );
    await vi.waitFor(() => expect(readdirSync(observedRoot)).toEqual([]), {
      timeout: 5_000,
      interval: 20,
    });
  });

  it("uninstall removes only the marked block or a proven Prim-created file", () => {
    const created = repository("uninstall-created");
    const createdPath = ensureEffectivePostCommitHook(created).path;
    expect(uninstallEffectivePostCommitHook(created)).toMatchObject({
      changed: true,
      removedFile: true,
    });
    expect(() => lstatSync(createdPath)).toThrow();

    const foreign = repository("uninstall-foreign");
    const foreignPath = join(foreign, ".git", "hooks", "post-commit");
    const bytes = Buffer.from("#!/bin/sh\nprintf foreign\n");
    writeFileSync(
      foreignPath,
      Buffer.concat([bytes, Buffer.from(`\n${postCommitHookBlock()}\n`)]),
      { mode: 0o750 },
    );
    expect(uninstallEffectivePostCommitHook(foreign)).toMatchObject({
      changed: true,
      removedFile: false,
    });
    expect(readFileSync(foreignPath).subarray(0, bytes.length)).toEqual(bytes);
    expect(readFileSync(foreignPath, "utf8")).not.toContain(PRIM_POST_COMMIT_BLOCK_END);
  });

  it("project uninstall preserves an inherited global hook and removes only the chained repo hook", () => {
    const root = repository("uninstall-inherited-global");
    const globalConfig = join(temp("global-config"), "config");
    const globalHooks = temp("global-hooks");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    writeFileSync(globalConfig, "");
    git(root, "config", "--global", "core.hooksPath", globalHooks);
    const globalPath = join(globalHooks, "post-commit");
    const projectPath = join(root, ".git", "hooks", "post-commit");
    ensurePostCommitHookAtPath(globalPath);
    ensurePostCommitHookAtPath(projectPath);
    const globalBefore = readFileSync(globalPath);

    expect(resolveEffectivePostCommitHook(root).hookPath).toBe(globalPath);
    expect(uninstallProjectPostCommitHook(root)).toMatchObject({
      path: projectPath,
      changed: true,
      removedFile: true,
    });
    expect(readFileSync(globalPath)).toEqual(globalBefore);
    expect(() => lstatSync(projectPath)).toThrow();
  });

  it("replaces and uninstalls the exact legacy Prim-owned scaffold without double capture", () => {
    const root = repository("legacy-owned");
    const path = join(root, ".git", "hooks", "post-commit");
    writeFileSync(
      path,
      `#!/bin/sh
# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)

if command -v prim-post-commit >/dev/null 2>&1; then
  prim-post-commit || true
elif [ -f "./node_modules/.bin/prim-post-commit" ]; then
  ./node_modules/.bin/prim-post-commit || true
else
  npx --yes -p @primitive.ai/prim prim-post-commit 2>/dev/null || true
fi
`,
      { mode: 0o755 },
    );
    ensureEffectivePostCommitHook(root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(refreshed).toContain("prim-created-post-commit-hook");
    expect(refreshed).not.toContain("prim-managed-hook");
    expect(uninstallEffectivePostCommitHook(root).removedFile).toBe(true);
  });

  it("preserves a foreign tail added to the exact legacy Prim-owned scaffold", () => {
    const root = repository("legacy-owned-tail");
    const path = join(root, ".git", "hooks", "post-commit");
    writeFileSync(
      path,
      `#!/bin/sh
# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)

if command -v prim-post-commit >/dev/null 2>&1; then
  prim-post-commit || true
elif [ -f "./node_modules/.bin/prim-post-commit" ]; then
  ./node_modules/.bin/prim-post-commit || true
else
  npx --yes -p @primitive.ai/prim prim-post-commit 2>/dev/null || true
fi
printf 'foreign tail\\n'
`,
      { mode: 0o751 },
    );

    ensureEffectivePostCommitHook(root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(refreshed).toContain("printf 'foreign tail\\n'");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);

    expect(uninstallEffectivePostCommitHook(root)).toMatchObject({
      changed: true,
      removedFile: false,
    });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nprintf 'foreign tail\\n'\n");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);
  });

  it("replaces the shipped version-pinned project scaffold and preserves its foreign tail", () => {
    const root = repository("legacy-pinned-project");
    const path = join(root, ".git", "hooks", "post-commit");
    writeFileSync(
      path,
      `#!/bin/sh
# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)

${PINNED_INVOCATION}
printf 'foreign tail\\n'
`,
      { mode: 0o751 },
    );

    ensureEffectivePostCommitHook(root);
    expect(readFileSync(path, "utf8")).toContain("printf 'foreign tail\\n'");
    expect(readFileSync(path, "utf8")).not.toContain("@primitive.ai/prim@0.1.0-alpha.60");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);

    expect(uninstallEffectivePostCommitHook(root)).toMatchObject({
      removedFile: false,
      changed: true,
    });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nprintf 'foreign tail\\n'\n");
  });

  it("refreshes the exact legacy Prim global scaffold without double invocation", () => {
    const hooks = temp("legacy-global");
    const path = join(hooks, "post-commit");
    writeFileSync(
      path,
      `#!/bin/sh
# prim global post-commit hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
if command -v prim-post-commit >/dev/null 2>&1; then
  prim-post-commit || true
elif [ -f "./node_modules/.bin/prim-post-commit" ]; then
  ./node_modules/.bin/prim-post-commit || true
else
  npx --yes -p @primitive.ai/prim prim-post-commit 2>/dev/null || true
fi
fi
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/post-commit"
`,
      { mode: 0o755 },
    );
    ensurePostCommitHookAtPath(path);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(refreshed).not.toContain("\nprim-post-commit || true\n");
    expect(refreshed).toContain("common_dir=$(git rev-parse --git-common-dir");
  });

  it("replaces only the gate in the shipped version-pinned global scaffold", () => {
    const hooks = temp("legacy-pinned-global");
    const path = join(hooks, "post-commit");
    const chain = `common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/post-commit"
if [ -x "$repo_hook" ]; then
  "$repo_hook" "$@" || true
fi
printf 'foreign tail\\n'
`;
    writeFileSync(
      path,
      `#!/bin/sh
# prim global post-commit hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
${PINNED_INVOCATION}
fi
${chain}`,
      { mode: 0o750 },
    );

    ensurePostCommitHookAtPath(path);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed).toContain(postCommitHookBlock());
    expect(refreshed.endsWith(chain)).toBe(true);
    expect(refreshed).not.toContain("@primitive.ai/prim@0.1.0-alpha.60");
    expect(lstatSync(path).mode & 0o777).toBe(0o750);
  });

  it("refuses to replace an unrecognized legacy invocation", () => {
    const root = repository("legacy-unrecognized");
    const path = join(root, ".git", "hooks", "post-commit");
    const foreign = `#!/bin/sh
# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)

prim-post-commit || true
printf 'foreign tail\\n'
`;
    writeFileSync(path, foreign, { mode: 0o755 });

    expect(() => ensureEffectivePostCommitHook(root)).toThrow(/unrecognized legacy/);
    expect(readFileSync(path, "utf8")).toBe(foreign);
  });

  it("keeps the wired block version-stable and free of absolute paths", () => {
    const root = repository("portable");
    for (const hook of ["pre-commit", "post-commit", "post-rewrite"] as const) {
      const block = managedHookBlock(hook);
      expect(block).not.toContain(root);
      expect(block).not.toContain(String(packageVersion()));
      expect(block).not.toContain(process.execPath);
      expect(block).toContain(`/git-hook-scripts/${hook}"`);
    }
  });

  it.each([
    ["PRIM_CONFIG_DIR", { PRIM_CONFIG_DIR: "/opt/prim-config", HOME: "/home/u" }],
    ["XDG_CONFIG_HOME", { XDG_CONFIG_HOME: "/xdg", HOME: "/home/u" }],
    ["HOME", { HOME: "/home/u" }],
  ])("resolves the sourced script like primConfigDirectory (%s)", (_label, env) => {
    const block = managedHookBlock("post-commit");
    const assignment = block.split("\n").find((line) => line.startsWith("prim_hook=")) ?? "";
    const resolved = execFileSync("/bin/sh", ["-c", `${assignment}\nprintf %s "$prim_hook"`], {
      env: { PATH: process.env.PATH, ...env },
      encoding: "utf8",
    });
    expect(resolved).toBe(
      join(primConfigDirectory({ env, homeDir: env.HOME }), "git-hook-scripts", "post-commit"),
    );
  });

  it("is a silent no-op where the script is absent", () => {
    const result = execFileSync(
      "/bin/sh",
      ["-eu", "-c", `${managedHookBlock("post-commit")}\nprintf done`],
      {
        env: { PATH: process.env.PATH, PRIM_CONFIG_DIR: temp("empty-config") },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result).toBe("done");
  });

  it("writes gated, executable scripts idempotently", () => {
    writeGitHookScripts();
    const path = gitHookScriptPath("pre-commit");
    const before = lstatSync(path);
    writeGitHookScripts();
    expect(lstatSync(path).mtimeMs).toBe(before.mtimeMs);
    for (const hook of ["pre-commit", "post-commit", "post-rewrite"] as const) {
      const script = readFileSync(gitHookScriptPath(hook), "utf8");
      expect(lstatSync(gitHookScriptPath(hook)).mode & 0o777).toBe(0o755);
      expect(script).toBe(gitHookScript(hook));
      expect(script).toContain('if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]');
      expect(script).not.toMatch(/^\s*exit\b/mu);
    }
  });

  it("keeps the post-commit script free of checkout-specific absolute paths", () => {
    const root = repository("portable-script");
    const script = gitHookScript("post-commit");
    expect(script).not.toContain(root);
    expect(script).toContain(pinnedNpxCommand("prim-post-commit"));
    expect(script).toContain(`@primitive.ai/prim@${packageVersion()}`);
    expect(script).toContain("--ignore-scripts");
    expect(script).not.toContain("@latest");
    expect(script).toContain("prim_commit_sha=$(git rev-parse --verify HEAD 2>/dev/null)");
    expect(script).toContain(
      'export PRIM_COMMIT_SHA="$prim_commit_sha" PRIM_COMMIT_BRANCH="$prim_commit_branch"',
    );
    expect(script).toContain('PRIM_COMMIT_OBSERVED_FILE="$prim_commit_observed_file"');
    expect(script).toContain('mktemp "${TMPDIR:-/tmp}/prim-post-commit-observed.XXXXXXXX"');
    expect(script).toContain('"$prim_node" "$prim_entry" ) </dev/null >/dev/null 2>&1 &');
    expect(script).not.toContain("./node_modules/.bin/prim-post-commit");
  });
});
