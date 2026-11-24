import { describe, expect, it } from "vitest";
import { cloudSetupPointer } from "./cloud-env.js";

describe("cloudSetupPointer", () => {
  it("leaves the message alone outside a Claude Code cloud session", () => {
    expect(cloudSetupPointer("GitHub repo connection is required", {})).toBe(
      "GitHub repo connection is required",
    );
  });

  it("points at cloud setup, which names the cause, inside one", () => {
    expect(
      cloudSetupPointer("Machine authentication is cooling down. Retry later.", {
        CLAUDE_CODE_REMOTE: "true",
      }),
    ).toBe(
      "Machine authentication is cooling down. Retry later; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
    );
  });
});
