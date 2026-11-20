/** Validate reviewed Go rules with the native worker; never reinterpret JavaScript patterns. */
import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { boundedNames, image, json, object, pathSafe } from "./migration-handoff-io.js";
import type { Guard, Spec } from "./migration-handoff-plan.js";

export function privacyInventory(
  spec: Spec,
  ownedLockDirectories = new Set<string>(),
): { guards: Guard[]; found: Set<string> } {
  const guards: Guard[] = [];
  const found = new Set<string>();
  let entries = 0;
  function scan(root: string, depth: number): void {
    if (depth > 32 || guards.length >= 4000)
      throw new Error("Repository privacy inventory exceeds bound; reduce declared scope");
    pathSafe(root);
    const legacyPath = join(root, ".prim", "redaction.json");
    const nativePath = join(root, ".prim", "redaction-go.json");
    const legacy = image(legacyPath);
    const native = image(nativePath);
    // Missing configs are guarded too, so newly introduced rules invalidate preparation.
    guards.push({ path: legacyPath, before: legacy }, { path: nativePath, before: native });
    if (legacy.text !== null && native.text === null)
      throw new Error("Legacy workspace rules require an explicitly reviewed redaction-go.json");
    if (native.text !== null) found.add(nativePath);
    for (const name of boundedNames(root, 25000 - entries)) {
      if (++entries > 25000) throw new Error("Privacy entry inventory exceeds bound");
      // Never follow Git metadata or dependency trees; these are not declared capture workspaces.
      if ([".git", "node_modules", ".prim"].includes(name)) continue;
      const path = join(root, name);
      // Only the caller's already-acquired and owner-verified configuration locks are excluded.
      if (ownedLockDirectories.has(path)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) scan(path, depth + 1);
    }
  }
  for (const root of spec.projects) scan(root, 0);
  return { guards, found };
}
export async function redactions(
  spec: Spec,
  ownedLockDirectories = new Set<string>(),
): Promise<Guard[]> {
  const { guards, found } = privacyInventory(spec, ownedLockDirectories);
  if (spec.redactions.length !== found.size)
    throw new Error(
      "Every discovered native redaction configuration needs one reviewed hash and expected probe",
    );
  for (const review of spec.redactions) {
    const snapshot = image(review.path);
    if (
      !found.delete(review.path) ||
      review.reviewedForGoRE2 !== true ||
      snapshot.hash !== review.sha256 ||
      snapshot.text === null ||
      snapshot.text.length > 65536 ||
      typeof review.probe !== "string" ||
      review.probe.length > 16384 ||
      typeof review.expected !== "string"
    )
      throw new Error("Invalid or changed redaction review");
    const config = object(json(snapshot.text));
    if (config.engine !== "go-re2" || config.version !== 1)
      throw new Error("Native rules must explicitly select go-re2 version 1");
    await new Promise<void>((resolve, reject) => {
      const child = execFile(
        spec.native.runtime,
        ["redact-workspace-worker"],
        { timeout: 2000, maxBuffer: 1024 * 1024 },
        (error, stdout) => {
          try {
            const result = object(json(stdout));
            if (error || result.ok !== true || result.value !== review.expected)
              throw new Error("Reviewed redaction probe did not match native worker output");
            resolve();
          } catch {
            reject(new Error("Native redaction validation failed; no config switch occurred"));
          }
        },
      );
      child.stdin?.end(JSON.stringify({ config, value: review.probe }));
    });
  }
  return guards;
}
