import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCK_PATH = resolve(ROOT, "contracts/cli-http-v1.lock.json");
const SOURCE_REPOSITORY = "campus-ai/primitive";
const SOURCE_REMOTE = `https://github.com/${SOURCE_REPOSITORY}.git`;
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
  return "usage: pnpm contracts:update --revision <full-client-commit> | pnpm contracts:provenance";
}

function fullCommit(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase commit ID`);
  }
  return value;
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

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function parseArtifacts(bytes) {
  const schema = parseObject(bytes.schema, "source contract schema");
  const fixtures = parseObject(bytes.fixtures, "source conformance fixtures");
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
  return schema;
}

function fetchCanonicalArtifacts(revision) {
  const checkout = mkdtempSync(join(tmpdir(), "primitive-cli-contract-"));
  try {
    execFileSync("git", ["init", "--bare", "--quiet", checkout]);
    execFileSync("git", [
      "-C",
      checkout,
      "fetch",
      "--no-tags",
      "--depth=1",
      SOURCE_REMOTE,
      revision,
    ]);
    const resolved = execFileSync(
      "git",
      ["-C", checkout, "rev-parse", "--verify", "FETCH_HEAD^{commit}"],
      { encoding: "utf8" },
    ).trim();
    if (resolved !== revision) {
      throw new Error(`canonical source resolved ${resolved}, not requested commit ${revision}`);
    }
    return Object.fromEntries(
      Object.entries(ARTIFACTS).map(([name, artifact]) => [
        name,
        execFileSync("git", ["-C", checkout, "show", `${revision}:${artifact.sourcePath}`]),
      ]),
    );
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}

function readLock() {
  const lock = parseObject(readFileSync(LOCK_PATH), "contract lock");
  assertExactKeys(
    lock,
    ["artifactId", "artifacts", "contractVersion", "scope", "sourceCommit", "sourceRepository"],
    "contract lock",
  );
  if (lock.sourceRepository !== SOURCE_REPOSITORY) {
    throw new Error("contract lock does not identify the canonical CLI source");
  }
  fullCommit(lock.sourceCommit, "sourceCommit");
  if (
    typeof lock.artifacts !== "object" ||
    lock.artifacts === null ||
    Array.isArray(lock.artifacts)
  ) {
    throw new Error("contract lock artifacts must be an object");
  }
  assertExactKeys(lock.artifacts, Object.keys(ARTIFACTS), "contract lock artifacts");
  for (const [name, artifact] of Object.entries(ARTIFACTS)) {
    const entry = lock.artifacts[name];
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`${name} provenance must be an object`);
    }
    assertExactKeys(entry, ["sha256", "sourcePath"], `${name} provenance`);
    if (entry.sourcePath !== artifact.sourcePath) {
      throw new Error(`${name} provenance has an unexpected source path`);
    }
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error(`${name} provenance has an invalid checksum`);
    }
  }
  return lock;
}

function writeContract(revision) {
  const bytes = fetchCanonicalArtifacts(revision);
  const schema = parseArtifacts(bytes);
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
}

function verifyProvenance() {
  const lock = readLock();
  const canonicalBytes = fetchCanonicalArtifacts(lock.sourceCommit);
  parseArtifacts(canonicalBytes);
  for (const [name, artifact] of Object.entries(ARTIFACTS)) {
    const vendoredBytes = readFileSync(artifact.vendoredPath);
    if (!canonicalBytes[name].equals(vendoredBytes)) {
      throw new Error(`${name} bytes do not match the canonical source commit`);
    }
    const checksum = createHash("sha256").update(vendoredBytes).digest("hex");
    if (checksum !== lock.artifacts[name].sha256) {
      throw new Error(`${name} checksum does not match its lock`);
    }
  }
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      check: { type: "boolean" },
      revision: { type: "string" },
    },
  });
  if (positionals.length > 0 || (values.check === true && values.revision !== undefined)) {
    throw new Error(usage());
  }
  if (values.check === true) {
    verifyProvenance();
    return;
  }
  if (Object.keys(values).length === 1 && typeof values.revision === "string") {
    writeContract(fullCommit(values.revision, "revision"));
    return;
  }
  throw new Error(usage());
}

main();
