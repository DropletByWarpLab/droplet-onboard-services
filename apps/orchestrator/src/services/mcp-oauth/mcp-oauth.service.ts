/**
 * WARP-2405 / WARP-2401 — web sign-in (OAuth 2.1 + PKCE) for a remote MCP server.
 *
 * The box is the OAuth client. The bridge makes every outbound hop (discovery,
 * client registration, code exchange, refresh) through its DNS-pinned fetch;
 * this module owns the flow state, the identity ladder, the two checks the MCP
 * SDK omits (single-use CSRF `state` and the RFC 9207 `iss` compare) and the
 * sealed per-owner token store (`McpOAuthConnection`, WARP-2409).
 *
 * Fail closed throughout: every refusal is a typed outcome, nothing from the
 * callback query becomes a destination or reflected text, and no code, state,
 * verifier, token or pasted URL is ever logged (rule 19).
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import { providerDescriptor, type McpSignIn } from "@droplet/shared-types";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { recordActivity } from "../activity.singleton.js";
import {
  decryptColumn,
  deriveMcpOAuthTokenKey,
  encryptColumn,
  mcpOAuthAad,
} from "../column-crypto.service.js";
import {
  McpBridgeError,
  McpBridgeOAuthClient,
  OAUTH_HOST_NOT_ALLOWED,
  OAUTH_PKCE_UNSUPPORTED,
  OAUTH_REFUSED,
  type McpOAuthDiscovery,
} from "../mcp-bridge.client.js";
import { remoteMcpEgressAllowed, type RemoteMcpEgressDecision, type RemoteMcpGatePrisma } from "../remote-mcp-gateway.service.js";

const logger = createLogger("mcp-oauth");

export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
export const MCP_OAUTH_FLOW_TTL_MS = 10 * 60_000;
/** Bound on in-flight sign-ins: a restart-scoped map must not grow without limit. */
const MAX_PENDING = 500;
const MAX_CODE_LEN = 2048;
const MAX_STATE_LEN = 128;
const MAX_PASTE_LEN = 4096;
/** Redirects registered with the authorization server alongside the box origin
 *  (RFC 8252 §7.3, port-agnostic): the fallback when it refuses the box origin. */
export const MCP_OAUTH_LOOPBACK_REDIRECTS = [
  `http://localhost${MCP_OAUTH_CALLBACK_PATH}`,
  `http://127.0.0.1${MCP_OAUTH_CALLBACK_PATH}`,
] as const;

export type McpOAuthScopeName = "MEMBER" | "WORKSPACE";
export type McpOAuthStateName = "DISCONNECTED" | "PENDING_CONSENT" | "CONNECTED" | "NEEDS_RECONNECT" | "ERROR";
/** The only things a callback can tell the browser. */
export type McpOAuthOutcome = "connected" | "cancelled" | "expired" | "failed" | "blocked";
const SIGN_IN_ROLES = ["owner", "admin", "family"] as const;
const ADMIN_ROLES = ["owner", "admin"] as const;
const roleIn = (role: string | undefined, set: readonly string[]): boolean => !!role && set.includes(role);

export type McpOAuthErrorCode =
  | "unknown_provider"
  | "forbidden"
  | "acknowledge_required"
  | "pkce_unsupported"
  | "host_not_allowed"
  // The same pre-credential rules every remote MCP call obeys (remoteMcpEgressAllowed).
  | "remote_mcp_off"
  | "server_not_allowed"
  | "connection_disabled"
  | "client_required"
  | "too_many_pending"
  | "sign_in_unavailable"
  | "bare_code_rejected"
  | "invalid_redirect_url";

const ERROR_STATUS: Record<McpOAuthErrorCode, number> = {
  unknown_provider: 404,
  forbidden: 403,
  acknowledge_required: 400,
  pkce_unsupported: 400,
  host_not_allowed: 422,
  remote_mcp_off: 409,
  server_not_allowed: 409,
  connection_disabled: 409,
  client_required: 400,
  too_many_pending: 503,
  sign_in_unavailable: 503,
  bare_code_rejected: 400,
  invalid_redirect_url: 400,
};

