/**
 * WARP-2115 / ADR-041 — the Microsoft 365 connection lifecycle.
 *
 * This is the cloud-connector auth layer: it owns the per-user link between a
 * Droplet account and a Microsoft 365 account, the encrypted token cache, and
 * the explicit state a person sees in the dashboard.
 *
 * Shape, and why:
 *
 *   - **Delegated, per user.** ADR-041 rules out application permissions,
 *     which would grant "read every mailbox in the tenant". The box reads
 *     Microsoft *as the signed-in person*, so it can never see more than they
 *     can. One `M365Connection` row per user, keyed by `userId`.
 *   - **Prisma and the Entra client are injected**, matching the repo's
 *     service style (cf. `email-channel.service.ts`) and keeping the whole
 *     lifecycle testable without a database or a network.
 *   - **State is explicit, never inferred** from whether a token happens to
 *     decrypt. DISCONNECTED and NEEDS_RECONNECT look identical to a
 *     "do we have a working token" check but mean opposite things to a person.
 *   - **Nothing here logs a token, a cache blob, or a device code.** The public
 *     view is built by an explicit allow-list, not by spreading the row.
 */
import type { PrismaClient } from "@prisma/client";

import { recordActivity } from "../activity.singleton.js";
import { sealTokenCache, unsealTokenCache } from "./token-cache.js";
import {
  classifyAuthFailure,
  isPendingFlowExpired,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
  type EntraFailureLike,
} from "./state.js";

// --- The Entra port -------------------------------------------------------
//
// Narrow on purpose: the service depends on this, not on MSAL, so the
// lifecycle is testable and the SDK stays swappable.

/** What Microsoft gives us to show the person so they can approve the sign-in. */
export interface DeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  expiresAt: Date;
  /** Microsoft's own instruction text. Displayed verbatim — it is localized. */
  message: string;
}

/** The result of a completed (or silently refreshed) authentication. */
export interface EntraAuthResult {
  homeAccountId: string;
  tenantId: string | null;
  accountUpn: string | null;
  /** Space-separated scopes Microsoft actually granted — may be narrower than asked. */
  grantedScopes: string;
  /** Serialized MSAL cache. Contains the refresh token; sealed before storage. */
  serializedCache: string;
  /** Present on a silent acquisition; the bearer for a Graph call. */
  accessToken?: string;
}

export interface EntraClient {
  /**
   * Begin a device-code sign-in. `onCode` fires as soon as Microsoft issues
   * the code (so the caller can show it immediately); the promise resolves
   * only once the person has approved it.
   */
  acquireByDeviceCode(opts: {
    onCode: (info: DeviceCodeInfo) => void;
  }): Promise<EntraAuthResult>;

  /** Refresh silently from a stored cache. */
  acquireSilent(serializedCache: string, homeAccountId: string): Promise<EntraAuthResult>;
}

// --- Errors ---------------------------------------------------------------

/** No usable Microsoft link for this person. Callers should surface the
 *  connection state rather than treating this as a server fault. */
export class M365NotConnectedError extends Error {
  constructor(public readonly state: string) {
    super(`Microsoft 365 is not connected (state: ${state}).`);
    this.name = "M365NotConnectedError";
  }
}

// --- The public view ------------------------------------------------------

export type M365State =
  | "DISCONNECTED"
  | "PENDING_CONSENT"
  | "CONNECTED"
  | "NEEDS_RECONNECT"
  | "ERROR";

/**
 * What a route may return. Built field-by-field rather than by spreading the
 * row, so a column added later (another secret, say) cannot leak by default.
 */
export interface M365ConnectionView {
  state: M365State;
  /** Which Microsoft account is linked, for the person to recognise. Not secret. */
  accountUpn: string | null;
  tenantId: string | null;
  grantedScopes: string[];
  connectedAt: Date | null;
  lastRefreshOkAt: Date | null;
  /** Redacted, human-readable reason for ERROR / NEEDS_RECONNECT. */
  lastError: string | null;
}

interface ConnectionRow {
  state: string;
  accountUpn: string | null;
  tenantId: string | null;
  grantedScopes: string | null;
  connectedAt: Date | null;
  lastRefreshOkAt: Date | null;
  lastError: string | null;
  pendingFlowExpiresAt: Date | null;
  homeAccountId: string | null;
  tokenCacheEnc: string | null;
}

