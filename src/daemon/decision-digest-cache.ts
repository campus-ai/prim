import { randomBytes } from "node:crypto";
import type { DecisionFeedRow } from "../decisions/recent.js";

export const DECISION_DIGEST_CACHE_WARMING = "daemon Decision cache warming";
export const DECISION_DIGEST_CACHE_LIMIT = 100;
export const DECISION_DIGEST_CACHE_WINDOW = "24h";
export const DECISION_DIGEST_CACHE_PATH =
  `/api/cli/decisions/recent?limit=${String(DECISION_DIGEST_CACHE_LIMIT)}` +
  `&since=${DECISION_DIGEST_CACHE_WINDOW}`;
export const DECISION_DRAFT_DIGEST_CACHE_PATH = `${DECISION_DIGEST_CACHE_PATH}&drafts=true`;

const SAFE_PRIVATE_DRAFT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_DRAFT_CURSOR_LENGTH = 4_096;

export function decisionDraftDigestCachePath(cursor?: string): string {
  return cursor === undefined
    ? DECISION_DRAFT_DIGEST_CACHE_PATH
    : `/api/cli/decisions/recent?limit=${String(DECISION_DIGEST_CACHE_LIMIT)}` +
        `&drafts=true&cursor=${encodeURIComponent(cursor)}`;
}

/**
 * A draft ID is interpolated into a Markdown inline-code command. Keep the
 * grammar deliberately narrower than the wire contract so server-controlled
 * text cannot close the code span or introduce a second command.
 */
export function isActionablePrivateDraft(row: unknown): row is DecisionFeedRow {
  if (typeof row !== "object" || row === null || Array.isArray(row)) return false;
  const candidate = row as Partial<DecisionFeedRow>;
  return (
    typeof candidate.id === "string" &&
    SAFE_PRIVATE_DRAFT_ID.test(candidate.id) &&
    typeof candidate.intent === "string" &&
    candidate.authorIsSelf === true &&
    candidate.stage === "draft" &&
    (candidate.intentKind === undefined || candidate.intentKind === "change")
  );
}

/** Unique, command-safe authored drafts on one server page, in server order. */
export function privateDraftActionableIds(rows: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    if (!isActionablePrivateDraft(row) || seen.has(row.id)) continue;
    seen.add(row.id);
    ids.push(row.id);
  }
  return ids;
}

export interface DecisionDigestCacheSnapshot {
  decisions: DecisionFeedRow[];
  /** Time of the last structurally valid server response. */
  cachedAt?: number;
  /** Present until the daemon has a verified feed snapshot. */
  unavailable?: string;
  /** New paginated servers attest whether this is the terminal page. */
  pageDone?: boolean;
  /** Opaque local proof required to acknowledge this private page. */
  pageToken?: string;
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
  /** Walk one opaque server page at a time, only after verified handoff. */
  cyclePages?: boolean;
}

