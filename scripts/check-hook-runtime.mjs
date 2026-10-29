import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "prim-hook-runtime-smoke-"));
const home = join(root, "home");
const config = join(root, "config");
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const env = {
  ...process.env,
  HOME: home,
  PRIM_CONFIG_DIR: config,
  XDG_CACHE_HOME: join(root, "cache"),
  PRIM_UNINSTALL_ORCHESTRATOR: "1",
  PRIM_HOOK_MODE: "block",
  PRIM_BYPASS: "",
  PRIM_TOKEN: "",
  PRIM_API_URL: "http://127.0.0.1:1",
};

function run(file, args, input, cwd = packageRoot) {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    env,
    input,
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${file} ${args.join(" ")} failed: ${result.error?.message ?? result.stderr ?? `status ${result.status}`}`,
    );
  }
  return result.stdout;
}

try {
  mkdirSync(home, { recursive: true });
  run(process.execPath, ["dist/index.js", "claude", "install", "--scope", "user"]);
  const output = run(join(config, "prim-hook-launcher-v1"), ["prim-session-start"], "{}").trim();
  if (output !== "{}") throw new Error(`prim-session-start emitted unexpected output: ${output}`);
  const settings = JSON.parse(readFileSync(join(home, ".claude/settings.json"), "utf8"));
  if (
    !settings.hooks.PreToolUse.some(
      (entry) =>
        entry.matcher?.split("|").includes("Bash") &&
        entry.hooks.some((hook) => hook.command.includes("prim-pre-tool-use")),
    )
  ) {
    throw new Error("Installed Claude gate does not match Bash");
  }
  const repo = join(root, "repo");
  mkdirSync(repo);
  run("git", ["init", "--quiet"], undefined, repo);
  run("git", ["config", "--local", "prim.active", "true"], undefined, repo);
  const entries = [
    [process.execPath, [join(packageRoot, "dist/hooks/pre-tool-use.js")]],
    [process.execPath, [join(packageRoot, "dist/hook-runtime/hooks/pre-tool-use.js")]],
    [join(config, "prim-hook-launcher-v1"), ["prim-pre-tool-use"]],
  ];
  const cases = [
    ["python3 edit.py", "shell command write targets could not be determined"],
    ['python3 -c \'open("a.ts", "w").write("hi")\'', "GitHub repo connection is required"],
    ['node -e \'require("fs").writeFileSync("a.ts", "hi")\'', "GitHub repo connection is required"],
    ["git status --short", undefined],
  ];
  for (const [file, args] of entries) {
    for (const [command, message] of cases) {
      const envelope = {
        hook_event_name: "PreToolUse",
        session_id: "shell-golden",
        tool_use_id: "call",
        tool_name: "Bash",
        tool_input: { command },
        cwd: repo,
      };
      const result = JSON.parse(run(file, args, JSON.stringify(envelope), repo));
      if (result.hookSpecificOutput?.permissionDecision !== (message ? "deny" : "allow"))
        throw new Error("Unexpected hook disposition");
      if (message) {
        if (!result.hookSpecificOutput.permissionDecisionReason?.includes(message))
          throw new Error(`Missing explicit pause for ${command}`);
      } else if (result.systemMessage) throw new Error("Read-only command warned");
    }
  }
  process.stdout.write(
    `${JSON.stringify({ status: "pass", hookBundlesAndLauncher: 3, shellCases: cases.length, bashMatcher: "installed" })}\n`,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}
