import type { DecisionFeedRow } from "../decisions/recent.js";

export const DECISION_DIGEST_CACHE_WARMING = "daemon Decision cache warming";
export const DECISION_DIGEST_CACHE_LIMIT = 100;
export const DECISION_DIGEST_CACHE_WINDOW = "24h";
export const DECISION_DIGEST_CACHE_PATH =
  `/api/cli/decisions/recent?limit=${String(DECISION_DIGEST_CACHE_LIMIT)}` +
  `&since=${DECISION_DIGEST_CACHE_WINDOW}`;

export interface DecisionDigestCacheSnapshot {
  decisions: DecisionFeedRow[];
  /** Time of the last structurally valid server response. */
  cachedAt?: number;
  /** Present until the daemon has a verified feed snapshot. */
  unavailable?: string;
}

type DecisionDigestResponse = {
  decisions?: unknown;
  unavailable?: unknown;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Daemon-owned, in-memory snapshot of the organization Decision feed.
 *
 * Refreshes collapse onto one request. Once a valid snapshot exists, a later
 * transport failure leaves that last-known-good snapshot readable: prompt
 * hooks stay local and fast while the daemon retries in the background.
 */
export class DecisionDigestCache {
  private snapshot: DecisionDigestCacheSnapshot = {
    decisions: [],
    unavailable: DECISION_DIGEST_CACHE_WARMING,
  };

  private refreshInFlight: Promise<void> | undefined;

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  read(): DecisionDigestCacheSnapshot {
    return { ...this.snapshot, decisions: [...this.snapshot.decisions] };
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    this.refreshInFlight = this.performRefresh().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  private async performRefresh(): Promise<void> {
    try {
      const value = (await this.load()) as DecisionDigestResponse;
      if (typeof value !== "object" || value === null || !Array.isArray(value.decisions)) {
        throw new Error("malformed Decision feed response");
      }
      this.snapshot = {
        decisions: value.decisions as DecisionFeedRow[],
        cachedAt: this.now(),
        unavailable: typeof value.unavailable === "string" ? value.unavailable : undefined,
      };
    } catch (error) {
      // Never replace a last-known-good page with a transient transport error.
      // Before the first valid page, retain UNKNOWN so hooks cannot spend their
      // startup cursor on a feed the daemon never verified.
      if (this.snapshot.cachedAt === undefined) {
        this.snapshot = {
          decisions: [],
          unavailable: `daemon Decision cache unavailable: ${errorMessage(error)}`,
        };
      }
    }
  }
}
