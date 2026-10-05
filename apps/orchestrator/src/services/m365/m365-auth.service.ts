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
 *   - **The customer's own app (WARP-2705).** Every sign-in and refresh goes
 *     through the app registration stored on the connection. WARP-3788 lets
 *     the owner save their organisation's app once for new connections; a
 *     person's stored or explicitly supplied app still takes precedence.
 *   - **Authorization code + PKCE is the primary sign-in (WARP-2704).** Every
 *     Entra tenant created since 2026-07-01 blocks device code through
 *     security defaults; device code stays as a fallback for tenants that
 *     still allow it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import type { Prisma, PrismaClient } from "@prisma/client";

import { recordActivity } from "../activity.singleton.js";
import { purgeCursorsForUser } from "./delta-cursor.service.js";
import { purgeM365FileDataForUser, purgeSharePointDataForUser } from "./drive-data.service.js";
import { GRAPH_RESOURCES, grantCovers } from "./graph-resources.js";
import { scopesForRefresh, scopesForSignIn } from "./scopes.js";
import { getMicrosoftApp } from "../account-provider-setup.service.js";
import { accountConnectReturnTo, type AccountConnectReturnTo } from "../account-connect-return.js";
import { microsoftCalendarViewOf, purgeMicrosoftCalendar, setMicrosoftCalendarEnabled, type MicrosoftCalendarView } from "./calendar-landing.service.js";
import type { M365GrantGeneration } from "./m365-contracts.js";
export type { M365GrantGeneration } from "./m365-contracts.js";
import {
  sealPendingFlow,
  sealTokenCache,
  unsealPendingFlow,
  unsealTokenCache,
} from "./token-cache.js";
import {
  classifyAuthFailure,
  isPendingFlowExpired,
  redactAuthError,
  PENDING_FLOW_TTL_MS,
  type EntraAppRegistration,
  type EntraFailureLike,
} from "./state.js";

export type { EntraAppRegistration } from "./state.js";

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

/**
 * Every operation takes the app registration it signs in through (WARP-2705):
 * the port receives the resolved customer-owned app, never fleet credentials.
 */
export interface EntraClient {
  /**
   * The URL of Microsoft's sign-in page for an authorization-code sign-in
   * (WARP-2704). PKCE is S256 over `codeChallenge`; `state` and `nonce` are
   * echoed back so the callback can be tied to the flow that started it.
   */
  getAuthCodeUrl(
    app: EntraAppRegistration,
    opts: {
      redirectUri: string;
      state: string;
      nonce: string;
      codeChallenge: string;
      /** WARP-3538 — what this sign-in asks Microsoft for; see `scopes.ts`. */
      scopes: readonly string[];
    },
  ): Promise<string>;

  /**
   * Redeem the code the callback received, with the verifier kept server-side.
   * `scopes` are the ones the authorize leg asked for (sealed with the flow),
   * never re-derived: Entra wants the redemption's scopes equal to, or a subset
   * of, the authorize leg's.
   */
  acquireByAuthorizationCode(
    app: EntraAppRegistration,
    opts: { code: string; redirectUri: string; codeVerifier: string; nonce: string; scopes: readonly string[] },
  ): Promise<EntraAuthResult>;

  /**
   * Begin a device-code sign-in — the fallback. `onCode` fires as soon as
   * Microsoft issues the code (so the caller can show it immediately); the
   * promise resolves only once the person has approved it.
   */
  acquireByDeviceCode(
    app: EntraAppRegistration,
    opts: { onCode: (info: DeviceCodeInfo) => void; scopes: readonly string[] },
  ): Promise<EntraAuthResult>;

