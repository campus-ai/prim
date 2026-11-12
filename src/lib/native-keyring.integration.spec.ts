import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AsyncEntry } from "@napi-rs/keyring";
import { afterAll, expect, it } from "vitest";
import { KEYRING_LOADER, keyringNativeBinary } from "./native-keyring.js";

const temporary = mkdtempSync(join(tmpdir(), "prim-native-keyring-"));
afterAll(() => rmSync(temporary, { recursive: true, force: true }));
it("loads the copied native store in a fresh process without npm resolution", () => {
  copyFileSync(keyringNativeBinary(), join(temporary, "keyring.node"));
  writeFileSync(join(temporary, "keyring.cjs"), KEYRING_LOADER);
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      "const store = require(process.argv[1]); process.stdout.write(typeof store.AsyncEntry)",
      join(temporary, "keyring.cjs"),
    ],
    { cwd: temporary, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
  );
  expect(output).toBe("function");
});
it.skipIf(process.env.PRIM_NATIVE_KEYRING_INTEGRATION !== "1")(
  "round trips through persistent platform credential storage",
  async () => {
    const entry = new AsyncEntry("ai.primitive.prim.test", randomUUID(), {
      linux: { store: "secret-service" },
    });
    const signal = AbortSignal.timeout(10_000);
    try {
      await entry.setPassword("non-secret-integration-fixture", signal);
      expect(await entry.getPassword(signal)).toBe("non-secret-integration-fixture");
    } finally {
      await entry.deletePassword(signal);
    }
  },
);
