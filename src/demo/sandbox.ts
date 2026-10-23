import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { atomicWriteFile } from "../lib/atomic-file.js";
import {
  REPOSITORY_EDIT,
  SAMPLE_DECISIONS,
  SAMPLE_FILES,
  SAMPLE_NOTE,
  WARNING_EDIT,
} from "./scenario.js";
import { type DemoRun, saveRun } from "./state.js";
import { DEMO_ADHERE, DEMO_INITIAL, DEMO_SUPERSEDE } from "./story.js";

export const decisionBytes = (adopted: boolean) =>
  `${JSON.stringify(adopted ? SAMPLE_DECISIONS : SAMPLE_DECISIONS.slice(0, 1), null, 2)}\n`;

function allowedFiles(run: DemoRun): Record<string, readonly string[]> {
  if (run.version === 2)
    return { ".owner": [run.id], "customers.ts": [DEMO_INITIAL, DEMO_ADHERE, DEMO_SUPERSEDE] };
  return {
    ".owner": [run.id],
    "note.md": [SAMPLE_NOTE],
    "decisions.json": [decisionBytes(false), decisionBytes(true)],
    ...Object.fromEntries(Object.entries(SAMPLE_FILES).map(([name, value]) => [name, [value]])),
    "service.ts": [SAMPLE_FILES["service.ts"], WARNING_EDIT],
    "orders.ts": [SAMPLE_FILES["orders.ts"], REPOSITORY_EDIT],
  };
}

/** Validate ownership and contents before any write/delete, including recovery. */
export function inspectSandbox(run: DemoRun): string {
  const sandbox = run.sandbox;
  if (
    !sandbox ||
    dirname(sandbox.path) !== realpathSync(tmpdir()) ||
    !basename(sandbox.path).startsWith("prim-demo-")
  ) {
    throw new Error("invalid demo sandbox ownership");
  }
  const stat = lstatSync(sandbox.path);
  if (!stat.isDirectory() || stat.dev !== sandbox.device || stat.ino !== sandbox.inode) {
    throw new Error(`demo sandbox changed; retained ${sandbox.path}`);
  }
  const allowed = allowedFiles(run);
  for (const name of readdirSync(sandbox.path)) {
    const path = join(sandbox.path, name);
    const file = lstatSync(path);
    if (
      !Object.hasOwn(allowed, name) ||
      !file.isFile() ||
      file.nlink !== 1 ||
      file.size > 16_384 ||
      !allowed[name].includes(readFileSync(path, "utf8"))
    ) {
      throw new Error(`unexpected demo contents; retained ${sandbox.path}`);
    }
  }
  return sandbox.path;
}

export function createSandbox(run: DemoRun): void {
  if (!run.sandbox) {
    const path = mkdtempSync(join(realpathSync(tmpdir()), "prim-demo-"));
    const stat = lstatSync(path);
    run.sandbox = { path, device: stat.dev, inode: stat.ino };
    // Record ownership before the first sample file so an interrupted start
    // remains recoverable without guessing which directory belongs to us.
    saveRun(run);
  }
  const root = inspectSandbox(run);
  const files =
    run.version === 2
      ? { ".owner": run.id, "customers.ts": DEMO_INITIAL }
      : {
          ".owner": run.id,
          "note.md": SAMPLE_NOTE,
          ...SAMPLE_FILES,
          "decisions.json": decisionBytes(false),
        };
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name);
    if (!existsSync(path)) atomicWriteFile(path, content, { mode: 0o600 });
  }
}

export function writeSample(
  run: DemoRun,
  name: "service.ts" | "orders.ts" | "decisions.json" | "customers.ts",
  bytes: string,
): void {
  const root = inspectSandbox(run);
  if (!allowedFiles(run)[name].includes(bytes)) throw new Error("unsupported demo edit");
  atomicWriteFile(join(root, name), bytes, { mode: 0o600 });
}

export function readSample(run: DemoRun, name: keyof typeof SAMPLE_FILES | "customers.ts"): string {
  return readFileSync(join(inspectSandbox(run), name), "utf8");
}

export function cleanSandbox(run: DemoRun): void {
  if (!run.sandbox) return;
  // An already removed directory is a successful idempotent cleanup.
  try {
    lstatSync(run.sandbox.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    run.sandbox = undefined;
    return;
  }
  const root = inspectSandbox(run);
  for (const name of readdirSync(root)) {
    inspectSandbox(run);
    unlinkSync(join(root, name));
  }
  rmdirSync(root);
  run.sandbox = undefined;
}
