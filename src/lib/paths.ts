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

const UNSAFE_CONFIG_PATH_CHARACTERS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

function absolutePath(value: string | undefined, variable: string): string | undefined {
  if (value !== undefined && UNSAFE_CONFIG_PATH_CHARACTERS.test(value)) {
    throw new Error(`${variable} contains unsafe characters`);
  }
  if (!value || value.trim() !== value || !isAbsolute(value)) return;
  const normalized = normalize(value);
  return normalized === value ? value : undefined;
}

/** Resolve Primitive's configuration directory without consulting the cwd. */
export function resolvePrimConfigDirectory(
  options: PrimConfigDirectoryOptions = {},
): PrimConfigDirectory {
  const env = options.env ?? process.env;
  const explicit = absolutePath(env.PRIM_CONFIG_DIR, "PRIM_CONFIG_DIR");
  if (explicit) return { path: explicit, source: "explicit" };

  const xdgConfigHome = absolutePath(env.XDG_CONFIG_HOME, "XDG_CONFIG_HOME");
  if (xdgConfigHome) return { path: join(xdgConfigHome, "prim"), source: "xdg" };

  const home = absolutePath(options.homeDir ?? homedir(), "HOME");
  if (!home) {
    throw new Error("cannot resolve Primitive config directory: HOME is not an absolute path");
  }
  return { path: join(home, ".config", "prim"), source: "default" };
}

export function primConfigDirectory(options: PrimConfigDirectoryOptions = {}): string {
  return resolvePrimConfigDirectory(options).path;
}
