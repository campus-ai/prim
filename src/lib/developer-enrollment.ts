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
import { HttpError, getPinnedClient, getSiteUrl } from "../client.js";
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
  machineRecord,
  machineString,
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
    let status: Record<string, unknown>;
    try {
      status = machineRecord(
        await client.get("/api/cli/auth/enrollment/status", {
          signal: AbortSignal.timeout(15_000),
        }),
      );
    } catch (error) {
      if (error instanceof HttpError && (error.status === 401 || error.status === 403))
        throw new MachineAuthError(
          "human_sign_in_required",
          "Sign in once with prim auth login to authorize this developer installation.",
        );
      throw error;
    }
    if (!machineString(status.userId, 128) || !machineString(status.organizationId, 128))
      throw new MachineAuthError(
        "invalid_enrollment",
        "The server did not verify the enrollment user and organization.",
      );
    const owner = { authorizedUserId: status.userId, organizationId: status.organizationId };
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
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const verifier = randomBytes(32).toString("hex");
    const signal = AbortSignal.timeout(60_000);
    const start = machineRecord(
      await client.post(
        "/api/cli/auth/enrollment/start",
        {
          installationId,
          requestId: randomUUID(),
          displayName: hostname().slice(0, 128),
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
          challenge: createHash("sha256").update(verifier).digest("hex"),
        },
        { signal },
      ),
    );
    if (!isCliEnrollmentStartResponse(start) || !machineString(start.enrollmentId, 128))
      throw new MachineAuthError(
        "invalid_enrollment",
        "The server returned an invalid enrollment.",
      );
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
      response.authorizedUserId !== owner.authorizedUserId
    )
      throw new MachineAuthError(
        "invalid_enrollment",
        "The server returned an invalid enrollment exchange.",
      );
    let secret: string;
    try {
      secret = privateDecrypt(
        { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha256" },
        Buffer.from(response.ciphertext, "base64"),
      ).toString("utf8");
    } catch {
      throw new MachineAuthError(
        "invalid_enrollment",
        "The credential exchange could not be decrypted for this installation.",
      );
    }
    const profile = await configureMachine(response.clientId, secret, {
      expectedAuthorizedUserId: owner.authorizedUserId,
      expectedOrganizationId: owner.organizationId,
    });
    writeMachineMetadata(path, {
      installationId,
      pendingEnrollmentId: start.enrollmentId,
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
