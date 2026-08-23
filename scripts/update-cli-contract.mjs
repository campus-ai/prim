import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = resolve(ROOT, "contracts/cli-http-v1.lock.json");
const SOURCE_REPOSITORY = "campus-ai/primitive";
const ARTIFACTS = {
  schema: {
    sourcePath: "contracts/cli-http-v1.schema.json",
    vendoredPath: resolve(ROOT, "contracts/cli-http-v1.schema.json"),
  },
  fixtures: {
    sourcePath: "contracts/cli-http-v1.fixtures.json",
    vendoredPath: resolve(ROOT, "contracts/cli-http-v1.fixtures.json"),
  },
};

function usage() {
  return "usage: pnpm contracts:update --repository <client-repo> --revision <git-revision>";
}

function parseObject(bytes, label) {
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    repository: { type: "string" },
    revision: { type: "string" },
  },
});
if (
  positionals.length > 0 ||
  typeof values.repository !== "string" ||
  typeof values.revision !== "string"
) {
  throw new Error(usage());
}

const repository = resolve(values.repository);
const revision = execFileSync(
  "git",
  ["-C", repository, "rev-parse", "--verify", `${values.revision}^{commit}`],
  { encoding: "utf8" },
).trim();
if (!/^[0-9a-f]{40}$/u.test(revision)) {
  throw new Error("source revision did not resolve to a full lowercase commit ID");
}

const bytes = Object.fromEntries(
  Object.entries(ARTIFACTS).map(([name, artifact]) => [
    name,
    execFileSync("git", ["-C", repository, "show", `${revision}:${artifact.sourcePath}`]),
  ]),
);
const schemaBytes = bytes.schema;
const fixturesBytes = bytes.fixtures;
if (!schemaBytes || !fixturesBytes) {
  throw new Error("source revision does not contain both required CLI contract artifacts");
}
const schema = parseObject(schemaBytes, "source contract schema");
const fixtures = parseObject(fixturesBytes, "source conformance fixtures");
if (
  typeof schema.$id !== "string" ||
  typeof schema["x-primitive-contract-version"] !== "number" ||
  typeof schema["x-primitive-scope"] !== "string"
) {
  throw new Error("source revision does not contain a supported CLI contract schema");
}
if (
  fixtures.contractId !== schema.$id ||
  fixtures.contractVersion !== schema["x-primitive-contract-version"] ||
  !Array.isArray(fixtures.cases) ||
  fixtures.cases.length === 0
) {
  throw new Error("source conformance fixtures do not match the CLI contract schema");
}

const lock = {
  sourceRepository: SOURCE_REPOSITORY,
  sourceCommit: revision,
  artifacts: Object.fromEntries(
    Object.entries(ARTIFACTS).map(([name, artifact]) => [
      name,
      {
        sourcePath: artifact.sourcePath,
        sha256: createHash("sha256").update(bytes[name]).digest("hex"),
      },
    ]),
  ),
  artifactId: schema.$id,
  contractVersion: schema["x-primitive-contract-version"],
  scope: schema["x-primitive-scope"],
};
for (const [name, artifact] of Object.entries(ARTIFACTS)) {
  writeFileSync(artifact.vendoredPath, bytes[name]);
}
writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