export class McpOAuthError extends Error {
  readonly status: number;
  constructor(readonly code: McpOAuthErrorCode, message: string) {
    super(message);
    this.name = "McpOAuthError";
    this.status = ERROR_STATUS[code];
  }
}

interface PendingFlow {
  connectionId: string;
  provider: string;
  userId: string;
  scope: McpOAuthScopeName;
  codeVerifier: string;
  redirectUri: string;
  resource: string;
  issuer: string;
  /** RFC 9207: the callback MUST carry `iss` when the server advertised it. */
  issRequired: boolean;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  scopes: string;
  /** What the row was before consent began, restored if consent fails. */
  priorState: McpOAuthStateName;
  expiresAt: number;
}

export interface McpOAuthDependencies {
  oauth: Pick<McpBridgeOAuthClient, "discover" | "register" | "exchange" | "revoke">;
  now: () => Date;
  /** Closes a connection's live bridge session (sign-out). Best effort. */
  closeSession: (provider: string, connectionId: string) => Promise<void>;
  /**
   * The rules every remote MCP call obeys before it may reach the vendor (server
   * allowlist, `remote_mcp` channel, connection not DISABLED), applied before
   * EVERY OAuth hop so a switched-off box never talks to the vendor to sign in.
   */
  egress: (prisma: PrismaClient, serverId: string) => Promise<RemoteMcpEgressDecision>;
  /**
   * In-flight sign-ins, keyed by sha256(state).
   * ponytail: in memory; a restart mid-consent means the person tries again.
   * Upgrade to a sealed row column only if restarts mid-consent become common.
   */
  pending: Map<string, PendingFlow>;
}

/**
 * The bridge client, built on first use: routers are created at app start (and in
 * tests that never sign in), long before any hop needs the bridge's address.
 */
function lazyBridgeOAuthClient(): Pick<McpBridgeOAuthClient, "discover" | "register" | "exchange" | "refresh" | "revoke"> {
  let client: McpBridgeOAuthClient | null = null;
  const get = (): McpBridgeOAuthClient =>
    (client ??= new McpBridgeOAuthClient({ baseUrl: config.MCP_BRIDGE_URL, serviceToken: config.MCP_BRIDGE_SERVICE_TOKEN }));
  return {
    discover: (mcpUrl) => get().discover(mcpUrl),
    register: (endpoint, redirects) => get().register(endpoint, redirects),
    exchange: (input) => get().exchange(input),
    refresh: (input) => get().refresh(input),
    revoke: (input) => get().revoke(input),
  };
}

export function mcpOAuthDependencies(overrides: Partial<McpOAuthDependencies> = {}): McpOAuthDependencies {
  return {
    now: () => new Date(),
    pending: new Map(),
    // Lazy: the singleton pulls the whole MCP stack, which this module must not load with it.
    closeSession: async (provider, connectionId) => {
      const { closeRemoteConnectionSession } = await import("../mcp-client.singleton.js");
      await closeRemoteConnectionSession(provider, connectionId);
    },
    // Lazy import: remote-mcp-servers imports this module for its token reader.
    egress: async (prisma, serverId) => {
      const { parseRemoteMcpAllowlist } = await import("../remote-mcp-servers.js");
      return remoteMcpEgressAllowed(
        prisma as unknown as Pick<RemoteMcpGatePrisma, "offLanAllowlistChannel" | "integrationConnection">,
        serverId,
        parseRemoteMcpAllowlist(config.REMOTE_MCP_SERVER_ALLOWLIST),
      );
    },
    ...overrides,
    oauth: overrides.oauth ?? lazyBridgeOAuthClient(),
  };
}

const sha256hex = (v: string): string => createHash("sha256").update(v).digest("hex");
const b64url = (b: Buffer): string => b.toString("base64url");

/** Timing-safe string equality that never throws on a length difference. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

/** Refuses (409, a fixed code) when the box may not talk to this server right now. */
async function requireEgress(prisma: PrismaClient, deps: McpOAuthDependencies, serverId: string): Promise<void> {
  let decision: RemoteMcpEgressDecision;
  try {
    decision = await deps.egress(prisma, serverId);
  } catch {
    throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
  }
  if (decision.allowed) return;
  switch (decision.reason) {
    case "channel_disabled":
      throw new McpOAuthError("remote_mcp_off", "Remote MCP is switched off by the owner. Nothing was sent.");
    case "server_not_allowlisted":
      throw new McpOAuthError("server_not_allowed", "This server is not enabled on this box. Nothing was sent.");
    case "connection_disabled":
      throw new McpOAuthError("connection_disabled", decision.message);
    default:
      throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
  }
}

