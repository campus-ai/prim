import { type Teammate, formatTeammates, formatTeammatesWithArea } from "./presence.js";

export type DecisionIngestionStatus = "enabled" | "disabled";

export interface StatusSnapshot {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  lastHeartbeatAt?: number;
  onlineCount?: number;
  onlineNames?: string[];
  onlineTeammates?: Teammate[];
  presenceStale?: boolean;
  envMismatch?: boolean;
  healthy?: boolean;
  heartbeat?: { healthy?: boolean };
  ingestion?: { healthy?: boolean; pendingCount?: number; pendingSampled?: boolean };
  needsReauth?: boolean;
}

const STATUSLINE_NAME_CAP = 3;

export interface StatuslineRenderOptions {
  /**
   * Codex has no persistent statusline surface, so its hook-delivered report
   * keeps the repo activation state visible even while daemon health is down.
   * The Claude statusline and daemon raw protocol retain their historical
   * output when this is omitted.
   */
  includeIngestionWhenUnavailable?: boolean;
  /**
   * Render teammate labels bare, without the OSC 8 hyperlink + SGR styling.
   * The Claude statusline is a terminal surface, so it keeps the styled links;
   * hook JSON context fields are not, so escape bytes would reach the
   * consuming agent verbatim.
   */
  plainLinks?: boolean;
}

/** Render a status snapshot without performing socket, filesystem, or Git I/O. */
export function formatStatusline(
  version: string,
  snapshot: StatusSnapshot | null,
  resolveIngestionStatus: () => DecisionIngestionStatus,
  options: StatuslineRenderOptions = {},
): string {
  const ingestionSuffix = (status: DecisionIngestionStatus | undefined): string =>
    status === undefined ? "" : ` · Decision ingestion ${status}`;
  const ingestionStatus =
    snapshot === null || snapshot.healthy === false
      ? options.includeIngestionWhenUnavailable
        ? resolveIngestionStatus()
        : undefined
      : resolveIngestionStatus();

  if (!snapshot) {
    return `primitive ${version} (daemon: down${ingestionSuffix(ingestionStatus)})`;
  }
  if (snapshot.healthy === false) {
    if (snapshot.needsReauth) {
      return `primitive ${version} (daemon: paused · run \`prim auth login\`${ingestionSuffix(ingestionStatus)})`;
    }
    if (snapshot.ingestion?.healthy === false) {
      const pending = snapshot.ingestion.pendingCount;
      const qualifier = snapshot.ingestion.pendingSampled ? "at least " : "";
      return `primitive ${version} (daemon: degraded · delivery: stalled${typeof pending === "number" ? ` · ${qualifier}${String(pending)} pending` : ""}${ingestionSuffix(ingestionStatus)})`;
    }
    if (snapshot.heartbeat?.healthy === false) {
      return `primitive ${version} (daemon: degraded · presence: unavailable${ingestionSuffix(ingestionStatus)})`;
    }
    return `primitive ${version} (daemon: starting${ingestionSuffix(ingestionStatus)})`;
  }

  if (snapshot.envMismatch) {
    return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus} · presence: other env)`;
  }
  if (snapshot.presenceStale) {
    return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus} · presence: stale)`;
  }

  let team: string;
  if (snapshot.onlineTeammates !== undefined) {
    team = `team: ${formatTeammatesWithArea(snapshot.onlineTeammates, STATUSLINE_NAME_CAP, options.plainLinks === true)}`;
  } else if (snapshot.onlineNames !== undefined) {
    team = `team: ${formatTeammates(snapshot.onlineNames, STATUSLINE_NAME_CAP)}`;
  } else if (typeof snapshot.onlineCount === "number") {
    team = `team: ${String(snapshot.onlineCount)} online`;
  } else {
    team = "team: —";
  }
  return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus} · ${team})`;
}

interface CacheEntry {
  expiresAt: number;
  value: DecisionIngestionStatus;
}

export const STATUSLINE_INGESTION_CACHE_TTL_MS = 30_000;
export const STATUSLINE_INGESTION_CACHE_MAX_ENTRIES = 256;

/** Small daemon-local cache for the only Git-backed part of status rendering. */
export class StatuslineIngestionCache {
  readonly #entries = new Map<string, CacheEntry>();

  constructor(
    private readonly resolve: (cwd: string) => DecisionIngestionStatus,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = STATUSLINE_INGESTION_CACHE_TTL_MS,
    private readonly maxEntries = STATUSLINE_INGESTION_CACHE_MAX_ENTRIES,
  ) {}

  get(cwd: string): DecisionIngestionStatus {
    const now = this.now();
    const cached = this.#entries.get(cwd);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const value = this.resolve(cwd);
    this.#entries.delete(cwd);
    this.#entries.set(cwd, { expiresAt: now + this.ttlMs, value });
    while (this.#entries.size > this.maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.#entries.clear();
  }
}
