/**
 * Decision Event Pipeline — `prim session` subcommand.
 *
 *   prim session start --orgId=<id> <sessionId>
 *   prim session list
 *   prim session drop <sessionId>
 *
 * Writes an explicit session marker file at
 * `~/.config/prim/sessions/<sessionId>.json`. The highest-priority tier of
 * the org-binding chain (`src/binding.ts`) reads this file to attribute
 * moves to a specific org, overriding the cwd-derived defaults.
 *
 * The session id matches Claude Code's hook payload `session_id` — copy
 * it from `prim moves tail` or the Claude session log if you need to
 * bind retroactively. For interactive workflows, you typically run
 * `prim session start --orgId=$ORG <new-session-id>` BEFORE starting
 * `claude` so every captured move is bound from the first hook fire.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { SESSIONS_DIR } from "../binding.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

type SessionMarker = {
  orgId: string;
  startedAt: number;
};

function ensureDir(): void {
  if (!existsSync(SESSIONS_DIR)) {
    mkdirSync(SESSIONS_DIR, { recursive: true, mode: DIR_MODE });
  }
}

function markerPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

export function registerSessionCommands(program: Command): void {
  const session = program
    .command("session")
    .description("Decision Event Pipeline — session binding markers");

  session
    .command("start <sessionId>")
    .description("Pin a Claude Code session to an org")
    .requiredOption("--orgId <orgId>", "Convex organization id")
    .action((sessionId: string, opts: { orgId: string }) => {
      ensureDir();
      const marker: SessionMarker = {
        orgId: opts.orgId,
        startedAt: Date.now(),
      };
      writeFileSync(markerPath(sessionId), JSON.stringify(marker, null, 2), {
        mode: FILE_MODE,
      });
      console.log(`[prim] session ${sessionId} bound to org ${opts.orgId}`);
    });

  session
    .command("list")
    .description("List active session markers")
    .action(() => {
      if (!existsSync(SESSIONS_DIR)) {
        console.log("[prim] no session markers");
        return;
      }
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
      if (files.length === 0) {
        console.log("[prim] no session markers");
        return;
      }
      for (const f of files) {
        const sessionId = f.replace(/\.json$/, "");
        try {
          const m = JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8")) as SessionMarker;
          console.log(`${sessionId}  org=${m.orgId}`);
        } catch {
          // Skip unreadable markers; surface in next `status` polish.
        }
      }
    });

  session
    .command("drop <sessionId>")
    .description("Remove a session marker")
    .action((sessionId: string) => {
      const p = markerPath(sessionId);
      if (!existsSync(p)) {
        console.log(`[prim] no marker for session ${sessionId}`);
        return;
      }
      unlinkSync(p);
      console.log(`[prim] dropped session marker ${sessionId}`);
    });
}
