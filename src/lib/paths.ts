import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";

export type PrimConfigDirectorySource = "explicit" | "xdg" | "default";

export interface PrimConfigDirectoryOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface PrimConfigDirectory {
  path: string;
  source: PrimConfigDirectorySource;
}

function absolutePath(value: string | undefined): string | undefined {
  if (!value || value.trim() !== value || !isAbsolute(value)) return;
  const normalized = normalize(value);
  return normalized === value ? value : undefined;
}

/** Resolve Primitive's configuration directory without consulting the cwd. */
export function resolvePrimConfigDirectory(
  options: PrimConfigDirectoryOptions = {},
): PrimConfigDirectory {
  const env = options.env ?? process.env;
  const explicit = absolutePath(env.PRIM_CONFIG_DIR);
  if (explicit) return { path: explicit, source: "explicit" };

  const xdgConfigHome = absolutePath(env.XDG_CONFIG_HOME);
  if (xdgConfigHome) return { path: join(xdgConfigHome, "prim"), source: "xdg" };

  const home = absolutePath(options.homeDir ?? homedir());
  if (!home) {
    throw new Error("cannot resolve Primitive config directory: HOME is not an absolute path");
  }
  return { path: join(home, ".config", "prim"), source: "default" };
}

export function primConfigDirectory(options: PrimConfigDirectoryOptions = {}): string {
  return resolvePrimConfigDirectory(options).path;
}
