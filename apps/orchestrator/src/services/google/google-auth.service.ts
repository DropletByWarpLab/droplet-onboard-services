/** WARP-3788: delegated Gmail OAuth for the existing IMAP/SMTP mailbox workers. */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { GoogleConnection, Prisma, PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { getGoogleApp, validateGoogleRedirectUri } from "../account-provider-setup.service.js";
import { recordActivity } from "../activity.singleton.js";
import { requestIndexerRefresh } from "../email/provision.service.js";
import { createGoogleProvider, GoogleProviderError, type GoogleApp, type GoogleProvider } from "./google-client.js";
import { openGoogleFlow, openGoogleGrant, sealGoogleFlow, sealGoogleGrant, type PriorGoogleConnection } from "./token-store.js";
import { DEFAULT_GOOGLE_FEATURES, googleGrantCovers, scopesForGoogleFeatures, type GoogleFeatures } from "./scopes.js";
import { GOOGLE_CALENDAR_EVENTS_URL } from "./google-calendar-client.js";
import { accountConnectReturnTo, type AccountConnectReturnTo } from "../account-connect-return.js";

export const GOOGLE_FLOW_TTL_MS = 15 * 60_000;
export type GoogleState = "DISCONNECTED" | "PENDING_CONSENT" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
export type GoogleOutcome = "connected" | "cancelled" | "expired" | "failed" | "different_account";
export interface GoogleConnectionView {
  state: GoogleState;
  accountAddress: string | null;
  connectedAt: Date | null;
  lastError: string | null;
  mailboxId: string | null;
  mailEnabled: boolean;
  calendarEnabled: boolean;
  calendar: {
    state: "DISCONNECTED" | "WAITING" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
    lastSyncAt: Date | null;
    lastError: string | null;
    eventCount: number;
  };
}
export interface GoogleDependencies {
  provider: GoogleProvider;
  getApp: (prisma: PrismaClient) => Promise<GoogleApp | undefined>;
  refreshIndexer: () => Promise<unknown>;
  now: () => Date;
  mailboxAvailable: () => boolean;
}

export function googleDependencies(deps: Partial<GoogleDependencies> = {}): GoogleDependencies {
  return { provider: createGoogleProvider(), getApp: getGoogleApp, refreshIndexer: requestIndexerRefresh,
    now: () => new Date(), mailboxAvailable: () => !!config.SERVICE_TOKEN_EMAIL, ...deps };
}

export class GoogleSetupRequiredError extends Error {
  constructor(public readonly callbackUnsupported = false) {
    super(callbackUnsupported
      ? "Google needs an HTTPS callback on this Droplet's registered domain. Ask an administrator to finish account connection setup."
      : "Ask an administrator to finish Google account connection setup.");
    this.name = "GoogleSetupRequiredError";
  }
}
export class GoogleNotConnectedError extends Error {
  constructor() { super("Google is not connected."); this.name = "GoogleNotConnectedError"; }
}
export class GoogleTemporarilyUnavailableError extends Error {
  constructor() { super("Google is temporarily unavailable. Try again shortly."); this.name = "GoogleTemporarilyUnavailableError"; }
}
export class GoogleMailboxUnavailableError extends Error {
  constructor() { super("Email integration is unavailable. Ask an administrator to finish email setup."); this.name = "GoogleMailboxUnavailableError"; }
}
export class GoogleDisconnectRequiredError extends Error {
  constructor() { super("Disconnect Google first before removing a connected feature. Disconnecting removes its local mail and calendar archives."); this.name = "GoogleDisconnectRequiredError"; }
}
class FlowCancelledError extends Error {}
class MailboxConflictError extends Error {}
class AccountSwitchRequiredError extends Error {}
const logger = createLogger("google-auth");

const ACTIVE_USER = { directoryStatus: "ACTIVE" as const, deletionStatus: "NONE" as const };
const CLEARED_FLOW = { pendingStateHash: null, pendingFlowEnc: null, pendingExpiresAt: null };
const UNLINKED = {
  state: "DISCONNECTED" as const, tokenEnc: null, accountAddress: null,
  mailEnabled: true, calendarEnabled: false, calendarSyncState: "DISCONNECTED" as const,
  connectedAt: null, lastRefreshOkAt: null, lastError: null, ...CLEARED_FLOW,
};
const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const RESTORE_ERROR = "The stored Google connection could not be restored. Sign in again to reconnect Google.";

function priorConnection(row: GoogleConnection | null, features: GoogleFeatures): PriorGoogleConnection {
  if (row?.state === "PENDING_CONSENT") {
    try {
      const prior = row.pendingFlowEnc ? openGoogleFlow(row.userId, row.pendingFlowEnc).prior : undefined;
      if (prior) return prior;
    } catch { /* A fresh sign-in can repair a damaged stored flow. */ }
    return { state: row.tokenEnc || row.emailAccountId || row.calendarSourceId ? "NEEDS_RECONNECT" : "DISCONNECTED",
      mail: row.mailEnabled, calendar: row.calendarEnabled,
      calendarSyncState: row.calendarEnabled ? "NEEDS_RECONNECT" : "DISCONNECTED",
      connectedAt: null, lastRefreshOkAt: null, lastError: RESTORE_ERROR };
  }
  return { state: row?.state ?? "DISCONNECTED", mail: row?.mailEnabled ?? features.mail,
    calendar: row?.calendarEnabled ?? features.calendar, calendarSyncState: row?.calendarSyncState ?? "DISCONNECTED",
    connectedAt: row?.connectedAt?.toISOString() ?? null, lastRefreshOkAt: row?.lastRefreshOkAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null };
}

/** Restore the exact prior state only while this sealed consent still owns the
 * row. Feature removal and newer sign-ins clear or replace that CAS marker. */
async function settleGoogleFlow(prisma: PrismaClient, row: GoogleConnection,
  where: Prisma.GoogleConnectionWhereInput, fallbackState: "DISCONNECTED" | "ERROR", lastError: string | null): Promise<void> {
  let data: Prisma.GoogleConnectionUpdateManyMutationInput;
  try {
    const prior = row.pendingFlowEnc ? openGoogleFlow(row.userId, row.pendingFlowEnc).prior : undefined;
    if (prior && prior.state !== "DISCONNECTED") {
      if (prior.state === "CONNECTED") {
        if (!row.tokenEnc || !googleGrantCovers(openGoogleGrant(row.userId, row.tokenEnc).scopes,
          scopesForGoogleFeatures(prior))) throw new Error("Google grant unavailable.");
      }
      data = { state: prior.state, mailEnabled: prior.mail, calendarEnabled: prior.calendar,
        calendarSyncState: prior.calendarSyncState,
        connectedAt: prior.connectedAt ? new Date(prior.connectedAt) : null,
        lastRefreshOkAt: prior.lastRefreshOkAt ? new Date(prior.lastRefreshOkAt) : null,
        lastError: prior.lastError ?? lastError, ...CLEARED_FLOW };
    } else data = { state: fallbackState, calendarSyncState: row.calendarEnabled
      ? row.calendarSourceId ? "NEEDS_RECONNECT" : fallbackState === "ERROR" ? "ERROR" : "DISCONNECTED" : "DISCONNECTED",
      lastError, ...CLEARED_FLOW };
  } catch {
    data = { state: "NEEDS_RECONNECT", tokenEnc: null,
      calendarSyncState: row.calendarEnabled ? "NEEDS_RECONNECT" : "DISCONNECTED", lastError: RESTORE_ERROR, ...CLEARED_FLOW };
  }
  await prisma.googleConnection.updateMany({ where: { ...where, user: { is: ACTIVE_USER } }, data });
}

async function audit(userId: string, what: string, state: GoogleState): Promise<void> {
  await recordActivity({ kind: "auth", severity: "info", sourceIcon: "cloud", what,
    sub: state, actor: { type: "user", id: userId }, refs: { connector: "google", userId, state } });
}

async function postCommitFollowups(userId: string, what: string, state: GoogleState, deps: GoogleDependencies): Promise<void> {
  // The grant/archive transaction already succeeded. A recorder or indexer
  // outage must not send the browser a false failure for that committed result.
  const results = await Promise.allSettled([audit(userId, what, state),
    ...(deps.mailboxAvailable() ? [Promise.resolve().then(() => deps.refreshIndexer())] : [])]);
  results.forEach((result, index) => {
    if (result.status === "rejected") logger.warn({ userId, connector: "google", followup: index === 0 ? "audit" : "indexer" },
      "Google connection followup failed");
  });
}

/** Allow-list projection: neither a token nor client credentials may reach the dashboard. */
export async function getGoogleConnectionView(prisma: PrismaClient, userId: string, now = new Date()): Promise<GoogleConnectionView> {
  let row = await prisma.googleConnection.findUnique({ where: { userId } });
  if (row?.state === "PENDING_CONSENT" && row.pendingExpiresAt && row.pendingExpiresAt <= now) {
    await settleGoogleFlow(prisma, row,
      { id: row.id, state: "PENDING_CONSENT", pendingFlowEnc: row.pendingFlowEnc, pendingExpiresAt: row.pendingExpiresAt },
      "DISCONNECTED", "Google sign-in expired. Please try again.");
    row = await prisma.googleConnection.findUnique({ where: { userId } });
  }
  const user = row?.calendarSourceId ? await prisma.user.findFirst({ where: { id: userId }, select: { username: true } }) : null;
  const candidate = row?.calendarSourceId ? await prisma.calendarSource.findUnique({ where: { id: row.calendarSourceId } }) : null;
  const source = candidate?.userId === user?.username && candidate?.authMode === "google_oauth" ? candidate : null;
  const eventCount = source ? await prisma.calendarEvent.count({ where: { sourceId: source.id, userId: source.userId } }) : 0;
  return {
    state: row?.state ?? "DISCONNECTED", accountAddress: row?.accountAddress ?? null,
    connectedAt: row?.connectedAt ?? null, lastError: row?.lastError ?? null, mailboxId: row?.emailAccountId ?? null,
    mailEnabled: row?.mailEnabled ?? true, calendarEnabled: row?.calendarEnabled ?? false,
    calendar: { state: row?.calendarSyncState ?? "DISCONNECTED", lastSyncAt: source?.lastSyncAt ?? null,
      lastError: source?.lastSyncError ?? null, eventCount },
  };
}

export async function beginGoogleConnect(
  prisma: PrismaClient, userId: string, redirectUri: string, deps: GoogleDependencies,
  features: GoogleFeatures & { returnTo?: AccountConnectReturnTo } = DEFAULT_GOOGLE_FEATURES,
) {
  if (!features.mail && !features.calendar) throw new GoogleSetupRequiredError();
  if (!validateGoogleRedirectUri(redirectUri)) throw new GoogleSetupRequiredError(true);
  const app = await deps.getApp(prisma);
  if (!app) throw new GoogleSetupRequiredError();
  if (features.mail && !deps.mailboxAvailable()) throw new GoogleMailboxUnavailableError();
  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const expiresAt = new Date(deps.now().getTime() + GOOGLE_FLOW_TTL_MS);
  await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId, ...ACTIVE_USER }, select: { id: true } });
    if (!user) throw new GoogleNotConnectedError();
    // Serialize a new consent intention with feature removal/disconnect before
    // reading prior features. A flow started first is cancelled by a later remove.
    await tx.googleConnection.updateMany({ where: { userId }, data: { updatedAt: deps.now() } });
    const previous = await tx.googleConnection.findUnique({ where: { userId } });
    if ((!features.mail && previous?.emailAccountId) || (!features.calendar && previous?.calendarSourceId)) {
      throw new GoogleDisconnectRequiredError();
    }
    const pending = { state: "PENDING_CONSENT" as const, connectedAt: null, lastRefreshOkAt: null,
      pendingStateHash: sha256(state), pendingFlowEnc: sealGoogleFlow(userId, {
        ...app, ...features, codeVerifier, redirectUri, returnTo: accountConnectReturnTo(features.returnTo),
        prior: priorConnection(previous, features),
      }), pendingExpiresAt: expiresAt, lastError: null };
    // Retain an existing encrypted grant so disconnect can still revoke it
    // during re-consent. PENDING_CONSENT never permits the worker to use it.
    await tx.googleConnection.upsert({ where: { userId }, create: { userId, tokenEnc: null,
      mailEnabled: features.mail, calendarEnabled: features.calendar, calendarSyncState: "DISCONNECTED", ...pending }, update: pending });
  });
  await audit(userId, "Google sign-in started", "PENDING_CONSENT");
  return { state, expiresAt, authorizeUrl: deps.provider.getAuthorizationUrl(app, {
    redirectUri, state, codeChallenge: createHash("sha256").update(codeVerifier).digest("base64url"), scopes: scopesForGoogleFeatures(features),
  }) };
}

