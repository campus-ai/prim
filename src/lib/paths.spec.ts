import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePrimConfigDirectory } from "./paths.js";

describe("resolvePrimConfigDirectory", () => {
  it("prefers an explicit absolute override, then XDG, then the home default", () => {
    expect(
      resolvePrimConfigDirectory({
        env: { PRIM_CONFIG_DIR: "/private/prim-config", XDG_CONFIG_HOME: "/xdg" },
        homeDir: "/home/tester",
      }),
    ).toEqual({ path: "/private/prim-config", source: "explicit" });
    expect(
      resolvePrimConfigDirectory({ env: { XDG_CONFIG_HOME: "/xdg" }, homeDir: "/home/tester" }),
    ).toEqual({ path: join("/xdg", "prim"), source: "xdg" });
    expect(resolvePrimConfigDirectory({ env: {}, homeDir: "/home/tester" })).toEqual({
      path: join("/home/tester", ".config", "prim"),
      source: "default",
    });
  });

  it("ignores relative overrides instead of making configuration cwd-dependent", () => {
    expect(
      resolvePrimConfigDirectory({
        env: { PRIM_CONFIG_DIR: "repo-config", XDG_CONFIG_HOME: "relative-xdg" },
        homeDir: "/home/tester",
      }),
    ).toEqual({ path: join("/home/tester", ".config", "prim"), source: "default" });
  });

  it("rejects noncanonical roots and fails closed without an absolute home", () => {
    expect(
      resolvePrimConfigDirectory({
        env: { PRIM_CONFIG_DIR: " /private/prim ", XDG_CONFIG_HOME: "/xdg/../other" },
        homeDir: "/home/tester",
      }),
    ).toEqual({ path: join("/home/tester", ".config", "prim"), source: "default" });
    expect(() => resolvePrimConfigDirectory({ env: {}, homeDir: "relative-home" })).toThrow(
      "HOME is not an absolute path",
    );
  });
});
