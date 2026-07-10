#!/usr/bin/env node
/**
 * prim Decision feedback hook for Claude Code.
 *
 * Drains server-side feedback rows for Decisions created asynchronously by
 * automatic capture and renders them as Claude Code system messages. Installed
 * only for Claude Code. Fail-soft: malformed stdin, inactive repos, auth/network
 * failures, and empty queues all emit `{}` and exit 0.
 */

import { warmBinCache } from "../lib/bin-cache.js";
import {
  type DecisionFeedbackHookEnvelope,
  decisionFeedbackSystemMessage,
} from "./decision-feedback-core.js";

const STDIN_TIMEOUT_MS = 1_000;

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      reject(new Error("stdin read timeout"));
    }, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emit(systemMessage?: string): void {
  if (systemMessage) {
    process.stdout.write(`${JSON.stringify({ systemMessage })}\n`);
    return;
  }
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  warmBinCache();
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit();
    return;
  }
  let envelope: DecisionFeedbackHookEnvelope;
  try {
    envelope = JSON.parse(raw) as DecisionFeedbackHookEnvelope;
  } catch {
    emit();
    return;
  }
  process.env.PRIM_SUPPRESS_AUTH_REFRESH_ERRORS = "1";
  emit(await decisionFeedbackSystemMessage(envelope));
}

main().catch(() => {
  emit();
});