function signInFor(provider: string): { displayName: string; signIn: McpSignIn } {
  const d = providerDescriptor(provider);
  if (!d || d.track !== "mcp" || d.signIn?.kind !== "oauth") {
    throw new McpOAuthError("unknown_provider", "That service does not offer web sign-in.");
  }
  return { displayName: d.displayName, signIn: d.signIn };
}

/** An authorization-server URL we will send a browser or a code to: https, no userinfo. */
function httpsUrl(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && !u.username && !u.password && !u.hash ? u : null;
  } catch {
    return null;
  }
}

// ─── token store ─────────────────────────────────────────────────────────────

export interface McpOAuthTokenBlob {
  accessToken: string;
  refreshToken: string | null;
  /** ISO time the access token stops working. */
  expiresAt: string;
  scope: string;
  tokenEndpoint: string;
  /** The server's RFC 7009 endpoint when its metadata advertised one. */
  revocationEndpoint?: string;
  resource: string;
  mcpUrl: string;
}
export interface McpOAuthOwnerRow {
  id: string;
  scope: McpOAuthScopeName;
  memberId: string | null;
}

export function sealTokens(row: McpOAuthOwnerRow, blob: McpOAuthTokenBlob): string {
  return encryptColumn(deriveMcpOAuthTokenKey(), JSON.stringify(blob), mcpOAuthAad(row));
}

/** Opens a row's tokens; throws (fail closed) on a blob that is not this row's. */
export function openTokens(row: McpOAuthOwnerRow & { tokensEnc: string | null }): McpOAuthTokenBlob {
  if (!row.tokensEnc) throw new Error("mcp-oauth: row holds no tokens");
  const b = JSON.parse(decryptColumn(deriveMcpOAuthTokenKey(), row.tokensEnc, mcpOAuthAad(row))) as McpOAuthTokenBlob;
  if (typeof b.accessToken !== "string" || !b.accessToken) throw new Error("mcp-oauth: malformed token blob");
  return b;
}

const sealSecret = (row: McpOAuthOwnerRow, secret: string): string =>
  encryptColumn(deriveMcpOAuthTokenKey(), secret, mcpOAuthAad(row));
const openSecret = (row: McpOAuthOwnerRow & { clientSecretEnc: string | null }): string | undefined =>
  row.clientSecretEnc ? decryptColumn(deriveMcpOAuthTokenKey(), row.clientSecretEnc, mcpOAuthAad(row)) : undefined;

// ─── begin ───────────────────────────────────────────────────────────────────

export interface BeginInput {
  provider: string;
  scope: McpOAuthScopeName;
  userId: string;
  username: string;
  role: string | undefined;
  acknowledge?: boolean;
  /** `<trusted origin>/api/mcp/oauth/callback`, built by the route. */
  originCallback: string;
  redirectMode?: "origin" | "loopback";
}
export interface BeginResult {
  authorizeUrl: string;
  state: string;
  expiresAt: string;
  redirectUri: string;
}

function prunePending(deps: McpOAuthDependencies): void {
  const now = deps.now().getTime();
  for (const [k, v] of deps.pending) if (v.expiresAt <= now) deps.pending.delete(k);
}

