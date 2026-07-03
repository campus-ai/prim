import { readFileSync } from "node:fs";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

// Mirrors tsup's `--loader ".html=text" / ".svg=text"`: the auth callback
// pages import their HTML templates and SVG assets as plain strings.
const textAssets: Plugin = {
  name: "text-assets",
  enforce: "pre",
  load(id) {
    const path = id.split("?")[0];
    if (path.endsWith(".html") || path.endsWith(".svg")) {
      return `export default ${JSON.stringify(readFileSync(path, "utf-8"))};`;
    }
  },
};

export default defineConfig({
  plugins: [textAssets],
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