/**
 * WARP-2285 — the audit rows this surface was shipped without.
 *
 * `routes/m365.ts` and this file together contained ZERO `recordActivity`
 * calls: a customer could grant Microsoft 365 consent, have a refresh token
 * encrypted onto their row, and later disconnect, and none of it appeared in
 * the activity log. Under ADR-041 §2 connecting IS the consent record, so that
 * was a compliance gap on an already-shipped surface.
 *
 * One row per state transition, each named distinctly. The NEEDS_RECONNECT and
 * DISCONNECTED rows in particular must stay tellable apart — the schema
 * docstring at `schema.prisma:4990-5012` requires the states themselves be
 * distinguishable, and an audit that flattened them would answer "is this
 * person connected?" but not "did they leave, or did their grant die?", which
 * are a support question and a security question respectively.
 *
 * Nothing here records a token, a cache blob, a device code or an access token.
 * The scope carries the user, the state, and the redacted reason only.
 */
async function auditM365(params: {
  what: string;
  state: M365State;
  userId: string;
  severity: "info" | "warn";
  reason?: string | null;
  /** True when a person asked for this; false when the box discovered it. */
  userInitiated: boolean;
}): Promise<void> {
  await recordActivity({
    kind: "auth",
    severity: params.severity,
    sourceIcon: "cloud",
    what: params.what,
    sub: params.state,
    actor: params.userInitiated
      ? { type: "user", id: params.userId }
      : { type: "system", id: null },
    refs: {
      connector: "m365",
      userId: params.userId,
      state: params.state,
      reason: params.reason ?? null,
    },
  });
}

const DISCONNECTED_VIEW: M365ConnectionView = {
  state: "DISCONNECTED",
  accountUpn: null,
  tenantId: null,
  grantedScopes: [],
  connectedAt: null,
  lastRefreshOkAt: null,
  lastError: null,
};

function toView(row: ConnectionRow, now: Date): M365ConnectionView {
  // A sign-in whose code has expired is reported as DISCONNECTED. The flow
  // itself lives in memory and does not survive a restart, so without this the
  // row would read "pending" forever and block any new attempt.
  const state =
    row.state === "PENDING_CONSENT" && isPendingFlowExpired(row.pendingFlowExpiresAt, now)
      ? "DISCONNECTED"
      : (row.state as M365State);

  return {
    state,
    accountUpn: row.accountUpn ?? null,
    tenantId: row.tenantId ?? null,
    grantedScopes: row.grantedScopes ? row.grantedScopes.split(" ").filter(Boolean) : [],
    connectedAt: row.connectedAt ?? null,
    lastRefreshOkAt: row.lastRefreshOkAt ?? null,
    lastError: row.lastError ?? null,
  };
}

// --- Reads ----------------------------------------------------------------

/** The connection as the dashboard should see it. Never carries token material. */
export async function getConnectionView(
  prisma: PrismaClient,
  userId: string,
  now: Date = new Date(),
): Promise<M365ConnectionView> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  return row ? toView(row, now) : DISCONNECTED_VIEW;
}

// --- Connect --------------------------------------------------------------

/**
 * Start a device-code sign-in.
 *
 * Resolves as soon as Microsoft issues the code, so the caller can show it
 * immediately; the sign-in itself completes in the background and flips the
 * row to CONNECTED (or ERROR / NEEDS_RECONNECT). The dashboard polls
 * `getConnectionView` to follow it.
 *
 * Connecting IS the consent event (ADR-041): a cloud connector ships off and
 * carries nothing until a person does this deliberately.
 */
export async function beginDeviceCodeConnect(
  prisma: PrismaClient,
  entra: EntraClient,
  userId: string,
  now: Date = new Date(),
): Promise<DeviceCodeInfo> {
  const expiresAt = new Date(now.getTime() + PENDING_FLOW_TTL_MS);

  await prisma.m365Connection.upsert({
    where: { userId },
    create: {
      userId,
      state: "PENDING_CONSENT",
      pendingFlowExpiresAt: expiresAt,
      lastError: null,
    },
    update: {
      state: "PENDING_CONSENT",
      pendingFlowExpiresAt: expiresAt,
      lastError: null,
    },
  });

  return await new Promise<DeviceCodeInfo>((resolve, reject) => {
    let handedBack = false;

    const completion = entra.acquireByDeviceCode({
      onCode: (info) => {
        handedBack = true;
        resolve(info);
      },
    });

    completion
      .then(async (result) => {
        await persistConnected(prisma, userId, result);
      })
      .catch(async (err: unknown) => {
        await persistFailure(prisma, userId, err);
        // If Microsoft failed before ever issuing a code, the caller is still
        // waiting on this promise — reject it so the request does not hang.
        if (!handedBack) reject(err);
      });
  });
}

