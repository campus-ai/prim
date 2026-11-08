import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AsyncEntry } from "@napi-rs/keyring";
import { atomicWriteFile } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import {
  MachineAuthError,
  type MachineConfiguration,
  type MachineIdentity,
  type MachineTokens,
  discoverMachineConfiguration,
  exchangeMachineCredentials,
  machineApiUrl,
  machineRecord,
  machineString,
  parseMachineConfiguration,
  parseMachineIdentity,
  verifyMachineIdentity,
} from "./machine-protocol.js";
import { primConfigDirectory } from "./paths.js";

export type MachineStorage = "keychain" | "file" | "environment";
export type MachineProfile = MachineConfiguration &
  MachineIdentity & {
    version: 1;
    apiUrl: string;
    generation: string;
    storage: Exclude<MachineStorage, "environment">;
  };
type MachineRecord = MachineProfile & MachineTokens & { clientSecret: string };
export type MachineCredential = MachineConfiguration &
  MachineIdentity &
  MachineTokens & {
    apiUrl: string;
    generation: string;
    storage: MachineStorage;
  };
type SecretEntry = Pick<AsyncEntry, "getPassword" | "setPassword" | "deletePassword">;
export type MachineDependencies = {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  entry?: (key: string) => SecretEntry;
};

const require = createRequire(import.meta.url);
const SERVICE = "ai.primitive.prim.machine";
const DEFAULT_API_URL = "https://api.getprimitive.ai";
const PROFILE_FILE = "machine_profile.json";
const RENEW_BEFORE_MS = 60_000;
let cached: MachineCredential | undefined;

function configurationDirectory(deps: MachineDependencies): string {
  return deps.directory ?? primConfigDirectory({ env: deps.env });
}
function apiUrlFor(deps: MachineDependencies): string {
  return machineApiUrl((deps.env ?? process.env).PRIM_API_URL?.trim() || DEFAULT_API_URL);
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function recordPath(directory: string, generation: string): string {
  return join(directory, `machine_${generation}.json`);
}
function storageKey(directory: string, generation: string): string {
  return `${hash(directory)}:${generation}`;
}

function keyringEntry(key: string): SecretEntry {
  // Copied runtimes own their native loader and binary; never depend on the npm cache.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++) {
    const loader = join(directory, "native", "keyring.cjs");
    if (existsSync(loader)) {
      const module = require(loader) as typeof import("@napi-rs/keyring");
      return new module.AsyncEntry(SERVICE, key, { linux: { store: "secret-service" } });
    }
    directory = dirname(directory);
  }
  const module = require("@napi-rs/keyring") as typeof import("@napi-rs/keyring");
  return new module.AsyncEntry(SERVICE, key, { linux: { store: "secret-service" } });
}

function protectPath(path: string, directory: boolean): void {
  if (process.platform !== "win32") {
    chmodSync(path, directory ? 0o700 : 0o600);
    return;
  }
  const encodedPath = Buffer.from(path).toString("base64");
  const script = `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', '${directory ? "ContainerInherit, ObjectInherit" : "None"}', 'None', 'Allow'); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $p -AclObject $acl`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { stdio: "ignore", windowsHide: true },
  );
}

function ensureDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink())
    throw new MachineAuthError(
      "unsafe_storage",
      "Credential directory must not be a symbolic link.",
    );
  protectPath(directory, true);
}
function writePrivate(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  protectPath(path, false);
}
function readPrivate(path: string): unknown | undefined {
  let raw: string;
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.size > 96 * 1024 ||
      (process.platform !== "win32" &&
        ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    ) {
      throw new MachineAuthError(
        "unsafe_storage",
        "Machine credential files must be owner-only regular files.",
      );
    }
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new MachineAuthError("invalid_storage", "Stored machine credentials are malformed.");
  }
}

function parseProfile(value: unknown): MachineProfile {
  const data = machineRecord(value);
  const config = parseMachineConfiguration({
    protocol_version: data.version,
    issuer: data.issuer,
    audience: data.audience,
  });
  if (
    typeof data.apiUrl !== "string" ||
    machineApiUrl(data.apiUrl) !== data.apiUrl ||
    !machineString(data.generation, 64) ||
    !/^[a-f0-9-]{36}$/u.test(data.generation) ||
    (data.storage !== "keychain" && data.storage !== "file") ||
    !machineString(data.clientId, 256)
  ) {
    throw new MachineAuthError("invalid_storage", "Stored machine profile is malformed.");
  }
  const identity = parseMachineIdentity(
    {
      authenticated: true,
      organizationBindingVersion: 2,
      captureAuthorityKind: "workos_m2m",
      organizationId: data.organizationId,
      workosOrganizationId: data.workosOrganizationId,
      principal: { ...data, kind: "machine" },
    },
    data.clientId,
  );
  return {
    ...config,
    ...identity,
    version: 1,
    apiUrl: data.apiUrl,
    generation: data.generation,
    storage: data.storage,
  };
}

