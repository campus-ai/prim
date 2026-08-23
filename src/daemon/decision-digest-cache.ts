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
 * Daemon-owned, in-memory snapshot of one credential generation's organization
 * Decision feed. Credential rotation resets the snapshot before another
 * principal can read it.
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

  private generation = 0;

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly now: () => number = Date.now,
  ) {}

  read(): DecisionDigestCacheSnapshot {
    return { ...this.snapshot, decisions: [...this.snapshot.decisions] };
  }

  /** Drop tenant-scoped state and fence any refresh started by the old principal. */
  reset(): void {
    this.generation += 1;
    this.refreshInFlight = undefined;
    this.snapshot = {
      decisions: [],
      unavailable: DECISION_DIGEST_CACHE_WARMING,
    };
  }

  refresh(): Promise<void> {
    if (this.refreshInFlight) return this.refreshInFlight;
    const generation = this.generation;
    const refresh = this.performRefresh(generation).finally(() => {
      if (this.refreshInFlight === refresh) this.refreshInFlight = undefined;
    });
    this.refreshInFlight = refresh;
    return this.refreshInFlight;
  }

  private async performRefresh(generation: number): Promise<void> {
    try {
      const value = (await this.load()) as DecisionDigestResponse;
      if (generation !== this.generation) return;
      if (typeof value !== "object" || value === null || !Array.isArray(value.decisions)) {
        throw new Error("malformed Decision feed response");
      }
      this.snapshot = {
        decisions: value.decisions as DecisionFeedRow[],
        cachedAt: this.now(),
        unavailable: typeof value.unavailable === "string" ? value.unavailable : undefined,
      };
    } catch (error) {
      if (generation !== this.generation) return;
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