type PrivateDraftPage = {
  token: string;
  requiredIds: Set<string>;
  acknowledgedIds: Set<string>;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function privatePageToken(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Daemon-owned, in-memory snapshot of one credential generation's organization
 * Decision feed. Credential rotation resets the snapshot before another
 * principal can read it.
 *
 * Refreshes collapse onto one request. Team summaries retain a verified page
 * across a later transport failure. Authority-bearing private pages instead
 * fail closed. A private page remains pinned until every command-safe authored
 * draft on that exact page has been handed off by an authenticated hook.
 */
export class DecisionDigestCache {
  private snapshot: DecisionDigestCacheSnapshot = {
    decisions: [],
    unavailable: DECISION_DIGEST_CACHE_WARMING,
  };

  private refreshInFlight: Promise<void> | undefined;

  private generation = 0;

  private nextCursor: string | undefined;

  /** Continuations already issued in this cycle; loops are unsafe evidence. */
  private seenContinuationCursors = new Set<string>();

  private privatePage: PrivateDraftPage | undefined;

  constructor(
    private readonly load: (cursor?: string) => Promise<unknown>,
    private readonly now: () => number = Date.now,
    private readonly options: DecisionDigestCacheOptions = {},
  ) {}

  read(): DecisionDigestCacheSnapshot {
    return { ...this.snapshot, decisions: [...this.snapshot.decisions] };
  }

  /**
   * Record commands that a hook actually handed off. A plain snapshot read is
   * intentionally insufficient: a page can only move after all command-safe
   * authored drafts from this exact page are proven delivered.
   */
  acknowledgePrivatePage(pageToken: string, deliveredIds: readonly string[]): boolean {
    const page = this.privatePage;
    if (this.options.cyclePages !== true || page === undefined || page.token !== pageToken) {
      return false;
    }
    for (const id of deliveredIds) {
      if (page.requiredIds.has(id)) page.acknowledgedIds.add(id);
    }
    return [...page.requiredIds].every((id) => page.acknowledgedIds.has(id));
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
    this.seenContinuationCursors.clear();
    this.privatePage = undefined;
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

  private pageFullyAcknowledged(): boolean {
    const page = this.privatePage;
    return page !== undefined && [...page.requiredIds].every((id) => page.acknowledgedIds.has(id));
  }

  private assertPrivatePaginationProof(
    value: DecisionDigestResponse,
    requestCursor: string | undefined,
  ): { pageDone: boolean; nextCursor: string | undefined } {
    // The versioned private-draft protocol is all-or-nothing. A pre-pagination
    // server omits isDone; a partial pair or a replay could hide page 101+, so
    // neither is safe to present as a complete private-draft view.
    if (value.isDone === true) {
      if (value.continueCursor !== undefined) {
        throw new Error("malformed terminal Decision pagination response");
      }
      return { pageDone: true, nextCursor: undefined };
    }
    if (
      value.isDone !== false ||
      typeof value.continueCursor !== "string" ||
      value.continueCursor.length === 0 ||
      value.continueCursor.length > MAX_DRAFT_CURSOR_LENGTH ||
      value.continueCursor === requestCursor ||
      this.seenContinuationCursors.has(value.continueCursor)
    ) {
      throw new Error("malformed or replayed Decision pagination response");
    }
    return { pageDone: false, nextCursor: value.continueCursor };
  }

  private clearAfterPrivateFailure(error: unknown): void {
    this.snapshot = {
      decisions: [],
      unavailable: `daemon Decision cache unavailable: ${errorMessage(error)}`,
    };
    this.nextCursor = undefined;
    this.seenContinuationCursors.clear();
    this.privatePage = undefined;
  }

  private async performRefresh(generation: number): Promise<void> {
    try {
      if (
        this.options.cyclePages === true &&
        this.snapshot.cachedAt !== undefined &&
        !this.pageFullyAcknowledged()
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
      let page: PrivateDraftPage | undefined;
      if (this.options.cyclePages === true) {
        if (value.unavailable !== undefined) {
          throw new Error("private Decision feed unavailable");
        }
        const proof = this.assertPrivatePaginationProof(value, requestCursor);
        pageDone = proof.pageDone;
        nextCursor = proof.nextCursor;
        if (nextCursor !== undefined) this.seenContinuationCursors.add(nextCursor);
        if (pageDone) this.seenContinuationCursors.clear();
        page = {
          token: privatePageToken(),
          requiredIds: new Set(privateDraftActionableIds(value.decisions)),
          acknowledgedIds: new Set(),
        };
      }

      this.snapshot = {
        decisions: value.decisions as DecisionFeedRow[],
        cachedAt: this.now(),
        unavailable: typeof value.unavailable === "string" ? value.unavailable : undefined,
        ...(pageDone === undefined ? {} : { pageDone }),
        ...(page === undefined ? {} : { pageToken: page.token }),
      };
      this.nextCursor = nextCursor;
      this.privatePage = page;
    } catch (error) {
      if (generation !== this.generation) return;
      // Never replace a last-known-good team page with a transient transport
      // failure. Private action pages always clear: stale authority-bearing
      // commands are more dangerous than duplicate delivery.
      if (this.options.cyclePages === true || this.options.failurePolicy === "clear") {
        this.clearAfterPrivateFailure(error);
      } else if (this.snapshot.cachedAt === undefined) {
        this.snapshot = {
          decisions: [],
          unavailable: `daemon Decision cache unavailable: ${errorMessage(error)}`,
        };
      }
    }
  }
}
