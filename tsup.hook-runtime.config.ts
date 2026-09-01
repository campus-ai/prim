import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defineConfig } from "tsup";

const require = createRequire(import.meta.url);
// The node export is CommonJS and esbuild turns its `require("process")` into
// an ESM-incompatible dynamic require. The browser export is dependency-free
// ESM and preserves the parser API used by the staged hooks.
const yamlBrowserEntry = join(dirname(require.resolve("yaml/package.json")), "browser", "index.js");

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "hooks/pre-commit": "src/hooks/pre-commit.ts",
    "hooks/post-commit": "src/hooks/post-commit.ts",
    "hooks/post-rewrite": "src/hooks/post-rewrite.ts",
    "hooks/prim-hook": "src/hooks/prim-hook.ts",
    "hooks/pre-tool-use": "src/hooks/pre-tool-use.ts",
    "hooks/post-tool-use": "src/hooks/post-tool-use.ts",
    "hooks/session-start": "src/hooks/session-start.ts",
    "hooks/session-end": "src/hooks/session-end.ts",
    "daemon/server": "src/daemon/server.ts",
    "statusline-main": "src/statusline-main.ts",
  },
  outDir: "dist/hook-runtime",
  format: ["esm"],
  splitting: false,
  noExternal: [/.*/],
  esbuildOptions(options) {
    options.alias = { ...options.alias, yaml: yamlBrowserEntry };
  },
  clean: true,
});