/**
 * Record a completed sign-in — but ONLY if the flow that produced it is still
 * the one the row is waiting on.
 *
 * A device-code poll can outlive the person's interest in it. Without the
 * `state: "PENDING_CONSENT"` guard this sequence silently reverses a purge:
 * connect → the person disconnects (token purged, ADR-041's guarantee) → the
 * still-in-flight poll resolves minutes later → the row is rewritten to
 * CONNECTED with a freshly sealed token nobody asked for.
 *
 * `updateMany` is what makes the check-and-write atomic; a read-then-update
 * would leave the same race open, just narrower.
 */
async function persistConnected(
  prisma: PrismaClient,
  userId: string,
  result: EntraAuthResult,
  now: Date = new Date(),
): Promise<void> {
  const { count } = await prisma.m365Connection.updateMany({
    where: { userId, state: "PENDING_CONSENT" },
    data: {
      state: "CONNECTED",
      homeAccountId: result.homeAccountId,
      tenantId: result.tenantId,
      accountUpn: result.accountUpn,
      grantedScopes: result.grantedScopes,
      tokenCacheEnc: sealTokenCache(userId, result.serializedCache),
      pendingFlowExpiresAt: null,
      connectedAt: now,
      lastRefreshOkAt: now,
      lastError: null,
    },
  });

  // Gated on `count` deliberately. When the guard above rejects the write — the
  // person disconnected while the poll was still in flight — nothing changed,
  // and an audit row claiming a connection would be the audit log's own version
  // of the bug that guard exists to prevent.
  if (count > 0) {
    await auditM365({
      what: "Microsoft 365 connected",
      state: "CONNECTED",
      userId,
      severity: "info",
      userInitiated: true,
    });
  }
}

/**
 * Record a failed authentication in the state the person can act on.
 *
 * The classification is the whole point: a dead grant is routine and asks for
 * a new sign-in; a rejected app registration or a tenant policy block is ours
 * to fix and must not loop the customer through a flow that cannot succeed.
 */
async function persistFailure(
  prisma: PrismaClient,
  userId: string,
  err: unknown,
): Promise<void> {
  const failure = (err ?? {}) as EntraFailureLike;
  const kind = classifyAuthFailure(failure);

  // A wobble must not touch a healthy connection. ERROR is terminal by its own
  // definition and the sync engine skips rows in it, so downgrading on a
  // thirty-second WAN outage would stop syncing permanently and silently.
  // Record the reason for support; leave the state alone.
  if (kind === "TRANSIENT") {
    await prisma.m365Connection.updateMany({
      where: { userId },
      data: { lastError: redactAuthError(failure) },
    });
    return;
  }

  // The person closed the tab or pressed Cancel. Nothing failed; put the
  // connection back where it started so they can simply try again.
  if (kind === "ABANDONED") {
    await prisma.m365Connection.updateMany({
      where: { userId },
      data: { state: "DISCONNECTED", pendingFlowExpiresAt: null, lastError: null },
    });
    return;
  }

  await prisma.m365Connection.updateMany({
    where: { userId },
    data: {
      state: kind,
      pendingFlowExpiresAt: null,
      lastError: redactAuthError(failure),
    },
  });
}

// --- Needs reconnect, discovered by the box ---------------------------------

/**
 * Move a CONNECTED link to NEEDS_RECONNECT because Graph refused a token that
 * had refreshed fine.
 *
 * The refresh path above only ever sees a refresh fail. A live 401/403 on a
 * delta call — resource access revoked, a conditional-access policy, a tenant
 * that changed under the grant — never reaches it, so without this seam the
 * sync engine would back the cursor off forever while the row the dashboard
 * reads kept saying CONNECTED. The stored cache is kept: the person may only
 * need to consent again, and dropping it would force a full sign-in for a
 * policy hiccup. Idempotent — a second cursor hitting the same wall in the
 * same tick writes nothing new.
 */
export async function markNeedsReconnect(
  prisma: PrismaClient,
  userId: string,
  reason: string,
): Promise<void> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  if (!row || row.state !== "CONNECTED") return;

  await prisma.m365Connection.update({
    where: { userId },
    data: { state: "NEEDS_RECONNECT", lastError: reason },
  });
  await auditM365({
    what: "Microsoft 365 needs reconnect",
    state: "NEEDS_RECONNECT",
    userId,
    severity: "warn",
    reason,
    userInitiated: false,
  });
}

