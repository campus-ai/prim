import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pinnedNpxCommand } from "./bin-path.js";
import {
  PRIM_POST_REWRITE_BLOCK_END,
  PRIM_POST_REWRITE_BLOCK_START,
  ensurePostRewriteHookAtPath,
  postRewriteHookBlock,
  uninstallPostRewriteHookAtPath,
} from "./post-commit-hook.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function write(cwd: string, relative: string, contents: string): void {
  writeFileSync(join(cwd, relative), contents);
}

function commit(cwd: string, message: string): string {
  git(cwd, ["add", "."]);
  git(cwd, ["commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

type HookRepo = {
  root: string;
  capturePath: string;
  pairsPathLog: string;
  tempDir: string;
  env: NodeJS.ProcessEnv;
};

function initializedRepository(): HookRepo {
  const root = temporaryDirectory("prim-post-rewrite-git-");
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "prim@example.com"]);
  git(root, ["config", "user.name", "Prim Test"]);
  git(root, ["config", "prim.active", "true"]);
  git(root, ["config", "core.hooksPath", ".git/hooks"]);
  const cacheHome = temporaryDirectory("prim-post-rewrite-cache-");
  const binDir = join(cacheHome, "prim", "bin");
  mkdirSync(binDir, { recursive: true });
  const fakeDriver = join(cacheHome, "prim-post-rewrite");
  writeFileSync(
    fakeDriver,
    `#!/bin/sh
{
  printf 'source=%s\\nbranch=%s\\n' "$PRIM_REWRITE_SOURCE" "$PRIM_REWRITE_BRANCH"
  cat "$PRIM_REWRITE_PAIRS_FILE"
  printf '%s\\n' '<<<end>>>'
} >> "$PRIM_TEST_DRIVER_CAPTURE"
printf '%s\\n' "$PRIM_REWRITE_PAIRS_FILE" >> "$PRIM_TEST_PAIRS_PATH_LOG"
`,
    { mode: 0o755 },
  );
  chmodSync(fakeDriver, 0o755);
  writeFileSync(join(binDir, "node"), "/bin/sh\n");
  writeFileSync(join(binDir, "prim-post-rewrite"), `${fakeDriver}\n`);
  const capturePath = join(root, "rewrite-capture.txt");
  const pairsPathLog = join(root, "rewrite-pairs-paths.txt");
  const tempDir = join(root, "hook-tmp");
  mkdirSync(tempDir);
  return {
    root,
    capturePath,
    pairsPathLog,
    tempDir,
    env: {
      ...process.env,
      PRIM_BIN_CACHE: "1",
      XDG_CACHE_HOME: cacheHome,
      PRIM_TEST_DRIVER_CAPTURE: capturePath,
      PRIM_TEST_PAIRS_PATH_LOG: pairsPathLog,
      TMPDIR: tempDir,
    },
  };
}

function installRewriteHook(repo: HookRepo, foreignTail = ""): void {
  const path = join(repo.root, ".git", "hooks", "post-rewrite");
  writeFileSync(path, `#!/bin/sh\n${postRewriteHookBlock()}\n${foreignTail}`, { mode: 0o755 });
  chmodSync(path, 0o755);
}

function waitForCapture(repo: HookRepo, invocations = 1): string {
  const deadline = Date.now() + 3_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  let last = "";
  let stableSince = 0;
  while (Date.now() < deadline) {
    if (existsSync(repo.capturePath)) {
      const value = readFileSync(repo.capturePath, "utf8");
      const complete = value.split("<<<end>>>").length - 1 >= invocations;
      const noTemporaryFiles = readdirSync(repo.tempDir).length === 0;
      if (complete && noTemporaryFiles) {
        if (value !== last) {
          last = value;
          stableSince = Date.now();
        } else if (Date.now() - stableSince >= 100) {
          return value;
        }
      }
    }
    Atomics.wait(sleeper, 0, 0, 10);
  }
  throw new Error("timed out waiting for detached post-rewrite capture");
}

function expectLauncherFilesRemoved(repo: HookRepo): void {
  const paths = existsSync(repo.pairsPathLog)
    ? readFileSync(repo.pairsPathLog, "utf8").trim().split("\n").filter(Boolean)
    : [];
  expect(paths.length).toBeGreaterThan(0);
  for (const path of paths) expect(existsSync(path)).toBe(false);
  expect(readdirSync(repo.tempDir)).toEqual([]);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("post-rewrite managed hook", () => {
  it("captures synchronously, re-arms stdin, and launches through every fail-soft branch", () => {
    const block = postRewriteHookBlock();
    expect(block).toContain(PRIM_POST_REWRITE_BLOCK_START);
    expect(block).toContain(PRIM_POST_REWRITE_BLOCK_END);
    expect(block).toContain('case "$1" in amend|rebase)');
    expect(block).toContain('cat > "$prim_rewrite_pairs_file"');
    expect(block).toContain('exec < "$prim_rewrite_pairs_file"');
    expect(block.indexOf('exec < "$prim_rewrite_pairs_file"')).toBeLessThan(
      block.indexOf("prim_post_rewrite_ran"),
    );
    expect(block).toContain("chmod 600");
    expect(block).toContain('"$prim_cache_dir/prim-post-rewrite"');
    expect(block).toContain(pinnedNpxCommand("prim-post-rewrite"));
    expect(block).toContain("--ignore-scripts");
    expect(block).not.toContain("@latest");
    expect(block).not.toContain("./node_modules/.bin/prim-post-rewrite");
    expect(block).toContain("rm -f");
  });

  it("merges idempotently after the shebang and removes only its own created scaffold", () => {
    const directory = temporaryDirectory("prim-post-rewrite-engine-");
    const path = join(directory, "post-rewrite");
    const first = ensurePostRewriteHookAtPath(path);
    expect(first).toMatchObject({ changed: true, kind: "direct" });
    const installed = readFileSync(path, "utf8");
    expect(installed).toBe(
      `#!/bin/sh\n${postRewriteHookBlock()}\n# prim-created-post-rewrite-hook\n`,
    );
    expect(ensurePostRewriteHookAtPath(path).changed).toBe(false);
    expect(uninstallPostRewriteHookAtPath(path)).toMatchObject({
      changed: true,
      removedFile: true,
    });
    expect(existsSync(path)).toBe(false);
  });

  it("preserves foreign bytes and never applies post-commit legacy migrations", () => {
    const directory = temporaryDirectory("prim-post-rewrite-engine-");
    const path = join(directory, "post-rewrite");
    const legacyPostCommit = `#!/bin/sh
# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)

prim-post-commit || true
foreign-tool "$@"
`;
    writeFileSync(path, legacyPostCommit, { mode: 0o755 });

    ensurePostRewriteHookAtPath(path);

    const installed = readFileSync(path, "utf8");
    expect(installed).toContain(postRewriteHookBlock());
    expect(installed).toContain("# prim post-commit hook — installed by:");
    expect(installed).toContain("prim-post-commit || true");
    expect(installed).toContain('foreign-tool "$@"');
  });

  it("re-feeds the exact stdin bytes to a chained foreign body", () => {
    const repo = initializedRepository();
    const foreignCapture = join(repo.root, "foreign-capture.txt");
    installRewriteHook(repo, 'cat > "$PRIM_TEST_FOREIGN_CAPTURE"\n');
    const pairs = `${"a".repeat(40)} ${"b".repeat(40)}\n${"c".repeat(40)} ${"d".repeat(40)}\n`;
    execFileSync(join(repo.root, ".git", "hooks", "post-rewrite"), ["rebase"], {
      cwd: repo.root,
      env: { ...repo.env, PRIM_TEST_FOREIGN_CAPTURE: foreignCapture },
      input: pairs,
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(readFileSync(foreignCapture, "utf8")).toBe(pairs);
    expect(waitForCapture(repo)).toContain(pairs);
    expectLauncherFilesRemoved(repo);
  });

  it("passes stdin through unchanged without launching in an inactive repository", () => {
    const repo = initializedRepository();
    git(repo.root, ["config", "prim.active", "false"]);
    const foreignCapture = join(repo.root, "foreign-capture.txt");
    installRewriteHook(repo, 'cat > "$PRIM_TEST_FOREIGN_CAPTURE"\n');
    const pairs = `${"a".repeat(40)} ${"b".repeat(40)}\n`;
    execFileSync(join(repo.root, ".git", "hooks", "post-rewrite"), ["rebase"], {
      cwd: repo.root,
      env: { ...repo.env, PRIM_TEST_FOREIGN_CAPTURE: foreignCapture },
      input: pairs,
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(readFileSync(foreignCapture, "utf8")).toBe(pairs);
    expect(existsSync(repo.capturePath)).toBe(false);
    expect(readdirSync(repo.tempDir)).toEqual([]);
  });
});

describe("post-rewrite fired by real Git", () => {
  it("captures one exact pair for amend", () => {
    const repo = initializedRepository();
    write(repo.root, "file.txt", "first\n");
    const oldSha = commit(repo.root, "first");
    installRewriteHook(repo);
    write(repo.root, "file.txt", "amended\n");
    git(repo.root, ["add", "."]);
    git(repo.root, ["commit", "--amend", "--no-edit"], repo.env);
    const newSha = git(repo.root, ["rev-parse", "HEAD"]);

    const captured = waitForCapture(repo);
    expect(captured).toContain("source=amend");
    expect(captured).toContain(`${oldSha} ${newSha}\n`);
    expect(captured.match(/^[0-9a-f]{40} [0-9a-f]{40}$/gmu)).toHaveLength(1);
    expectLauncherFilesRemoved(repo);
  }, 15_000);

  it("captures every rewritten commit when rebasing onto a moved base", () => {
    const repo = initializedRepository();
    write(repo.root, "base.txt", "base\n");
    commit(repo.root, "base");
    git(repo.root, ["checkout", "-b", "feature"]);
    for (let index = 1; index <= 3; index += 1) {
      write(repo.root, `feature-${String(index)}.txt`, `${String(index)}\n`);
      commit(repo.root, `feature ${String(index)}`);
    }
    git(repo.root, ["checkout", "main"]);
    write(repo.root, "main.txt", "moved base\n");
    commit(repo.root, "move base");
    git(repo.root, ["checkout", "feature"]);
    installRewriteHook(repo);

    git(repo.root, ["rebase", "main"], repo.env);

    const captured = waitForCapture(repo);
    expect(captured).toContain("source=rebase");
    expect(captured.match(/^[0-9a-f]{40} [0-9a-f]{40}$/gmu)).toHaveLength(3);
    expectLauncherFilesRemoved(repo);
  }, 15_000);

  it("preserves a many-to-one mapping produced by an interactive squash", () => {
    const repo = initializedRepository();
    for (let index = 1; index <= 3; index += 1) {
      write(repo.root, `file-${String(index)}.txt`, `${String(index)}\n`);
      commit(repo.root, `commit ${String(index)}`);
    }
    const editor = join(repo.root, "sequence-editor.sh");
    writeFileSync(
      editor,
      `#!/bin/sh
awk 'NR == 2 { sub(/^pick /, "squash ") } { print }' "$1" > "$1.prim"
mv "$1.prim" "$1"
`,
      { mode: 0o755 },
    );
    chmodSync(editor, 0o755);
    installRewriteHook(repo);

    git(repo.root, ["rebase", "-i", "--root"], {
      ...repo.env,
      GIT_SEQUENCE_EDITOR: editor,
      GIT_EDITOR: "true",
    });

    const captured = waitForCapture(repo);
    const pairs = [...captured.matchAll(/^([0-9a-f]{40}) ([0-9a-f]{40})$/gmu)].map((match) => ({
      oldSha: match[1],
      newSha: match[2],
    }));
    expect(pairs.length).toBeGreaterThanOrEqual(3);
    expect(new Set(pairs.map((pair) => pair.newSha)).size).toBeLessThan(pairs.length);
    expectLauncherFilesRemoved(repo);
  }, 15_000);

  it("emits nothing and leaves no temp file when a conflicted rebase is aborted", () => {
    const repo = initializedRepository();
    write(repo.root, "conflict.txt", "base\n");
    commit(repo.root, "base");
    git(repo.root, ["checkout", "-b", "feature"]);
    write(repo.root, "conflict.txt", "feature\n");
    commit(repo.root, "feature");
    git(repo.root, ["checkout", "main"]);
    write(repo.root, "conflict.txt", "main\n");
    commit(repo.root, "main");
    git(repo.root, ["checkout", "feature"]);
    installRewriteHook(repo);

    expect(() => git(repo.root, ["rebase", "main"], repo.env)).toThrow();
    git(repo.root, ["rebase", "--abort"], repo.env);

    expect(existsSync(repo.capturePath)).toBe(false);
    expect(existsSync(repo.pairsPathLog)).toBe(false);
    expect(readdirSync(repo.tempDir)).toEqual([]);
  }, 15_000);
});