export async function beginMcpSignIn(
  prisma: PrismaClient,
  input: BeginInput,
  deps: McpOAuthDependencies,
): Promise<BeginResult> {
  const { signIn } = signInFor(input.provider);
  // Authorisation lives here as well as on the route: WORKSPACE is an admin's
  // explicit, acknowledged choice; MEMBER is for people, never guests/services.
  if (input.scope === "WORKSPACE") {
    if (!roleIn(input.role, ADMIN_ROLES)) throw new McpOAuthError("forbidden", "Only an owner or admin can create a Workspace connection.");
    if (input.acknowledge !== true) throw new McpOAuthError("acknowledge_required", "Confirm that everyone allowed to use this server acts as this account.");
  } else if (!roleIn(input.role, SIGN_IN_ROLES)) {
    throw new McpOAuthError("forbidden", "Your role cannot sign in to this service.");
  }
  // Before discovery and registration, the first hops that dial the vendor.
  await requireEgress(prisma, deps, input.provider);
  prunePending(deps);
  if (deps.pending.size >= MAX_PENDING) throw new McpOAuthError("too_many_pending", "Too many sign-ins are in progress. Try again shortly.");

  let disc: McpOAuthDiscovery;
  try {
    disc = await deps.oauth.discover(signIn.mcpUrl);
  } catch (err) {
    if (err instanceof McpBridgeError && err.code === OAUTH_PKCE_UNSUPPORTED) {
      throw new McpOAuthError("pkce_unsupported", "This service's sign-in does not support PKCE S256, so Droplet will not use it.");
    }
    if (err instanceof McpBridgeError && err.code === OAUTH_REFUSED && err.reason === OAUTH_HOST_NOT_ALLOWED) {
      throw new McpOAuthError("host_not_allowed", "This service's sign-in uses a host Droplet does not allow.");
    }
    logger.warn({ provider: input.provider, reason: err instanceof McpBridgeError ? err.reason : undefined }, "mcp_oauth_discovery_failed");
    throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
  }
  // The bridge vetted these; the box re-checks what it is about to act on.
  const authorize = httpsUrl(disc.authorizationEndpoint);
  const token = httpsUrl(disc.tokenEndpoint);
  if (disc.resource !== signIn.mcpUrl || !authorize || !token || !httpsUrl(disc.issuer)) {
    logger.warn({ provider: input.provider }, "mcp_oauth_discovery_rejected");
    throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
  }

  const ownerWhere: Prisma.McpOAuthConnectionWhereInput =
    input.scope === "MEMBER"
      ? { provider: input.provider, scope: "MEMBER", memberId: input.userId }
      : { provider: input.provider, scope: "WORKSPACE" };
  const existing = await prisma.mcpOAuthConnection.findFirst({ where: ownerWhere });
  const id = existing?.id ?? randomUUID();
  const owner: McpOAuthOwnerRow = { id, scope: input.scope, memberId: input.scope === "MEMBER" ? input.userId : null };

  // Client identity ladder (ADR-072 §2, WARP-2401), in this order:
  //  1. a client already held for this provider AND issuer: pasted by an admin
  //     (PATCH /mcp/oauth/client) or registered earlier. Keyed by issuer and
  //     never reused across servers (SEP-2352).
  //  2. CIMD: skipped in v1 (ADR-072 §10: the box hosts no client document).
  //  3. dynamic client registration.
  // No fleet-wide Warp Lab client identity exists on any box.
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  const held = await prisma.mcpOAuthConnection.findFirst({
    where: { provider: input.provider, issuer: disc.issuer, clientId: { not: null } },
    orderBy: { createdAt: "asc" },
  });
  if (held?.clientId) {
    clientId = held.clientId;
    try {
      clientSecret = openSecret(held);
    } catch {
      // A stored secret that no longer opens is a broken registration, not a reason to register another.
      logger.warn({ provider: input.provider }, "mcp_oauth_client_secret_unreadable");
      throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
    }
  } else {
    logger.info({ provider: input.provider }, "cimd_unsupported_v1");
    if (!disc.registrationEndpoint) {
      throw new McpOAuthError("client_required", "This service needs an OAuth client id. Ask an administrator to enter one.");
    }
    try {
      // DCR is deprecated by the MCP spec revision 2026-07-28 in favour of CIMD.
      // It stays a fallback rung, not the main path: do not promote it.
      const reg = await deps.oauth.register(disc.registrationEndpoint, [input.originCallback, ...MCP_OAUTH_LOOPBACK_REDIRECTS]);
      clientId = reg.clientId;
      clientSecret = reg.clientSecret;
    } catch {
      logger.warn({ provider: input.provider }, "mcp_oauth_registration_failed");
      throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
    }
  }

  const priorState: McpOAuthStateName = existing
    ? existing.state === "PENDING_CONSENT"
      ? existing.tokensEnc ? "CONNECTED" : "DISCONNECTED"
      : existing.state
    : "DISCONNECTED";
  const now = deps.now();
  const fields = {
    state: "PENDING_CONSENT" as const,
    issuer: disc.issuer,
    tokenEndpointHost: token.host,
    clientId,
    clientSecretEnc: clientSecret ? sealSecret(owner, clientSecret) : null,
    lastError: null,
    ...(input.scope === "WORKSPACE" ? { workspaceAckAt: now, workspaceAckBy: input.username } : {}),
  };
  try {
    // Existing tokens are kept while re-consenting (a cancelled consent restores the prior state).
    if (existing) await prisma.mcpOAuthConnection.update({ where: { id }, data: fields });
    else await prisma.mcpOAuthConnection.create({ data: { id, provider: input.provider, scope: input.scope, memberId: owner.memberId, ...fields } });
  } catch {
    logger.warn({ provider: input.provider }, "mcp_oauth_row_write_failed");
    throw new McpOAuthError("sign_in_unavailable", "Sign-in could not be started. Try again shortly.");
  }

  for (const [k, v] of deps.pending) if (v.connectionId === id) deps.pending.delete(k);
  const state = b64url(randomBytes(32));
  const codeVerifier = b64url(randomBytes(48));
  const redirectUri = input.redirectMode === "loopback" ? MCP_OAUTH_LOOPBACK_REDIRECTS[1] : input.originCallback;
  const scopes = signIn.scopes.join(" ");
  const expiresAt = now.getTime() + MCP_OAUTH_FLOW_TTL_MS;
  deps.pending.set(sha256hex(state), {
    connectionId: id, provider: input.provider, userId: input.userId, scope: input.scope, codeVerifier, redirectUri,
    resource: signIn.mcpUrl, issuer: disc.issuer, issRequired: disc.issParameterSupported, tokenEndpoint: disc.tokenEndpoint,
    ...(disc.revocationEndpoint ? { revocationEndpoint: disc.revocationEndpoint } : {}),
    scopes, priorState, expiresAt,
  });

  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", b64url(createHash("sha256").update(codeVerifier).digest()));
  authorize.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: the resource on the authorize request, and again on the token request.
  authorize.searchParams.set("resource", signIn.mcpUrl);
  return { authorizeUrl: authorize.toString(), state, expiresAt: new Date(expiresAt).toISOString(), redirectUri };
}

