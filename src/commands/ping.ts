import { performance } from "node:perf_hooks";
import type { Command } from "commander";
import { getClient, getSiteUrl } from "../client.js";

export function registerPingCommand(program: Command) {
  program
    .command("holler")
    .description("Test connectivity to the Primitive backend")
    .action(async () => {
      const url = getSiteUrl();
      console.log(`Pinging ${url}...`);

      const start = performance.now();
      try {
        const client = getClient();
        await client.get("/api/cli/specs");
        const elapsed = Math.round(performance.now() - start);
        console.log(`Connected in ${String(elapsed)}ms`);
      } catch (error) {
        const elapsed = Math.round(performance.now() - start);
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Connection failed (${String(elapsed)}ms): ${message}`);
        process.exit(1);
      }
    });
}
