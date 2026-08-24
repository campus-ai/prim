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
  const candidate = value?.trim();
  return candidate && isAbsolute(candidate) ? normalize(candidate) : undefined;
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

  return {
    path: join(options.homeDir ?? homedir(), ".config", "prim"),
    source: "default",
  };
}

export function primConfigDirectory(options: PrimConfigDirectoryOptions = {}): string {
  return resolvePrimConfigDirectory(options).path;
}