// ─── complete ────────────────────────────────────────────────────────────────

export interface CompleteInput {
  state: string | null;
  code: string | null;
  error: string | null;
  iss: string | null;
  /** Callback route: the browser's state cookie. Paste route: null. */
  browserState: string | null;
  /** Paste route: the signed-in caller. Callback route: null (the flow is the identity). */
  caller: { id: string; role: string | undefined } | null;
}
export interface CompleteResult {
  outcome: McpOAuthOutcome;
  /** Known only once the flow was claimed. */
  provider: string | null;
  scope: McpOAuthScopeName | null;
}

const FAILED: CompleteResult = { outcome: "failed", provider: null, scope: null };

async function settleFailure(prisma: PrismaClient, flow: PendingFlow, lastError: string | null): Promise<void> {
  try {
    await prisma.mcpOAuthConnection.updateMany({
      where: { id: flow.connectionId, state: "PENDING_CONSENT" },
      data: { state: flow.priorState, lastError },
    });
  } catch {
    logger.warn({ provider: flow.provider }, "mcp_oauth_restore_failed");
  }
}

export async function completeMcpSignIn(
  prisma: PrismaClient,
  input: CompleteInput,
  deps: McpOAuthDependencies,
): Promise<CompleteResult> {
  const { state } = input;
  if (typeof state !== "string" || state.length === 0 || state.length > MAX_STATE_LEN) return FAILED;
  if (input.caller === null) {
    // Callback: the browser that started the flow must be the one finishing it.
    if (typeof input.browserState !== "string" || !safeEqual(input.browserState, state)) return FAILED;
  }
  // Single use: claimed and deleted on first sight, valid or not.
  const key = sha256hex(state);
  const flow = deps.pending.get(key);
  deps.pending.delete(key);
  if (!flow) return FAILED;
  const result = (outcome: McpOAuthOutcome): CompleteResult => ({ outcome, provider: flow.provider, scope: flow.scope });
  if (flow.expiresAt <= deps.now().getTime()) {
    await settleFailure(prisma, flow, null);
    return result("expired");
  }
  if (input.caller !== null) {
    // Paste: only the person who started it, and a WORKSPACE sign-in only while still an admin.
    const ok = input.caller.id === flow.userId && (flow.scope === "MEMBER" || roleIn(input.caller.role, ADMIN_ROLES));
    if (!ok) { await settleFailure(prisma, flow, null); return result("failed"); }
  }
  // RFC 9207: compared before anything else in the response is honoured.
  if (input.iss !== null && input.iss !== flow.issuer) { await settleFailure(prisma, flow, "sign_in_failed"); return result("failed"); }
  if (flow.issRequired && input.iss === null) { await settleFailure(prisma, flow, "sign_in_failed"); return result("failed"); }
  if (input.error !== null) {
    await settleFailure(prisma, flow, null);
    return result(input.error === "access_denied" ? "cancelled" : "failed");
  }
  const code = input.code;
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_CODE_LEN) { await settleFailure(prisma, flow, "sign_in_failed"); return result("failed"); }

  const row = await prisma.mcpOAuthConnection.findUnique({ where: { id: flow.connectionId } });
  const ownerOk = !!row && row.provider === flow.provider && row.state === "PENDING_CONSENT" && row.scope === flow.scope &&
    (flow.scope === "MEMBER" ? row.memberId === flow.userId : row.memberId === null);
  if (!row || !ownerOk || !row.clientId) { await settleFailure(prisma, flow, "sign_in_failed"); return result("failed"); }

  // The exchange hands the vendor a code: only while remote MCP may talk to it. A
  // refusal has already burned the state above and leaves the row as it was.
  let egress: RemoteMcpEgressDecision;
  try {
    egress = await deps.egress(prisma, flow.provider);
  } catch {
    egress = { allowed: false, reason: "gate_unavailable", message: "" };
  }
  if (!egress.allowed) { await settleFailure(prisma, flow, null); return result("blocked"); }

  const now = deps.now();
  try {
    const tokens = await deps.oauth.exchange({
      tokenEndpoint: flow.tokenEndpoint,
      clientId: row.clientId,
      ...(openSecret(row) ? { clientSecret: openSecret(row) } : {}),
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      resource: flow.resource,
    });
    const expiresAt = new Date(now.getTime() + tokenTtlSeconds(tokens.expiresIn) * 1000);
    const tokensEnc = sealTokens(row, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken ?? null,
      expiresAt: expiresAt.toISOString(),
      // Stored as granted. The box never asked for more than the descriptor's set.
      scope: tokens.scope ?? flow.scopes,
      tokenEndpoint: flow.tokenEndpoint,
      ...(flow.revocationEndpoint ? { revocationEndpoint: flow.revocationEndpoint } : {}),
      resource: flow.resource,
      mcpUrl: flow.resource,
    });
    const written = await prisma.mcpOAuthConnection.updateMany({
      where: { id: row.id, state: "PENDING_CONSENT" },
      data: { tokensEnc, state: "CONNECTED", connectedAt: now, lastRefreshOkAt: now, tokenExpiresAt: expiresAt, lastError: null },
    });
    if (written.count !== 1) return result("failed");
  } catch {
    logger.warn({ provider: flow.provider }, "mcp_oauth_exchange_failed");
    await settleFailure(prisma, flow, "sign_in_failed");
    return result("failed");
  }
  await audit(flow, "CONNECTED");
  return result("connected");
}

