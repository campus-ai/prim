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
  it.each([
    ["PRIM_CONFIG_DIR", "/private/prim\u001b[2J"],
    ["PRIM_CONFIG_DIR", "/private/prim\u202e"],
    ["XDG_CONFIG_HOME", "/private/.config\u200b"],
    ["XDG_CONFIG_HOME", "/private/.config\u2028"],
  ])("fails closed when %s contains terminal-unsafe characters", (variable, value) => {
    expect(() =>
      resolvePrimConfigDirectory({
        env: { [variable]: value },
        homeDir: "/home/tester",
      }),
    ).toThrow(`${variable} contains unsafe characters`);
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
