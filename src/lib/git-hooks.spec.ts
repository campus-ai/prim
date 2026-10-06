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
import { packageVersion } from "./bin-path.js";
import { GIT_HOOK_ENTRYPOINT_NAME, blockMarkers } from "./git-hook-contract.js";
import { legacyInlineHookBlock } from "./git-hook-legacy.js";
import { stageFakeGitHookRuntime } from "./git-hook-runtime.testing.js";
import {
  ensureEffectiveGitHook,
  ensureGitHookAtPath,
  externalHookRemedy,
  inspectEffectiveGitHook,
  managedHookBlock,
  resolveEffectiveGitHook,
  uninstallEffectiveGitHook,
  uninstallGitHookAtPath,
  uninstallProjectGitHook,
} from "./git-hooks.js";

const roots: string[] = [];
const { start: PRIM_POST_COMMIT_BLOCK_START, end: PRIM_POST_COMMIT_BLOCK_END } =
  blockMarkers("post-commit");
let configDir: string;
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

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  configDir = temp("config");
  vi.stubEnv("PRIM_CONFIG_DIR", configDir);
  stageFakeGitHookRuntime(configDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("effective post-commit hook", () => {
  it("resolves and installs the normal Git hooks directory", () => {
    const root = repository("normal");
    const result = ensureEffectiveGitHook("post-commit", root);
    expect(result.path).toBe(join(root, ".git", "hooks", "post-commit"));
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: true,
      executable: true,
      current: true,
      kind: "direct",
    });
  });

  it("honors repository-local relative and absolute core.hooksPath overrides", () => {
    const relativeRoot = repository("relative");
    git(relativeRoot, "config", "--local", "core.hooksPath", "custom-hooks");
    expect(ensureEffectiveGitHook("post-commit", relativeRoot).path).toBe(
      join(relativeRoot, "custom-hooks", "post-commit"),
    );

    const absoluteRoot = repository("absolute");
    const absoluteHooks = temp("absolute-hooks");
    git(absoluteRoot, "config", "--local", "core.hooksPath", absoluteHooks);
    expect(ensureEffectiveGitHook("post-commit", absoluteRoot).path).toBe(
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
    const result = ensureEffectiveGitHook("post-commit", linked);
    expect(result.path).toBe(join(expectedHooks, "post-commit"));
    expect(inspectEffectiveGitHook("post-commit", linked).covered).toBe(true);
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

    const resolved = resolveEffectiveGitHook("post-commit", root);
    expect(resolved).toMatchObject({
      kind: "husky_v9",
      hookPath: join(root, ".husky", "post-commit"),
      dispatcherPath: generated,
    });
    ensureEffectiveGitHook("post-commit", root);
    expect(readFileSync(generated)).toEqual(originalDispatcher);
    expect(readFileSync(join(root, ".husky", "post-commit"), "utf8")).toContain(
      PRIM_POST_COMMIT_BLOCK_START,
    );

    chmodSync(join(root, ".husky", "post-commit"), 0o644);
    expect(() => ensureEffectiveGitHook("post-commit", root)).not.toThrow();
    expect(lstatSync(join(root, ".husky", "post-commit")).mode & 0o777).toBe(0o644);
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
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

    expect(() => ensureEffectiveGitHook("post-commit", root)).not.toThrow();
    expect(readFileSync(join(root, ".husky", "post-commit"), "utf8")).toMatch(
      /^# >>> prim post-commit hook >>>/u,
    );
    expect(readFileSync(join(root, ".husky", "post-commit"), "utf8")).toContain(
      "printf 'foreign husky\\n'",
    );
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: true,
      kind: "husky_v9",
    });

    writeFileSync(join(generatedDir, "h"), "#!/usr/bin/env sh\nexit 0\n", { mode: 0o755 });
    expect(() => ensureEffectiveGitHook("post-commit", root)).toThrow(/unrecognized Husky v9/);
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
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

    expect(() => ensureEffectiveGitHook("post-commit", root)).not.toThrow();
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
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

      expect(() => ensureEffectiveGitHook("post-commit", root)).toThrow(/Husky/);
      expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
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
    ensureEffectiveGitHook("post-commit", root);
    const installed = readFileSync(path);
    expect(
      Buffer.from(installed.toString("utf8").replace(`${managedHookBlock("post-commit")}\n`, "")),
    ).toEqual(foreign);
    expect(lstatSync(path).mode & 0o777).toBe(0o740);

    const stale = installed
      .toString("utf8")
      .replace(managedHookBlock("post-commit"), legacyInlineHookBlock("post-commit"));
    writeFileSync(path, stale, { mode: 0o740 });
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: false,
      reason: "stale_block",
    });
    ensureEffectiveGitHook("post-commit", root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed).toBe(installed.toString("utf8"));
    expect(refreshed).not.toContain("@primitive.ai/prim@");
    expect(refreshed.replace(`${managedHookBlock("post-commit")}\n`, "")).toBe(
      foreign.toString("utf8"),
    );
  });

  it("rejects malformed markers, binary files, symlinks, and missing Husky dispatchers", () => {
    const malformed = repository("malformed");
    const malformedPath = join(malformed, ".git", "hooks", "post-commit");
    writeFileSync(malformedPath, `#!/bin/sh\n${PRIM_POST_COMMIT_BLOCK_START}\n`, { mode: 0o755 });
    expect(() => ensureEffectiveGitHook("post-commit", malformed)).toThrow(/malformed/);

    const binary = repository("binary");
    writeFileSync(join(binary, ".git", "hooks", "post-commit"), Buffer.from([35, 0, 10]), {
      mode: 0o755,
    });
    expect(() => ensureEffectiveGitHook("post-commit", binary)).toThrow(/binary/);

    const linked = repository("symlink");
    const outside = temp("outside-hook");
    const destination = join(outside, "post-commit");
    writeFileSync(destination, "#!/bin/sh\n", { mode: 0o755 });
    symlinkSync(destination, join(linked, ".git", "hooks", "post-commit"));
    expect(() => ensureEffectiveGitHook("post-commit", linked)).toThrow(/unsafe/);

    const husky = repository("missing-dispatcher");
    mkdirSync(join(husky, ".husky", "_"), { recursive: true });
    git(husky, "config", "--local", "core.hooksPath", ".husky/_");
    expect(() => ensureEffectiveGitHook("post-commit", husky)).toThrow(/dispatcher/);
  });

  it("does not chmod or edit a non-executable foreign direct hook", () => {
    const root = repository("non-executable");
    const path = join(root, ".git", "hooks", "post-commit");
    const foreign = Buffer.from("#!/bin/sh\nprintf foreign\n");
    writeFileSync(path, foreign, { mode: 0o640 });
    expect(() => ensureEffectiveGitHook("post-commit", root)).toThrow(/not executable/);
    expect(readFileSync(path)).toEqual(foreign);
    expect(lstatSync(path).mode & 0o777).toBe(0o640);
  });

  it("refuses to modify an executable hook with an unsupported interpreter", () => {
    const root = repository("foreign-unreachable");
    const path = join(root, ".git", "hooks", "post-commit");
    const source = "#!/usr/bin/env python3\nprint('foreign')\n";
    writeFileSync(path, source, { mode: 0o755 });

    expect(() => ensureEffectiveGitHook("post-commit", root)).toThrow(/unsupported/);
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it.each([
    ["exit", "#!/bin/sh\nprintf foreign\nexit 0\n"],
    ["exec", '#!/bin/sh\nexec other-hook "$@"\n'],
    ["return", "#!/bin/sh\nreturn 0\n"],
  ])("positions Prim before foreign %s control flow", (_label, source) => {
    const root = repository("foreign-control-flow");
    const path = join(root, ".git", "hooks", "post-commit");
    writeFileSync(path, source, { mode: 0o755 });

    ensureEffectiveGitHook("post-commit", root);
    const installed = readFileSync(path, "utf8");
    expect(installed.indexOf(PRIM_POST_COMMIT_BLOCK_START)).toBe("#!/bin/sh\n".length);
    expect(installed.indexOf(PRIM_POST_COMMIT_BLOCK_END)).toBeLessThan(
      installed.indexOf(source.split("\n")[1] ?? "missing"),
    );
    expect(inspectEffectiveGitHook("post-commit", root).covered).toBe(true);

    uninstallEffectiveGitHook("post-commit", root);
    expect(readFileSync(path, "utf8")).toBe(source);
  });

  it.each([
    ["exit", "printf foreign\nexit 0\n"],
    ["exec", 'exec other-hook "$@"\n'],
    ["return", "return 0\n"],
  ])(
    "reports a block behind a top-level %s as unreachable and moves it only when explicit",
    (_label, foreign) => {
      const root = repository("late-block");
      const path = join(root, ".git", "hooks", "post-commit");
      const late = `#!/bin/sh\n${foreign}${managedHookBlock("post-commit")}\n`;
      writeFileSync(path, late, { mode: 0o755 });

      expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
        covered: false,
        reason: "unreachable_block",
      });
      expect(ensureEffectiveGitHook("post-commit", root, { context: "ambient" }).changed).toBe(
        false,
      );
      expect(readFileSync(path, "utf8")).toBe(late);

      ensureEffectiveGitHook("post-commit", root, { context: "explicit" });
      const repaired = readFileSync(path, "utf8");
      expect(repaired.indexOf(PRIM_POST_COMMIT_BLOCK_START)).toBe("#!/bin/sh\n".length);
      expect(repaired).toContain(foreign);
      expect(inspectEffectiveGitHook("post-commit", root).covered).toBe(true);
    },
  );

  it("treats a redirecting exec as reachable and never moves a reachable block", () => {
    const root = repository("placed-block");
    const path = join(root, ".git", "hooks", "post-commit");
    const placed = `#!/bin/sh\nexec 1>&2\nexec < /dev/null\nprintf before\n${managedHookBlock("post-commit")}\nprintf after\nexit 0\n`;
    writeFileSync(path, placed, { mode: 0o755 });

    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({ covered: true });
    expect(ensureEffectiveGitHook("post-commit", root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(placed);
  });

  it("publishes rewrites atomically without leaving temporary files", () => {
    const root = repository("atomic");
    const hooks = join(root, ".git", "hooks");
    const path = join(hooks, "post-commit");
    writeFileSync(path, "#!/bin/sh\nprintf foreign\n", { mode: 0o751 });

    ensureEffectiveGitHook("post-commit", root);

    expect(readFileSync(path, "utf8")).toContain("printf foreign");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);
    expect(readdirSync(hooks).filter((name) => name.includes(".prim-"))).toEqual([]);
  });

  it("snapshots rapid sequential commits before launching background capture", async () => {
    const root = repository("rapid-commits");
    const observedRoot = temp("rapid-observed");
    const output = join(temp("rapid-output"), "captures");
    stageFakeGitHookRuntime(configDir, {
      "prim-post-commit": `files=$(git diff-tree --no-commit-id --name-only -r --root "$PRIM_COMMIT_SHA")
marker=missing
if [ -f "$PRIM_COMMIT_OBSERVED_FILE" ]; then marker=present; fi
printf '%s|%s|%s\\n' "$PRIM_COMMIT_SHA" "$files" "$marker" >> "$PRIM_CAPTURE_OUTPUT"
`,
    });
    vi.stubEnv("TMPDIR", observedRoot);
    vi.stubEnv("PRIM_CAPTURE_OUTPUT", output);
    git(root, "config", "--local", "prim.active", "true");
    ensureEffectiveGitHook("post-commit", root);

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
    const createdPath = ensureEffectiveGitHook("post-commit", created).path;
    expect(uninstallEffectiveGitHook("post-commit", created)).toMatchObject({
      changed: true,
      removedFile: true,
    });
    expect(() => lstatSync(createdPath)).toThrow();

    const foreign = repository("uninstall-foreign");
    const foreignPath = join(foreign, ".git", "hooks", "post-commit");
    const bytes = Buffer.from("#!/bin/sh\nprintf foreign\n");
    writeFileSync(
      foreignPath,
      Buffer.concat([bytes, Buffer.from(`\n${managedHookBlock("post-commit")}\n`)]),
      { mode: 0o750 },
    );
    expect(uninstallEffectiveGitHook("post-commit", foreign)).toMatchObject({
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
    ensureGitHookAtPath("post-commit", globalPath);
    ensureGitHookAtPath("post-commit", projectPath);
    const globalBefore = readFileSync(globalPath);

    expect(resolveEffectiveGitHook("post-commit", root).hookPath).toBe(globalPath);
    expect(uninstallProjectGitHook("post-commit", root)).toMatchObject({
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
    ensureEffectiveGitHook("post-commit", root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(refreshed).toContain("prim-created-post-commit-hook");
    expect(refreshed).not.toContain("prim-managed-hook");
    expect(uninstallEffectiveGitHook("post-commit", root).removedFile).toBe(true);
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

    ensureEffectiveGitHook("post-commit", root);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(refreshed).toContain("printf 'foreign tail\\n'");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);

    expect(uninstallEffectiveGitHook("post-commit", root)).toMatchObject({
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

    ensureEffectiveGitHook("post-commit", root);
    expect(readFileSync(path, "utf8")).toContain("printf 'foreign tail\\n'");
    expect(readFileSync(path, "utf8")).not.toContain("@primitive.ai/prim@0.1.0-alpha.60");
    expect(lstatSync(path).mode & 0o777).toBe(0o751);

    expect(uninstallEffectiveGitHook("post-commit", root)).toMatchObject({
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
    ensureGitHookAtPath("post-commit", path);
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

    ensureGitHookAtPath("post-commit", path);
    const refreshed = readFileSync(path, "utf8");
    expect(refreshed).toContain(managedHookBlock("post-commit"));
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

    expect(() => ensureEffectiveGitHook("post-commit", root)).toThrow(/unrecognized legacy/);
    expect(readFileSync(path, "utf8")).toBe(foreign);
  });

  it("keeps the wired block free of versions, machine paths, and runtimes", () => {
    const root = repository("portable");
    const block = managedHookBlock("post-commit");
    expect(block).not.toContain(root);
    expect(block).not.toContain(configDir);
    expect(block).not.toContain(process.execPath);
    expect(block).not.toContain(String(packageVersion()));
    expect(block).not.toMatch(/\bnpx\b|@latest|node_modules/u);
    expect(block).toContain(`${GIT_HOOK_ENTRYPOINT_NAME} post-commit "$@" || :`);
  });
});

describe("v1 hook wiring contract", () => {
  it("never writes a worktree hook file from ambient repair, and writes it once when explicit", () => {
    const root = repository("worktree-hooks");
    git(root, "config", "--local", "core.hooksPath", ".githooks");
    const path = join(root, ".githooks", "post-commit");

    expect(ensureEffectiveGitHook("post-commit", root, { context: "ambient" })).toMatchObject({
      changed: false,
      outcome: "deferred",
    });
    expect(() => lstatSync(path)).toThrow();
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      location: "worktree",
      reason: "missing",
    });

    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("created");
    const installed = readFileSync(path, "utf8");
    for (const context of ["explicit", "ambient"] as const) {
      expect(ensureEffectiveGitHook("post-commit", root, { context })).toMatchObject({
        changed: false,
        outcome: "unchanged",
      });
    }
    expect(readFileSync(path, "utf8")).toBe(installed);
  });

  it("repairs the untracked .git/hooks file from ambient repair", () => {
    const root = repository("ambient-dot-git");
    expect(ensureEffectiveGitHook("post-commit", root, { context: "ambient" })).toMatchObject({
      changed: true,
      outcome: "created",
    });
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      location: "repository",
      covered: true,
    });
  });

  it("leaves a pre-v1 block in a tracked Husky file for an explicit command", () => {
    const root = repository("husky-legacy-block");
    mkdirSync(join(root, ".husky", "_"), { recursive: true });
    writeFileSync(
      join(root, ".husky", "_", "post-commit"),
      '#!/bin/sh\nexec sh "$(dirname "$0")/../post-commit"\n',
      { mode: 0o755 },
    );
    git(root, "config", "--local", "core.hooksPath", ".husky/_");
    const path = join(root, ".husky", "post-commit");
    const legacy = `${legacyInlineHookBlock("post-commit")}\nnpx lint-staged\n`;
    writeFileSync(path, legacy);

    expect(ensureEffectiveGitHook("post-commit", root, { context: "ambient" }).outcome).toBe(
      "deferred",
    );
    expect(readFileSync(path, "utf8")).toBe(legacy);
    expect(inspectEffectiveGitHook("post-commit", root).reason).toBe("stale_block");

    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(
      `${managedHookBlock("post-commit")}\nnpx lint-staged\n`,
    );
  });

  it("writes nothing under prim.gitHooks=manual and reports the mode beside health", () => {
    const root = repository("manual");
    git(root, "config", "--local", "prim.gitHooks", "manual");

    expect(ensureEffectiveGitHook("post-commit", root)).toMatchObject({
      changed: false,
      outcome: "manual",
    });
    expect(() => lstatSync(join(root, ".git", "hooks", "post-commit"))).toThrow();
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      mode: "manual",
      covered: false,
      reason: "missing",
    });
  });

  it("accepts a formatter's re-indented, re-spaced block as current", () => {
    const root = repository("formatted");
    const path = join(root, ".git", "hooks", "post-rewrite");
    const formatted = managedHookBlock("post-rewrite")
      .replaceAll("\n  ", "\n\t")
      .replaceAll('>"', '> "')
      .replaceAll('<"', '< "')
      .replace("; then rm -f", "; then\n\trm -f")
      .replace('stdin}"; fi', 'stdin}"\nfi');
    const content = `#!/bin/sh\n${formatted}\n`;
    writeFileSync(path, content, { mode: 0o755 });

    expect(inspectEffectiveGitHook("post-rewrite", root)).toMatchObject({ covered: true });
    expect(ensureEffectiveGitHook("post-rewrite", root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(content);
  });

  it("never downgrades a block written by a later contract", () => {
    const root = repository("newer-contract");
    const path = join(root, ".git", "hooks", "post-commit");
    const newer = `#!/bin/sh\n${PRIM_POST_COMMIT_BLOCK_START}\n# prim git hook v2: future\nprim-future-call\n${PRIM_POST_COMMIT_BLOCK_END}\n`;
    writeFileSync(path, newer, { mode: 0o755 });

    expect(ensureEffectiveGitHook("post-commit", root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(newer);
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({ covered: true });
  });

  it("leaves a hook that calls the entrypoint itself alone and reports it as user-wired", () => {
    const root = repository("user-wired");
    const path = join(root, ".git", "hooks", "post-commit");
    const own = `#!/bin/sh\n"$HOME/.config/prim/${GIT_HOOK_ENTRYPOINT_NAME}" post-commit "$@"\n`;
    writeFileSync(path, own, { mode: 0o755 });

    expect(ensureEffectiveGitHook("post-commit", root).changed).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(own);
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: true,
      wiring: "user",
    });
  });

  it("reports an unstaged entrypoint instead of claiming coverage", () => {
    const root = repository("no-entrypoint");
    ensureEffectiveGitHook("post-commit", root);
    rmSync(join(configDir, GIT_HOOK_ENTRYPOINT_NAME));
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: false,
      entrypoint: "missing",
      reason: "entrypoint_missing",
    });
  });

  it("wires pre-commit into a foreign hook and migrates an owned legacy pre-commit", () => {
    const foreign = repository("pre-commit-foreign");
    const foreignPath = join(foreign, ".git", "hooks", "pre-commit");
    writeFileSync(foreignPath, "#!/bin/sh\nnpm test\n", { mode: 0o755 });
    ensureEffectiveGitHook("pre-commit", foreign);
    expect(readFileSync(foreignPath, "utf8")).toBe(
      `#!/bin/sh\n${managedHookBlock("pre-commit")}\nnpm test\n`,
    );
    uninstallEffectiveGitHook("pre-commit", foreign);
    expect(readFileSync(foreignPath, "utf8")).toBe("#!/bin/sh\nnpm test\n");

    const owned = repository("pre-commit-owned");
    const ownedPath = join(owned, ".git", "hooks", "pre-commit");
    writeFileSync(
      ownedPath,
      "#!/bin/sh\n# prim pre-commit hook — installed by: prim hooks install (prim-managed-hook)\n\n{ npx --yes -p @primitive.ai/prim@0.1.0-alpha.60 prim-pre-commit; } || true\n",
      { mode: 0o755 },
    );
    ensureEffectiveGitHook("pre-commit", owned);
    expect(readFileSync(ownedPath, "utf8")).toContain("prim-created-pre-commit-hook");
    expect(readFileSync(ownedPath, "utf8")).not.toContain("@primitive.ai/prim@");
    expect(uninstallEffectiveGitHook("pre-commit", owned).removedFile).toBe(true);
  });

  it("removes a scaffold an earlier release created in a foreign hooks dir", () => {
    const hooks = temp("foreign-created");
    const path = join(hooks, "pre-commit");
    writeFileSync(
      path,
      `#!/bin/sh\n# prim-created-hook\n\n${blockMarkers("pre-commit").start}\n{ prim-pre-commit; } || true\n${blockMarkers("pre-commit").end}\n`,
      { mode: 0o755 },
    );
    ensureGitHookAtPath("pre-commit", path);
    expect(readFileSync(path, "utf8")).toBe(
      `#!/bin/sh\n${managedHookBlock("pre-commit")}\n# prim-created-pre-commit-hook\n`,
    );
    expect(uninstallGitHookAtPath("pre-commit", path).removedFile).toBe(true);
  });

  it("never deletes a user's shebang-only hook it merely added a block to", () => {
    const hooks = temp("foreign-user");
    const path = join(hooks, "post-commit");
    writeFileSync(path, "#!/bin/sh\n", { mode: 0o755 });
    ensureGitHookAtPath("post-commit", path);
    expect(uninstallGitHookAtPath("post-commit", path)).toMatchObject({
      changed: true,
      removedFile: false,
    });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\n");
  });

  it.each([
    ["no config root", { PRIM_CONFIG_DIR: "/nonexistent/prim-config" }],
    ["no HOME", {}],
    ["a relative HOME", { HOME: "relative/home" }],
  ])("is a silent no-op under sh -eu with %s", (_label, env) => {
    const result = execFileSync(
      "/bin/sh",
      ["-eu", "-c", `${managedHookBlock("post-commit")}\nprintf done`],
      {
        env: { PATH: process.env.PATH, ...env },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    expect(result).toBe("done");
  });

  it("finds the entrypoint exactly where primConfigDirectory resolves the config root", () => {
    const base = temp("resolver");
    const home = join(base, "home");
    const cases: [NodeJS.ProcessEnv, string][] = [
      [{ HOME: home, PRIM_CONFIG_DIR: join(base, "explicit") }, join(base, "explicit")],
      [{ HOME: home, XDG_CONFIG_HOME: join(base, "xdg") }, join(base, "xdg", "prim")],
      [{ HOME: home }, join(home, ".config", "prim")],
      // Non-canonical overrides fall through, exactly as in Node.
      [{ HOME: home, PRIM_CONFIG_DIR: `${base}//explicit` }, join(home, ".config", "prim")],
      [{ HOME: home, XDG_CONFIG_HOME: "relative/xdg" }, join(home, ".config", "prim")],
    ];
    for (const [env, expected] of cases) {
      const log = join(base, "ran");
      rmSync(log, { force: true });
      mkdirSync(expected, { recursive: true });
      writeFileSync(
        join(expected, GIT_HOOK_ENTRYPOINT_NAME),
        `#!/bin/sh\nprintf '%s %s' "$0" "$1" > '${log}'\n`,
        { mode: 0o755 },
      );
      execFileSync("/bin/sh", ["-c", managedHookBlock("pre-commit")], {
        env: { PATH: process.env.PATH, ...env },
      });
      expect(readFileSync(log, "utf8")).toBe(
        `${join(expected, GIT_HOOK_ENTRYPOINT_NAME)} pre-commit`,
      );
      rmSync(join(expected, GIT_HOOK_ENTRYPOINT_NAME));
    }
  });

  it.skipIf(spawnShellcheck() === null)(
    "passes shellcheck -o all in sh, bash, and shebang-less Husky hooks",
    () => {
      const dir = temp("shellcheck");
      for (const hook of ["pre-commit", "post-commit", "post-rewrite"] as const) {
        const files = [
          [`${hook}.sh`, `#!/bin/sh\n${managedHookBlock(hook)}\necho user\n`, []],
          [`${hook}.bash`, `#!/usr/bin/env bash\n${managedHookBlock(hook)}\necho user\n`, []],
          [`${hook}.husky`, `${managedHookBlock(hook)}\nnpx lint-staged\n`, ["-s", "sh"]],
        ] as const;
        for (const [name, content, shell] of files) {
          writeFileSync(join(dir, name), content);
          expect(() =>
            execFileSync("shellcheck", ["-o", "all", ...shell, join(dir, name)], {
              stdio: ["ignore", "pipe", "pipe"],
            }),
          ).not.toThrow();
        }
      }
    },
  );
});

function spawnShellcheck(): string | null {
  try {
    return execFileSync("shellcheck", ["--version"], { encoding: "utf8" });
  } catch {
    return null;
  }
}

// Husky v8's runtime (8.0.x): it re-runs the hook in a child shell, then exits.
const HUSKY_V8_SH = `#!/usr/bin/env sh
if [ -z "$husky_skip_init" ]; then
  readonly hook_name="$(basename -- "$0")"
  if [ "$HUSKY" = "0" ]; then
    exit 0
  fi
  readonly husky_skip_init=1
  export husky_skip_init
  sh -e "$0" "$@"
  exitCode="$?"
  exit $exitCode
fi
`;

describe("where prim may write", () => {
  it("never edits a shared global hooks dir, explicit or ambient", () => {
    const root = repository("foreign-global");
    const globalHooks = temp("foreign-global-hooks");
    const globalConfig = join(temp("foreign-global-config"), "config");
    writeFileSync(globalConfig, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    git(root, "config", "--global", "core.hooksPath", globalHooks);
    const path = join(globalHooks, "post-commit");
    writeFileSync(path, "#!/bin/sh\nteam-lint\n", { mode: 0o755 });

    for (const context of ["explicit", "ambient"] as const) {
      expect(ensureEffectiveGitHook("post-commit", root, { context })).toMatchObject({
        changed: false,
        outcome: "external",
      });
    }
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nteam-lint\n");
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      location: "external",
      reason: "missing_block",
    });

    // A path the user chose (a consented user-scope install) is still writable.
    expect(ensureGitHookAtPath("post-commit", path).outcome).toBe("updated");
    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("unchanged");
  });

  it("treats a worktree hooks dir reached through a symlink as the worktree", () => {
    const root = repository("symlinked-hooks");
    mkdirSync(join(root, ".githooks"));
    const alias = join(temp("symlink-parent"), "alias");
    symlinkSync(root, alias);
    git(root, "config", "--local", "core.hooksPath", join(alias, ".githooks"));

    expect(ensureEffectiveGitHook("post-commit", root, { context: "ambient" })).toMatchObject({
      outcome: "deferred",
    });
    expect(() => lstatSync(join(root, ".githooks", "post-commit"))).toThrow();
    expect(inspectEffectiveGitHook("post-commit", root).location).toBe("worktree");
  });

  it("never edits another worktree's tracked hooks from a linked worktree", () => {
    const root = repository("main-tracked-hooks");
    mkdirSync(join(root, ".githooks"));
    writeFileSync(join(root, ".githooks", "pre-commit"), "#!/bin/sh\nmake lint\n", {
      mode: 0o755,
    });
    git(root, "add", ".githooks");
    git(root, "commit", "-qm", "hooks");
    git(root, "config", "core.hooksPath", join(root, ".githooks"));
    const linked = join(temp("linked-parent"), "linked");
    git(root, "worktree", "add", "-qb", "linked", linked);

    for (const context of ["ambient", "explicit"] as const) {
      expect(ensureEffectiveGitHook("pre-commit", linked, { context }).outcome).toBe("external");
    }
    expect(git(root, "status", "--porcelain")).toBe("");
  });

  it("only refreshes, never adds, under repair-only (SessionStart's pre-commit)", () => {
    const root = repository("repair-only");
    const path = join(root, ".git", "hooks", "pre-commit");
    expect(
      ensureEffectiveGitHook("pre-commit", root, { context: "ambient", repairOnly: true }),
    ).toMatchObject({ outcome: "skipped" });
    expect(() => lstatSync(path)).toThrow();

    writeFileSync(path, "#!/bin/sh\nnpm test\n", { mode: 0o755 });
    expect(
      ensureEffectiveGitHook("pre-commit", root, { context: "ambient", repairOnly: true }).outcome,
    ).toBe("skipped");

    const stale = `#!/bin/sh\n${blockMarkers("pre-commit").start}\n{ prim-pre-commit; } || true\n${blockMarkers("pre-commit").end}\nnpm test\n`;
    writeFileSync(path, stale, { mode: 0o755 });
    expect(
      ensureEffectiveGitHook("pre-commit", root, { context: "ambient", repairOnly: true }).outcome,
    ).toBe("updated");
    expect(readFileSync(path, "utf8")).toBe(
      `#!/bin/sh\n${managedHookBlock("pre-commit")}\nnpm test\n`,
    );
  });

  it("keeps a working pre-v1 block while the hook runtime is not staged", () => {
    const root = repository("runtime-missing");
    const path = join(root, ".git", "hooks", "post-commit");
    const legacy = `#!/bin/sh\n${legacyInlineHookBlock("post-commit")}\n`;
    writeFileSync(path, legacy, { mode: 0o755 });
    rmSync(join(configDir, GIT_HOOK_ENTRYPOINT_NAME));

    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("runtime_missing");
    expect(readFileSync(path, "utf8")).toBe(legacy);
  });

  it("removes pre-commit from a repo-local core.hooksPath on project uninstall", () => {
    const root = repository("uninstall-configured");
    git(root, "config", "--local", "core.hooksPath", ".githooks");
    const path = join(root, ".githooks", "pre-commit");
    mkdirSync(join(root, ".githooks"));
    writeFileSync(path, "#!/bin/sh\nmake lint\n", { mode: 0o755 });
    ensureEffectiveGitHook("pre-commit", root);
    expect(readFileSync(path, "utf8")).toContain(blockMarkers("pre-commit").start);

    expect(uninstallProjectGitHook("pre-commit", root)).toMatchObject({ changed: true });
    expect(readFileSync(path, "utf8")).toBe("#!/bin/sh\nmake lint\n");
  });
});

describe("Husky v8", () => {
  function huskyV8Repository(name: string, preCommit: string): { root: string; path: string } {
    const root = repository(name);
    mkdirSync(join(root, ".husky", "_"), { recursive: true });
    writeFileSync(join(root, ".husky", "_", "husky.sh"), HUSKY_V8_SH);
    const path = join(root, ".husky", "pre-commit");
    writeFileSync(path, preCommit, { mode: 0o755 });
    git(root, "config", "--local", "core.hooksPath", ".husky");
    git(root, "config", "--local", "prim.active", "true");
    return { root, path };
  }
  const V8_HOOK = '#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n\ntrue\n';

  it("places the block after husky.sh, so it runs once and honors HUSKY=0", () => {
    const { root, path } = huskyV8Repository("husky-v8", V8_HOOK);
    const log = join(temp("husky-v8-log"), "runs");
    stageFakeGitHookRuntime(configDir, {
      "prim-pre-commit": `printf 'run\\n' >> '${log}'\n`,
    });
    ensureEffectiveGitHook("pre-commit", root);
    expect(readFileSync(path, "utf8")).toBe(
      `#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n${managedHookBlock("pre-commit")}\n\ntrue\n`,
    );

    const run = (env: NodeJS.ProcessEnv) =>
      execFileSync(path, [], { cwd: root, env: { ...process.env, ...env }, stdio: "ignore" });
    run({});
    expect(readFileSync(log, "utf8")).toBe("run\n");
    run({ HUSKY: "0" });
    expect(readFileSync(log, "utf8")).toBe("run\n");
  });

  it("moves a block above husky.sh below it on an explicit install only", () => {
    const above = `#!/usr/bin/env sh\n${managedHookBlock("pre-commit")}\n. "$(dirname -- "$0")/_/husky.sh"\n\ntrue\n`;
    const { root, path } = huskyV8Repository("husky-v8-above", above);
    expect(ensureEffectiveGitHook("pre-commit", root, { context: "ambient" }).outcome).toBe(
      "unchanged",
    );
    ensureEffectiveGitHook("pre-commit", root);
    expect(readFileSync(path, "utf8")).toBe(
      `#!/usr/bin/env sh\n. "$(dirname -- "$0")/_/husky.sh"\n${managedHookBlock("pre-commit")}\n\ntrue\n`,
    );
  });
});

describe("recognizing prim in a hook file", () => {
  it("does not mistake a comment mentioning prim for wiring", () => {
    const root = repository("comment-mention");
    const path = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(path, "#!/bin/sh\n# TODO re-add prim-pre-commit\nnpm test\n", { mode: 0o755 });
    expect(inspectEffectiveGitHook("pre-commit", root).reason).toBe("missing_block");
    expect(ensureEffectiveGitHook("pre-commit", root).outcome).toBe("updated");
  });

  it("does not accept a block whose command was joined onto its comment", () => {
    const root = repository("joined-comment");
    const path = join(root, ".git", "hooks", "post-commit");
    const broken = managedHookBlock("post-commit").replace(
      "# shellcheck disable=SC2016\n",
      "# shellcheck disable=SC2016 ",
    );
    writeFileSync(path, `#!/bin/sh\n${broken}\n`, { mode: 0o755 });
    expect(inspectEffectiveGitHook("post-commit", root).reason).toBe("stale_block");
    ensureEffectiveGitHook("post-commit", root, { context: "ambient" });
    expect(readFileSync(path, "utf8")).toBe(`#!/bin/sh\n${managedHookBlock("post-commit")}\n`);
  });
});

describe("round-two review regressions", () => {
  function globalConfig(): string {
    const path = join(temp("rr-global"), "config");
    writeFileSync(path, "");
    vi.stubEnv("GIT_CONFIG_GLOBAL", path);
    return path;
  }

  it("names a remedy that fits where core.hooksPath is configured", () => {
    const local = repository("remedy-local");
    git(local, "config", "--local", "core.hooksPath", temp("remedy-local-hooks"));
    expect(externalHookRemedy("post-commit", local)).toContain(
      "this repository's core.hooksPath points outside it",
    );
    expect(externalHookRemedy("post-commit", local)).not.toContain("--scope user");

    globalConfig();
    const global = repository("remedy-global");
    git(global, "config", "--global", "core.hooksPath", temp("remedy-global-hooks"));
    expect(externalHookRemedy("post-commit", global)).toContain("prim hooks install --scope user");
  });

  it("keeps a working pre-v1 block in a shared dir instead of failing", () => {
    globalConfig();
    const root = repository("kept-legacy");
    const hooks = temp("kept-legacy-hooks");
    git(root, "config", "--global", "core.hooksPath", hooks);
    const path = join(hooks, "post-commit");
    const legacy = `#!/bin/sh\n${legacyInlineHookBlock("post-commit")}\n`;
    writeFileSync(path, legacy, { mode: 0o755 });

    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("kept");
    expect(readFileSync(path, "utf8")).toBe(legacy);
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      location: "external",
      reason: "stale_block",
    });
  });

  it("treats a hook inside a nested linked worktree as another worktree's", () => {
    const root = repository("nested-main");
    writeFileSync(join(root, "README.md"), "x\n");
    git(root, "add", "README.md");
    git(root, "commit", "-qm", "base");
    const nested = join(root, ".worktrees", "wt");
    git(root, "worktree", "add", "-qb", "nested", nested);
    mkdirSync(join(nested, ".githooks"));
    git(root, "config", "--local", "core.hooksPath", join(nested, ".githooks"));

    expect(inspectEffectiveGitHook("post-commit", root).location).toBe("external");
    expect(ensureEffectiveGitHook("post-commit", root).outcome).toBe("external");
  });

  it("flags a block above husky.sh as misplaced, without failing coverage logic", () => {
    const root = repository("misplaced-husky");
    mkdirSync(join(root, ".husky", "_"), { recursive: true });
    writeFileSync(join(root, ".husky", "_", "husky.sh"), "");
    git(root, "config", "--local", "core.hooksPath", ".husky");
    writeFileSync(
      join(root, ".husky", "post-commit"),
      `#!/usr/bin/env sh\n${managedHookBlock("post-commit")}\n. "$(dirname -- "$0")/_/husky.sh"\n`,
      { mode: 0o755 },
    );
    expect(inspectEffectiveGitHook("post-commit", root)).toMatchObject({
      covered: false,
      reason: "misplaced_block",
    });
  });

  it.each([
    ["a trailing comment", "npm test # prim-pre-commit"],
    ["an echo string", 'echo "prim-pre-commit is disabled"'],
    ["a quoted argument", "grep -q prim-pre-commit .git/hooks/pre-commit"],
  ])("does not mistake %s for the user's own wiring", (_label, line) => {
    const root = repository("not-user-wired");
    const path = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(path, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
    expect(inspectEffectiveGitHook("pre-commit", root).reason).toBe("missing_block");
  });

  it.each([
    ["a bare call", "prim-pre-commit || true"],
    ["a path call after env", 'FOO=1 exec "$HOME/.config/prim/prim-git-hook-v1" pre-commit "$@"'],
  ])("recognizes %s as the user's own wiring", (_label, line) => {
    const root = repository("user-wired-forms");
    const path = join(root, ".git", "hooks", "pre-commit");
    writeFileSync(path, `#!/bin/sh\n${line}\n`, { mode: 0o755 });
    expect(inspectEffectiveGitHook("pre-commit", root)).toMatchObject({ wiring: "user" });
  });

  it.each([
    [
      "a deleted newline",
      (block: string) => block.replace('"${prim_rewrite_stdin}"\nfi', '"${prim_rewrite_stdin}" fi'),
    ],
    [
      "respaced quoted text",
      (block: string) => block.replace("prim_absolute() {", "prim_absolute()  {"),
    ],
  ])("treats %s inside a block as a change", (_label, edit) => {
    const root = repository("hand-edit");
    const path = join(root, ".git", "hooks", "post-rewrite");
    const edited = edit(managedHookBlock("post-rewrite"));
    expect(edited).not.toBe(managedHookBlock("post-rewrite"));
    writeFileSync(path, `#!/bin/sh\n${edited}\n`, { mode: 0o755 });
    expect(inspectEffectiveGitHook("post-rewrite", root).reason).toBe("stale_block");
  });

  it("never strips a shared hooks dir on project uninstall", () => {
    const root = repository("uninstall-shared");
    const shared = temp("uninstall-shared-hooks");
    git(root, "config", "--local", "core.hooksPath", shared);
    const path = join(shared, "post-commit");
    const content = `#!/bin/sh\n${managedHookBlock("post-commit")}\nteam\n`;
    writeFileSync(path, content, { mode: 0o755 });
    expect(uninstallProjectGitHook("post-commit", root)).toMatchObject({
      changed: false,
      skipped: "external",
    });
    expect(readFileSync(path, "utf8")).toBe(content);
  });
});