/**
 * Seconds an access token is good for, from the token response's `expires_in`.
 * ponytail: a missing or absurd value is refreshed within an hour at the latest.
 */
export function tokenTtlSeconds(expiresIn: number | undefined): number {
  return expiresIn && expiresIn >= 60 && expiresIn <= 30 * 86_400 ? expiresIn : 3600;
}

/** The client secret sealed on a row, if any. Throws if it does not open under that row. */
export const openClientSecret = (row: McpOAuthOwnerRow & { clientSecretEnc: string | null }): string | undefined =>
  openSecret(row);

async function audit(flow: PendingFlow, state: McpOAuthStateName): Promise<void> {
  try {
    await recordActivity({
      kind: "auth", severity: "info", sourceIcon: "cloud",
      what: `Signed in to ${flow.provider}`, sub: state,
      actor: { type: "user", id: flow.userId },
      refs: { connector: flow.provider, connectionId: flow.connectionId, scope: flow.scope, state },
    });
  } catch {
    logger.warn({ provider: flow.provider }, "mcp_oauth_audit_failed");
  }
}

/**
 * The address a person pastes after the browser could not reach the box
 * (loopback fallback). Only a FULL callback URL is accepted: a bare code is
 * refused, because the code alone cannot be bound to a `state` or an issuer.
 * Nothing from it is logged or echoed.
 */