/** Resolve the landing page from the sealed, browser-bound flow before completion clears it. */
export async function getGoogleConnectReturnTo(prisma: PrismaClient, state: string | null, browserState: string | null): Promise<AccountConnectReturnTo> {
  if (!state || !browserState || state.length > 256 || browserState.length > 256) return "/settings";
  const expected = Buffer.from(state);
  const actual = Buffer.from(browserState);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "/settings";
  const row = await prisma.googleConnection.findUnique({ where: { pendingStateHash: sha256(state) } });
  if (!row || row.state !== "PENDING_CONSENT" || !row.pendingFlowEnc) return "/settings";
  try {
    return accountConnectReturnTo(openGoogleFlow(row.userId, row.pendingFlowEnc).returnTo);
  } catch {
    return "/settings";
  }
}

/** Browser-bound single-use claim. The sealed flow remains a CAS marker while the exchange runs. */
export async function completeGoogleConnect(prisma: PrismaClient, callback: {
  state: string | null; browserState: string | null; code: string | null; error: string | null;
}, deps: GoogleDependencies): Promise<GoogleOutcome> {
  if (!callback.state || !callback.browserState || callback.state.length > 256 || callback.browserState.length > 256) return "failed";
  const expected = Buffer.from(callback.state);
  const actual = Buffer.from(callback.browserState);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return "failed";
  const stateHash = sha256(callback.state);
  const row = await prisma.googleConnection.findUnique({ where: { pendingStateHash: stateHash } });
  if (!row || row.state !== "PENDING_CONSENT" || !row.pendingFlowEnc) return "failed";
  const claim = { id: row.id, state: "PENDING_CONSENT" as const, pendingFlowEnc: row.pendingFlowEnc, pendingStateHash: null };
  const claimed = await prisma.googleConnection.updateMany({
    where: { ...claim, pendingStateHash: stateHash }, data: { pendingStateHash: null },
  });
  if (claimed.count !== 1) return "failed";
  async function finish(state: "DISCONNECTED" | "ERROR", lastError: string | null) {
    await settleGoogleFlow(prisma, row!, claim, state, lastError);
  }
  if (!row.pendingExpiresAt || row.pendingExpiresAt <= deps.now()) {
    await finish("DISCONNECTED", "Google sign-in expired. Please try again.");
    return "expired";
  }
  if (callback.error) {
    await finish(callback.error === "access_denied" ? "DISCONNECTED" : "ERROR",
      callback.error === "access_denied" ? null : "Google sign-in could not be completed. Please try again.");
    return callback.error === "access_denied" ? "cancelled" : "failed";
  }
  if (!callback.code || callback.code.length > 4096) {
    await finish("ERROR", "Google sign-in could not be completed. Please try again.");
    return "failed";
  }

  try {
    const flow = openGoogleFlow(row.userId, row.pendingFlowEnc);
    const scopes = scopesForGoogleFeatures(flow);
    const tokens = await deps.provider.exchangeCode(flow, {
      code: callback.code, codeVerifier: flow.codeVerifier, redirectUri: flow.redirectUri, scopes,
    });
    if (!tokens.refreshToken || !googleGrantCovers(tokens.grantedScopes, scopes)) throw new GoogleProviderError(true);
    const address = await deps.provider.getAccountAddress(tokens.accessToken);
    const tokenEnc = sealGoogleGrant(row.userId, {
      clientId: flow.clientId, clientSecret: flow.clientSecret, refreshToken: tokens.refreshToken,
      scopes: tokens.grantedScopes,
    });
    await prisma.$transaction(async (tx) => {
      // This conditional write locks the connection before any mailbox change.
      // Disconnect, another flow, user deletion or deactivation makes it fail.
      const current = await tx.googleConnection.updateMany({
        where: { ...claim, user: { is: ACTIVE_USER } },
        data: { state: "CONNECTED", tokenEnc, accountAddress: address, connectedAt: deps.now(),
          mailEnabled: flow.mail, calendarEnabled: flow.calendar, calendarSyncState: flow.calendar ? "WAITING" : "DISCONNECTED",
          lastRefreshOkAt: deps.now(), ...CLEARED_FLOW, lastError: null },
      });
      if (current.count !== 1) throw new FlowCancelledError();
      const user = await tx.user.findFirst({ where: { id: row.userId, ...ACTIVE_USER }, select: { username: true } });
      if (!user) throw new FlowCancelledError();
      const previous = row.emailAccountId ? await tx.emailAccount.findUnique({ where: { id: row.emailAccountId } }) : null;
      const previousAddress = previous?.userId === row.userId && previous.authMode === "GOOGLE_OAUTH"
        ? previous.address : row.accountAddress;
      if ((row.emailAccountId || row.calendarSourceId) && previousAddress && previousAddress.toLowerCase() !== address.toLowerCase()) {
        throw new AccountSwitchRequiredError();
      }
      if ((!flow.mail && row.emailAccountId) || (!flow.calendar && row.calendarSourceId)) throw new GoogleDisconnectRequiredError();
      if (flow.mail) {
      const existing = await tx.emailAccount.findFirst({ where: { address: { equals: address, mode: "insensitive" } } });
      if (existing && (existing.userId !== row.userId || existing.authMode !== "GOOGLE_OAUTH")) throw new MailboxConflictError();
      const data = {
        userId: row.userId, displayName: "Gmail", address, username: address, authMode: "GOOGLE_OAUTH" as const,
        imapHost: "imap.gmail.com", imapPort: 993, imapTls: true,
        smtpHost: "smtp.gmail.com", smtpPort: 465, smtpTls: true,
        passwordEnc: null, imapStatus: "reconnecting" as const, lastError: null,
      };
      const account = existing
        ? await tx.emailAccount.update({ where: { id: existing.id }, data })
        : await tx.emailAccount.create({ data });
      await tx.googleConnection.update({ where: { id: row.id }, data: { emailAccountId: account.id } });
      }
      if (flow.calendar) {
        const oldSource = row.calendarSourceId ? await tx.calendarSource.findUnique({ where: { id: row.calendarSourceId } }) : null;
        if (oldSource && (oldSource.userId !== user.username || oldSource.authMode !== "google_oauth")) throw new MailboxConflictError();
        const sourceData = { userId: user.username, name: "Google Calendar", url: GOOGLE_CALENDAR_EVENTS_URL,
          authMode: "google_oauth", username: address, passwordEnc: null, syncIntervalSec: 300,
          lastSyncError: null, externalSyncRun: randomBytes(24).toString("hex") };
        const source = oldSource ? await tx.calendarSource.update({ where: { id: oldSource.id }, data: sourceData })
          : await tx.calendarSource.create({ data: sourceData });
        await tx.googleConnection.update({ where: { id: row.id }, data: { calendarSourceId: source.id } });
      }
    });
  } catch (err) {
    if (err instanceof FlowCancelledError) return "cancelled";
    if (err instanceof AccountSwitchRequiredError) {
      await finish("ERROR", "Disconnect the existing Google account before linking a different account. Disconnecting removes its mail and calendar archives from this Droplet.");
      return "different_account";
    }
    if (err instanceof GoogleDisconnectRequiredError) {
      await finish("ERROR", err.message);
      return "failed";
    }
    await finish("ERROR", err instanceof MailboxConflictError
      ? "This email address is already connected. Disconnect the existing mailbox before linking Google."
      : "Google sign-in could not be completed. Please try again.");
    return "failed";
  }
  await postCommitFollowups(row.userId, "Google account connected", "CONNECTED", deps);
  return "connected";
}

