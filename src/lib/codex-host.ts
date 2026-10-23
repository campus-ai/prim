import { lstatSync, realpathSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import WebSocket from "ws";
import { hookCommandResolutions } from "./bin-path.js";

const TIMEOUT_MS = 3000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const BINS = ["prim-hook", "prim-pre-tool-use", "prim-post-tool-use", "prim-session-start"];

export type CodexHostStatus = {
  connection: "available" | "unavailable";
  trust: "trusted" | "review-required" | "disabled" | "unknown";
  reload: "not-requested" | "refreshed" | "unavailable";
  reason?: string;
};

/**
 * Codex snapshots hooks in loaded sessions. Installing hooks.json alone does
 * not refresh them. Use the same empty config/batchWrite as Codex's native
 * reload action; never write hook trust, approvals, or configuration values.
 * Only refresh a host that actually owns the calling session.
 */
export async function inspectCodexHost(reload = false): Promise<CodexHostStatus> {
  const unavailable = (reason: string): CodexHostStatus => ({
    connection: "unavailable",
    trust: "unknown",
    reload: reload ? "unavailable" : "not-requested",
    reason,
  });
  const root = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  if (!isAbsolute(root)) return unavailable("invalid-codex-home");
  let socketPath = join(root, "app-server-control", "app-server-control.sock");
  try {
    const alias = lstatSync(socketPath);
    if (process.getuid && alias.uid !== process.getuid()) return unavailable("unsafe-host-socket");
    // Native Codex publishes a rendezvous symlink to its private Unix socket.
    // Resolve it once, validate the target, and connect to that checked path.
    socketPath = realpathSync(socketPath);
    const stat = lstatSync(socketPath);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid()))
      return unavailable("unsafe-host-socket");
  } catch {
    return unavailable("host-socket-unavailable");
  }

  return new Promise((resolve) => {
    let finished = false;
    let refreshed = false;
    let requestId = 0;
    let method = "initialize";
    const socket = new WebSocket("ws://localhost/", {
      createConnection: () => connect(socketPath),
      handshakeTimeout: TIMEOUT_MS,
      maxPayload: MAX_RESPONSE_BYTES,
      perMessageDeflate: false,
    });
    const finish = (value: CodexHostStatus) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.terminate();
      resolve(value);
    };
    const fail = (reason: string) =>
      finish({ ...unavailable(reason), ...(refreshed ? { reload: "refreshed" } : {}) });
    const timer = setTimeout(() => fail("host-timeout"), TIMEOUT_MS);
    const request = (next: string, params: unknown) => {
      method = next;
      socket.send(JSON.stringify({ id: ++requestId, method, params }));
    };
    const listHooks = () => request("hooks/list", { cwds: [process.cwd()] });
    socket.on("error", () => fail("host-connection-failed"));
    socket.on("close", () => fail("host-disconnected"));
    socket.on("open", () => {
      request("initialize", {
        clientInfo: { name: "primitive-hooks", version: "1" },
        capabilities: { experimentalApi: true },
      });
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(raw.toString());
        // Notifications and server requests are not ours to answer.
        if (message.id !== requestId) return;
        if (message.error || !message.result) return fail("host-request-failed");
        const result = message.result;
        if (method === "initialize") {
          socket.send(JSON.stringify({ method: "initialized" }));
          if (reload) request("thread/loaded/list", {});
          else listHooks();
        } else if (method === "thread/loaded/list") {
          const session = process.env.CODEX_THREAD_ID;
          if (!session || !Array.isArray(result.data) || !result.data.includes(session))
            return fail("calling-session-not-loaded");
          request("config/batchWrite", { edits: [], reloadUserConfig: true });
        } else if (method === "config/batchWrite") {
          refreshed = true;
          listHooks();
        } else if (method === "hooks/list") {
          const entry = result.data?.find((item: { cwd?: string }) => item.cwd === process.cwd());
          if (!entry || !Array.isArray(entry.hooks) || entry.errors?.length)
            return fail("host-hook-catalog-unavailable");
          const owned = entry.hooks.filter(
            (hook: { command?: unknown }) =>
              typeof hook.command === "string" &&
              hookCommandResolutions([hook.command], BINS).length > 0,
          );
          const trust: CodexHostStatus["trust"] =
            owned.length === 0
              ? "unknown"
              : owned.some((hook: { enabled?: boolean }) => hook.enabled !== true)
                ? "disabled"
                : owned.some((hook: { trustStatus?: string }) =>
                      ["untrusted", "modified"].includes(hook.trustStatus ?? ""),
                    )
                  ? "review-required"
                  : owned.every((hook: { trustStatus?: string }) =>
                        ["trusted", "managed"].includes(hook.trustStatus ?? ""),
                      )
                    ? "trusted"
                    : "unknown";
          finish({
            connection: "available",
            trust,
            reload: refreshed ? "refreshed" : "not-requested",
          });
        }
      } catch {
        fail("invalid-host-response");
      }
    });
  });
}

export function codexHostGuidance(host: CodexHostStatus): string {
  if (host.trust === "review-required")
    return "Open /hooks in Codex and review the Primitive hooks marked for review, then resume this tour.";
  if (host.trust === "disabled")
    return "Primitive hooks are disabled in Codex. Open /hooks to enable them if intended, then resume this tour.";
  if (host.reload === "refreshed" && host.trust === "trusted")
    return "Codex reloaded its trusted Primitive hooks. Resume this tour; its next real PreToolUse event must still verify isolation.";
  if (host.reload === "unavailable")
    return "The running Codex session could not be refreshed. Exit and resume this same Codex session to load the installed hooks; review them only if Codex prompts. Then resume this tour, without rerunning setup.";
  if (host.trust === "trusted")
    return "Codex reports Primitive hooks trusted. Run prim codex refresh in this same agent session, then resume this tour. Do not ask for trust again.";
  return "Codex hook readiness is unknown. Inspect /hooks for errors or a review request. If already enabled and trusted, refresh the running session before resuming this tour.";
}