export function parsePastedRedirect(text: unknown): { state: string; code: string | null; error: string | null; iss: string | null } {
  if (typeof text !== "string" || text.length === 0 || text.length > MAX_PASTE_LEN) {
    throw new McpOAuthError("invalid_redirect_url", "Paste the full address from your browser's address bar.");
  }
  const raw = text.trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new McpOAuthError("bare_code_rejected", "Paste the full address, not just the code.");
  }
  const one = (name: string): string | null => {
    const all = u.searchParams.getAll(name);
    return all.length === 1 ? all[0] : null;
  };
  const state = one("state");
  const code = one("code");
  const error = one("error");
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password ||
    u.pathname !== MCP_OAUTH_CALLBACK_PATH || !state || (!code && !error)
  ) {
    throw new McpOAuthError("invalid_redirect_url", "That is not a Droplet sign-in address.");
  }
  return { state, code, error, iss: one("iss") };
}

// ─── read side ───────────────────────────────────────────────────────────────

export interface McpSignInView {
  provider: string;
  member: { id: string; state: McpOAuthStateName; connectedAt: string | null; lastRefreshOkAt: string | null } | null;
  /** `ackBy` is shown to owners and admins only. */
  workspace: { id: string; state: McpOAuthStateName; ackBy: string | null; connectedAt: string | null } | null;
  redirectUri: string;
  callbackSupported: boolean;
  /** Whether a shared API token is also connected (the last rung). */
  apiToken: boolean;
}

/** Field by field: no token, secret or issuer detail ever reaches a client. */
export async function mcpSignInView(
  prisma: PrismaClient,
  provider: string,
  userId: string,
  redirectUri: string,
  role?: string,
): Promise<McpSignInView> {
  signInFor(provider);
  const [member, workspace, apiToken] = await Promise.all([
    prisma.mcpOAuthConnection.findFirst({ where: { provider, scope: "MEMBER", memberId: userId } }),
    prisma.mcpOAuthConnection.findFirst({ where: { provider, scope: "WORKSPACE" } }),
    prisma.integrationConnection.findFirst({
      where: { provider, status: "CONNECTED", providerTokensEnc: { not: null } },
      select: { id: true },
    }),
  ]);
  return {
    provider,
    member: member && {
      id: member.id, state: member.state, connectedAt: member.connectedAt?.toISOString() ?? null,
      lastRefreshOkAt: member.lastRefreshOkAt?.toISOString() ?? null,
    },
    workspace: workspace && {
      id: workspace.id, state: workspace.state, ackBy: roleIn(role, ADMIN_ROLES) ? workspace.workspaceAckBy : null, connectedAt: workspace.connectedAt?.toISOString() ?? null,
    },
    redirectUri,
    // True when the box has an https origin to call back to; otherwise clients start with
    // redirectMode "loopback" and show the paste field first. The authorization server
    // decides in the end; paste is the guaranteed path.
    callbackSupported: redirectUri.startsWith("https://"),
    apiToken: !!apiToken,
  };
}

// ─── disconnect / client ─────────────────────────────────────────────────────

/** Revokes at the vendor when its metadata advertised an endpoint (best effort,
 *  never blocks the local disconnect), deletes the tokens, closes the live
 *  session and marks the row DISCONNECTED. Returns false when the caller may
 *  not (or the row is absent): both read as "not found". */
