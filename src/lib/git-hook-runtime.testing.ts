/**
 * Test support: stage a fake hook runtime under a config root.
 *
 * The launcher and Git hook entrypoint are the real frozen bytes; only the
 * selected release is fake. Its `node` is `/bin/sh`, so each entry is a shell
 * script, which lets real-Git specs observe exactly what a hook hands to prim.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STABLE_HOOK_LAUNCHER_NAME } from "./bin-path.js";
import { GIT_HOOK_ENTRYPOINT_CONTENT, GIT_HOOK_ENTRYPOINT_NAME } from "./git-hook-contract.js";
import { HOOK_RUNTIME_ENTRIES, STABLE_HOOK_LAUNCHER_CONTENT } from "./hook-runtime.js";

const FAKE_RELEASE = `release-${"0".repeat(64)}`;

export function stageFakeGitHookRuntime(
  configDir: string,
  entries: Partial<Record<keyof typeof HOOK_RUNTIME_ENTRIES, string>> = {},
): void {
  const release = join(configDir, "hook-runtime", "releases", FAKE_RELEASE);
  mkdirSync(release, { recursive: true });
  writeFileSync(join(configDir, STABLE_HOOK_LAUNCHER_NAME), STABLE_HOOK_LAUNCHER_CONTENT, {
    mode: 0o700,
  });
  writeFileSync(join(configDir, GIT_HOOK_ENTRYPOINT_NAME), GIT_HOOK_ENTRYPOINT_CONTENT, {
    mode: 0o700,
  });
  writeFileSync(join(configDir, "hook-runtime", "current"), `${FAKE_RELEASE}\n`);
  writeFileSync(join(release, "node"), "/bin/sh\n");
  for (const [bin, script] of Object.entries(entries)) {
    const target = join(release, HOOK_RUNTIME_ENTRIES[bin as keyof typeof HOOK_RUNTIME_ENTRIES]);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, script ?? "");
  }
}
