import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACT_PATH = "contracts/cli-http-v1.schema.json";
const LOCK_PATH = resolve(ROOT, "contracts/cli-http-v1.lock.json");
const VENDORED_PATH = resolve(ROOT, ARTIFACT_PATH);
const SOURCE_REPOSITORY = "campus-ai/primitive";

function usage() {
  return "usage: pnpm contracts:update --repository <client-repo> --revision <git-revision>";
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

const artifactBytes = execFileSync("git", [
  "-C",
  repository,
  "show",
  `${revision}:${ARTIFACT_PATH}`,
]);
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
