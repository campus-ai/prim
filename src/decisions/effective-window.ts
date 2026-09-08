/**
 * Parse the human-facing absolute-time flags used by Decision authoring.
 *
 * The wire contract stores safe-integer Unix milliseconds. Keeping the
 * conversion here makes create and rescope agree on ISO input, preserves
 * negative (pre-epoch) instants, and rejects a malformed window before it can
 * be silently degraded by an older server.
 */

export interface EffectiveWindow {
  [key: string]: unknown | undefined;
  effectiveFrom?: number;
  effectiveUntil?: number;
}

export interface EffectiveWindowOptions {
  effectiveFrom?: string;
  effectiveUntil?: string;
  clearWindow?: boolean;
}

const INTEGER_MILLISECONDS_RE = /^-?(?:0|[1-9][0-9]*)$/u;
const ISO_INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/u;

export class EffectiveWindowInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EffectiveWindowInputError";
  }
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isValidIsoCalendarDate(value: string): boolean {
  const match = ISO_INSTANT_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month);
}

function invalidInstant(flag: "--effective-from" | "--effective-until"): EffectiveWindowInputError {
  return new EffectiveWindowInputError(
    `${flag} must be an ISO-8601 instant or a safe Unix epoch in milliseconds`,
  );
}

/** Convert one ISO-8601 instant or exact Unix-millisecond string to wire ms. */
export function parseEffectiveInstant(
  value: string,
  flag: "--effective-from" | "--effective-until",
): number {
  if (INTEGER_MILLISECONDS_RE.test(value)) {
    const milliseconds = Number(value);
    if (Number.isSafeInteger(milliseconds)) return milliseconds;
    throw invalidInstant(flag);
  }
  if (!isValidIsoCalendarDate(value)) throw invalidInstant(flag);
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds)) throw invalidInstant(flag);
  return milliseconds;
}

/**
 * Produce a canonical wire window. `null` is the rescope-only explicit clear;
 * an omitted pair leaves an existing rescope window untouched.
 */
export function effectiveWindowFromOptions(
  options: EffectiveWindowOptions,
): EffectiveWindow | null | undefined {
  const { effectiveFrom, effectiveUntil, clearWindow } = options;
  if (clearWindow) {
    if (effectiveFrom !== undefined || effectiveUntil !== undefined) {
      throw new EffectiveWindowInputError(
        "--clear-window cannot be combined with --effective-from or --effective-until",
      );
    }
    return null;
  }
  if (effectiveFrom === undefined && effectiveUntil === undefined) return undefined;

  const from =
    effectiveFrom === undefined
      ? undefined
      : parseEffectiveInstant(effectiveFrom, "--effective-from");
  const until =
    effectiveUntil === undefined
      ? undefined
      : parseEffectiveInstant(effectiveUntil, "--effective-until");
  if (from !== undefined && until !== undefined && from >= until) {
    throw new EffectiveWindowInputError("--effective-from must be before --effective-until");
  }
  return {
    ...(from === undefined ? {} : { effectiveFrom: from }),
    ...(until === undefined ? {} : { effectiveUntil: until }),
  };
}
