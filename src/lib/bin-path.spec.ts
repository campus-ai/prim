/**
 * `bin-path` coverage — bin resolution for spawning + the settings.json shim.
 *
 * Runs against the `src/` layout (no build needed): locateRoot walks up to the
 * repo's own package.json, so binFile returns paths under the real `dist/` tree
 * as declared in the `bin` map — including the stem mismatches a naive
 * `name + ".js"` would get wrong.
 */
import { isAbsolute } from "node:path";
import { describe, expect, it } from "vitest";
import { binFile, commandMatchesBin, hookShimCommand } from "./bin-path.js";

describe("binFile", () => {
  it("resolves the daemon server to an absolute dist path", () => {
    const file = binFile("prim-daemon-server");
    expect(file).not.toBeNull();
    expect(isAbsolute(file as string)).toBe(true);
    expect(file).toMatch(/\/dist\/daemon\/server\.js$/);
  });

  it("honors the bin-map stem mismatches (bin name != filename)", () => {
    expect(binFile("prim-pre-tool-use")).toMatch(/\/dist\/hooks\/pre-tool-use\.js$/);
    expect(binFile("prim-hook")).toMatch(/\/dist\/hooks\/prim-hook\.js$/);
  });

  it("returns null for an unknown bin", () => {
    expect(binFile("prim-nonesuch")).toBeNull();
  });
});

describe("hookShimCommand", () => {
  it("emits a PATH -> node_modules -> npx@latest resolution ladder", () => {
    const cmd = hookShimCommand("prim-hook");
    expect(cmd).toContain("command -v prim-hook >/dev/null 2>&1");
    expect(cmd).toContain('elif [ -f "./node_modules/.bin/prim-hook" ]');
    expect(cmd).toContain("npx --yes -p @primitive.ai/prim@latest prim-hook");
    // No stdio/exit suppression — the hook's STDOUT + exit code must pass through.
    expect(cmd).not.toContain("|| true");
    expect(cmd).not.toContain("2>/dev/null; ");
  });

  it("threads args through every branch (codex, statusline)", () => {
    const codex = hookShimCommand("prim-hook", "--agent codex");
    expect(codex).toContain("then prim-hook --agent codex;");
    expect(codex).toContain("./node_modules/.bin/prim-hook --agent codex;");
    expect(codex).toContain("@primitive.ai/prim@latest prim-hook --agent codex;");

    const status = hookShimCommand("prim", "statusline");
    expect(status).toContain("command -v prim >/dev/null 2>&1");
    expect(status).toContain("then prim statusline;");
  });
});

describe("commandMatchesBin", () => {
  it("matches the legacy bare form, with or without args", () => {
    expect(commandMatchesBin("prim-hook", "prim-hook")).toBe(true);
    expect(commandMatchesBin("prim-hook --agent codex", "prim-hook")).toBe(true);
  });

  it("matches the current shim form", () => {
    expect(commandMatchesBin(hookShimCommand("prim-hook"), "prim-hook")).toBe(true);
    expect(commandMatchesBin(hookShimCommand("prim-hook", "--agent codex"), "prim-hook")).toBe(
      true,
    );
  });

  it("does not cross-match a sibling bin", () => {
    expect(commandMatchesBin(hookShimCommand("prim-post-tool-use"), "prim-pre-tool-use")).toBe(
      false,
    );
    expect(commandMatchesBin("prim-post-tool-use", "prim-pre-tool-use")).toBe(false);
  });

  it("does not match a foreign command or undefined", () => {
    expect(commandMatchesBin("/usr/local/bin/other", "prim-hook")).toBe(false);
    expect(commandMatchesBin(undefined, "prim-hook")).toBe(false);
  });
});