export function readMachineProfile(deps: MachineDependencies = {}): MachineProfile | undefined {
  const value = readPrivate(join(configurationDirectory(deps), PROFILE_FILE));
  return value === undefined ? undefined : parseProfile(value);
}

function environmentCredentials(
  deps: MachineDependencies,
): { clientId: string; clientSecret: string; generation: string } | undefined {
  const env = deps.env ?? process.env;
  const { PRIM_M2M_CLIENT_ID: clientId, PRIM_M2M_CLIENT_SECRET: clientSecret } = env;
  if (clientId === undefined && clientSecret === undefined) return undefined;
  if (
    !clientId ||
    !clientSecret ||
    !/^client_[\w-]+$/u.test(clientId) ||
    !machineString(clientSecret)
  ) {
    throw new MachineAuthError(
      "incomplete_machine_credentials",
      "Set both PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET.",
    );
  }
  return {
    clientId,
    clientSecret,
    generation: hash(`${apiUrlFor(deps)}\0${clientId}\0${clientSecret}`),
  };
}

export function hasMachineConfiguration(deps: MachineDependencies = {}): boolean {
  const env = deps.env ?? process.env;
  const configured =
    env.PRIM_M2M_CLIENT_ID !== undefined ||
    env.PRIM_M2M_CLIENT_SECRET !== undefined ||
    existsSync(join(configurationDirectory(deps), PROFILE_FILE));
  if (configured && env.PRIM_TOKEN?.trim()) {
    throw new MachineAuthError(
      "conflicting_credentials",
      "Unset PRIM_TOKEN when using machine credentials.",
    );
  }
  if (configured) environmentCredentials(deps);
  return configured;
}

/** Non-secret context for journal partitioning and local daemon isolation. */
export function machineContext(
  deps: MachineDependencies = {},
): (MachineIdentity & { issuer: string; generation: string; apiUrl: string }) | undefined {
  if (!hasMachineConfiguration(deps)) return undefined;
  const environment = environmentCredentials(deps);
  if (environment) return cached?.generation === environment.generation ? cached : undefined;
  const profile = readMachineProfile(deps);
  if (profile && profile.apiUrl !== apiUrlFor(deps))
    throw new MachineAuthError(
      "deployment_mismatch",
      "Machine credentials belong to another API deployment. Configure this deployment or inject its credentials.",
    );
  return profile;
}

export function cachedMachineCredential(
  deps: MachineDependencies = {},
): MachineCredential | undefined {
  const context = machineContext(deps);
  return context && cached?.generation === context.generation && cached.apiUrl === context.apiUrl
    ? cached
    : undefined;
}

export function machineSessionEnded(deps: MachineDependencies = {}): boolean {
  if (!hasMachineConfiguration(deps)) return false;
  const generation =
    environmentCredentials(deps)?.generation ?? readMachineProfile(deps)?.generation;
  if (!generation) return false;
  // Environment credentials never write token/credential state to disk.
  if (environmentCredentials(deps)) return environmentTerminal === generation;
  return readPrivate(join(configurationDirectory(deps), "machine_terminal.json")) === generation;
}
let environmentTerminal: string | undefined;

async function loadRecord(
  profile: MachineProfile,
  deps: MachineDependencies,
  signal?: AbortSignal,
): Promise<MachineRecord> {
  const directory = configurationDirectory(deps);
  let value: unknown;
  try {
    if (profile.storage === "keychain") {
      const raw = await (deps.entry ?? keyringEntry)(
        storageKey(directory, profile.generation),
      ).getPassword(signal);
      if (!raw || raw.length > 96 * 1024) throw new Error("missing");
      value = JSON.parse(raw);
    } else value = readPrivate(recordPath(directory, profile.generation));
    const data = machineRecord(value);
    const stored = parseProfile(data);
    if (
      [
        "apiUrl",
        "issuer",
        "audience",
        "generation",
        "storage",
        "machineId",
        "clientId",
        "organizationId",
        "workosOrganizationId",
      ].some(
        (key) => stored[key as keyof MachineProfile] !== profile[key as keyof MachineProfile],
      ) ||
      !machineString(data.clientSecret) ||
      !machineString(data.accessToken, 64 * 1024) ||
      typeof data.expiresAt !== "number" ||
      !Number.isFinite(data.expiresAt)
    )
      throw new Error("mismatch");
    return {
      ...stored,
      clientSecret: data.clientSecret,
      accessToken: data.accessToken,
      expiresAt: data.expiresAt,
    };
  } catch {
    throw new MachineAuthError(
      "storage_unavailable",
      `Cannot read machine credentials from ${profile.storage}. Unlock or repair that store; Prim will not use another credential.`,
    );
  }
}

