import type { DecisionFeedRow } from "../decisions/recent.js";

export const DECISION_DIGEST_CACHE_WARMING = "daemon Decision cache warming";
export const DECISION_DIGEST_CACHE_LIMIT = 100;
export const DECISION_DIGEST_CACHE_WINDOW = "24h";
export const DECISION_DIGEST_CACHE_PATH =
  `/api/cli/decisions/recent?limit=${String(DECISION_DIGEST_CACHE_LIMIT)}` +
  `&since=${DECISION_DIGEST_CACHE_WINDOW}`;
export const DECISION_DRAFT_DIGEST_CACHE_PATH = `${DECISION_DIGEST_CACHE_PATH}&drafts=true`;

export function decisionDraftDigestCachePath(cursor?: string): string {
  return cursor === undefined
    ? DECISION_DRAFT_DIGEST_CACHE_PATH
    : `/api/cli/decisions/recent?limit=${String(DECISION_DIGEST_CACHE_LIMIT)}` +
        `&drafts=true&cursor=${encodeURIComponent(cursor)}`;
}

export interface DecisionDigestCacheSnapshot {
  decisions: DecisionFeedRow[];
  /** Time of the last structurally valid server response. */
  cachedAt?: number;
  /** Present until the daemon has a verified feed snapshot. */
  unavailable?: string;
  /** New paginated servers attest whether this is the terminal page. */
  pageDone?: boolean;
}

type DecisionDigestResponse = {
  decisions?: unknown;
  unavailable?: unknown;
  continueCursor?: unknown;
  isDone?: unknown;
};

export interface DecisionDigestCacheOptions {
  /** Team summaries may survive outages; private action commands may not. */
  failurePolicy?: "retain" | "clear";
  /** Walk one opaque server page per refresh and restart after the terminal page. */
  cyclePages?: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Daemon-owned, in-memory snapshot of one credential generation's organization
 * Decision feed. Credential rotation resets the snapshot before another
 * principal can read it.
 *
 * Refreshes collapse onto one request. Team summaries retain a verified page
 * across a later transport failure. Authority-bearing private pages instead
 * use the clear policy and fail closed; paginated pages also remain pinned
 * until an authenticated socket caller has observed them.
 */
export class DecisionDigestCache {
  private snapshot: DecisionDigestCacheSnapshot = {
    decisions: [],
    unavailable: DECISION_DIGEST_CACHE_WARMING,
  };

  private refreshInFlight: Promise<void> | undefined;

  private generation = 0;

  private nextCursor: string | undefined;

  /**
   * A private page may advance only after an authenticated socket caller has
   * observed it. Periodic refreshes otherwise could walk past an older page
   * between prompts and starve every draft on that page indefinitely.
   */
  private pageObserved = false;

  constructor(
    private readonly load: (cursor?: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly options: DecisionDigestCacheOptions = {},
  ) {}

  read(): DecisionDigestCacheSnapshot {
    if (this.options.cyclePages === true && this.snapshot.cachedAt !== undefined) {
      this.pageObserved = true;
    }
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
    this.nextCursor = undefined;
    this.pageObserved = false;
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
      if (
        this.options.cyclePages === true &&
        this.snapshot.cachedAt !== undefined &&
        !this.pageObserved
      ) {
        return;
      }
      const requestCursor = this.nextCursor;
      const value = (await this.load(requestCursor)) as DecisionDigestResponse;
      if (generation !== this.generation) return;
      if (typeof value !== "object" || value === null || !Array.isArray(value.decisions)) {
        throw new Error("malformed Decision feed response");
      }
      let pageDone: boolean | undefined;
      let nextCursor: string | undefined;
      if (this.options.cyclePages === true) {
        const hasCursor = typeof value.continueCursor === "string";
        const hasDone = typeof value.isDone === "boolean";
        if (hasCursor !== hasDone || (hasCursor && value.continueCursor === "")) {
          throw new Error("malformed Decision pagination response");
        }
        if (hasCursor && hasDone) {
          pageDone = value.isDone as boolean;
          const candidate = value.continueCursor as string;
          if (!pageDone && candidate === requestCursor) {
            throw new Error("replayed Decision pagination cursor");
          }
          nextCursor = pageDone ? undefined : candidate;
        }
      }
      this.snapshot = {
        decisions: value.decisions as DecisionFeedRow[],
        cachedAt: this.now(),
        unavailable: typeof value.unavailable === "string" ? value.unavailable : undefined,
        pageDone,
      };
      this.nextCursor = nextCursor;
      this.pageObserved = false;
    } catch (error) {
      if (generation !== this.generation) return;
      // Never replace a last-known-good page with a transient transport error.
      // Before the first valid page, retain UNKNOWN so hooks cannot spend their
      // startup cursor on a feed the daemon never verified.
      if (this.options.failurePolicy === "clear" || this.snapshot.cachedAt === undefined) {
        this.snapshot = {
          decisions: [],
          unavailable: `daemon Decision cache unavailable: ${errorMessage(error)}`,
        };
        this.nextCursor = undefined;
        this.pageObserved = false;
      }
    }
  }
}
