import { type Teammate, formatTeammates, formatTeammatesWithArea } from "./presence.js";

export type DecisionIngestionStatus = "enabled" | "disabled";
export type RepositoryBindingDiagnosticState = "connected" | "unbound" | "invalid";

export function repositoryBindingDiagnosticLabel(
  state: RepositoryBindingDiagnosticState | undefined,
): string | undefined {
  if (state === "unbound") return "repository: unbound (enforcement not evaluating)";
  if (state === "invalid") return "repository binding: invalid (run `prim doctor`)";
  return undefined;
}

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
  principalMismatch?: boolean;
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
  /** Last locally observed repository-binding state for this checkout. */
  resolveRepositoryBindingState?: () => RepositoryBindingDiagnosticState | undefined;
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

  // Terminal auth is the actionable root cause and deliberately suppresses
  // lower-priority binding diagnostics. One line, one recovery action.
  if (snapshot?.healthy === false && snapshot.needsReauth) {
    return `primitive ${version} (daemon: paused · run \`prim auth login\`${ingestionSuffix(ingestionStatus)})`;
  }

  const repositoryLabel = repositoryBindingDiagnosticLabel(
    (snapshot !== null && snapshot.healthy !== false) ||
      options.includeIngestionWhenUnavailable === true
      ? options.resolveRepositoryBindingState?.()
      : undefined,
  );
  const repositorySuffix = repositoryLabel ? ` · ${repositoryLabel}` : "";

  if (!snapshot) {
    return `primitive ${version} (daemon: down${repositorySuffix}${ingestionSuffix(ingestionStatus)})`;
  }
  if (snapshot.healthy === false) {
    if (snapshot.ingestion?.healthy === false) {
      const pending = snapshot.ingestion.pendingCount;
      const qualifier = snapshot.ingestion.pendingSampled ? "at least " : "";
      return `primitive ${version} (daemon: degraded · delivery: stalled${typeof pending === "number" ? ` · ${qualifier}${String(pending)} pending` : ""}${repositorySuffix}${ingestionSuffix(ingestionStatus)})`;
    }
    if (snapshot.heartbeat?.healthy === false) {
      return `primitive ${version} (daemon: degraded · presence: unavailable${repositorySuffix}${ingestionSuffix(ingestionStatus)})`;
    }
    return `primitive ${version} (daemon: starting${repositorySuffix}${ingestionSuffix(ingestionStatus)})`;
  }

  if (snapshot.envMismatch) {
    return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus}${repositorySuffix} · presence: other env)`;
  }
  if (snapshot.principalMismatch) {
    return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus}${repositorySuffix} · presence: other account)`;
  }
  if (snapshot.presenceStale) {
    return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus}${repositorySuffix} · presence: stale)`;
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
  return `primitive ${version} (daemon: live, Decision ingestion ${ingestionStatus}${repositorySuffix} · ${team})`;
}

interface CacheEntry {
  expiresAt: number;
  value: DecisionIngestionStatus;
  repositoryBindingState?: RepositoryBindingDiagnosticState;
}

export const STATUSLINE_INGESTION_CACHE_TTL_MS = 30_000;
export const STATUSLINE_INGESTION_CACHE_MAX_ENTRIES = 256;

export interface StatuslineIngestionCacheOptions {
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
  resolveRepositoryBindingState?: (cwd: string) => RepositoryBindingDiagnosticState | undefined;
}

/** Small daemon-local cache for the only Git-backed part of status rendering. */
export class StatuslineIngestionCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #resolveRepositoryBindingState?: StatuslineIngestionCacheOptions["resolveRepositoryBindingState"];

  constructor(
    private readonly resolve: (cwd: string) => DecisionIngestionStatus,
    options: StatuslineIngestionCacheOptions = {},
  ) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? STATUSLINE_INGESTION_CACHE_TTL_MS;
    this.#maxEntries = options.maxEntries ?? STATUSLINE_INGESTION_CACHE_MAX_ENTRIES;
    this.#resolveRepositoryBindingState = options.resolveRepositoryBindingState;
  }

  #entry(cwd: string): CacheEntry {
    const now = this.#now();
    const cached = this.#entries.get(cwd);
    if (cached && cached.expiresAt > now) {
      return cached;
    }

    const value = this.resolve(cwd);
    const repositoryState =
      value === "enabled" ? this.#resolveRepositoryBindingState?.(cwd) : undefined;
    const entry = {
      expiresAt: now + this.#ttlMs,
      value,
      ...(repositoryState ? { repositoryBindingState: repositoryState } : {}),
    };
    this.#entries.delete(cwd);
    this.#entries.set(cwd, entry);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return entry;
  }

  get(cwd: string): DecisionIngestionStatus {
    return this.#entry(cwd).value;
  }

  getRepositoryBindingState(cwd: string): RepositoryBindingDiagnosticState | undefined {
    return this.#entry(cwd).repositoryBindingState;
  }

  clear(): void {
    this.#entries.clear();
  }
}
