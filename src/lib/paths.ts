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
  const candidate = value?.trim();
  return candidate && isAbsolute(candidate) ? normalize(candidate) : undefined;
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

  return {
    path: join(options.homeDir ?? homedir(), ".config", "prim"),
    source: "default",
  };
}

export function primConfigDirectory(options: PrimConfigDirectoryOptions = {}): string {
  return resolvePrimConfigDirectory(options).path;
}
