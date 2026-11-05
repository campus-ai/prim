import { terminalSafeLine } from "../lib/terminal-safe.js";

export type DecisionMaker =
  | { kind: "unknown" }
  | { kind: "external"; sourcePrincipalId: string; displayName: string };

export interface DecisionAdoption {
  at: number;
  qualifier: "exact" | "on_or_about" | "no_later_than";
  precision: "day" | "minute" | "second";
}

/** Additive fields; older servers continue to return only authorName/classifiedAt. */
export interface DecisionMetadata {
  producerKind?: string;
  decisionMaker?: DecisionMaker;
  adoption?: DecisionAdoption;
  importedAt?: number;
  importedByName?: string;
}

export function decisionMakerName(row: DecisionMetadata & { authorName: string }): string {
  if (row.producerKind === "seed") {
    // A legacy seed's authorName names the operational importer. It is not
    // evidence of who made the historical decision.
    return row.decisionMaker?.kind === "external"
      ? terminalSafeLine(row.decisionMaker.displayName)
      : "Decision maker unknown";
  }
  return terminalSafeLine(row.authorName);
}

function validDate(at: number): Date | undefined {
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

export function formatHistoricalAdoption(adoption: DecisionAdoption | undefined): string {
  if (!adoption) {
    return "date unknown";
  }
  const date = validDate(adoption.at);
  if (!date) {
    return "date unknown";
  }
  // Calendar-only evidence is encoded at UTC midnight. Always preserve that
  // calendar day, including for readers west of UTC. Time-bearing evidence is
  // explicit about its zone and never renders more precision than the source.
  const iso = date.toISOString();
  const timestamp =
    adoption.precision === "day"
      ? iso.slice(0, 10)
      : `${iso.slice(0, adoption.precision === "minute" ? 16 : 19).replace("T", " ")} UTC`;
  switch (adoption.qualifier) {
    case "on_or_about":
      return `on or about ${timestamp}`;
    case "no_later_than":
      return `no later than ${timestamp}`;
    default:
      return timestamp;
  }
}

export function formatDecidedAt(row: DecisionMetadata & { classifiedAt: number }): string {
  if (row.producerKind === "seed") {
    return formatHistoricalAdoption(row.adoption);
  }
  return validDate(row.classifiedAt)?.toISOString() ?? "date unknown";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function formatRecentDecisionDate(
  row: DecisionMetadata & { classifiedAt: number },
  now: number,
): string {
  if (row.producerKind === "seed") {
    return formatHistoricalAdoption(row.adoption);
  }
  const date = validDate(row.classifiedAt);
  if (!date) {
    return "date unknown";
  }
  const today = new Date(now);
  if (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  ) {
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  }
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}
