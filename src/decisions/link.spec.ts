/**
 * `prim decisions link|unlink` — formatter + fetch-folding coverage.
 *
 * Asserts the human verdict ECHOES the dependency direction in words (the AX
 * guard against a mistaken `--on`), the idempotent and rejection variants, and
 * that fetchLink/fetchUnlink fold the server's HTTP status (404 → throw, 409 →
 * ambiguous, 422 → self_loop/would_cycle) back onto the one outcome union via an
 * injected client stub.
 */

import { describe, expect, it } from "vitest";
import type { CliClient } from "../client.js";
import {
  LinkNotFoundError,
  type RelateOutcome,
  type RelateResult,
  fetchLink,
  fetchUnlink,
  formatRelateHuman,
  formatRelateJson,
  isRelateRejection,
} from "./link.js";

const CHILD_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const CHILD_SHORT = "230a72aa";
const PARENT_ID = "r570h4fj4sdza47zxzs9taend9899td2";
const PARENT_SHORT = "3a4b96d9";

const endpoints = {
  childId: CHILD_ID,
  childShortId: CHILD_SHORT,
  parentId: PARENT_ID,
  parentShortId: PARENT_SHORT,
};

const REQUEST = { child: "dec_230a72aa", parent: "dec_3a4b96d9" };
const result = (outcome: RelateOutcome): RelateResult => ({ request: REQUEST, outcome });

/** A CliClient whose post resolves to `body` or rejects with `error`. */
function stub(opts: { body?: unknown; error?: Error }): CliClient {
  return {
    get: () => Promise.reject(new Error("unused")),
    post: () => (opts.error ? Promise.reject(opts.error) : Promise.resolve(opts.body)),
  };
}

describe("formatRelateHuman — resolved outcomes echo direction", () => {
  it("linked: child now depends on parent", () => {
    expect(formatRelateHuman(result({ outcome: "linked", ...endpoints }))).toBe(
      "[prim] dec_230a72aa now depends on dec_3a4b96d9.",
    );
  });

  it("already_linked: idempotent no-op", () => {
    const out = formatRelateHuman(result({ outcome: "already_linked", ...endpoints }));
    expect(out).toContain("already depends on");
    expect(out).toContain("nothing to change");
  });

  it("unlinked: child no longer depends on parent", () => {
    expect(formatRelateHuman(result({ outcome: "unlinked", ...endpoints }))).toBe(
      "[prim] dec_230a72aa no longer depends on dec_3a4b96d9.",
    );
  });

  it("not_linked: idempotent no-op", () => {
    const out = formatRelateHuman(result({ outcome: "not_linked", ...endpoints }));
    expect(out).toContain("did not depend on");
    expect(out).toContain("nothing to change");
  });

  it("falls back to raw ids when shortIds are absent", () => {
    const out = formatRelateHuman(
      result({
        outcome: "linked",
        childId: CHILD_ID,
        childShortId: undefined,
        parentId: PARENT_ID,
        parentShortId: undefined,
      }),
    );
    expect(out).toBe(`[prim] ${CHILD_ID} now depends on ${PARENT_ID}.`);
  });
});

describe("formatRelateHuman — rejections", () => {
  it("self_loop", () => {
    expect(formatRelateHuman(result({ outcome: "self_loop" }))).toContain(
      "cannot depend on itself",
    );
  });

  it("would_cycle surfaces the rendered path", () => {
    const out = formatRelateHuman(
      result({
        outcome: "would_cycle",
        detail: "this link would create a dependency cycle: dec_a → dec_b",
      }),
    );
    expect(out).toContain("refusing to link");
    expect(out).toContain("dec_a → dec_b");
  });

  it("ambiguous names which id the user typed", () => {
    const out = formatRelateHuman(result({ outcome: "ambiguous", which: "parent" }));
    expect(out).toContain('the parent id "dec_3a4b96d9" is ambiguous');
  });

  it("renders the walk_cap detail (the fail-closed precaution message)", () => {
    const out = formatRelateHuman(
      result({
        outcome: "would_cycle",
        detail:
          "the dependency chain is too long to verify it would not create a cycle — refusing as a precaution",
      }),
    );
    expect(out).toContain("too long to verify");
    expect(out).toContain("cycle");
  });
});

