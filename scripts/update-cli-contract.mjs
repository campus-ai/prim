import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_PATH = "contracts/cli-http-v1.schema.json";
const LOCK_PATH = resolve(ROOT, "contracts/cli-http-v1.lock.json");
const VENDORED_PATH = resolve(ROOT, ARTIFACT_PATH);
const SOURCE_REPOSITORY = "campus-ai/primitive";
const SOURCE_REMOTE = `https://github.com/${SOURCE_REPOSITORY}.git`;

function usage() {
  return "usage: pnpm contracts:update --revision <full-client-commit> | pnpm contracts:provenance";
}

function fullCommit(value, label) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/u.test(value)) {
    throw new Error(`${label} must be a full lowercase commit ID`);
  }
  return value;
}

function parseArtifact(artifactBytes) {
  const artifact = JSON.parse(artifactBytes.toString("utf8"));
  if (
    typeof artifact !== "object" ||
    artifact === null ||
    Array.isArray(artifact) ||
    typeof artifact.$id !== "string" ||
    typeof artifact["x-primitive-contract-version"] !== "number" ||
    typeof artifact["x-primitive-scope"] !== "string"
  ) {
    throw new Error("source revision does not contain a supported CLI contract artifact");
  }
  return artifact;
}

function fetchCanonicalArtifact(revision) {
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
    return execFileSync("git", ["-C", checkout, "show", `${revision}:${ARTIFACT_PATH}`]);
  } finally {
    rmSync(checkout, { force: true, recursive: true });
  }
}

function readLock() {
  const lock = JSON.parse(readFileSync(LOCK_PATH, "utf8"));
  if (
    typeof lock !== "object" ||
    lock === null ||
    Array.isArray(lock) ||
    lock.sourceRepository !== SOURCE_REPOSITORY ||
    lock.sourcePath !== ARTIFACT_PATH
  ) {
    throw new Error("contract lock does not identify the canonical CLI source");
  }
  fullCommit(lock.sourceCommit, "sourceCommit");
  if (typeof lock.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(lock.sha256)) {
    throw new Error("contract lock has an invalid checksum");
  }
  return lock;
}

function writeContract(revision) {
  const artifactBytes = fetchCanonicalArtifact(revision);
  const artifact = parseArtifact(artifactBytes);
  const lock = {
    sourceRepository: SOURCE_REPOSITORY,
    sourceCommit: revision,
    sourcePath: ARTIFACT_PATH,
    sha256: createHash("sha256").update(artifactBytes).digest("hex"),
    artifactId: artifact.$id,
    contractVersion: artifact["x-primitive-contract-version"],
    scope: artifact["x-primitive-scope"],
  };
  writeFileSync(VENDORED_PATH, artifactBytes);
  writeFileSync(LOCK_PATH, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
}

function verifyProvenance() {
  const lock = readLock();
  const canonicalBytes = fetchCanonicalArtifact(lock.sourceCommit);
  parseArtifact(canonicalBytes);
  const vendoredBytes = readFileSync(VENDORED_PATH);
  if (!canonicalBytes.equals(vendoredBytes)) {
    throw new Error("vendored contract bytes do not match the canonical source commit");
  }
  const checksum = createHash("sha256").update(vendoredBytes).digest("hex");
  if (checksum !== lock.sha256) {
    throw new Error("vendored contract checksum does not match its lock");
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