  /**
   * Refresh silently from a stored cache. `scopes` are ONLY what the connection
   * already holds (`scopesForRefresh`): a refresh that asks for a scope never
   * consented fails into NEEDS_RECONNECT.
   */
  acquireSilent(
    app: EntraAppRegistration,
    serializedCache: string,
    homeAccountId: string,
    scopes: readonly string[],
  ): Promise<EntraAuthResult>;
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

/**
 * A sign-in has no supplied app, stored per-person app, or owner-configured
 * organisation app. The owner must complete Account connection setup.
 */
export class M365AppRequiredError extends Error {
  constructor() {
    super(
      "Connecting Microsoft 365 needs your organisation's app registration: its " +
        "Application (client) ID and Directory (tenant) ID.",
    );
    this.name = "M365AppRequiredError";
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
 * WARP-3538 — where a person stands on SharePoint: what they chose, whether
 * Microsoft has allowed it, and whether they have to act.
 *
 * Three facts, kept apart because three different things change them. `enabled`
 * is the PERSON's switch and only they move it. `granted` is MICROSOFT's side:
 * the grant on the connection covers what finding a person's libraries needs
 * (`Sites.Read.All`), which an administrator may not have approved and which a
 * connection made before this existed never asked for. `needsConsent` is the
 * two together — on, and not allowed — and is what the card turns into "Sign in
 * again": the box says it so a card cannot disagree with the box about whether
 * a person has to act.
 */
export interface M365SharePointView {
  enabled: boolean;
  granted: boolean;
  needsConsent: boolean;
}

/**
 * Build the SharePoint view from the two columns it is made of.
 *
 * `enabled` is `=== true`, not truthiness: an absent or malformed flag is OFF
 * (explicit state, never inferred). `granted` is judged by the SAME function and
 * the SAME scope discovery uses (`grantCovers` against the sharepoint workload's
 * `leastPrivilegeScope`), so the view says "needs consent" exactly when
 * discovery would report the workload `notGranted` — never a second opinion.
 * A grant that was never recorded (`null`) covers nothing.
 */
export function sharePointViewOf(
  sharePointEnabled: unknown,
  grantedScopes: string | null | undefined,
): M365SharePointView {
  const enabled = sharePointEnabled === true;
  const granted = grantCovers(
    (grantedScopes ?? "").split(" ").filter(Boolean),
    GRAPH_RESOURCES.sharepoint.leastPrivilegeScope,
  );
  return { enabled, granted, needsConsent: enabled && !granted };
}

/**
 * What a route may return. Built field-by-field rather than by spreading the
 * row, so a column added later (another secret, say) cannot leak by default.
 */
export interface M365ConnectionView {
  state: M365State;
  /** Which Microsoft account is linked, for the person to recognise. Not secret. */
  accountUpn: string | null;
  tenantId: string | null;
  /** WARP-2705 — the app registration this connection signs in through. Not
   *  secret; kept across a disconnect so reconnecting is one click. */
  app: EntraAppRegistration | null;
  grantedScopes: string[];
  connectedAt: Date | null;
  lastRefreshOkAt: Date | null;
  /** Redacted, human-readable reason for ERROR / NEEDS_RECONNECT. */
  lastError: string | null;
  /** WARP-3538 — the person's SharePoint choice and Microsoft's answer to it. */
  sharePoint: M365SharePointView;
  calendar: MicrosoftCalendarView;
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
  appClientId?: string | null;
  appTenantId?: string | null;
  /** WARP-3538 — the person's explicit SharePoint opt-in. Absent reads as OFF. */
  sharePointEnabled?: boolean;
  calendarEnabled?: boolean;
  calendarSourceId?: string | null;
  calendarSyncState?: MicrosoftCalendarView["state"];
  pendingStateHash?: string | null;
  pendingFlowEnc?: string | null;
  cursorLinkHash?: string | null;
}

/**
 * The columns that name a Microsoft account: the sealed credential and the
 * account it belongs to. Cleared together, never one at a time.
 *
 * #2344 review — DISCONNECTED is "no Microsoft account linked" and
 * `disconnect()` purges these, but a person who was CONNECTED and pressed
 * Connect again reached DISCONNECTED another way (cancel, expiry, a network
 * wobble on the callback) with the old account's refresh token still sealed on
 * the row. So a new sign-in drops them the moment it starts, and every way
 * into DISCONNECTED clears them again. `appClientId` / `appTenantId` are not
 * here on purpose (WARP-2705): configuration, not a credential.
 */
const NO_ACCOUNT = {
  tokenCacheEnc: null,
  homeAccountId: null,
  accountUpn: null,
  tenantId: null,
  grantedScopes: null,
  connectedAt: null,
} as const;

/** A DISCONNECTED row: no account, and no sign-in in flight. */
const UNLINKED = {
  state: "DISCONNECTED",
  ...NO_ACCOUNT,
  pendingStateHash: null,
  pendingFlowEnc: null,
  pendingFlowExpiresAt: null,
} as const;

/**
 * WARP-3059 (#2347 review) — which link a person's delta cursors belong to.
 *
 * A delta link, a resume link and a folder id are positions in ONE mailbox,
 * read through ONE app registration. Signing in as another account, into
 * another tenant, or through another app makes every one of them wrong: the
 * old delta links would be replayed against the new mailbox, and folder ids
 * that do not exist there 404, classify FATAL and park FAILED for good. A
 * delta token is issued to one app's reads, and nothing documents it as
 * portable to another registration, so a new app starts from scratch too.
 *
 * Hashed, so a row names no account through it. It is NOT in NO_ACCOUNT: the
 * cursors survive a sign-in starting, so what says whose they are must too.
 */
function cursorLinkHash(app: EntraAppRegistration, result: EntraAuthResult): string {
  return createHash("sha256")
    .update(JSON.stringify([app.clientId, result.homeAccountId, result.tenantId ?? null]))
    .digest("hex");
}

/** The stored app registration, or null when the row predates WARP-2705. */
function storedApp(row: ConnectionRow | null): EntraAppRegistration | null {
  if (!row?.appClientId || !row.appTenantId) return null;
  return { clientId: row.appClientId, tenantId: row.appTenantId };
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
  app: null,
  grantedScopes: [],
  connectedAt: null,
  lastRefreshOkAt: null,
  lastError: null,
  sharePoint: { enabled: false, granted: false, needsConsent: false },
  calendar: microsoftCalendarViewOf(null),
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
    app: storedApp(row),
    grantedScopes: row.grantedScopes ? row.grantedScopes.split(" ").filter(Boolean) : [],
    connectedAt: row.connectedAt ?? null,
    lastRefreshOkAt: row.lastRefreshOkAt ?? null,
    lastError: row.lastError ?? null,
    sharePoint: sharePointViewOf(row.sharePointEnabled, row.grantedScopes),
    calendar: microsoftCalendarViewOf(row),
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
  if (!row) return DISCONNECTED_VIEW;
  const person = row.calendarSourceId ? await prisma.user.findFirst({ where: { id: userId }, select: { username: true } }) : null;
  const source = row.calendarSourceId && person ? await prisma.calendarSource.findFirst({
    where: { id: row.calendarSourceId, userId: person.username, authMode: "m365_oauth" }, select: { lastSyncAt: true, lastSyncError: true },
  }) : null;
  return { ...toView(row, now), calendar: microsoftCalendarViewOf(row, source) };
}

// --- Connect --------------------------------------------------------------

/** Options every sign-in accepts. */
export interface ConnectOptions {
  /** The app to sign in through. Omit to reuse the one stored on the
   *  connection; with neither, the sign-in is refused (M365AppRequiredError). */
  app?: EntraAppRegistration;
}

/**
 * What a new sign-in is made of, off the person's row (read ONCE): the app it
 * signs in through — the one asked for, else the stored one — and whether the
 * person has opted in to SharePoint, which decides the scopes it asks for
 * (WARP-3538).
 *
 * `=== true`, not truthiness: an absent or malformed flag is OFF. A first-time
 * connect has no row and is therefore OFF — a person cannot opt in to SharePoint
 * before they are connected, and one who has not asked for it is never asked for
 * its scope (see `scopes.ts` for why a tenant that has not approved it would
 * otherwise fail the whole sign-in).
 */
async function resolveConnect(
  prisma: PrismaClient,
  userId: string,
  requested: EntraAppRegistration | undefined,
): Promise<{ app: EntraAppRegistration; sharePointEnabled: boolean }> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  const sharePointEnabled = row?.sharePointEnabled === true;
  if (requested) return { app: requested, sharePointEnabled };
  const stored = storedApp(row) ?? await getMicrosoftApp(prisma);
  if (!stored) throw new M365AppRequiredError();
  return { app: stored, sharePointEnabled };
}

/** 32 random bytes, base64url — the RFC 7636 verifier shape (43 chars). */
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the row stores in place of the raw OAuth `state`. */
function hashState(state: string): string {
  return createHash("sha256").update(state).digest("hex");
}

/** Constant-time string equality that tolerates unequal lengths. */
function sameSecret(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

/**
 * WARP-2704 — start an authorization-code sign-in.
 *
 * Builds Microsoft's sign-in URL FIRST and only then parks the row in
 * PENDING_CONSENT, so a box that cannot reach Microsoft answers with an error
 * without dirtying the connection. The row keeps a SHA-256 of `state` (the
 * callback's lookup key) and the sealed verifier, nonce and redirect URI; the
 * raw `state` goes back to the caller once, for the redirect and the browser
 * cookie that ties the callback to this browser.
 *
 * A link already on the row is dropped here (NO_ACCOUNT): a person who presses
 * Connect is starting over, and nothing may refresh the old grant while they
 * are at Microsoft's page — a refresh would write CONNECTED over the sign-in
 * in flight, and its callback would find nothing to claim.
 *
 * Connecting IS the consent event (ADR-041).
 */
export async function beginAuthCodeConnect(
  prisma: PrismaClient,
  entra: EntraClient,
  userId: string,
  opts: ConnectOptions & {
    /** The box's own callback URL, byte-identical in both legs. */
    redirectUri: string;
    returnTo?: AccountConnectReturnTo;
  },
  now: Date = new Date(),
): Promise<{ authorizeUrl: string; state: string; expiresAt: Date }> {
  const { app, sharePointEnabled } = await resolveConnect(prisma, userId, opts.app);
  // Decided now, from the row as it is NOW, and sealed with the flow below: the
  // callback redeems with these exact scopes however the row changes meanwhile.
  const scopes = scopesForSignIn(sharePointEnabled);

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken();
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  const authorizeUrl = await entra.getAuthCodeUrl(app, {
    redirectUri: opts.redirectUri,
    state,
    nonce,
    codeChallenge,
    scopes,
  });

  const expiresAt = new Date(now.getTime() + PENDING_FLOW_TTL_MS);
  const pending = {
    state: "PENDING_CONSENT" as const,
    ...NO_ACCOUNT,
    appClientId: app.clientId,
    appTenantId: app.tenantId,
    pendingStateHash: hashState(state),
    pendingFlowEnc: sealPendingFlow(userId, {
      codeVerifier,
      nonce,
      redirectUri: opts.redirectUri,
      scopes,
      returnTo: accountConnectReturnTo(opts.returnTo),
    }),
    pendingFlowExpiresAt: expiresAt,
    lastError: null,
  };
  await prisma.m365Connection.upsert({
    where: { userId },
    create: { userId, ...pending },
    update: pending,
  });

  return { authorizeUrl, state, expiresAt };
}

/** How a callback ended, for the dashboard to say so. */
export type AuthCodeOutcome = "connected" | "cancelled" | "expired" | "failed" | "invalid" | "different_account";

/** Resolve the landing page from the sealed, browser-bound flow before completion clears it. */
export async function getAuthCodeReturnTo(prisma: PrismaClient, state: string | null, browserState: string | null): Promise<AccountConnectReturnTo> {
  if (!state || !browserState || !sameSecret(state, browserState)) return "/settings";
  const row = await prisma.m365Connection.findUnique({ where: { pendingStateHash: hashState(state) } });
  if (!row || row.state !== "PENDING_CONSENT" || !row.pendingFlowEnc) return "/settings";
  try {
    return accountConnectReturnTo(unsealPendingFlow(row.userId, row.pendingFlowEnc).returnTo);
  } catch {
    return "/settings";
  }
}

/**
 * WARP-2704 — finish an authorization-code sign-in from Microsoft's redirect.
 *
 * The callback is reached WITHOUT a Droplet session (a Microsoft sign-in with
 * MFA or an admin's consent can outlast the 15-minute access token), so the
 * person is identified by the flow, never by anything the browser asserts:
 *
 *   1. `state` must equal the httpOnly cookie set when THIS browser pressed
 *      Connect. That is what stops a lured browser from linking an attacker's
 *      mailbox to the owner's account (login CSRF).
 *   2. The row is found by the state's hash and CLAIMED by one conditional
 *      write that clears it, so a replayed or racing callback redeems nothing.
 *   3. The verifier, nonce and redirect URI come from the sealed row, and the
 *      code is redeemed through the app stored on it.
 *
 * An unknown or mismatched state touches no row at all.
 */
export async function completeAuthCodeConnect(
  prisma: PrismaClient,
  entra: EntraClient,
  callback: {
    state: string | null | undefined;
    /** The state cookie this browser carries. */
    browserState: string | null | undefined;
    code?: string | null;
    /** Microsoft's `error` / `error_description`, when it sent those instead. */
    error?: string | null;
    errorDescription?: string | null;
  },
  now: Date = new Date(),
): Promise<AuthCodeOutcome> {
  const { state, browserState } = callback;
  if (!state || !browserState || !sameSecret(state, browserState)) return "invalid";

  const stateHash = hashState(state);
  const row = (await prisma.m365Connection.findUnique({
    where: { pendingStateHash: stateHash },
  })) as (ConnectionRow & { userId: string }) | null;
  if (!row || row.state !== "PENDING_CONSENT") return "invalid";
  const userId = row.userId;

  const { count } = await prisma.m365Connection.updateMany({
    where: { userId, state: "PENDING_CONSENT", pendingStateHash: stateHash },
    data: { pendingStateHash: null },
  });
  if (count !== 1) return "invalid";
  const flowWhere: Prisma.M365ConnectionWhereInput = { userId, state: "PENDING_CONSENT", pendingStateHash: null,
    pendingFlowEnc: row.pendingFlowEnc, pendingFlowExpiresAt: row.pendingFlowExpiresAt };

  if (isPendingFlowExpired(row.pendingFlowExpiresAt, now)) {
    await returnToDisconnected(prisma, userId, null, flowWhere);
    return "expired";
  }

  if (callback.error) {
    return await settleConnectFailure(prisma, userId, {
      errorCode: callback.error,
      errorMessage: callback.errorDescription ?? undefined,
    }, flowWhere);
  }

  const app = storedApp(row);
  if (!callback.code || !app || !row.pendingFlowEnc) {
    await returnToDisconnected(prisma, userId, "Microsoft did not return a usable sign-in. Please try again.", flowWhere);
    return "failed";
  }

  let flow: ReturnType<typeof unsealPendingFlow>;
  try {
    flow = unsealPendingFlow(userId, row.pendingFlowEnc);
  } catch {
    await returnToDisconnected(prisma, userId, "This sign-in could no longer be completed. Please try again.", flowWhere);
    return "failed";
  }

  let result: EntraAuthResult;
  try {
    result = await entra.acquireByAuthorizationCode(app, {
      code: callback.code,
      redirectUri: flow.redirectUri,
      codeVerifier: flow.codeVerifier,
      nonce: flow.nonce,
      // The scopes the authorize leg asked for — sealed with the flow, never
      // re-read from the row, which the person may have changed since.
      scopes: flow.scopes,
    });
  } catch (err) {
    return await settleConnectFailure(prisma, userId, err, flowWhere);
  }

  return await persistConnected(prisma, userId, app, result, now, flowWhere);
}

/**
 * Put an in-flight sign-in back to DISCONNECTED — and only an in-flight one,
 * so a stale flow ending late cannot unlink a connection made since. Clears
 * the account columns too (UNLINKED): a row parked PENDING_CONSENT before the
 * sign-in started dropping them still holds the old link's token.
 */
async function returnToDisconnected(
  prisma: PrismaClient,
  userId: string,
  lastError: string | null,
  expectedFlow?: Prisma.M365ConnectionWhereInput,
): Promise<void> {
  await prisma.m365Connection.updateMany({
    where: expectedFlow ?? { userId, state: "PENDING_CONSENT" },
    data: { ...UNLINKED, lastError },
  });
}

/**
 * A failed authorization-code sign-in, in the state the person can act on.
 *
 * Differs from `persistFailure` in one place: a TRANSIENT failure returns the
 * row to DISCONNECTED rather than leaving it alone. The flow was already
 * claimed, so nothing can complete it — left in PENDING_CONSENT the row would
 * read "signing in" until the window lapsed.
 */
async function settleConnectFailure(
  prisma: PrismaClient,
  userId: string,
  err: unknown,
  expectedFlow?: Prisma.M365ConnectionWhereInput,
): Promise<AuthCodeOutcome> {
  const failure = (err ?? {}) as EntraFailureLike;
  const kind = classifyAuthFailure(failure);
  if (kind === "TRANSIENT") {
    await returnToDisconnected(prisma, userId, redactAuthError(failure), expectedFlow);
    return "failed";
  }
  if (kind === "ABANDONED") await returnToDisconnected(prisma, userId, null, expectedFlow);
  else if (expectedFlow) await prisma.$transaction(async (tx) => {
    const locked = await tx.m365Connection.updateMany({ where: expectedFlow, data: { state: "PENDING_CONSENT" } });
    if (locked.count !== 1) return;
    const row = await tx.m365Connection.findUnique({ where: { userId } });
    await persistFailure(tx, userId, failure, { where: expectedFlow, calendarEnabled: row?.calendarEnabled === true });
  });
  else await persistFailure(prisma, userId, failure);
  return kind === "ABANDONED" ? "cancelled" : "failed";
}

/**
 * Start a device-code sign-in — the FALLBACK since WARP-2704. Every tenant
 * created since 2026-07-01 blocks this flow (AADSTS50199 → ERROR), so the
 * authorization code above is what the dashboard offers first.
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
  opts: ConnectOptions = {},
  now: Date = new Date(),
): Promise<DeviceCodeInfo> {
  const { app, sharePointEnabled } = await resolveConnect(prisma, userId, opts.app);
  const scopes = scopesForSignIn(sharePointEnabled);
  const expiresAt = new Date(now.getTime() + PENDING_FLOW_TTL_MS);
  // A device completion needs the same unforgeable generation fence as a
  // browser callback, even when two polls began within the same millisecond.
  const deviceFlowEnc = sealPendingFlow(userId, { redirectUri: "", scopes, codeVerifier: randomToken(), nonce: randomToken() });
  const deviceWhere: Prisma.M365ConnectionWhereInput = { userId, state: "PENDING_CONSENT", pendingStateHash: null,
    pendingFlowEnc: deviceFlowEnc, pendingFlowExpiresAt: expiresAt };

  // An authorization-code attempt left open in another tab is superseded:
  // its hash and sealed flow go, so its callback can no longer claim the row.
  // A link already on the row goes too, as in beginAuthCodeConnect.
  const pending = {
    state: "PENDING_CONSENT" as const,
    ...NO_ACCOUNT,
    appClientId: app.clientId,
    appTenantId: app.tenantId,
    pendingStateHash: null,
    pendingFlowEnc: deviceFlowEnc,
    pendingFlowExpiresAt: expiresAt,
    lastError: null,
  };
  await prisma.m365Connection.upsert({
    where: { userId },
    create: { userId, ...pending },
    update: pending,
  });

  return await new Promise<DeviceCodeInfo>((resolve, reject) => {
    let handedBack = false;

    const completion = entra.acquireByDeviceCode(app, {
      scopes,
      onCode: (info) => {
        handedBack = true;
        resolve(info);
      },
    });

    completion
      .then(async (result) => {
        await persistConnected(prisma, userId, app, result, new Date(), deviceWhere);
      })
      .catch(async (err: unknown) => {
        await settleConnectFailure(prisma, userId, err, deviceWhere);
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
 *
 * `app` is the registration THIS sign-in went through, not whatever the row
 * says now: a newer sign-in may have replaced it.
 */
async function persistConnected(
  prisma: PrismaClient,
  userId: string,
  app: EntraAppRegistration,
  result: EntraAuthResult,
  now: Date = new Date(),
  expectedFlow?: Prisma.M365ConnectionWhereInput,
): Promise<"connected" | "cancelled" | "different_account"> {
  const linkHash = cursorLinkHash(app, result);
  const outcome = await prisma.$transaction(async (tx) => {
  const flowGuard = { ...expectedFlow, userId, state: "PENDING_CONSENT" as const };
  // Serialize completion with another consent flow, OFF, disconnect and leaver
  // cleanup before reading or deleting anything that belonged to this link.
  const locked = await tx.m365Connection.updateMany({ where: flowGuard, data: { state: "PENDING_CONSENT" } });
  if (locked.count !== 1) return "cancelled" as const;
  const person = await tx.user.findFirst({ where: { id: userId, directoryStatus: "ACTIVE", deletionStatus: "NONE" }, select: { id: true } });
  if (!person) return "cancelled" as const;

  // WARP-3059 (#2347 review) — a sign-in as someone else does not inherit the
  // cursors on file. Reconnecting is the ordinary recovery path and never
  // passes through disconnect(), so this is where they go. BEFORE the row
  // turns CONNECTED, because that is what makes them claimable: purging after
  // would leave a window for a tick to replay the old account's positions
  // with the new account's token. Only for the sign-in the row is still
  // waiting on: one that lost its race writes nothing below, and must not
  // purge the winner's cursors either.
  const prior = (await tx.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  if (!prior || prior.state !== "PENDING_CONSENT") return "cancelled";
  const relinked = prior?.state === "PENDING_CONSENT" && prior.cursorLinkHash !== linkHash;
  if (relinked && prior?.calendarSourceId) {
    const rejected = await tx.m365Connection.updateMany({ where: { ...flowGuard, calendarEnabled: true, calendarSourceId: prior.calendarSourceId }, data: {
      state: "ERROR", calendarSyncState: "NEEDS_RECONNECT", pendingStateHash: null, pendingFlowEnc: null,
      pendingFlowExpiresAt: null, lastError: "Your copied Outlook calendar was kept. Disconnect Outlook before linking a different Microsoft account.",
    } });
    return rejected.count ? "different_account" : "cancelled";
  }
  if (relinked) {
    await tx.m365DeltaCursor.deleteMany({ where: { userId } });
    // WARP-3538 (ADR-041 §4) — and the files LANDED from the old account: a
    // person who signs in as somebody else must not search the previous
    // account's file names, and nothing else would ever remove them (the new
    // account's sweep only covers drives it reads). After the cursors, like
    // disconnect: a failure here leaves rows nothing refreshes, never a cursor
    // still reading for the wrong account.
    await purgeM365FileDataForUser(tx, userId);
  }

  const { count } = await tx.m365Connection.updateMany({
    where: flowGuard,
    data: {
      state: "CONNECTED",
      cursorLinkHash: linkHash,
      // The cap count belongs to the old account's libraries; the new account's
      // first complete discovery writes its own. (The opt-in itself is the
      // person's choice at the moment they pressed Connect and is kept: the
      // scopes this sign-in asked for were decided from it.)
      ...(relinked ? { sharePointLibrariesCapped: 0 } : {}),
      homeAccountId: result.homeAccountId,
      tenantId: result.tenantId,
      accountUpn: result.accountUpn,
      grantedScopes: result.grantedScopes,
      tokenCacheEnc: sealTokenCache(userId, result.serializedCache),
      pendingStateHash: null,
      pendingFlowEnc: null,
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
    if (prior?.calendarEnabled === true && prior.calendarSourceId) await tx.m365Connection.updateMany({
      where: { userId, state: "CONNECTED", cursorLinkHash: linkHash, calendarEnabled: true, calendarSourceId: prior.calendarSourceId },
      data: { calendarSyncState: grantCovers(result.grantedScopes.split(/\s+/), GRAPH_RESOURCES.calendar.leastPrivilegeScope) ? "WAITING" : "NEEDS_RECONNECT" },
    });
  }
  return count > 0 ? "connected" as const : "cancelled" as const;
  });
  if (outcome === "connected") {
    await auditM365({
      what: "Microsoft 365 connected",
      state: "CONNECTED",
      userId,
      severity: "info",
      userInitiated: true,
    });
  }
  return outcome;
}

/**
 * Record a failed authentication in the state the person can act on.
 *
 * The classification is the whole point: a dead grant is routine and asks for
 * a new sign-in; a rejected app registration or a tenant policy block is ours
 * to fix and must not loop the customer through a flow that cannot succeed.
 */
async function persistFailure(
  prisma: Pick<PrismaClient, "m365Connection">,
  userId: string,
  err: unknown,
  expected?: { where: Prisma.M365ConnectionWhereInput; calendarEnabled: boolean },
): Promise<void> {
  const failure = (err ?? {}) as EntraFailureLike;
  const kind = classifyAuthFailure(failure);

  // A wobble must not touch a healthy connection. ERROR is terminal by its own
  // definition and the sync engine skips rows in it, so downgrading on a
  // thirty-second WAN outage would stop syncing permanently and silently.
  // Record the reason for support; leave the state alone.
  if (kind === "TRANSIENT") {
    await prisma.m365Connection.updateMany({
      where: expected?.where ?? { userId },
      data: { lastError: redactAuthError(failure) },
    });
    return;
  }

  // The person closed the tab or pressed Cancel. Nothing failed; put the
  // connection back where it started so they can simply try again. Only a
  // sign-in still in flight: a device-code poll that lapses after the person
  // finished in the browser instead must not unlink what they just made.
  if (kind === "ABANDONED") {
    if (expected) return;
    await prisma.m365Connection.updateMany({ where: { userId, state: "PENDING_CONSENT" }, data: { ...UNLINKED, lastError: null } });
    return;
  }

  await prisma.m365Connection.updateMany({
    where: expected?.where ?? { userId },
    data: {
      state: kind,
      pendingStateHash: null,
      pendingFlowEnc: null,
      pendingFlowExpiresAt: null,
      lastError: redactAuthError(failure),
      ...(expected?.calendarEnabled ? { calendarSyncState: kind === "NEEDS_RECONNECT" ? "NEEDS_RECONNECT" as const : "ERROR" as const } : {}),
    },
  });
  if (!expected) await prisma.m365Connection.updateMany({ where: { userId, calendarEnabled: true }, data: { calendarSyncState: kind === "NEEDS_RECONNECT" ? "NEEDS_RECONNECT" : "ERROR" } });
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
  generation?: M365GrantGeneration,
): Promise<void> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  if (!row || row.state !== "CONNECTED") return;

  const changed = await prisma.m365Connection.updateMany({
    where: generation ? grantGenerationWhere(userId, generation) : grantGenerationWhere(userId, row),
    data: { state: "NEEDS_RECONNECT", lastError: reason,
      ...(row.calendarEnabled === true ? { calendarSyncState: "NEEDS_RECONNECT" as const } : {}) },
  });
  if (changed.count !== 1) return;
  await auditM365({
    what: "Microsoft 365 needs reconnect",
    state: "NEEDS_RECONNECT",
    userId,
    severity: "warn",
    reason,
    userInitiated: false,
  });
}

// --- The SharePoint switch ------------------------------------------------

/** What `setSharePointEnabled` did. */
export type SharePointSwitchResult =
  | {
      ok: true;
      /** True when the person's choice actually changed; false for a repeat. */
      changed: boolean;
      /** The connection as it is AFTER the change — what the card should now show. */
      view: M365ConnectionView;
    }
  /** Turning it ON needs a CONNECTED account to ask for the scope on. */
  | { ok: false; reason: "not_connected" };

/**
 * WARP-3538 — the person's own SharePoint switch.
 *
 * ## On
 *
 * Records the choice on a connection that exists and is CONNECTED. It asks
 * Microsoft for nothing and reads nothing by itself: the NEXT sign-in requests
 * `Sites.Read.All` (`scopesForSignIn`), and until the grant holds it the view
 * says `needsConsent` and discovery reports SharePoint `notGranted`. Refused
 * unless CONNECTED — a person cannot opt in before they have an account to ask
 * the scope on, and a disconnect resets the choice precisely so that a later
 * sign-in is never asked for a scope nobody asked for (`disconnect`).
 *
 * The write is CONDITIONAL on the row still being CONNECTED. A disconnect that
 * lands between the read and the write would otherwise be undone into "SharePoint
 * on" for an account that is gone — and the next sign-in would ask a tenant for a
 * scope that was never requested. A write that matched nothing is the same
 * refusal.
 *
 * ## Off
 *
 * Is the deletion the confirmation dialog promised — "Droplet deletes the list of
 * SharePoint files it kept and stops reading them" — and so is ONE transaction:
 * the flag, the cap count, the SharePoint cursors, the library rows and the landed
 * SharePoint items go together or not at all. Half of it would be the worst case:
 * the person told it is off while the list is still searchable, or the list gone
 * while discovery carries on re-reading. OneDrive's cursor, source and items,
 * every other workload and every other person are untouched
 * (`purgeSharePointDataForUser`).
 *
 * Off is never refused, whatever state the connection is in, and it is
 * idempotent AND repairing: pressed again — or after a discovery that was already
 * running re-created a library — it removes whatever is there, and says nothing
 * to the log when nothing about the person's choice changed.
 *
 * Both directions are audited as the other lifecycle events are (`auditM365`):
 * widening or narrowing what the box reads on a person's behalf belongs in the
 * log beside connect and disconnect.
 */
export async function setSharePointEnabled(
  prisma: PrismaClient,
  userId: string,
  enabled: boolean,
  now: Date = new Date(),
): Promise<SharePointSwitchResult> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;
  const was = row?.sharePointEnabled === true;

  if (enabled) {
    if (!row || row.state !== "CONNECTED") return { ok: false, reason: "not_connected" };
    if (!was) {
      const { count } = await prisma.m365Connection.updateMany({
        where: { userId, state: "CONNECTED" },
        data: { sharePointEnabled: true },
      });
      if (count === 0) return { ok: false, reason: "not_connected" };
      await auditM365({
        what: "Microsoft 365 SharePoint turned on",
        state: "CONNECTED",
        userId,
        severity: "info",
        userInitiated: true,
      });
    }
  } else {
    await prisma.$transaction(async (tx) => {
      await tx.m365Connection.updateMany({
        where: { userId },
        data: { sharePointEnabled: false, sharePointLibrariesCapped: 0 },
      });
      await purgeSharePointDataForUser(tx, userId);
    });
    if (was) {
      await auditM365({
        what: "Microsoft 365 SharePoint turned off",
        state: toView(row!, now).state,
        userId,
        severity: "info",
        userInitiated: true,
      });
    }
  }

  return { ok: true, changed: enabled !== was, view: await getConnectionView(prisma, userId, now) };
}

// --- Disconnect -----------------------------------------------------------

/** The person's calendar preference. ON asks Microsoft for no additional permissions. */
export async function setCalendarEnabled(prisma: PrismaClient, userId: string, enabled: boolean) {
  const before = await prisma.m365Connection.findUnique({ where: { userId } });
  if (!await setMicrosoftCalendarEnabled(prisma, userId, enabled)) return { ok: false as const, reason: "not_connected" as const };
  if (enabled !== (before?.calendarEnabled === true)) await auditM365({
    what: enabled ? "Outlook calendar turned on" : "Outlook calendar turned off",
    state: (before?.state ?? "DISCONNECTED") as M365State, userId, severity: "info", userInitiated: true,
  });
  return { ok: true as const, view: await getConnectionView(prisma, userId) };
}

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

  const unlink = async (tx: Pick<PrismaClient, "m365Connection">) => tx.m365Connection.update({
    where: { userId },
    data: {
      ...UNLINKED,
      lastError: null,
      // WARP-3538 — disconnect is a clean slate, including the SharePoint
      // choice: the person who reconnects next month is asked for the base set
      // only until they say otherwise, because a scope they did not ask for can
      // fail the whole sign-in (see `scopes.ts`). Reset HERE and not in UNLINKED:
      // that constant also describes a sign-in that was merely cancelled, which
      // must not undo a choice the person made.
      sharePointEnabled: false,
      sharePointLibrariesCapped: 0,
      // The cursors go below, so nothing is left for this to name. A cursor a
      // discovery already running re-creates after the purge is then unowned,
      // and the next sign-in purges it rather than adopting it.
      cursorLinkHash: null,
      // appClientId / appTenantId are kept on purpose (WARP-2705): they are
      // configuration, not a credential, and they make reconnecting one click.
    },
  });
  // Always take the connection lock before inspecting the source. A calendar
  // opt-in may have committed after the pre-read above; that source goes too.
  await prisma.$transaction(async (tx) => { await purgeMicrosoftCalendar(tx, userId); await unlink(tx); });

  // WARP-3059 — and the sync positions. A delta link is the OLD account's
  // position: replayed after reconnecting as a different account it is wrong,
  // and left in place it is claimed and failed on every tick. After the
  // credential purge, so a failure here can only leave residue, never a token.
  await purgeCursorsForUser(prisma, userId);

  // WARP-3538 (ADR-041 §4: "deletion is a real operation") — and the files that
  // were landed: the person's OneDrive and SharePoint file lists and the sources
  // that name them. After the cursors, so a failure here leaves rows nothing will
  // refresh rather than a cursor still reading for a person who has left.
  await purgeM365FileDataForUser(prisma, userId);

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
  const { count } = await prisma.$transaction(async (tx) => {
    await purgeMicrosoftCalendar(tx, userId);
    return tx.m365Connection.deleteMany({ where: { userId } });
  });
  // WARP-3059 — the deleted person's sync positions go with them. Second, so a
  // failure here leaves residue rather than a live refresh token.
  await purgeCursorsForUser(prisma, userId);
  // WARP-3538 — and the file names landed from their Microsoft 365: a leaver's
  // OneDrive file list must not outlive them in a table nobody can reach
  // through the API.
  await purgeM365FileDataForUser(prisma, userId);
  return count;
}

// --- Token acquisition ----------------------------------------------------

function grantGenerationWhere(userId: string, generation: M365GrantGeneration): Prisma.M365ConnectionWhereInput {
  return { userId, state: "CONNECTED", tokenCacheEnc: generation.tokenCacheEnc,
    cursorLinkHash: generation.cursorLinkHash, connectedAt: generation.connectedAt,
    calendarEnabled: generation.calendarEnabled, calendarSourceId: generation.calendarSourceId };
}

class M365GrantChangedError extends Error {
  constructor() { super("The Microsoft connection changed. Try again."); this.name = "M365GrantChangedError"; }
}

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
  onGrant?: (generation: M365GrantGeneration) => void,
): Promise<string> {
  const row = (await prisma.m365Connection.findUnique({
    where: { userId },
  })) as ConnectionRow | null;

  if (!row || row.state !== "CONNECTED" || !row.tokenCacheEnc || !row.homeAccountId) {
    throw new M365NotConnectedError(row?.state ?? "DISCONNECTED");
  }
  const expected = grantGenerationWhere(userId, row);

  // An unreadable cache is expected after a factory reset regenerates
  // DEVICE_SECRET_KEY: the rows survive, the key does not. That is a
  // reconnect, not a crash — and not an ERROR the person cannot act on.
  let cache: string;
  try {
    cache = unsealTokenCache(userId, row.tokenCacheEnc);
  } catch {
    const changed = await prisma.m365Connection.updateMany({
      where: expected,
      data: {
        state: "NEEDS_RECONNECT",
        ...(row.calendarEnabled === true ? { calendarSyncState: "NEEDS_RECONNECT" as const } : {}),
        tokenCacheEnc: null,
        // WARP-3538 — the key that sealed this person's LANDED file names is the
        // same one that just failed to open their token (DEVICE_SECRET_KEY,
        // regenerated by a factory reset that kept the rows). Those rows can never
        // be read again, and the cursors would carry on landing only what changes
        // from here. Forgetting which link the cursors belong to makes the
        // reconnect count as "a different account" (NULL means "not known"), so
        // it purges the cursors and the unreadable files and re-lands everything
        // under the new key — the re-sync that makes dropping the data safe.
        cursorLinkHash: null,
        lastError: "The stored Microsoft sign-in could not be read. Please connect again.",
      },
    });
    if (changed.count !== 1) throw new M365GrantChangedError();
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

  // WARP-2705 — only a link made before per-connection apps can lack one. Its
  // tokens belong to an app the box no longer names, so it cannot refresh:
  // that is a reconnect, said plainly, not an ERROR and not a crash.
  const app = storedApp(row);
  if (!app) {
    const reason =
      "This Microsoft 365 link was made before Droplet used your organisation's own app. Please connect again.";
    const changed = await prisma.m365Connection.updateMany({
      where: expected,
      data: { state: "NEEDS_RECONNECT", lastError: reason, ...(row.calendarEnabled === true ? { calendarSyncState: "NEEDS_RECONNECT" as const } : {}) },
    });
    if (changed.count !== 1) throw new M365GrantChangedError();
    await auditM365({
      what: "Microsoft 365 needs reconnect",
      state: "NEEDS_RECONNECT",
      userId,
      severity: "warn",
      reason,
      userInitiated: false,
    });
    throw new M365NotConnectedError("NEEDS_RECONNECT");
  }

  let result: EntraAuthResult;
  try {
    // 🔴 Only what this connection already HOLDS (WARP-3538, see `scopes.ts`): a
    // person who turned SharePoint on after connecting has not consented to
    // Sites.Read.All yet, and a refresh that asked for it would fail into
    // NEEDS_RECONNECT — a healthy connection broken by a switch.
    result = await entra.acquireSilent(app, cache, row.homeAccountId, scopesForRefresh(row.grantedScopes));
  } catch (err) {
    await persistFailure(prisma, userId, err, { where: expected, calendarEnabled: row.calendarEnabled === true });
    // SDK failures can carry response or credential material. The stored
    // status is redacted; callers receive a fixed message as well.
    throw new Error("Microsoft 365 could not refresh this account. Try again or reconnect.");
  }

  const tokenCacheEnc = sealTokenCache(userId, result.serializedCache);
  const changed = await prisma.$transaction(async (tx) => {
  const updated = await tx.m365Connection.updateMany({
    where: expected,
    data: {
      state: "CONNECTED",
      // MSAL rotates the refresh token on use, so the cache must be re-sealed
      // every time or the next refresh replays a superseded token.
      tokenCacheEnc,
      grantedScopes: result.grantedScopes,
      ...(row.calendarEnabled === true && !grantCovers(result.grantedScopes.split(/\s+/), GRAPH_RESOURCES.calendar.leastPrivilegeScope)
        ? { calendarSyncState: "NEEDS_RECONNECT" as const } : {}),
      lastRefreshOkAt: now,
      lastError: null,
    },
  });
  if (updated.count === 1 && !await tx.user.findFirst({ where: { id: userId, directoryStatus: "ACTIVE", deletionStatus: "NONE" }, select: { id: true } })) throw new M365GrantChangedError();
  return updated;
  });
  if (changed.count !== 1) throw new M365GrantChangedError();

  if (!result.accessToken) {
    throw new M365NotConnectedError("ERROR");
  }
  onGrant?.({ tokenCacheEnc, cursorLinkHash: row.cursorLinkHash, connectedAt: row.connectedAt,
    calendarEnabled: row.calendarEnabled, calendarSourceId: row.calendarSourceId });
  return result.accessToken;
}