export async function disconnectMcpOAuth(
  prisma: PrismaClient,
  id: string,
  caller: { id: string; role: string | undefined },
  deps?: Pick<McpOAuthDependencies, "oauth" | "closeSession" | "egress">,
  /** Filled in for the caller: `revokeSkipped` when remote MCP is switched off. */
  notes: { revokeSkipped?: boolean } = {},
): Promise<boolean> {
  const row = await prisma.mcpOAuthConnection.findUnique({ where: { id } });
  if (!row) return false;
  const allowed = row.scope === "MEMBER" ? row.memberId === caller.id : roleIn(caller.role, ADMIN_ROLES);
  if (!allowed) return false;
  if (deps && row.tokensEnc && row.clientId) {
    try {
      const blob = openTokens(row);
      if (blob.revocationEndpoint) {
        // The vendor revoke is a hop like any other: not while remote MCP is off for
        // this server. The LOCAL deletion below happens regardless; that is what matters.
        const egress = await deps.egress(prisma, row.provider);
        if (!egress.allowed) {
          notes.revokeSkipped = true;
          throw new Error("egress refused");
        }
        // The refresh token is the long-lived grant; revoking it ends the sign-in.
        await deps.oauth.revoke({
          revocationEndpoint: blob.revocationEndpoint,
          clientId: row.clientId,
          token: blob.refreshToken ?? blob.accessToken,
        });
      }
    } catch {
      logger.warn({ provider: row.provider }, "mcp_oauth_revoke_failed");
    }
  }
  await prisma.mcpOAuthConnection.update({
    where: { id },
    data: { state: "DISCONNECTED", tokensEnc: null, tokenExpiresAt: null, connectedAt: null, lastError: null },
  });
  await deps?.closeSession(row.provider, row.id).catch(() => undefined);
  return true;
}

/**
 * Ladder rung 1 (owner/admin): hold a pre-registered OAuth client for a
 * provider. Discovery finds the issuer it belongs to; every row of that
 * (provider, issuer) takes it, and the caller's own MEMBER row carries it when
 * none exists yet.
 */
export async function storeMcpOAuthClient(
  prisma: PrismaClient,
  input: { provider: string; clientId: string; clientSecret?: string; userId: string },
  deps: McpOAuthDependencies,
): Promise<void> {
  const { signIn } = signInFor(input.provider);
  await requireEgress(prisma, deps, input.provider);
  let disc: McpOAuthDiscovery;
  try {
    disc = await deps.oauth.discover(signIn.mcpUrl);
  } catch {
    throw new McpOAuthError("sign_in_unavailable", "The service could not be reached. Try again shortly.");
  }
  const token = httpsUrl(disc.tokenEndpoint);
  if (!token || disc.resource !== signIn.mcpUrl) throw new McpOAuthError("sign_in_unavailable", "The service could not be reached. Try again shortly.");
  const rows = await prisma.mcpOAuthConnection.findMany({ where: { provider: input.provider, issuer: disc.issuer } });
  for (const r of rows) {
    await prisma.mcpOAuthConnection.update({
      where: { id: r.id },
      data: { clientId: input.clientId, clientSecretEnc: input.clientSecret ? sealSecret(r, input.clientSecret) : null },
    });
  }
  if (rows.length === 0) {
    // No row holds this issuer yet: the admin's own MEMBER row carries the client.
    const own = await prisma.mcpOAuthConnection.findFirst({ where: { provider: input.provider, scope: "MEMBER", memberId: input.userId } });
    const id = own?.id ?? randomUUID();
    const data = {
      issuer: disc.issuer, tokenEndpointHost: token.host, clientId: input.clientId,
      clientSecretEnc: input.clientSecret ? sealSecret({ id, scope: "MEMBER", memberId: input.userId }, input.clientSecret) : null,
    };
    if (own) await prisma.mcpOAuthConnection.update({ where: { id }, data });
    else await prisma.mcpOAuthConnection.create({ data: { id, provider: input.provider, scope: "MEMBER", memberId: input.userId, state: "DISCONNECTED", ...data } });
  }
}
