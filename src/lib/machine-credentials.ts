import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AsyncEntry } from "@napi-rs/keyring";
import { atomicWriteFile } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { acquireBrokerCredential, forwardBrokerRequest } from "./machine-broker.js";
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
  parseInjectedMachineIdentity,
  parseMachineConfiguration,
  parseMachineIdentity,
  rejectedCredentialsMessage,
  verifyInjectedMachineIdentity,
  verifyMachineIdentity,
} from "./machine-protocol.js";
import { withMachineCooldown } from "./machine-retry.js";
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
    /**
     * The cloud environment's proxy holds the access token and attaches it to
     * API requests; `accessToken` is empty and requests go through the broker.
     */
    tokenInjection?: "network";
  };
type SecretEntry = Pick<AsyncEntry, "getPassword" | "setPassword" | "deletePassword">;
export type MachineDependencies = {
  expectedAuthorizedUserId?: string;
  expectedOrganizationId?: string;
  directory?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  entry?: (key: string) => SecretEntry;
  /** Only the credential broker itself performs environment exchanges directly. */
  localEnvironment?: boolean;
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

function environmentContextPath(deps: MachineDependencies, clientId: string): string {
  return join(
    configurationDirectory(deps),
    `machine_context_${hash(`${apiUrlFor(deps)}\0${clientId}`)}.json`,
  );
}

/** Share only verified identity metadata with fresh hooks, never injected secrets or tokens. */
function writeEnvironmentContext(credential: MachineCredential, deps: MachineDependencies): void {
  const {
    apiUrl,
    issuer,
    audience,
    generation,
    machineId,
    clientId,
    organizationId,
    workosOrganizationId,
    displayName,
    authorizedUserId,
    scopes,
    expiresAt,
  } = credential;
  try {
    writePrivate(environmentContextPath(deps, clientId), {
      version: 1,
      apiUrl,
      issuer,
      audience,
      generation,
      machineId,
      clientId,
      organizationId,
      workosOrganizationId,
      displayName,
      authorizedUserId,
      scopes,
      expiresAt,
    });
  } catch {
    // This cache is an optimization for local daemon clients, not an auth store.
  }
}

function readEnvironmentContext(
  environment: { clientId: string; generation: string },
  deps: MachineDependencies,
): (MachineConfiguration & MachineIdentity & { apiUrl: string; generation: string }) | undefined {
  try {
    const data = machineRecord(readPrivate(environmentContextPath(deps, environment.clientId)));
    if (
      data.generation !== environment.generation ||
      data.clientId !== environment.clientId ||
      data.apiUrl !== apiUrlFor(deps) ||
      typeof data.expiresAt !== "number" ||
      !Number.isFinite(data.expiresAt) ||
      data.expiresAt <= Date.now()
    )
      return undefined;
    const configuration = parseMachineConfiguration({
      protocol_version: data.version,
      issuer: data.issuer,
      audience: data.audience,
    });
    const identity = parseStoredIdentity(data);
    return {
      ...configuration,
      ...identity,
      apiUrl: data.apiUrl as string,
      generation: environment.generation,
    };
  } catch {
    return undefined;
  }
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
  // Use .NET directly: PowerShell 7 module paths can break Windows PowerShell cmdlet loading.
  const encodedPath = Buffer.from(path).toString("base64");
  const script = `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [System.Security.AccessControl.${directory ? "DirectorySecurity" : "FileSecurity"}]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true, $false); $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', '${directory ? "ContainerInherit, ObjectInherit" : "None"}', 'None', 'Allow'); $acl.AddAccessRule($rule); [System.IO.${directory ? "Directory" : "File"}]::SetAccessControl($p, $acl)`;
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { stdio: "pipe", encoding: "utf8", windowsHide: true },
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

function parseStoredIdentity(data: Record<string, unknown>): MachineIdentity {
  return parseMachineIdentity(
    {
      authenticated: true,
      organizationBindingVersion: data.authorizedUserId ? 3 : 2,
      captureAuthorityKind: "workos_m2m",
      organizationId: data.organizationId,
      workosOrganizationId: data.workosOrganizationId,
      principal: { ...data, kind: "machine" },
    },
    String(data.clientId),
  );
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
  const identity = parseStoredIdentity(data);
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

/** The secret reaches the token service through the cloud environment's network secret. */
export const NETWORK_SECRET_AUTH = "network-secret";
/**
 * The cloud environment's proxy requests the tokens too (an "OAuth 2.0 client
 * credentials" network secret) and attaches one to each API request, so
 * neither the secret nor a token ever enters the VM.
 */
export const NETWORK_TOKEN_AUTH = "network-token";
/** How long a proxy-authenticated identity is trusted before it is verified again. */
const INJECTED_IDENTITY_TTL_MS = 60 * 60_000;

export type EnvironmentCredentials = {
  clientId: string;
  /**
   * The client secret, or in a network mode a local random key: the broker
   * authenticates its peers with it and no request to a service carries it.
   */
  clientSecret: string;
  generation: string;
  secretInjection?: "network";
  tokenInjection?: "network";
};

const brokerKeys = new Map<string, string>();

/**
 * The broker's peer-authentication key when no client secret is in the
 * process. Random, owner-only, and per API and client, so every prim process
 * in the VM agrees on it without the secret ever entering the VM. Created
 * whole (written aside, then linked into place) so a concurrent reader never
 * sees a partial key, and read with the same ownership checks as every other
 * credential file. An absent key is only ever created, never removed, so
 * processes starting together always settle on the same one.
 */
function networkSecretBrokerKey(deps: MachineDependencies, clientId: string): string {
  const directory = configurationDirectory(deps);
  const path = join(directory, `machine_network_${hash(`${apiUrlFor(deps)}\0${clientId}`)}.key`);
  const known = brokerKeys.get(path);
  if (known) return known;
  ensureDirectory(directory);
  // undefined: absent; without key: present but not a key.
  const read = (): { key?: string } | undefined => {
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        (process.platform !== "win32" &&
          ((stat.mode & 0o077) !== 0 ||
            (typeof process.getuid === "function" && stat.uid !== process.getuid())))
      )
        throw new MachineAuthError(
          "unsafe_storage",
          `The machine broker key at ${path} is not an owner-only file. Delete it and retry.`,
          true,
        );
      const value = readFileSync(path, "utf8").trim();
      return { key: /^[a-f0-9]{64}$/u.test(value) ? value : undefined };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const existing = read();
    if (existing?.key) {
      brokerKeys.set(path, existing.key);
      return existing.key;
    }
    // Keys are only ever linked into place whole, so a file here that is not
    // a key was damaged from outside. Replacing it would race other processes
    // creating theirs; refuse it as unsafe instead.
    if (existing)
      throw new MachineAuthError(
        "unsafe_storage",
        `The machine broker key at ${path} is damaged. Delete it and retry.`,
        true,
      );
    const staged = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      writeFileSync(staged, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      // POSIX modes do not protect a file on Windows; owner-only ACLs do.
      protectPath(staged, false);
      linkSync(staged, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(staged, { force: true });
    }
  }
  const key = read()?.key;
  if (!key)
    throw new MachineAuthError("unsafe_storage", "The machine broker key is unreadable.", true);
  brokerKeys.set(path, key);
  return key;
}

export function environmentCredentials(
  deps: MachineDependencies,
): EnvironmentCredentials | undefined {
  const env = deps.env ?? process.env;
  const {
    PRIM_M2M_CLIENT_ID: clientId,
    PRIM_M2M_CLIENT_SECRET: clientSecret,
    PRIM_M2M_CLIENT_AUTH: auth,
  } = env;
  if (clientId === undefined && clientSecret === undefined && auth === undefined) return undefined;
  if (auth !== undefined && auth !== NETWORK_SECRET_AUTH && auth !== NETWORK_TOKEN_AUTH)
    throw new MachineAuthError(
      "incomplete_machine_credentials",
      `PRIM_M2M_CLIENT_AUTH accepts ${NETWORK_SECRET_AUTH} or ${NETWORK_TOKEN_AUTH}.`,
    );
  if (auth !== undefined) {
    if (!clientId || !/^client_[\w-]+$/u.test(clientId))
      throw new MachineAuthError(
        "incomplete_machine_credentials",
        `Set PRIM_M2M_CLIENT_ID with PRIM_M2M_CLIENT_AUTH=${auth}.`,
      );
    if (clientSecret !== undefined)
      throw new MachineAuthError(
        "conflicting_credentials",
        `Unset PRIM_M2M_CLIENT_SECRET: with PRIM_M2M_CLIENT_AUTH=${auth} the environment's network secret supplies it.`,
      );
    // The broker routes its own requests through the environment's proxy
    // (see brokerEnvironment). Earlier versions took routing from the caller's
    // environment and keyed the generation on it ("routed" or "direct"); this
    // marker differs from both, so an upgraded prim never reuses a broker
    // that an older one started without routing.
    // The mode is part of the key: the two modes' brokers do different work.
    const generation = hash(`${apiUrlFor(deps)}\0${clientId}\0${auth}\0broker-proxy`);
    const credentials = {
      clientId,
      generation,
      ...(auth === NETWORK_TOKEN_AUTH
        ? { tokenInjection: "network" }
        : { secretInjection: "network" }),
    } as EnvironmentCredentials;
    // Only paths that talk to the broker need its key; checking whether
    // credentials are configured must not write to disk.
    Object.defineProperty(credentials, "clientSecret", {
      enumerable: true,
      get: () => networkSecretBrokerKey(deps, clientId),
    });
    return credentials;
  }
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
    env.PRIM_M2M_CLIENT_AUTH !== undefined ||
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
  if (environment) {
    if (environmentTerminal === environment.generation) return undefined;
    return cached?.generation === environment.generation && cached.expiresAt > Date.now()
      ? cached
      : readEnvironmentContext(environment, deps);
  }
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
const NETWORK_REJECTION_PAUSE_MS = 30_000;
let networkRejection: { generation: string; until: number; error: MachineAuthError } | undefined;

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
        "authorizedUserId",
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
  const directory = configurationDirectory(deps);
  ensureDirectory(directory);
  return withFileLock(
    join(directory, "credentials.lock"),
    async () => {
      const { configuration, tokens, identity } = await withMachineCooldown(
        directory,
        apiUrl,
        clientId,
        signal,
        async () => {
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
          if (
            deps.expectedAuthorizedUserId &&
            identity.authorizedUserId !== deps.expectedAuthorizedUserId
          )
            throw new MachineAuthError(
              "delegation_mismatch",
              "The enrolled installation does not have the expected user delegation.",
              true,
            );
          if (
            deps.expectedOrganizationId &&
            identity.organizationId !== deps.expectedOrganizationId
          )
            throw new MachineAuthError(
              "delegation_mismatch",
              "The installation belongs to a different organization.",
              true,
            );
          return { configuration, tokens, identity };
        },
      );
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
    // Fixed in the cloud environment's settings, which no process here can
    // watch: a rejection is retried after a pause, never held for good.
    const networkManaged = Boolean(environment.secretInjection || environment.tokenInjection);
    const observedToken =
      cached?.generation === environment.generation ? cached.accessToken : undefined;
    const directory = configurationDirectory(deps);
    ensureDirectory(directory);
    if (!deps.fetch && !deps.localEnvironment) {
      try {
        cached = await acquireBrokerCredential({
          directory,
          apiUrl,
          environment,
          env: deps.env ?? process.env,
          force: options.force,
          observedToken,
          signal,
        });
        writeEnvironmentContext(cached, deps);
        return cached;
      } catch (error) {
        if (error instanceof MachineAuthError && error.terminal && !networkManaged)
          environmentTerminal = environment.generation;
        throw error;
      }
    }
    return withFileLock(
      join(directory, "credentials.lock"),
      async () => {
        if (machineSessionEnded(deps))
          throw new MachineAuthError(
            "machine_credentials_rejected",
            rejectedCredentialsMessage("Rotate the injected machine credentials.", deps.env),
            true,
          );
        if (
          (!options.force || (observedToken && cached?.accessToken !== observedToken)) &&
          cached?.generation === environment.generation &&
          cached.expiresAt > Date.now() + RENEW_BEFORE_MS
        )
          return cached;
        if (
          networkManaged &&
          networkRejection?.generation === environment.generation &&
          networkRejection.until > Date.now()
        )
          throw networkRejection.error;
        try {
          const { configuration, tokens, identity } = await withMachineCooldown(
            directory,
            apiUrl,
            environment.clientId,
            signal,
            async () => {
              const configuration = await discoverMachineConfiguration(apiUrl, signal, deps.fetch);
              if (environment.tokenInjection) {
                // No token to request or hold: ask the API who the proxy's
                // token says this is, and trust that for a while.
                const identity = await verifyInjectedMachineIdentity(
                  apiUrl,
                  environment.clientId,
                  signal,
                  deps.fetch,
                );
                const tokens = {
                  accessToken: "",
                  expiresAt: Date.now() + INJECTED_IDENTITY_TTL_MS,
                };
                return { configuration, tokens, identity };
              }
              const tokens = await exchangeMachineCredentials(
                configuration,
                environment.clientId,
                // The broker key is not a client secret; the proxy supplies that.
                environment.secretInjection ? "" : environment.clientSecret,
                signal,
                deps.fetch,
                { secretInjection: environment.secretInjection },
              ).catch((error: unknown) => {
                // The client ID is typed twice in network-secret mode: here and
                // as the network secret's username. A token for another client
                // means those two differ.
                if (
                  environment.secretInjection &&
                  error instanceof MachineAuthError &&
                  error.code === "token_client_mismatch"
                )
                  throw new MachineAuthError(
                    "network_secret_mismatch",
                    `The token service issued a token for another machine. Check that the network secret's username equals PRIM_M2M_CLIENT_ID (${environment.clientId}).`,
                    true,
                  );
                throw error;
              });
              const identity = await verifyMachineIdentity(
                apiUrl,
                tokens.accessToken,
                environment.clientId,
                signal,
                deps.fetch,
              );
              return { configuration, tokens, identity };
            },
          );
          cached = {
            ...configuration,
            ...tokens,
            ...identity,
            apiUrl,
            generation: environment.generation,
            storage: "environment",
            ...(environment.tokenInjection ? { tokenInjection: "network" as const } : {}),
          };
          writeEnvironmentContext(cached, deps);
          return cached;
        } catch (error) {
          // A rejected network secret is fixed in the environment's settings,
          // which this process cannot see change: retry after a short pause
          // rather than for the life of a long-running broker.
          if (networkManaged && error instanceof MachineAuthError && error.terminal) {
            networkRejection = {
              generation: environment.generation,
              until: Date.now() + NETWORK_REJECTION_PAUSE_MS,
              error,
            };
            // What was cached has just been refused (a revoked installation,
            // a changed network secret): stop handing it out, so callers get
            // this answer at once instead of one doomed request each.
            if (cached?.generation === environment.generation) cached = undefined;
            const contextPath = environmentContextPath(deps, environment.clientId);
            try {
              if (machineRecord(readPrivate(contextPath)).generation === environment.generation)
                rmSync(contextPath, { force: true });
            } catch {
              // Another generation's or a missing metadata cache is not ours to remove.
            }
            throw error;
          }
          if (error instanceof MachineAuthError && error.terminal) {
            environmentTerminal = environment.generation;
            const contextPath = environmentContextPath(deps, environment.clientId);
            try {
              if (machineRecord(readPrivate(contextPath)).generation === environment.generation)
                rmSync(contextPath, { force: true });
            } catch {
              // Another generation or a missing metadata cache must not mask rejection.
            }
          }
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
          const { tokens, identity } = await withMachineCooldown(
            directory,
            apiUrl,
            profile.clientId,
            signal,
            async () => {
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
              return { tokens, identity };
            },
          );
          if (
            identity.machineId !== profile.machineId ||
            identity.authorizedUserId !== profile.authorizedUserId ||
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

export type MachineApiRequest = {
  method: string;
  /** Path and query on the API origin, such as `/api/cli/auth/status`. */
  path: string;
  headers?: Record<string, string>;
  body?: string;
};

/**
 * Send one API request for a credential whose token the cloud environment's
 * proxy attaches (see NETWORK_TOKEN_AUTH). It goes through the broker, the
 * one prim process whose requests pass through that proxy, and carries no
 * Authorization header of prim's own.
 */
export async function forwardMachineRequest(
  request: MachineApiRequest,
  signal?: AbortSignal,
  deps: MachineDependencies = {},
): Promise<Response> {
  const environment = environmentCredentials(deps);
  if (!environment?.tokenInjection)
    throw new MachineAuthError(
      "identity_changed",
      "Machine identity changed; restart the operation.",
    );
  const directory = configurationDirectory(deps);
  ensureDirectory(directory);
  return forwardBrokerRequest({
    directory,
    apiUrl: apiUrlFor(deps),
    environment,
    env: deps.env ?? process.env,
    request,
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
  });
}

/** Ask the API, now, who an acquired credential authenticates as. */
export async function verifyAcquiredMachineIdentity(
  machine: MachineCredential,
  deps: MachineDependencies = {},
): Promise<MachineIdentity> {
  if (!machine.tokenInjection)
    return verifyMachineIdentity(machine.apiUrl, machine.accessToken, machine.clientId);
  const response = await forwardMachineRequest(
    { method: "GET", path: "/api/cli/auth/status" },
    AbortSignal.timeout(10_000),
    deps,
  );
  const value = response.ok ? await response.json().catch(() => undefined) : undefined;
  return parseInjectedMachineIdentity(response.status, value, machine.apiUrl, machine.clientId);
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
  authorizedUserId?: string;
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
      authorizedUserId: context.authorizedUserId,
      organizationId: context.organizationId,
    };
  const injected = environmentCredentials(deps);
  return injected
    ? { kind: "machine", apiUrl: apiUrlFor(deps), clientId: injected.clientId }
    : undefined;
}

export function machineJournalBucket(
  identity: Pick<MachineCaptureActor, "apiUrl" | "clientId" | "authorizedUserId">,
): string {
  return `_machine_${hash(`${identity.apiUrl}\0${identity.clientId}${identity.authorizedUserId ? `\0${identity.authorizedUserId}` : ""}`)}`;
}

/**
 * True for a capture actor made before its process knew who it was. With
 * credentials from the environment a fresh VM has no verified identity until
 * the first token exchange, and again each time the cached identity lapses,
 * so the actor names the client alone. An actor that names a machine,
 * organization, or user is a claim about a verified identity instead.
 */
export function identityPending(actor: MachineCaptureActor): boolean {
  return (
    actor.machineId === undefined &&
    actor.organizationId === undefined &&
    actor.authorizedUserId === undefined
  );
}

/**
 * Where a client's identity-pending captures wait. Kept apart from every
 * verified identity's bucket, so whichever identity the server confirms for
 * the client can take exactly these and nothing a verified identity wrote.
 */
export function machinePendingBucket(
  identity: Pick<MachineCaptureActor, "apiUrl" | "clientId">,
): string {
  return `_machine_pending_${hash(`${identity.apiUrl}\0${identity.clientId}`)}`;
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

/** Enrollment metadata uses the same owner-only directory and ACL policy as credentials. */
export function prepareMachineMetadataDirectory(directory: string): void {
  ensureDirectory(directory);
}
export function writeMachineMetadata(path: string, value: unknown): void {
  writePrivate(path, value);
}