// --- Disconnect -----------------------------------------------------------

/**
 * Unlink the account and PURGE the stored token.
 *
 * ADR-041 is explicit that a disconnect is not a flag flip — the credential
 * must actually go. The account label goes with it so the dashboard cannot
 * keep showing a Microsoft identity the box can no longer act as.
 */
export async function disconnect(prisma: PrismaClient, userId: string): Promise<void> {
  const existing = await prisma.m365Connection.findUnique({ where: { userId } });
  if (!existing) return; // never connected — nothing to purge

  await prisma.m365Connection.update({
    where: { userId },
    data: {
      state: "DISCONNECTED",
      tokenCacheEnc: null,
      homeAccountId: null,
      accountUpn: null,
      tenantId: null,
      grantedScopes: null,
      pendingFlowExpiresAt: null,
      connectedAt: null,
      lastError: null,
    },
  });

  // After the purge, not before: the row is the thing being attested to.
  await auditM365({
    what: "Microsoft 365 disconnected",
    state: "DISCONNECTED",
    userId,
    severity: "info",
    userInitiated: true,
  });
}

/**
 * Remove a person's Microsoft link entirely, row and all.
 *
 * Called when the user is deleted from the directory. `disconnect` above is
 * the owner-initiated path and deliberately keeps the row (so the dashboard
 * can still say "not connected"); this is the deprovisioning path, where
 * leaving anything behind is a security problem rather than a UX nicety.
 *
 * Without this a deleted employee's row survives holding a still-valid,
 * still-decryptable refresh token to their mailbox — and it is unreachable
 * through the API, which scopes strictly to the requester's own connection,
 * so nobody can ever disconnect it. `M365Connection.userId` is not a foreign
 * key (matching the other per-user tables here), so nothing cascades on our
 * behalf.
 */
export async function purgeM365ForUser(
  prisma: PrismaClient,
  userId: string,
): Promise<number> {
  const { count } = await prisma.m365Connection.deleteMany({ where: { userId } });
  return count;
}

// --- Token acquisition ----------------------------------------------------

/**
 * A bearer token for a Graph call, refreshing silently as needed.
 *
 * This is the seam the sync engine (WARP-2118) will call. Every failure path
 * updates the connection state before throwing, so a caller never has to
 * interpret an Entra error itself.
 */
export async function getAccessToken(
  prisma: PrismaClient,
  entra: EntraClient,
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;

  if (!row || !row.tokenCacheEnc || !row.homeAccountId) {
    throw new M365NotConnectedError(row?.state ?? "DISCONNECTED");
  }

  // An unreadable cache is expected after a factory reset regenerates
  // DEVICE_SECRET_KEY: the rows survive, the key does not. That is a
  // reconnect, not a crash — and not an ERROR the person cannot act on.
  let cache: string;
  try {
    cache = unsealTokenCache(userId, row.tokenCacheEnc);
  } catch {
    await prisma.m365Connection.update({
      where: { userId },
      data: {
        state: "NEEDS_RECONNECT",
        tokenCacheEnc: null,
        lastError: "The stored Microsoft sign-in could not be read. Please connect again.",
      },
    });
    // `userInitiated: false` and a distinct `what` are what keep this tellable
    // apart from the disconnect row above. Nobody asked for this; the box found
    // the stored sign-in unreadable and dropped it.
    await auditM365({
      what: "Microsoft 365 needs reconnect",
      state: "NEEDS_RECONNECT",
      userId,
      severity: "warn",
      reason: "The stored Microsoft sign-in could not be read.",
      userInitiated: false,
    });
    throw new M365NotConnectedError("NEEDS_RECONNECT");
  }

  let result: EntraAuthResult;
  try {
    result = await entra.acquireSilent(cache, row.homeAccountId);
  } catch (err) {
    await persistFailure(prisma, userId, err);
    throw err;
  }

  await prisma.m365Connection.update({
    where: { userId },
    data: {
      state: "CONNECTED",
      // MSAL rotates the refresh token on use, so the cache must be re-sealed
      // every time or the next refresh replays a superseded token.
      tokenCacheEnc: sealTokenCache(userId, result.serializedCache),
      grantedScopes: result.grantedScopes,
      lastRefreshOkAt: now,
      lastError: null,
    },
  });

  if (!result.accessToken) {
    throw new M365NotConnectedError("ERROR");
  }
  return result.accessToken;
}
