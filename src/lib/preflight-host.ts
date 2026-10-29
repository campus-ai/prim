import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compareSemver } from "./semver.js";

export type PreflightHost = "claude" | "codex" | "cursor" | "hermes";
export type FailureProtection = {
  host: PreflightHost;
  status: "supported" | "unsupported" | "unknown" | "limited";
  version?: string;
  detail: string;
};

/** Host failure handling is separate from the CLI's explicit 240-second deny. */
export function inspectFailureProtection(host: PreflightHost): FailureProtection {
  if (host === "codex")
    return {
      host,
      status: "limited",
      detail:
        "Codex accepts Primitive's explicit deny before the 240-second deadline, but does not provide a documented fail-closed policy for a killed, crashed, or timed-out hook. The installed hook timeout is 300 seconds; this host boundary is not guaranteed.",
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
      detail: `Cannot inspect ${host}; install or expose the host on PATH, then run prim doctor. Host failure protection is not verified.`,
    };
  }
  const version = /\b(\d+\.\d+\.\d+(?:-[\w.-]+)?)\b/u.exec(output)?.[1];
  if (host === "hermes") {
    // Hermes has no documented first supported version. Inspect the installed
    // implementation rather than treating a version string as proof of support.
    const project = /^\s*Project:\s*(.+?)\s*$/mu.exec(output)?.[1];
    try {
      if (project) {
        const source = readFileSync(join(project, "agent", "shell_hooks.py"), "utf8");
        if (/fail_closed\s*:\s*bool/u.test(source) && /["']fail_closed["']/u.test(source)) {
          return {
            host,
            version,
            status: "supported",
            detail:
              "Installed Hermes exposes fail_closed shell hooks; Primitive configures fail_closed: true and the 300-second maximum timeout.",
          };
        }
        return {
          host,
          version,
          status: "unsupported",
          detail:
            "Installed Hermes does not expose fail_closed shell hooks. Upgrade Hermes before relying on host timeout/crash protection; then run prim hermes install and prim doctor.",
        };
      }
    } catch {
      /* Unknown is not a claim that failure protection works. */
    }
    return {
      host,
      version,
      status: "unknown",
      detail:
        "Cannot verify installed Hermes fail_closed support. Upgrade to a version supporting fail_closed, expose its Project path through hermes version, then run prim doctor.",
    };
  }
  const minimum = host === "claude" ? "2.1.295" : "3.24.9";
  const comparison = compareSemver(version, minimum);
  const status =
    comparison === undefined ? "unknown" : comparison < 0 ? "unsupported" : "supported";
  return {
    host,
    version,
    status,
    detail:
      status === "supported"
        ? `${host} ${version} supports the configured ${host === "claude" ? 'onFailure: "block"' : "failClosed: true"} policy and 300-second timeout.`
        : `${host} ${version ?? "version unknown"}: upgrade to ${minimum} or newer ${host === "cursor" ? "(Primitive's verified failure-protection baseline) " : ""}before relying on host timeout/crash protection; then run prim ${host} install and prim doctor.`,
  };
}

export function reportFailureProtection(host: PreflightHost): FailureProtection {
  const protection = inspectFailureProtection(host);
  console.error(`[prim] ${protection.detail}`);
  if (protection.status === "unsupported" || protection.status === "unknown") {
    console.error(
      "[prim] Conflict Gate host failure protection is not ready; installed settings alone do not establish readiness.",
    );
  }
  return protection;
}
