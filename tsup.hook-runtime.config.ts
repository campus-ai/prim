import { defineConfig } from "tsup";

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
  clean: true,
});