/** Delete the local grant and the owned Gmail archive atomically. Also used by leaver cleanup. */
export async function purgeGoogleForUser(prisma: PrismaClient, userId: string): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    // Lock/cancel first, then read the latest link. Reading before this write
    // could miss a callback's newly committed mailbox while disconnect waits.
    const cancelled = await tx.googleConnection.updateMany({ where: { userId }, data: { state: "DISCONNECTED" } });
    if (!cancelled.count) return null;
    const row = await tx.googleConnection.findUnique({ where: { userId } });
    if (!row) return null;
    const user = await tx.user.findFirst({ where: { id: userId }, select: { username: true } });
    await tx.googleConnection.updateMany({ where: { id: row.id }, data: { ...UNLINKED, emailAccountId: null, calendarSourceId: null } });
    if (row.emailAccountId) {
      await tx.emailAccount.deleteMany({ where: { id: row.emailAccountId, userId, authMode: "GOOGLE_OAUTH" } });
    }
    if (row.calendarSourceId && user) {
      const source = await tx.calendarSource.findUnique({ where: { id: row.calendarSourceId } });
      if (source?.userId === user.username && source.authMode === "google_oauth") {
        await tx.calendarEvent.deleteMany({ where: { sourceId: source.id, userId: user.username } });
        await tx.calendarSource.deleteMany({ where: { id: source.id, userId: user.username, authMode: "google_oauth" } });
      }
    }
    return row.tokenEnc;
  });
}

