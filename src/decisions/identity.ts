const PUBLIC_ID = /^dec_[0-9a-f]{8}$/u;
const BARE_ID = /^[0-9a-f]{8}$/u;
const OPAQUE_FIELDS = new Set([
  "cursor",
  "continueCursor",
  "nextCursor",
  "reviewToken",
  "bypassToken",
]);

export function decisionIdentifier(id: unknown, shortId?: unknown): string | undefined {
  if (typeof id === "string" && PUBLIC_ID.test(id)) return id;
  if (typeof shortId === "string" && BARE_ID.test(shortId)) return `dec_${shortId}`;
  if (typeof id === "string" && BARE_ID.test(id)) return `dec_${id}`;
  return undefined;
}

/** Fail closed on old server identities that cannot be translated without guessing. */
export function publicDecisionResponse<T>(value: T): T {
  const replacements = new Map<string, string>();
  const referenceKeys = new Set([
    "decisionId",
    "childId",
    "parentId",
    "supersededBy",
    "activationDecisionId",
  ]);
  function visit(input: unknown, field = ""): unknown {
    if (OPAQUE_FIELDS.has(field) || input === null || input === undefined) return input;
    if (Array.isArray(input)) return input.map((item) => visit(item, field));
    if (typeof input === "string" && (referenceKeys.has(field) || /DecisionIds$/u.test(field))) {
      const id = decisionIdentifier(input);
      if (!id) throw new Error("Decision identity unavailable; update Primitive and retry");
      return id;
    }
    if (typeof input !== "object") return input;
    const row = { ...(input as Record<string, unknown>) };
    for (const [idKey, shortKey] of [
      ["id", "shortId"],
      ["_id", "shortId"],
      ["decisionId", "shortId"],
      ["childId", "childShortId"],
      ["parentId", "parentShortId"],
    ]) {
      if (
        !(idKey in row) ||
        ((idKey === "id" || idKey === "_id") && !("intent" in row || "shortId" in row))
      )
        continue;
      const id = decisionIdentifier(
        row[idKey],
        row[shortKey] ?? (idKey === "decisionId" ? row.decisionShortId : undefined),
      );
      if (!id) throw new Error("Decision identity unavailable; update Primitive and retry");
      const previous = row[idKey];
      if (typeof previous === "string" && !PUBLIC_ID.test(previous) && !BARE_ID.test(previous)) {
        replacements.set(previous, id);
      }
      if (shortKey in row) row[shortKey] = id.slice(4);
      if (idKey === "decisionId" && "decisionShortId" in row) row.decisionShortId = id.slice(4);
      row[idKey] = id;
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, visit(item, key)]));
  }
  const projected = visit(value);
  function replace(input: unknown, field = ""): unknown {
    if (OPAQUE_FIELDS.has(field)) return input;
    if (typeof input === "string") {
      let output = input;
      for (const [raw, id] of replacements) if (raw !== id) output = output.replaceAll(raw, id);
      return output;
    }
    if (Array.isArray(input)) return input.map((item) => replace(item, field));
    if (input && typeof input === "object")
      return Object.fromEntries(
        Object.entries(input).map(([key, item]) => [key, replace(item, key)]),
      );
    return input;
  }
  return replace(projected) as T;
}