async function persistRecord(
  record: MachineRecord,
  deps: MachineDependencies,
  signal?: AbortSignal,
): Promise<void> {
  const directory = configurationDirectory(deps);
  if (record.storage === "keychain") {
    try {
      await (deps.entry ?? keyringEntry)(storageKey(directory, record.generation)).setPassword(
        JSON.stringify(record),
        signal,
      );
    } catch {
      throw new MachineAuthError(
        "storage_unavailable",
        "Cannot update the machine credential store. Unlock it and retry.",
      );
    }
  } else writePrivate(recordPath(directory, record.generation), record);
}

export async function configureMachine(
  clientId: string,
  clientSecret: string,
  deps: MachineDependencies = {},
  signal?: AbortSignal,
): Promise<MachineProfile> {
  if ((deps.env ?? process.env).PRIM_TOKEN?.trim() || environmentCredentials(deps)) {
    throw new MachineAuthError(
      "conflicting_credentials",
      "Unset injected credentials before configuring a saved machine.",
    );
  }
  const apiUrl = apiUrlFor(deps);
  const configuration = await discoverMachineConfiguration(apiUrl, signal, deps.fetch);
  const tokens = await exchangeMachineCredentials(
    configuration,
    clientId,
    clientSecret,
    signal,
    deps.fetch,
  );
  const identity = await verifyMachineIdentity(
    apiUrl,
    tokens.accessToken,
    clientId,
    signal,
    deps.fetch,
  );
  const directory = configurationDirectory(deps);
  ensureDirectory(directory);
  return withFileLock(
    join(directory, "credentials.lock"),
    async () => {
      const previous = readMachineProfile(deps);
      const retired = readRetiredProfiles(directory);
      let profile: MachineProfile = {
        ...configuration,
        ...identity,
        version: 1,
        apiUrl,
        generation: randomUUID(),
        storage: "keychain",
      };
      try {
        await persistRecord({ ...profile, ...tokens, clientSecret }, deps, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (previous?.storage === "keychain") throw error;
        profile = { ...profile, storage: "file" };
        await persistRecord({ ...profile, ...tokens, clientSecret }, deps, signal);
      }
      writePrivate(join(directory, PROFILE_FILE), profile);
      rmSync(join(directory, "machine_terminal.json"), { force: true });
      cached = { ...profile, ...tokens };
      if (previous) {
        writePrivate(join(directory, "machine_retired.json"), [...retired, previous]);
      }
      await cleanupRetired(deps, signal);
      return profile;
    },
    { signal },
  );
}

export async function acquireMachineCredential(
  options: { force?: boolean; signal?: AbortSignal } = {},
  deps: MachineDependencies = {},
): Promise<MachineCredential | undefined> {
  if (!hasMachineConfiguration(deps)) return undefined;
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  const apiUrl = apiUrlFor(deps);
  const environment = environmentCredentials(deps);
  if (environment) {
    const observedToken =
      cached?.generation === environment.generation ? cached.accessToken : undefined;
    const directory = configurationDirectory(deps);
    ensureDirectory(directory);
    return withFileLock(
      join(directory, "credentials.lock"),
      async () => {
        if (machineSessionEnded(deps))
          throw new MachineAuthError(
            "machine_credentials_rejected",
            "Rotate the injected machine credentials.",
            true,
          );
        if (
          (!options.force || (observedToken && cached?.accessToken !== observedToken)) &&
          cached?.generation === environment.generation &&
          cached.expiresAt > Date.now() + RENEW_BEFORE_MS
        )
          return cached;
        try {
          const configuration = await discoverMachineConfiguration(apiUrl, signal, deps.fetch);
          const tokens = await exchangeMachineCredentials(
            configuration,
            environment.clientId,
            environment.clientSecret,
            signal,
            deps.fetch,
          );
          const identity = await verifyMachineIdentity(
            apiUrl,
            tokens.accessToken,
            environment.clientId,
            signal,
            deps.fetch,
          );
          cached = {
            ...configuration,
            ...tokens,
            ...identity,
            apiUrl,
            generation: environment.generation,
            storage: "environment",
          };
          return cached;
        } catch (error) {
          if (error instanceof MachineAuthError && error.terminal)
            environmentTerminal = environment.generation;
          throw error;
        }
      },
      { signal },
    );
  }
  const observedToken = cachedMachineCredential(deps)?.accessToken;
  const expected = machineContext(deps);
  const directory = configurationDirectory(deps);
  return withFileLock(
    join(directory, "credentials.lock"),
    async () => {
      const profile = readMachineProfile(deps);
      if (!profile || profile.generation !== expected?.generation || profile.apiUrl !== apiUrl)
        throw new MachineAuthError(
          "identity_changed",
          "Machine identity changed; retry the operation.",
        );
      if (machineSessionEnded(deps))
        throw new MachineAuthError(
          "machine_credentials_rejected",
          "Configure rotated or enabled machine credentials.",
          true,
        );
      let record = await loadRecord(profile, deps, signal);
      if (
        (options.force && (!observedToken || observedToken === record.accessToken)) ||
        record.expiresAt <= Date.now() + RENEW_BEFORE_MS
      ) {
        try {
          const tokens = await exchangeMachineCredentials(
            profile,
            profile.clientId,
            record.clientSecret,
            signal,
            deps.fetch,
          );
          const identity = await verifyMachineIdentity(
            apiUrl,
            tokens.accessToken,
            profile.clientId,
            signal,
            deps.fetch,
          );
          if (
            identity.machineId !== profile.machineId ||
            identity.organizationId !== profile.organizationId ||
            identity.workosOrganizationId !== profile.workosOrganizationId
          )
            throw new MachineAuthError(
              "identity_changed",
              "Machine identity changed; configure the new identity explicitly.",
              true,
            );
          record = { ...record, ...identity, ...tokens };
          await persistRecord(record, deps, signal);
        } catch (error) {
          if (error instanceof MachineAuthError && error.terminal)
            writePrivate(join(directory, "machine_terminal.json"), profile.generation);
          throw error;
        }
      }
      const { clientSecret: _secret, ...credential } = record;
      cached = credential;
      return credential;
    },
    { signal },
  );
}

export async function clearMachineCredentials(deps: MachineDependencies = {}): Promise<boolean> {
  const directory = configurationDirectory(deps);
  if (!existsSync(join(directory, PROFILE_FILE))) return false;
  return withFileLock(join(directory, "credentials.lock"), async () => {
    const profile = readMachineProfile(deps);
    if (!profile) return false;
    await cleanupRetired(deps, AbortSignal.timeout(10_000));
    if (existsSync(join(directory, "machine_retired.json")))
      throw new MachineAuthError(
        "storage_unavailable",
        "Unlock the credential store to remove retired machine credentials.",
      );
    if (profile.storage === "keychain") {
      try {
        const entry = (deps.entry ?? keyringEntry)(storageKey(directory, profile.generation));
        const signal = AbortSignal.timeout(10_000);
        if ((await entry.getPassword(signal)) !== null) await entry.deletePassword(signal);
      } catch {
        throw new MachineAuthError(
          "storage_unavailable",
          "Unlock the keychain to remove the saved machine credential.",
        );
      }
    } else rmSync(recordPath(directory, profile.generation), { force: true });
    rmSync(join(directory, PROFILE_FILE), { force: true });
    rmSync(join(directory, "machine_terminal.json"), { force: true });
    cached = undefined;
    return true;
  });
}

export type MachineCaptureActor = {
  kind: "machine";
  apiUrl: string;
  clientId: string;
  issuer?: string;
  machineId?: string;
  organizationId?: string;
};

export function machineCaptureActor(
  deps: MachineDependencies = {},
): MachineCaptureActor | undefined {
  if (!hasMachineConfiguration(deps)) return undefined;
  const context = machineContext(deps);
  if (context)
    return {
      kind: "machine",
      apiUrl: context.apiUrl,
      clientId: context.clientId,
      issuer: context.issuer,
      machineId: context.machineId,
      organizationId: context.organizationId,
    };
  const injected = environmentCredentials(deps);
  return injected
    ? { kind: "machine", apiUrl: apiUrlFor(deps), clientId: injected.clientId }
    : undefined;
}

export function machineJournalBucket(
  identity: Pick<MachineCaptureActor, "apiUrl" | "clientId">,
): string {
  return `_machine_${hash(`${identity.apiUrl}\0${identity.clientId}`)}`;
}

function readRetiredProfiles(directory: string): MachineProfile[] {
  const value = readPrivate(join(directory, "machine_retired.json"));
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new MachineAuthError(
      "storage_unavailable",
      "Invalid retired machine credential metadata.",
    );
  return value.map(parseProfile);
}

async function cleanupRetired(deps: MachineDependencies, signal?: AbortSignal): Promise<void> {
  const directory = configurationDirectory(deps);
  const path = join(directory, "machine_retired.json");
  const pending: MachineProfile[] = [];
  for (const profile of readRetiredProfiles(directory)) {
    try {
      if (profile.storage === "keychain") {
        const entry = (deps.entry ?? keyringEntry)(storageKey(directory, profile.generation));
        if ((await entry.getPassword(signal)) !== null) await entry.deletePassword(signal);
      } else rmSync(recordPath(directory, profile.generation), { force: true });
    } catch {
      pending.push(profile);
    }
  }
  if (pending.length) writePrivate(path, pending);
  else rmSync(path, { force: true });
}