export async function disconnectGoogle(prisma: PrismaClient, userId: string, deps: GoogleDependencies): Promise<void> {
  const tokenEnc = await purgeGoogleForUser(prisma, userId);
  // Purge locally first. A provider outage must not stop a person disconnecting.
  if (tokenEnc) {
    try { await deps.provider.revoke(openGoogleGrant(userId, tokenEnc).refreshToken); } catch { /* Local purge is complete. */ }
  }
  await postCommitFollowups(userId, "Google account disconnected", "DISCONNECTED", deps);
}

/** Existing Mailboxes Remove confirmation removes only Gmail, preserving a
 * separately selected Calendar subscription on the same Google grant. */
export async function disconnectGoogleMailbox(prisma: PrismaClient, userId: string, accountId: string,
  deps: GoogleDependencies = googleDependencies()): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const account = await tx.emailAccount.findFirst({ where: { id: accountId, userId, authMode: "GOOGLE_OAUTH" } });
    if (!account) return { removed: false, tokenEnc: null, state: "DISCONNECTED" as GoogleState };
    // Lock/cancel before reading the latest feature selections, so a late
    // consent exchange cannot recreate the just-removed mailbox.
    await tx.googleConnection.updateMany({ where: { userId, emailAccountId: accountId }, data: CLEARED_FLOW });
    const row = await tx.googleConnection.findUnique({ where: { userId } });
    let tokenEnc: string | null = null;
    let state: GoogleState = "DISCONNECTED";
    if (row?.emailAccountId === accountId) {
      const keepCalendar = row.calendarEnabled;
      state = keepCalendar ? row.state === "PENDING_CONSENT" ? "NEEDS_RECONNECT" : row.state : "DISCONNECTED";
      tokenEnc = keepCalendar ? null : row.tokenEnc;
      await tx.googleConnection.updateMany({ where: { id: row.id }, data: {
        emailAccountId: null, mailEnabled: false, state,
        ...(keepCalendar ? row.state === "PENDING_CONSENT" ? {
          calendarSyncState: "NEEDS_RECONNECT", lastError: "Gmail was disconnected. Sign in again to reconnect Google Calendar.",
        } : {} : { tokenEnc: null, accountAddress: null, connectedAt: null, lastRefreshOkAt: null, lastError: null,
          calendarSyncState: "DISCONNECTED" }),
      } });
    }
    await tx.emailAccount.deleteMany({ where: { id: accountId, userId, authMode: "GOOGLE_OAUTH" } });
    return { removed: true, tokenEnc, state };
  });
  if (!result.removed) return false;
  if (result.tokenEnc) {
    try { await deps.provider.revoke(openGoogleGrant(userId, result.tokenEnc).refreshToken); } catch { /* Local removal is complete. */ }
  }
  await postCommitFollowups(userId, "Gmail mailbox disconnected", result.state, deps);
  return true;
}

