import {
  constants,
  createHash,
  generateKeyPairSync,
  privateDecrypt,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import {
  type CliClient,
  DEFAULT_API_URL,
  HttpError,
  getBearerClient,
  getPinnedClient,
  getSiteUrl,
} from "../client.js";
import {
  isCliEnrollmentRedeemResponse,
  isCliEnrollmentStartResponse,
} from "../contract/cli-http-v1.js";
import { flush } from "../flusher.js";
import { classifyJournalBuckets } from "../journal-organization.js";
import { listBuckets } from "../journal.js";
import { withFileLock } from "./file-lock.js";
import {
  acquireMachineCredential,
  configureMachine,
  hasMachineConfiguration,
  prepareMachineMetadataDirectory,
  writeMachineMetadata,
} from "./machine-credentials.js";
import {
  MachineAuthError,
  discoverMachineConfiguration,
  exchangeMachineCredentials,
  machineApiUrl,
  machineRecord,
  machineString,
  verifyMachineIdentity,
} from "./machine-protocol.js";
import { primConfigDirectory } from "./paths.js";

type EnrollmentOwner = { authorizedUserId?: string; organizationId: string };
function installationPath(owner: EnrollmentOwner, directory = primConfigDirectory()): string {
  return join(
    directory,
    `installation_${createHash("sha256")
      .update(`${getSiteUrl()}\0${owner.authorizedUserId ?? ""}\0${owner.organizationId}`)
      .digest("hex")}.json`,
  );
}

async function activatePending(
  identity: EnrollmentOwner & { machineId: string },
): Promise<boolean> {
  if (!identity.authorizedUserId) return false;
  const path = installationPath(identity);
  let metadata: Record<string, unknown>;
  try {
    metadata = machineRecord(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
  if (!metadata.pendingEnrollmentId || metadata.pendingMachineId !== identity.machineId)
    return false;
  try {
    const client = await getPinnedClient();
    await client.post(
      "/api/cli/auth/enrollment/activate",
      { enrollmentId: metadata.pendingEnrollmentId },
      { signal: AbortSignal.timeout(30_000) },
    );
    writeMachineMetadata(path, { installationId: metadata.installationId });
    return false;
  } catch {
    return true;
  }
}

type EnrollmentClient = Pick<CliClient, "post">;

/**
 * Run one start → redeem exchange under a human session. The new secret is
 * encrypted to a key that exists only in this process, so the server never
 * returns it in the clear.
 */
async function exchangeEnrollment(
  client: EnrollmentClient,
  request: { installationId: string; displayName: string; authorizedUserId: string },
  onStarted?: () => void,
): Promise<{ enrollmentId: string; clientId: string; machineId: string; secret: string }> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const verifier = randomBytes(32).toString("hex");
  const signal = AbortSignal.timeout(60_000);
  const start = machineRecord(
    await client.post(
      "/api/cli/auth/enrollment/start",
      {
        installationId: request.installationId,
        requestId: randomUUID(),
        displayName: request.displayName,
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        challenge: createHash("sha256").update(verifier).digest("hex"),
      },
      { signal },
    ),
  );
  if (!isCliEnrollmentStartResponse(start) || !machineString(start.enrollmentId, 128))
    throw new MachineAuthError("invalid_enrollment", "The server returned an invalid enrollment.");
  onStarted?.();
  const response = machineRecord(
    await client.post(
      "/api/cli/auth/enrollment/redeem",
      { enrollmentId: start.enrollmentId, verifier },
      { signal },
    ),
  );
  if (
    !isCliEnrollmentRedeemResponse(response) ||
    !machineString(response.clientId, 256) ||
    !machineString(response.ciphertext, 4096) ||
    !machineString(response.machineId, 128) ||
    response.authorizedUserId !== request.authorizedUserId
  )
    throw new MachineAuthError(
      "invalid_enrollment",
      "The server returned an invalid enrollment exchange.",
    );
  try {
    return {
      enrollmentId: start.enrollmentId,
      clientId: response.clientId,
      machineId: response.machineId,
      secret: privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(response.ciphertext, "base64"),
      ).toString("utf8"),
    };
  } catch {
    throw new MachineAuthError(
      "invalid_enrollment",
      "The credential exchange could not be decrypted for this installation.",
    );
  }
}

/** Read the human enrollment owner, translating a rejected session into a sign-in hint. */
async function enrollmentOwner(
  client: Pick<CliClient, "get">,
  rejectedSessionHint = "Sign in once with prim auth login to authorize this developer installation.",
): Promise<{ authorizedUserId: string; organizationId: string }> {
  let status: Record<string, unknown>;
  try {
    status = machineRecord(
      await client.get("/api/cli/auth/enrollment/status", {
        signal: AbortSignal.timeout(15_000),
      }),
    );
  } catch (error) {
    if (error instanceof HttpError && (error.status === 401 || error.status === 403))
      throw new MachineAuthError("human_sign_in_required", rejectedSessionHint);
    throw error;
  }
  if (!machineString(status.userId, 128) || !machineString(status.organizationId, 128))
    throw new MachineAuthError(
      "invalid_enrollment",
      "The server did not verify the enrollment user and organization.",
    );
  return { authorizedUserId: status.userId, organizationId: status.organizationId };
}

export type EnvironmentInstallation = {
  /** The `.env` lines that hand this installation to its environment. */
  environment: string[];
  displayName: string;
  clientId: string;
  clientSecret: string;
  machineId: string;
  authorizedUserId: string;
  organizationId: string;
};

const INSTALLATION_NAME_MAX_LENGTH = 128;
const ENV_VALUE = /^[\w.~+/:=-]+$/u;

/** What a new installation's enrollment needs before anyone signs in. */
export type EnvironmentEnrollment = {
  name: string;
  siteUrl: string;
  configuration: Awaited<ReturnType<typeof discoverMachineConfiguration>>;
};

/**
 * Check everything that does not need a human first: the name must pass the
 * same rule the minted identity's display name is held to, and the server must
 * offer enrollment. Failing either after a browser sign-in wastes it; failing
 * the name after the mint leaves an installation that can never authenticate.
 */
export async function prepareEnvironmentEnrollment(
  displayName: string,
): Promise<EnvironmentEnrollment> {
  const name = displayName.trim();
  if (!machineString(name, INSTALLATION_NAME_MAX_LENGTH))
    throw new MachineAuthError(
      "invalid_installation_name",
      `Name the installation with 1-${INSTALLATION_NAME_MAX_LENGTH} printable characters.`,
    );
  let siteUrl: string;
  try {
    siteUrl = machineApiUrl(getSiteUrl());
  } catch {
    siteUrl = "";
  }
  // The deployment travels with the credential, so it must survive an .env line too.
  if (!siteUrl || !ENV_VALUE.test(siteUrl))
    throw new MachineAuthError(
      "invalid_configuration",
      "PRIM_API_URL must be an HTTPS origin that can be written as an .env value.",
    );
  const configuration = await discoverMachineConfiguration(siteUrl);
  if (!configuration.developerEnrollment)
    throw new MachineAuthError(
      "enrollment_unavailable",
      "Automatic enrollment is not enabled on this server.",
    );
  return { name, siteUrl, configuration };
}

/**
 * Enroll a separate installation that runs elsewhere, such as a Claude Code
 * cloud environment, and return its credential for that environment's
 * variables. Nothing is stored here: the human session and the new secret stay
 * in this process, so this machine's own installation is untouched. The new
 * installation is delegated to the signed-in user.
 *
 * Once the server has accepted the start, an installation exists whether or
 * not this process ever holds a working secret for it, so every later failure
 * names it for revocation instead of leaving it unaccounted for.
 */
export async function enrollEnvironmentInstallation(
  { name, siteUrl, configuration }: EnvironmentEnrollment,
  humanAccessToken: string,
): Promise<EnvironmentInstallation> {
  const client = getBearerClient(humanAccessToken, siteUrl);
  const owner = await enrollmentOwner(
    client,
    "The server did not accept this sign-in for enrollment. Check the organization's enrollment policy, then retry.",
  );
  let registered = false;
  try {
    // A fresh installation has no older secrets, so activation (which only
    // retires them) has nothing to do and is skipped.
    const { clientId, machineId, secret } = await exchangeEnrollment(
      client,
      { installationId: randomUUID(), displayName: name, authorizedUserId: owner.authorizedUserId },
      () => {
        registered = true;
      },
    );
    const tokens = await exchangeMachineCredentials(configuration, clientId, secret);
    const identity = await verifyMachineIdentity(siteUrl, tokens.accessToken, clientId);
    if (
      identity.machineId !== machineId ||
      identity.authorizedUserId !== owner.authorizedUserId ||
      identity.organizationId !== owner.organizationId
    )
      throw new MachineAuthError(
        "delegation_mismatch",
        "The new installation does not carry the signed-in user's delegation.",
        true,
      );
    return {
      environment: installationEnvironment({ clientId, clientSecret: secret }, siteUrl),
      displayName: name,
      clientId,
      clientSecret: secret,
      machineId,
      authorizedUserId: owner.authorizedUserId,
      organizationId: owner.organizationId,
    };
  } catch (error) {
    // Only a definite refusal of /start (a 4xx) proves nothing was created; a
    // lost, failed (5xx), or malformed /start answer may have created it anyway.
    const uncertain = !registered && !(error instanceof HttpError && error.status < 500);
    if (!registered && !uncertain) throw error;
    const cause =
      error instanceof MachineAuthError ? error.message : "Enrollment could not finish.";
    throw new MachineAuthError(
      error instanceof MachineAuthError ? error.code : "enrollment_failed",
      `${cause} Installation "${name}" ${registered ? "was already registered" : "may have been registered"}; ask an organization admin to revoke it in Settings → Developer installations.`,
    );
  }
}

/**
 * The `.env` lines that hand a new installation to the environment it runs in.
 * Values are written bare and anything else is refused: dotenv, Docker, and
 * hand-pasted forms disagree on quoting, but all read a bare value of this
 * charset identically. A non-default deployment travels with the credential,
 * which only authenticates there.
 */
export function installationEnvironment(
  installation: Pick<EnvironmentInstallation, "clientId" | "clientSecret">,
  siteUrl: string,
): string[] {
  const entries: Array<[string, string]> = [
    ["PRIM_M2M_CLIENT_ID", installation.clientId],
    ["PRIM_M2M_CLIENT_SECRET", installation.clientSecret],
  ];
  if (siteUrl !== DEFAULT_API_URL) entries.push(["PRIM_API_URL", siteUrl]);
  return entries.map(([key, value]) => {
    if (!ENV_VALUE.test(value))
      throw new MachineAuthError(
        "invalid_credentials",
        `${key} cannot be written as an .env value.`,
      );
    return `${key}=${value}`;
  });
}

/** One enrollment per local installation. The private exchange key never leaves this process. */
export async function enrollDeveloperInstallation(ifSupported = false) {
  if (hasMachineConfiguration()) {
    const current = await acquireMachineCredential();
    if (!current)
      throw new MachineAuthError(
        "identity_unavailable",
        "Verify the existing installation with prim auth status.",
      );
    return {
      enrolled: true,
      reused: true,
      authorizedUserId: current.authorizedUserId,
      machineId: current.machineId,
      storageBackend: current.storage,
      activationPending: await activatePending(current),
    };
  }
  const configuration = await discoverMachineConfiguration(getSiteUrl()).catch((error) => {
    if (
      ifSupported &&
      error instanceof MachineAuthError &&
      error.code === "server_upgrade_required"
    )
      return undefined;
    throw error;
  });
  if (!configuration?.developerEnrollment) {
    if (ifSupported) return { enrolled: false, reason: "server_enrollment_unavailable" };
    throw new MachineAuthError(
      "enrollment_unavailable",
      "Automatic enrollment is not enabled on this server.",
    );
  }
  if (process.env.PRIM_TOKEN)
    throw new MachineAuthError(
      "human_sign_in_required",
      "Unset PRIM_TOKEN and run prim auth login to authorize this developer installation.",
    );
  const directory = primConfigDirectory();
  prepareMachineMetadataDirectory(directory);
  return await withFileLock(join(directory, "enrollment.lock"), async () => {
    // Another setup may have completed while this process waited.
    if (hasMachineConfiguration()) {
      const current = await acquireMachineCredential();
      return {
        enrolled: true,
        reused: true,
        authorizedUserId: current?.authorizedUserId,
        machineId: current?.machineId,
      };
    }
    const client = await getPinnedClient();
    const owner = await enrollmentOwner(client);
    const path = installationPath(owner, directory);
    let installationId: string;
    try {
      const value = machineRecord(JSON.parse(readFileSync(path, "utf8")));
      if (
        typeof value.installationId !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(value.installationId)
      )
        throw new Error("invalid");
      installationId = value.installationId;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new MachineAuthError(
          "invalid_installation",
          "Installation metadata is unreadable. Restore it before enrolling again.",
        );
      installationId = randomUUID();
      writeMachineMetadata(path, { installationId });
    }
    // Drain with the original authority. Failures leave immutable journals to report below.
    try {
      await flush();
    } catch {
      /* Retain any unsent activity under its original owner. */
    }
    const { enrollmentId, clientId, secret } = await exchangeEnrollment(client, {
      installationId,
      displayName: hostname().slice(0, 128),
      authorizedUserId: owner.authorizedUserId,
    });
    const profile = await configureMachine(clientId, secret, {
      expectedAuthorizedUserId: owner.authorizedUserId,
      expectedOrganizationId: owner.organizationId,
    });
    writeMachineMetadata(path, {
      installationId,
      pendingEnrollmentId: enrollmentId,
      pendingMachineId: profile.machineId,
    });
    const activationPending = await activatePending(profile);
    const retained = classifyJournalBuckets(
      listBuckets().map((row) => row.bucket),
      { ...profile, captureAuthorityKind: "workos_m2m" },
    ).retainedBuckets;
    return {
      enrolled: true,
      reused: false,
      machineId: profile.machineId,
      authorizedUserId: profile.authorizedUserId,
      storageBackend: profile.storage,
      activationPending,
      retainedJournalBuckets: retained,
    };
  });
}
