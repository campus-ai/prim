import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
};

function run(file, args, input) {
  const result = spawnSync(file, args, {
    cwd: packageRoot,
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
} finally {
  rmSync(root, { recursive: true, force: true });
}