/** Calendar subscription Remove confirmation preserves a separately selected
 * Gmail mailbox. The caller's calendar owner uses username, while this grant uses UUID. */
export async function disconnectGoogleCalendar(prisma: PrismaClient, userId: string, sourceId: string,
  deps: GoogleDependencies = googleDependencies()): Promise<boolean> {
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.findFirst({ where: { id: userId }, select: { username: true } });
    const source = await tx.calendarSource.findUnique({ where: { id: sourceId } });
    if (!user || source?.userId !== user.username || source.authMode !== "google_oauth") {
      return { removed: false, tokenEnc: null, state: "DISCONNECTED" as GoogleState };
    }
    await tx.googleConnection.updateMany({ where: { userId, calendarSourceId: sourceId }, data: CLEARED_FLOW });
    const row = await tx.googleConnection.findUnique({ where: { userId } });
    let tokenEnc: string | null = null;
    let state: GoogleState = "DISCONNECTED";
    if (row?.calendarSourceId === sourceId) {
      const keepMail = row.mailEnabled;
      state = keepMail ? row.state === "PENDING_CONSENT" ? "NEEDS_RECONNECT" : row.state : "DISCONNECTED";
      tokenEnc = keepMail ? null : row.tokenEnc;
      await tx.googleConnection.updateMany({ where: { id: row.id }, data: {
        calendarSourceId: null, calendarEnabled: false, calendarSyncState: "DISCONNECTED", state,
        ...(keepMail ? row.state === "PENDING_CONSENT" ? {
          lastError: "Google Calendar was disconnected. Sign in again to reconnect Gmail.",
        } : {} : { tokenEnc: null, accountAddress: null, connectedAt: null, lastRefreshOkAt: null, lastError: null }),
      } });
    }
    await tx.calendarEvent.deleteMany({ where: { sourceId, userId: user.username } });
    await tx.calendarSource.deleteMany({ where: { id: sourceId, userId: user.username, authMode: "google_oauth" } });
    return { removed: true, tokenEnc, state };
  });
  if (!result.removed) return false;
  if (result.tokenEnc) {
    try { await deps.provider.revoke(openGoogleGrant(userId, result.tokenEnc).refreshToken); } catch { /* Local removal is complete. */ }
  }
  await postCommitFollowups(userId, "Google Calendar disconnected", result.state, deps);
  return true;
}