describe("isRelateRejection", () => {
  it("flags self_loop / would_cycle / ambiguous, not the resolved cases", () => {
    expect(isRelateRejection({ outcome: "self_loop" })).toBe(true);
    expect(isRelateRejection({ outcome: "would_cycle", detail: "x" })).toBe(true);
    expect(isRelateRejection({ outcome: "ambiguous", which: "child" })).toBe(true);
    expect(isRelateRejection({ outcome: "linked", ...endpoints })).toBe(false);
    expect(isRelateRejection({ outcome: "not_linked", ...endpoints })).toBe(false);
  });
});

describe("fetchLink / fetchUnlink — HTTP folding", () => {
  it("returns the 200 outcome body verbatim", async () => {
    const body = { outcome: "linked", ...endpoints };
    const res = await fetchLink("dec_230a72aa", "dec_3a4b96d9", {
      getClient: () => stub({ body }),
    });
    expect(res.outcome).toEqual(body);
  });

  it("folds 404 into LinkNotFoundError (naming which side)", async () => {
    await expect(
      fetchLink("x", "y", {
        getClient: () => stub({ error: new Error("Decision not found: parent") }),
      }),
    ).rejects.toBeInstanceOf(LinkNotFoundError);
  });

  it("folds 409 into ambiguous", async () => {
    const res = await fetchLink("x", "y", {
      getClient: () =>
        stub({ error: new Error("shortId is ambiguous in this organization (child)") }),
    });
    expect(res.outcome).toEqual({ outcome: "ambiguous", which: "child" });
  });

  it("folds 422 cycle into would_cycle with the detail", async () => {
    const res = await fetchLink("x", "y", {
      getClient: () =>
        stub({ error: new Error("this link would create a dependency cycle: dec_a → dec_b") }),
    });
    expect(res.outcome).toEqual({
      outcome: "would_cycle",
      detail: "this link would create a dependency cycle: dec_a → dec_b",
    });
  });

  it("folds the 422 walk_cap message into would_cycle (NOT not_found)", async () => {
    // The fail-closed bailout: its message means the OPPOSITE of a proven cycle
    // ("would not create a cycle"), but still carries the word "cycle" so the
    // /cycle/i fold wins. Critically, /not found/i must NOT match "would not".
    const walkCap =
      "the dependency chain is too long to verify it would not create a cycle — refusing as a precaution";
    const res = await fetchLink("x", "y", {
      getClient: () => stub({ error: new Error(walkCap) }),
    });
    expect(res.outcome).toEqual({ outcome: "would_cycle", detail: walkCap });
  });

  it("folds 409 into ambiguous on the parent side", async () => {
    const res = await fetchLink("x", "y", {
      getClient: () =>
        stub({ error: new Error("shortId is ambiguous in this organization (parent)") }),
    });
    expect(res.outcome).toEqual({ outcome: "ambiguous", which: "parent" });
  });

  it("folds 422 self-loop into self_loop", async () => {
    const res = await fetchLink("x", "x", {
      getClient: () => stub({ error: new Error("a decision cannot depend on itself") }),
    });
    expect(res.outcome).toEqual({ outcome: "self_loop" });
  });

  it("unlink folds not-found the same way", async () => {
    await expect(
      fetchUnlink("x", "y", {
        getClient: () => stub({ error: new Error("Decision not found: child") }),
      }),
    ).rejects.toBeInstanceOf(LinkNotFoundError);
  });

  it("rethrows an unmapped transport error", async () => {
    await expect(
      fetchLink("x", "y", { getClient: () => stub({ error: new Error("network timeout") }) }),
    ).rejects.toThrow("network timeout");
  });
});

describe("formatRelateJson", () => {
  it("emits the outcome verbatim", () => {
    const parsed = JSON.parse(formatRelateJson(result({ outcome: "linked", ...endpoints }))) as {
      outcome: string;
    };
    expect(parsed.outcome).toBe("linked");
  });
});
