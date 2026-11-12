import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
export const KEYRING_LOADER = 'module.exports = require("./keyring.node");\n';
export const KEYRING_NATIVE_FILES = ["native/keyring.cjs", "native/keyring.node"] as const;

/** Resolve the installed target-platform dependency when staging, never at build time. */
export function keyringNativeBinary(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const binary = join(directory, "native", "keyring.node");
    if (existsSync(binary)) return binary;
    directory = dirname(directory);
  }
  const packagePath = require.resolve("@napi-rs/keyring");
  require(packagePath);
  const entry = require.cache[packagePath];
  const binary = entry?.children.find(
    (child) => child.filename.endsWith(".node") && child.filename.includes("keyring"),
  );
  if (!binary || !existsSync(binary.filename))
    throw new Error(
      "Cannot stage the native credential store; reinstall Prim with optional dependencies enabled.",
    );
  return binary.filename;
}