export interface GoogleAccessGrant {
  accessToken: string;
  connectionId: string;
  connectedAt: Date | null;
  accountAddress: string | null;
  mailEnabled: boolean;
  calendarEnabled: boolean;
  emailAccountId: string | null;
  calendarSourceId: string | null;
}
const refreshInFlight = new WeakMap<PrismaClient, Map<string, Promise<GoogleAccessGrant>>>();

/** IMAP reconnect and SMTP send can authenticate together. Share only the
 * in-flight refresh; keep no access-token cache after the request completes. */
function getGoogleAccessGrant(prisma: PrismaClient, userId: string, deps: GoogleDependencies): Promise<GoogleAccessGrant> {
  let pending = refreshInFlight.get(prisma);
  if (!pending) {
    pending = new Map();
    refreshInFlight.set(prisma, pending);
  }
  const existing = pending.get(userId);
  if (existing) return existing;
  const task = (async () => {
    try { return await refreshGoogleAccessGrant(prisma, userId, deps); }
    finally { pending.delete(userId); }
  })();
  pending.set(userId, task);
  return task;
}

/** Only the mail worker route returns this bearer, with its exact service guard. */
export async function getGoogleMailboxAccessToken(prisma: PrismaClient, accountId: string, deps: GoogleDependencies): Promise<string> {
  const account = await prisma.emailAccount.findUnique({ where: { id: accountId } });
  if (!account?.userId || account.authMode !== "GOOGLE_OAUTH") throw new GoogleNotConnectedError();
  const row = await prisma.googleConnection.findUnique({ where: { userId: account.userId } });
  if (!row?.mailEnabled || row.emailAccountId !== account.id || row.state !== "CONNECTED") throw new GoogleNotConnectedError();
  const grant = await getGoogleAccessGrant(prisma, account.userId, deps);
  if (!grant.mailEnabled || grant.emailAccountId !== account.id) throw new GoogleNotConnectedError();
  return grant.accessToken;
}

