/**
 * The load-bearing isolation: a flush targeting one deployment must NEVER drain
 * another deployment's captured moves. `flush()` drives its drain off
 * listBuckets(), so this asserts listBuckets is scoped to the current env's
 * partition — capture under one env, switch envs, and the first env's bucket is
 * invisible. Regression guard for the "staging decisions in production" leak.
 *
 * Uses the real JOURNAL_DIR under throwaway `*.invalid` env slugs (isolated from
 * any real bucket) and cleans them up — no module mocking required.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JOURNAL_DIR, appendMove, listBuckets } from "./journal.js";
import type { Move } from "./protocol/move.js";

const ENV_A = "https://test-env-a.invalid";
const ENV_B = "https://test-env-b.invalid";
const SLUG_A = "test-env-a.invalid";
const SLUG_B = "test-env-b.invalid";

function move(eventType: string): Move {
  return {
    moveId: `m-${eventType}`,
    capturedAt: 1,
    sessionId: "s",
    eventType,
    payload: { ok: true },
    env: { cwd: "/repo", cliVersion: "x", osPlatform: "darwin" },
    envelopeVersion: 1,
  };
}

describe("journal environment isolation", () => {
  const prior = process.env.PRIM_API_URL;
  afterEach(() => {
    if (prior === undefined) {
      process.env.PRIM_API_URL = undefined;
    } else {
      process.env.PRIM_API_URL = prior;
    }
    rmSync(join(JOURNAL_DIR, SLUG_A), { recursive: true, force: true });
    rmSync(join(JOURNAL_DIR, SLUG_B), { recursive: true, force: true });
  });

  it("listBuckets only enumerates the current deployment's captures", () => {
    process.env.PRIM_API_URL = ENV_A;
    appendMove(move("PreToolUse"), "orgTest");
    process.env.PRIM_API_URL = ENV_B;
    appendMove(move("Stop"), "orgTest");

    // A flush under env A enumerates only env A's bucket — never env B's.
    process.env.PRIM_API_URL = ENV_A;
    const a = listBuckets();
    expect(a.some((b) => b.bucket === "orgTest")).toBe(true);
    expect(a.every((b) => b.path.includes(SLUG_A))).toBe(true);
    expect(a.some((b) => b.path.includes(SLUG_B))).toBe(false);

    // And under env B, only env B's.
    process.env.PRIM_API_URL = ENV_B;
    const b = listBuckets();
    expect(b.every((x) => x.path.includes(SLUG_B))).toBe(true);
    expect(b.some((x) => x.path.includes(SLUG_A))).toBe(false);
  });
});
