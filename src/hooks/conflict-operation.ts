import { createHash } from "node:crypto";

export function canonicalToolJson(value: unknown, depth = 0): string {
  if (depth > 100) throw new TypeError("Tool input exceeds the canonical depth limit");
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalToolJson(item, depth + 1)).join(",")}]`;
  }
  if (
    value &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalToolJson(record[key], depth + 1)}`)
      .join(",")}}`;
  }
  throw new TypeError("Tool input is not JSON-safe");
}

/** Hash complete normalized input before redaction or proposal truncation. */
export function toolInputDigest(toolName: string, toolInput: unknown): string {
  return createHash("sha256").update(canonicalToolJson({ toolName, toolInput })).digest("hex");
}