/** Calendar bearer stays inside the orchestrator. Generation metadata pins its later snapshot write. */
export async function getGoogleCalendarAccessToken(prisma: PrismaClient, userId: string, deps: GoogleDependencies): Promise<GoogleAccessGrant> {
  const row = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!row?.calendarEnabled || !row.calendarSourceId || row.state !== "CONNECTED") throw new GoogleNotConnectedError();
  const grant = await getGoogleAccessGrant(prisma, userId, deps);
  if (!grant.calendarEnabled || !grant.calendarSourceId) throw new GoogleNotConnectedError();
  return grant;
}

async function refreshGoogleAccessGrant(prisma: PrismaClient, userId: string, deps: GoogleDependencies): Promise<GoogleAccessGrant> {
  const row = await prisma.googleConnection.findUnique({ where: { userId } });
  if (!row || row.state !== "CONNECTED" || !row.tokenEnc) throw new GoogleNotConnectedError();
  const user = await prisma.user.findFirst({ where: { id: userId, ...ACTIVE_USER }, select: { username: true } });
  if (!user) throw new GoogleNotConnectedError();
  const requested = scopesForGoogleFeatures({ mail: row.mailEnabled, calendar: row.calendarEnabled });
  const where = { id: row.id, state: "CONNECTED" as const, tokenEnc: row.tokenEnc,
    mailEnabled: row.mailEnabled, calendarEnabled: row.calendarEnabled,
    emailAccountId: row.emailAccountId, calendarSourceId: row.calendarSourceId,
    user: { is: ACTIVE_USER } };
  let tokens;
  let grant;
  try {
    grant = openGoogleGrant(row.userId, row.tokenEnc);
    if (!googleGrantCovers(grant.scopes, requested)) throw new GoogleProviderError(true);
  } catch {
    await markNeedsReconnect();
    throw new GoogleNotConnectedError();
  }
  try {
    tokens = await deps.provider.refresh(grant, grant.refreshToken, grant.scopes);
    if (!googleGrantCovers(tokens.grantedScopes, requested)) throw new GoogleProviderError(true);
  } catch (err) {
    if (err instanceof GoogleProviderError && err.needsReconnect) {
      await markNeedsReconnect();
      throw new GoogleNotConnectedError();
    }
    throw new GoogleTemporarilyUnavailableError();
  }
  const updated = await prisma.googleConnection.updateMany({
    where, data: { tokenEnc: sealGoogleGrant(row.userId, { ...grant, refreshToken: tokens.refreshToken ?? grant.refreshToken,
      scopes: tokens.grantedScopes }),
      lastRefreshOkAt: deps.now(), lastError: null },
  });
  if (updated.count !== 1) throw new GoogleTemporarilyUnavailableError();
  return { accessToken: tokens.accessToken, connectionId: row.id, connectedAt: row.connectedAt,
    accountAddress: row.accountAddress, emailAccountId: row.emailAccountId, calendarSourceId: row.calendarSourceId,
    mailEnabled: row.mailEnabled, calendarEnabled: row.calendarEnabled };

  async function markNeedsReconnect() {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.googleConnection.updateMany({ where, data: {
        state: "NEEDS_RECONNECT", tokenEnc: null, lastError: "Google access expired or was revoked. Sign in again to reconnect Google.",
        calendarSyncState: row!.calendarEnabled ? "NEEDS_RECONNECT" : "DISCONNECTED",
      } });
      if (updated.count && row!.emailAccountId) await tx.emailAccount.updateMany({
        where: { id: row!.emailAccountId, userId: row!.userId, authMode: "GOOGLE_OAUTH" },
        data: { imapStatus: "error", lastErrorAt: deps.now(), lastError: "Sign in to Google again to reconnect Gmail." },
      });
      if (updated.count && row!.calendarSourceId) await tx.calendarSource.updateMany({
        where: { id: row!.calendarSourceId, userId: user!.username, authMode: "google_oauth" },
        data: { lastSyncError: "Sign in to Google again to reconnect Calendar." },
      });
    });
  }
}
