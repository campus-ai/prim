import { getOrCreateClientInstanceId } from "../daemon/client-instance-id.js";
import { packageVersion } from "./bin-path.js";
import { primConfigDirectory } from "./paths.js";

// Snapshot the running process's version before an in-place package upgrade.
// Staged daemons carry their immutable release version in the launcher env.
const runtimeVersion = process.env.PRIM_RUNTIME_VERSION ?? packageVersion();
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/u;
let instanceId: Promise<string | undefined> | undefined;

/** Optional diagnostics, independent of the version that captured a journal entry. */
export async function ingestUploaderHeaders(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};
  if (runtimeVersion && runtimeVersion.length <= 64 && VERSION_RE.test(runtimeVersion)) {
    headers["X-Prim-Uploader-Version"] = runtimeVersion;
  }
  instanceId ??= getOrCreateClientInstanceId({
    configDir: primConfigDirectory(),
    // Attribution must not consume the upload deadline waiting for another process.
    lockOptions: { timeoutMs: 0 },
  }).catch(() => {
    // Leave malformed identity untouched; retry on the next upload after repair
    // or lock contention. Never mint a replacement just to populate a header.
    instanceId = undefined;
    return undefined;
  });
  const id = await instanceId;
  if (id) headers["X-Prim-Client-Instance-Id"] = id;
  return headers;
}
