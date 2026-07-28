type ParsedSemver = { core: [bigint, bigint, bigint]; prerelease: string[] };

function parseSemver(value: unknown): ParsedSemver | undefined {
  if (typeof value !== "string" || value.length > 256) return;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      value,
    );
  if (!match) return;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    return;
  }
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
}

/** SemVer precedence, or undefined when either input is not valid SemVer. */
export function compareSemver(left: unknown, right: unknown): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return;
  for (let i = 0; i < a.core.length; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(a.prerelease.length, b.prerelease.length); i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}
