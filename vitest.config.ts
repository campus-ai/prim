import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // prim now emits color unconditionally (sans NO_COLOR). Force NO_COLOR in
    // the test env so content-assertion specs compare against plain text; the
    // color path itself is covered explicitly in src/lib/ansi.spec.ts.
    env: { NO_COLOR: "1" },
    include: ["src/**/*.spec.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: ["**/*.d.ts", "**/node_modules/**", "**/dist/**"],
    },
  },
});
