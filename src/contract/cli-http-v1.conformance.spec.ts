import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type CliHttpV1DefinitionName, cliHttpV1Validators } from "./cli-http-v1.js";

type ConformanceCase = {
  name: string;
  definition: string;
  valid: boolean;
  value: unknown;
};

const schema = JSON.parse(readFileSync(resolve("contracts/cli-http-v1.schema.json"), "utf8")) as {
  $id: string;
  "x-primitive-contract-version": number;
  $defs: Record<string, unknown>;
};
const fixtures = JSON.parse(
  readFileSync(resolve("contracts/cli-http-v1.fixtures.json"), "utf8"),
) as {
  contractId: string;
  contractVersion: number;
  cases: ConformanceCase[];
};

function validatorFor(definition: string): ((value: unknown) => boolean) | undefined {
  return Object.hasOwn(cliHttpV1Validators, definition)
    ? cliHttpV1Validators[definition as CliHttpV1DefinitionName]
    : undefined;
}

describe("shared CLI HTTP conformance fixtures", () => {
  it("matches the schema identity and completely covers every definition", () => {
    expect(fixtures.contractId).toBe(schema.$id);
    expect(fixtures.contractVersion).toBe(schema["x-primitive-contract-version"]);

    const definitions = Object.keys(schema.$defs).sort();
    expect(Object.keys(cliHttpV1Validators).sort()).toEqual(definitions);
    expect([...new Set(fixtures.cases.map(({ definition }) => definition))].sort()).toEqual(
      definitions,
    );
    for (const definition of definitions) {
      expect(
        fixtures.cases.some((fixture) => fixture.definition === definition && fixture.valid),
        `${definition} must have a valid shared fixture`,
      ).toBe(true);
    }
  });

  it.each(fixtures.cases)("$name", ({ definition, valid, value }) => {
    const validator = validatorFor(definition);
    expect(validator, `missing validator for ${definition}`).toBeDefined();
    expect(validator?.(value)).toBe(valid);
  });
});
