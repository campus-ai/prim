import { execFileSync } from "node:child_process";
import { compareSemver } from "./semver.js";

export type PreflightHost = "claude" | "codex" | "cursor" | "hermes";
export type FailureProtection = {
  host: PreflightHost;
  status: "supported" | "unsupported" | "unknown" | "limited";
  version?: string;
  detail: string;
};

/** A host failure must release the tool; only a delivered conflict can stop it. */
export function inspectFailureProtection(host: PreflightHost): FailureProtection {
  if (host === "codex")
    return {
      host,
      status: "supported",
      detail:
        "Codex gates wait at most two seconds. Confirmed conflicts retain explicit denial; crashed or timed-out checks permit the tool without a Primitive notice.",
    };
  let output: string;
  try {
    output = execFileSync(host, [host === "hermes" ? "version" : "--version"], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 64 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return {
      host,
      status: "unknown",
      detail: `Cannot inspect ${host}; install or expose the host on PATH, then run prim doctor. Host timeout behavior is not verified.`,
    };
  }
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/u.exec(output)?.[1];
  if (host === "hermes") {
    return {
      host,
      version,
      status: "supported",
      detail:
        "Hermes gates use a two-second timeout and fail_closed: false. Only confirmed conflicts stop a tool.",
    };
  }
  const minimum = host === "claude" ? "2.1.284" : "3.24.9";
  const comparison = compareSemver(version, minimum);
  const status =
    comparison === undefined ? "unknown" : comparison < 0 ? "unsupported" : "supported";
  return {
    host,
    version,
    status,
    detail:
      status === "supported"
        ? `${host} ${version} supports the configured ${host === "claude" ? "default fail-open" : "failClosed: false"} policy and two-second timeout.`
        : `${host} ${version ?? "version unknown"}: upgrade to ${minimum} or newer ${host === "cursor" ? "(Primitive's verified host compatibility baseline) " : ""}before relying on host timeout behavior; then run prim ${host} install and prim doctor.`,
  };
}

export function reportFailureProtection(host: PreflightHost): FailureProtection {
  const protection = inspectFailureProtection(host);
  console.error(`[prim] ${protection.detail}`);
  if (protection.status === "unsupported" || protection.status === "unknown") {
    console.error(
      "[prim] Conflict Gate host compatibility is not verified; installed settings alone do not establish readiness.",
    );
  }
  return protection;
}
