/**
 * The daemon read-proxy's env-binding check: a daemon bound to one deployment
 * must not answer a caller targeting another. These pin the URL comparison the
 * refusal turns on.
 */

import { describe, expect, it } from "vitest";
import {
  apiUrlsMatch,
  assertCallerEnvMatches,
  isCrossEnv,
  normalizeApiUrl,
} from "./env-binding.js";

const PROD = "https://api.getprimitive.ai";
const STAGING = "https://ceaseless-lemur-432.convex.site";

describe("normalizeApiUrl", () => {
  it("strips trailing slashes and surrounding whitespace", () => {
    expect(normalizeApiUrl(`${PROD}/`)).toBe(PROD);
    expect(normalizeApiUrl(`  ${PROD}//  `)).toBe(PROD);
    expect(normalizeApiUrl(PROD)).toBe(PROD);
  });
});

describe("apiUrlsMatch", () => {
  it("matches the same deployment regardless of trailing slash / whitespace", () => {
    expect(apiUrlsMatch(PROD, PROD)).toBe(true);
    expect(apiUrlsMatch(PROD, `${PROD}/`)).toBe(true);
    expect(apiUrlsMatch(` ${PROD} `, PROD)).toBe(true);
  });

  it("does NOT match different deployments — the cross-env leak this closes", () => {
    expect(apiUrlsMatch(PROD, STAGING)).toBe(false);
    expect(apiUrlsMatch(STAGING, PROD)).toBe(false);
  });
});

describe("isCrossEnv — the shared check (reads throw, presence withholds)", () => {
  it("is true only when a string callerEnv targets a different deployment", () => {
    expect(isCrossEnv(STAGING, PROD)).toBe(true);
    expect(isCrossEnv(PROD, PROD)).toBe(false);
    expect(isCrossEnv(`${PROD}/`, PROD)).toBe(false);
  });

  it("is false for a non-string callerEnv — an older CLI sends none", () => {
    expect(isCrossEnv(undefined, PROD)).toBe(false);
    expect(isCrossEnv(123, PROD)).toBe(false);
  });
});

describe("assertCallerEnvMatches — the daemon refusal that triggers fall-through", () => {
  it("throws when the caller targets a different deployment (→ ok:false → direct)", () => {
    expect(() => assertCallerEnvMatches(STAGING, PROD)).toThrow(/env mismatch/);
    expect(() => assertCallerEnvMatches(PROD, STAGING)).toThrow(/env mismatch/);
  });

  it("passes when the envs match, slash/whitespace-tolerant", () => {
    expect(() => assertCallerEnvMatches(PROD, PROD)).not.toThrow();
    expect(() => assertCallerEnvMatches(`${PROD}/`, PROD)).not.toThrow();
  });

  it("passes a non-string callerEnv — an older CLI sends none, served as before", () => {
    expect(() => assertCallerEnvMatches(undefined, PROD)).not.toThrow();
    expect(() => assertCallerEnvMatches(123, PROD)).not.toThrow();
  });
});
