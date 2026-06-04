import type {
  CameraInfo,
  CameraGroupInfo,
  CameraPinInfo,
  CameraSettings,
  CameraSettingsPatch,
  CameraSystemStatus,
  EventDetail,
  EventFilter,
  FilteredEventsResult,
  KnownFace,
  KnownPlate,
  NotificationPrefs,
  PtzAction,
  PtzCapabilities,
  RecordingDay,
  RecordingSegment,
  ReviewFilter,
  FilteredReviewsResult,
  TimelineEntry,
  ChatRequest,
  ConnectedDevice,
  DetectionEvent,
  DeviceInfo,
  DiscoveredCamera,
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
  FileEntryInfo,
  FileVersionInfo,
  TrashItemInfo,
  BulkOperationResult,
  FirewallConfig,
  HealthResponse,
  ModelsResponse,
  NetworkCommandResult,
  NetworkOverview,
  StorageStats,
  DrivesResponse,
  PoolsResponse,
  PoolInfo,
  DriveLabel,
  WirelessScanResult,
  AuthUser,
  InviteCreateRequest,
  InviteCreateResponse,
  InvitePublicInfo,
  InviteListItem,
  ShareInfo,
  ShareDetail,
  ShareCreateOptions,
  ShareUpdateOptions,
  ApplianceContract,
  ClaimResult,
  OrgInput,
  OrgResult,
  TeamInviteRequest,
  TeamInviteResult,
  DeviceClientInfo,
  PairingCodeInfo,
  PairingCodeStatus,
  VpnPeerInfo,
  VpnStatusInfo,
  VpnPeerCreatedInfo,
  DuckDnsStatus,
  ToolCatalogResponse,
} from "./types";
import { authFetch } from "./auth";

const BASE = "";

// --- Auth ---

/**
 * Tri-state result of probing `GET /api/auth/setup` (WARP-577).
 *
 * - `'required'`  — orchestrator explicitly answered `setupRequired: true`.
 * - `'complete'`  — orchestrator explicitly answered `setupRequired: false`.
 * - `'unknown'`   — indeterminate: any non-2xx, network error, probe timeout,
 *                   or a 2xx body that omits the `setupRequired` boolean.
 *
 * Callers MUST treat `'unknown'` as fail-CLOSED — i.e. never route a user into
 * the first-run `/setup` wizard on an indeterminate answer. Only an explicit
 * `'required'` may do that. This avoids guessing setup state from the absence
 * of a clean response (the repo's "no guessing" standard).
 */
export type SetupStatus = "required" | "complete" | "unknown";

/** Wall-clock budget for the setup probe before we treat it as `'unknown'`. */
const SETUP_PROBE_TIMEOUT_MS = 5000;

export async function checkSetupRequired(): Promise<SetupStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    SETUP_PROBE_TIMEOUT_MS,
  );

  try {
    // `/api/auth/setup` is a public, pre-auth probe (no session required), so
    // we call `fetch` directly rather than `authFetch` — there is no 401 to
    // refresh through, and the AbortController signal must reach the network
    // call unaltered for the probe timeout to fire.
    const res = await fetch(`${BASE}/api/auth/setup`, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    // Any non-2xx (5xx cold-boot, 502 gateway, etc.) is indeterminate — never
    // collapse "couldn't reach the orchestrator" into "setup is needed".
    if (!res.ok) return "unknown";

    let data: unknown;
    try {
      data = await res.json();
    } catch {
      // 2xx with an unparseable body — still indeterminate.
      return "unknown";
    }

    const setupRequired = (data as { setupRequired?: unknown } | null)
      ?.setupRequired;
    // Only an explicit boolean is trusted; a missing field is NOT "complete".
    if (setupRequired === true) return "required";
    if (setupRequired === false) return "complete";
    return "unknown";
  } catch {
    // Network error or aborted/timed-out probe → indeterminate.
    return "unknown";
  } finally {
    clearTimeout(timeout);
  }
}

export async function setupAdmin(
  email: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Setup failed") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}

/**
 * PR #372 — persist the wizard step so a mid-wizard refresh resumes here.
 * Fire-and-forget from the caller's perspective: a failure to persist must
 * never block the customer from advancing the wizard locally, so we
 * swallow network errors (the in-memory step still moves forward; the next
 * successful PATCH re-syncs). Public endpoint — runs before any user
 * exists, like POST /api/auth/setup.
 */
export async function patchSetupStep(setupStep: string): Promise<void> {
  try {
    await fetch(`${BASE}/api/setup/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ setup_step: setupStep }),
    });
  } catch {
    /* non-fatal — local wizard progress is the source of truth mid-step */
  }
}

/**
 * PR #372 — the wizard-FINISH transition: durably flip the appliance to
 * `ready` server-side (orchestrator `markApplianceReady`). This is the write
 * that survives a hard refresh — without it `ApplianceSetup.state` stays
 * `unclaimed` and `AuthGate` re-traps the owner in the first-run wizard.
 * The server also lands `setup_step` on `done`, so the persisted row is
 * internally consistent. markApplianceReady on an already-ready appliance is
 * a 200 no-op, so finishing twice / refreshing on `/done` is safe.
 *
 * The wizard authenticated at the account step (loginUser sets the
 * `droplet_session` cookie), and the orchestrator gates the `ready` claim
 * on that session, so we send credentials with the request.
 *
 * M4 (PR #372 re-review) — this used to swallow EVERY error (network AND
 * non-2xx). That left the UI showing "ready" (the optimistic in-memory flip)
 * while the server stayed `unclaimed`, so the next refresh re-trapped the
 * owner with no signal anything went wrong. We now THROW on a failed PATCH
 * (network error or non-2xx) so the caller can roll back the optimistic flip
 * and surface a retry. The server transition is idempotent, so retrying is
 * always safe.
 */
export async function patchSetupReady(): Promise<void> {
  const res = await fetch(`${BASE}/api/setup/state`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ appliance: "ready" }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.error || `Failed to finalize setup (appliance:ready): ${res.status}`,
    );
  }
}

/**
 * PR #382 — mark the post-setup product tour complete. PATCHes
 * `{ user_tour_completed: true }` to the same `/api/setup/state` machine #372
 * shipped (orchestrator `markTourCompleted`, an idempotent flip that can only
 * move false → true). Once persisted, AuthGate's "ready + tour pending → tour"
 * branch stops firing and the owner passes through to the dashboard.
 *
 * Public endpoint, same as the other setup-state writes (the tour runs
 * immediately post-claim, before any session-refresh concerns), so the plain
 * `fetch` — no authFetch refresh dance. We swallow a transient network error:
 * the optimistic in-memory flip in `completeTour` already routed the owner
 * onward, and the next `/api/setup/state` GET re-syncs. Re-running the tour
 * later is an explicit Help-page action, never an accidental re-trap.
 */
export async function patchTourCompleted(): Promise<void> {
  try {
    await fetch(`${BASE}/api/setup/state`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_tour_completed: true }),
    });
  } catch {
    /* non-fatal — optimistic flip already routed; next GET re-syncs */
  }
}

/**
 * PR #373 — fetch the read-only hardware contract the Claim step renders.
 * PUBLIC (runs before any account exists, like the rest of the wizard's
 * pre-account calls), so a bare `fetch` with no credentials. Throws on a
 * non-2xx so the Claim step can show the "We can't see your Droplet yet"
 * retry state and BLOCK continue (the appliance-unreachable edge).
 */
export async function fetchApplianceContract(): Promise<ApplianceContract> {
  const res = await fetch(`${BASE}/api/setup/appliance`);
  if (!res.ok) {
    throw new Error(`Failed to fetch appliance contract: ${res.status}`);
  }
  return res.json();
}

/** PR #373 — error carrying the claim failure kind so the Claim step can show
 *  the right inline message (wrong code vs rate-limited) without leaking the
 *  real code. */
export class ClaimError extends Error {
  /** Server `code` — e.g. CLAIM_CODE_INVALID, CLAIM_RATE_LIMITED. */
  readonly code: string;
  /** True when the failure was the per-IP rate-limit lock (HTTP 429). */
  readonly rateLimited: boolean;
  /** WARP-631 — seconds the client must wait before retrying (429 only). The
   *  Claim step starts a live m:ss countdown from this and re-enables the form
   *  when it elapses. */
  readonly retryAfterSeconds?: number;
  constructor(
    message: string,
    code: string,
    rateLimited: boolean,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ClaimError";
    this.code = code;
    this.rateLimited = rateLimited;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * PR #373 — verify + consume a claim code, binding the appliance. PUBLIC
 * (claiming precedes account creation) → bare `fetch`. On the happy path /
 * already-claimed short-circuit the server returns 200; on a wrong code (400)
 * or a rate-limit lock (429) we throw a `ClaimError` the step renders inline.
 * The server never echoes the real code, so neither do we.
 *
 * WARP-631 — a 429 carries `retryAfterSeconds` (the progressive-backoff wait);
 * we thread it onto the ClaimError so the step can run a live countdown.
 */
export async function postClaim(code: string): Promise<ClaimResult> {
  const res = await fetch(`${BASE}/api/setup/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const retryAfterSeconds =
      typeof data.retryAfterSeconds === "number" && data.retryAfterSeconds > 0
        ? data.retryAfterSeconds
        : undefined;
    throw new ClaimError(
      data.error || "That claim code didn't match. Try again.",
      data.code || "CLAIM_FAILED",
      res.status === 429,
      retryAfterSeconds,
    );
  }
  return res.json();
}

/** PR #380 — error carrying the org failure kind so the Org step can show the
 *  right inline message (slug taken vs slug invalid vs generic) on the right
 *  field. */
export class OrgError extends Error {
  /** Server `code` — e.g. ORG_SLUG_TAKEN, ORG_SLUG_INVALID, ORG_FIELDS_REQUIRED. */
  readonly code: string;
  /** True when the slug is already reserved (409) — the URL field error. */
  readonly slugTaken: boolean;
  /** True when the slug is malformed (400 ORG_SLUG_INVALID) — the URL field error. */
  readonly slugInvalid: boolean;
  constructor(message: string, code: string) {
    super(message);
    this.name = "OrgError";
    this.code = code;
    this.slugTaken = code === "ORG_SLUG_TAKEN";
    this.slugInvalid = code === "ORG_SLUG_INVALID";
  }
}

/**
 * PR #380 — name the single workspace + reserve droplet.local/<slug>. Org slots
 * AFTER account, but shares the wizard's public posture (the route is
 * allow-listed), so a bare `fetch` with same-origin credentials. On a taken
 * (409) or invalid (400) slug we throw an `OrgError` the step renders inline on
 * the URL field; the server validates the slug shape + uniqueness server-side.
 */
export async function postOrg(input: OrgInput): Promise<OrgResult> {
  const res = await fetch(`${BASE}/api/setup/org`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new OrgError(
      data.error || "Couldn't save your workspace. Try again in a moment.",
      data.code || "ORG_FAILED",
    );
  }
  return res.json();
}

/** PR #381 — error carrying the invite failure kind so the Team step can show
 *  the right inline message (bad email vs bad role vs generic) on the right
 *  field. */
export class InviteError extends Error {
  /** Server `code` — e.g. INVITE_EMAIL_INVALID, INVITE_ROLE_INVALID. */
  readonly code: string;
  /** True when the email was malformed (400 INVITE_EMAIL_INVALID) — the
   *  email-field error. */
  readonly emailInvalid: boolean;
  /** True when the role wasn't a valid household role (400 INVITE_ROLE_INVALID). */
  readonly roleInvalid: boolean;
  constructor(message: string, code: string) {
    super(message);
    this.name = "InviteError";
    this.code = code;
    this.emailInvalid = code === "INVITE_EMAIL_INVALID";
    this.roleInvalid = code === "INVITE_ROLE_INVALID";
  }
}

/**
 * PR #381 — invite a teammate by email + role (the onboarding TEAM step). The
 * TEAM step runs after the owner has authenticated (account step), so this is
 * an authenticated call (owner/admin-guarded on the orchestrator). On a bad
 * email (400) or bad role (400) we throw an `InviteError` the step renders
 * inline; the server is authoritative on email shape + the role vocabulary.
 */
export async function postTeamInvite(
  input: TeamInviteRequest,
): Promise<TeamInviteResult> {
  const res = await authFetch(`${BASE}/api/people/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new InviteError(
      data.error || "Couldn't send that invite. Try again in a moment.",
      data.code || "INVITE_FAILED",
    );
  }
  return res.json();
}

export async function loginUser(
  email: string,
  password: string
): Promise<{ user: AuthUser }> {
  const res = await authFetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Login failed");
  }
  return res.json();
}

export async function fetchMe(): Promise<AuthUser> {
  const res = await authFetch(`${BASE}/api/auth/me`);
  if (!res.ok) throw new Error("Not authenticated");
  return res.json();
}

export async function fetchUsers(): Promise<{ users: AuthUser[] }> {
  const res = await authFetch(`${BASE}/api/auth/users`);
  if (!res.ok) throw new Error(`Failed to fetch users: ${res.status}`);
  return res.json();
}

export async function createUser(
  email: string,
  password: string,
  displayName?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Failed to create user") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}

export async function deleteUser(username: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users/${username}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete user: ${res.status}`);
}

// --- PR #375 — TOTP 2FA enrollment ---

export interface TotpEnrollResponse {
  /** otpauth:// URI for manual entry into an authenticator app. */
  otpauthUri: string;
  /** Pre-rendered QR data-url (data:image/png;base64,…) for <img src>. */
  qrDataUrl: string;
  issuer: string;
}

export interface TotpVerifyResponse {
  enabled: boolean;
  /** Present only on the first successful verify — shown to the user once. */
  recoveryCodes?: string[];
}

/** Begin TOTP enrollment: returns the QR + otpauth URI for the current user. */
export async function enrollTotp(): Promise<TotpEnrollResponse> {
  const res = await authFetch(`${BASE}/api/auth/totp/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Could not start two-factor setup");
  }
  return res.json();
}

/**
 * Confirm a 6-digit code. On the first success the response carries the
 * one-time recovery codes (shown once); a later call enables nothing new.
 */
export async function verifyTotp(code: string): Promise<TotpVerifyResponse> {
  const res = await authFetch(`${BASE}/api/auth/totp/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "That code didn't match. Try again.");
  }
  return res.json();
}

// --- WARP-217 invites ---

/**
 * Generate a single-use invite token + URL. Admin-only on the backend; the
 * dashboard's Users page is already gated, so this throws on 403.
 */
export async function createInvite(
  payload: InviteCreateRequest,
): Promise<InviteCreateResponse> {
  const res = await authFetch(`${BASE}/api/auth/invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Failed to create invite") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
  return res.json();
}

export async function listInvites(): Promise<{ invites: InviteListItem[] }> {
  const res = await authFetch(`${BASE}/api/auth/invites`);
  if (!res.ok) throw new Error(`Failed to list invites: ${res.status}`);
  return res.json();
}

export async function revokeInvite(token: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/auth/invites/${encodeURIComponent(token)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to revoke invite: ${res.status}`);
  }
}

/**
 * PUBLIC — invitee fetches their invite metadata before setting a password.
 * Throws with `{ status, code }`-shaped detail so callers can distinguish
 * 404 (not found / revoked) from 410 USED / 410 EXPIRED.
 */
export async function getInvite(token: string): Promise<InvitePublicInfo> {
  const res = await authFetch(
    `${BASE}/api/auth/invites/accept/${encodeURIComponent(token)}`,
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Invite unavailable: ${res.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return res.json();
}

/**
 * PUBLIC — invitee submits a password to claim the invite. On success the
 * orchestrator sets the same JWT cookies as /auth/login and returns the
 * user payload, so the caller can navigate straight into the dashboard.
 */
export async function acceptInvite(
  token: string,
  password: string,
): Promise<{ user: AuthUser & { role: string } }> {
  const res = await authFetch(
    `${BASE}/api/auth/invites/accept/${encodeURIComponent(token)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || `Failed to accept invite: ${res.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return res.json();
}

/**
 * WARP-629 — runtime SSO discovery. Returns the provider IDs this appliance
 * has actually configured (e.g. `["google"]`), so the login page renders only
 * usable IdP buttons instead of a fixed build-time set. PUBLIC + pre-session
 * (the login page has no cookie yet), so a bare `fetch` — no authFetch refresh
 * dance, like checkSetupRequired / fetchSystemHealth.
 *
 * The body is provider IDs ONLY (no issuer/client-id/secret/redirect). Throws
 * on any non-2xx or malformed body; the caller treats a rejection as "no SSO"
 * and keeps the local-first password path standing (SSO is purely additive).
 */
export async function getEnabledSsoProviders(): Promise<string[]> {
  // Bound the request so a *hung* orchestrator (not just a rejected one) still
  // falls back to the password-only path instead of leaving discovery pending
  // forever. AbortSignal.timeout fires a TimeoutError → the caller's .catch
  // treats it as "no SSO" (review follow-up on #403).
  const res = await fetch(`${BASE}/api/sso/oidc/providers`, {
    credentials: "same-origin",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch SSO providers: ${res.status}`);
  }
  const data = (await res.json()) as { providers?: unknown };
  // Defensive: only trust a string[] under `providers`. Anything else → [].
  if (!Array.isArray(data.providers)) return [];
  return data.providers.filter((p): p is string => typeof p === "string");
}

// --- WARP-225: per-user context-meter ---

import type {
  ContextStatsSummary,
  ContextStatsFull,
  QueuedItem,
  FailedItem,
} from "./types-context-stats";

export async function fetchContextStatsSummary(): Promise<ContextStatsSummary> {
  const res = await authFetch(`${BASE}/api/me/context-stats`);
  if (!res.ok)
    throw new Error(`Failed to fetch context-stats summary: ${res.status}`);
  return res.json();
}

export async function fetchContextStatsFull(): Promise<ContextStatsFull> {
  const res = await authFetch(`${BASE}/api/me/context-stats/full`);
  if (!res.ok)
    throw new Error(`Failed to fetch context-stats full: ${res.status}`);
  return res.json();
}

export async function fetchContextStatsQueued(): Promise<QueuedItem[]> {
  const res = await authFetch(`${BASE}/api/me/context-stats/queued`);
  if (!res.ok)
    throw new Error(`Failed to fetch context-stats queued: ${res.status}`);
  const body = (await res.json()) as { items: QueuedItem[] };
  return body.items ?? [];
}

export async function fetchContextStatsFailed(): Promise<FailedItem[]> {
  const res = await authFetch(`${BASE}/api/me/context-stats/failed`);
  if (!res.ok)
    throw new Error(`Failed to fetch context-stats failed: ${res.status}`);
  const body = (await res.json()) as { items: FailedItem[] };
  return body.items ?? [];
}

/**
 * POST retry on a failed item. Surfaces 429 (rate-limited) inline so
 * the FailedList can show "Retry available in <X minutes>" without
 * looping the whole component into the SWR error path.
 */
export interface RetryResult {
  ok: boolean;
  status: number;
  retryAfterSeconds?: number;
}
export async function retryFailedContextItem(
  itemId: string,
): Promise<RetryResult> {
  const res = await authFetch(
    `${BASE}/api/me/context-stats/failed/${encodeURIComponent(itemId)}/retry`,
    { method: "POST" },
  );
  if (res.status === 202) return { ok: true, status: 202 };
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: Number(body?.retryAfterSeconds) || undefined,
    };
  }
  return { ok: false, status: res.status };
}

/** WARP-218 — exists already; called from QueuedList "Run now" button. */
export async function transcribeNowBrainItem(
  itemId: string,
): Promise<RetryResult> {
  const res = await authFetch(
    `${BASE}/api/files/brain/${encodeURIComponent(itemId)}/transcribe-now`,
    { method: "POST" },
  );
  if (res.status === 202) return { ok: true, status: 202 };
  if (res.status === 429) {
    const body = await res.json().catch(() => ({}));
    return {
      ok: false,
      status: 429,
      retryAfterSeconds: Number(body?.retryAfterSeconds) || undefined,
    };
  }
  return { ok: false, status: res.status };
}

// --- Storage ---

export async function fetchStorage(): Promise<StorageStats> {
  const res = await authFetch(`${BASE}/api/storage`);
  if (!res.ok) throw new Error(`Failed to fetch storage: ${res.status}`);
  return res.json();
}

export async function fetchDrives(): Promise<DrivesResponse> {
  const res = await authFetch(`${BASE}/api/storage/drives`);
  if (!res.ok) throw new Error(`Failed to fetch drives: ${res.status}`);
  return res.json();
}

/**
 * BUG-3 / ADR-019: read-only mdadm pool inventory. Returns an honest empty
 * list when no pool exists — never a fabricated pooled-storage sum.
 */
export async function fetchPools(): Promise<PoolsResponse> {
  const res = await authFetch(`${BASE}/api/storage/pools`);
  if (!res.ok) throw new Error(`Failed to fetch pools: ${res.status}`);
  return res.json();
}

/**
 * BUG-3 / ADR-019: destructive pool ops are TWO-STEP. Step 1 evaluates and
 * returns a single-use confirm token (202); step 2 confirms it to execute.
 * Owner/admin only (enforced server-side). Never auto, never AI.
 */
export interface PoolCommandToken {
  status: "confirmation_required";
  confirmationToken: string;
  service: string;
  resourceId: string;
  reason?: string;
  expiresIn?: number;
}

/** Step 1: create a pool — returns a confirm token (does NOT create yet). */
export async function requestCreatePool(input: {
  device: string;
  level: PoolInfo["level"];
  members: string[];
  confirmPhrase: string;
}): Promise<PoolCommandToken> {
  const res = await authFetch(`${BASE}/api/storage/pools`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not start pool creation: ${res.status}`);
  }
  return res.json();
}

/** Step 1: destroy a pool — returns a confirm token (does NOT destroy yet). */
export async function requestDestroyPool(
  device: string,
  confirmPhrase: string,
): Promise<PoolCommandToken> {
  const res = await authFetch(`${BASE}/api/storage/pools/${encodeURIComponent(device)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmPhrase }),
  });
  if (res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not start pool removal: ${res.status}`);
  }
  return res.json();
}

/** Step 2: confirm + execute a queued destructive pool op. */
export async function confirmPoolCommand(input: {
  confirmationToken: string;
  service: string;
  resourceId: string;
}): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch(`${BASE}/api/storage/command/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not complete the operation: ${res.status}`);
  }
  return res.json();
}

/**
 * WARP-612: ask the device-bridge to refresh its drive snapshot (admin-only;
 * proxies the bridge's /drives/changed cache hook — no mount side effects).
 */
export async function rescanDrives(): Promise<{ ok: boolean; error?: string }> {
  const res = await authFetch(`${BASE}/api/storage/drives/rescan`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to rescan drives: ${res.status}`);
  }
  return res.json();
}

/**
 * WARP-612: unmount + forget a hot-plug USB drive (admin-only). The
 * orchestrator + bridge refuse anything that isn't a USB mount under
 * /mnt/droplet/. Throws a friendly message on 409 (busy) / 503 (not
 * configured) so the caller can surface it.
 */
export async function ejectDrive(uuid: string): Promise<{ ok: boolean }> {
  const res = await authFetch(
    `${BASE}/api/storage/drives/${encodeURIComponent(uuid)}/eject`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to eject drive: ${res.status}`);
  }
  return res.json();
}

/**
 * WARP-174: upsert the customer's friendly name (+ optional icon + notes)
 * for a drive. Used by the setup wizard's Storage step and the
 * post-setup `/storage` page.
 *
 * First call for a given UUID requires `displayName`; later calls can
 * be partial. Server returns the full Drive row.
 */
export async function updateDriveLabel(
  uuid: string,
  patch: {
    displayName?: string;
    icon?: string | null;
    notes?: string | null;
  },
): Promise<DriveLabel> {
  const res = await authFetch(
    `${BASE}/api/storage/drives/${encodeURIComponent(uuid)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update drive: ${res.status}`);
  }
  return res.json();
}

// --- Health ---

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await authFetch(`${BASE}/api/health`);
  if (!res.ok) throw new Error(`Health check failed: ${res.status}`);
  return res.json();
}

export async function fetchDevices(): Promise<DeviceInfo[]> {
  const res = await authFetch(`${BASE}/api/devices`);
  if (!res.ok) throw new Error(`Failed to fetch devices: ${res.status}`);
  return res.json();
}

// --- Rolled-up system health (WARP-43) ---

export type SystemHealthStatus = "ok" | "degraded" | "down";
export type SystemComponentStatus = "ok" | "down";

export interface SystemComponent {
  name: string;
  status: SystemComponentStatus;
  latencyMs: number;
  lastCheckedAt: string;
  error?: string;
}

export interface SystemHealth {
  status: SystemHealthStatus;
  components: SystemComponent[];
  uptime: number;
  version: string;
}

export async function fetchSystemHealth(): Promise<SystemHealth> {
  // Public endpoint (no auth) — used by Docker healthcheck + dashboard pill.
  const res = await fetch(`${BASE}/api/orchestrator/health`, {
    credentials: "include",
  });
  // 503 is a valid "down" response; we still want to read the body.
  if (!res.ok && res.status !== 503) {
    throw new Error(`Failed to fetch system health: ${res.status}`);
  }
  return res.json();
}

// --- Network / Router ---

export type RouterErrorCode =
  | "UNREACHABLE"
  | "TIMEOUT"
  | "AUTH"
  | "ROLLED_BACK"
  | "DISABLED"
  | "UNKNOWN";

export class RouterStatusError extends Error {
  readonly code: RouterErrorCode;
  readonly status?: number;
  constructor(code: RouterErrorCode, message: string, status?: number) {
    super(message);
    this.name = "RouterStatusError";
    this.code = code;
    this.status = status;
  }
}

export async function fetchNetworkStatus(): Promise<NetworkOverview> {
  const res = await authFetch(`${BASE}/api/network/status`);
  if (res.ok) return res.json();
  // WARP-39: orchestrator returns 503 with a typed `{ error: { code, message, ... } }`
  // body. Surface it as a RouterStatusError so SWR's error channel can carry
  // the code up to the UI.
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON fallthrough */
  }
  const typed = (body as { error?: { code?: RouterErrorCode; message?: string } } | null)?.error;
  if (typed?.code) {
    throw new RouterStatusError(typed.code, typed.message ?? "Router error", res.status);
  }
  throw new RouterStatusError("UNKNOWN", `Failed to fetch network status: ${res.status}`, res.status);
}

export async function fetchConnectedDevices(): Promise<ConnectedDevice[]> {
  const res = await authFetch(`${BASE}/api/network/devices`);
  if (!res.ok) throw new Error(`Failed to fetch connected devices: ${res.status}`);
  const data = await res.json();
  return data.devices;
}

export async function fetchWifiSettings(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/wifi`);
  if (!res.ok) throw new Error(`Failed to fetch wifi settings: ${res.status}`);
  return res.json();
}

export async function scanWifiNetworks(): Promise<WirelessScanResult[]> {
  const res = await authFetch(`${BASE}/api/network/wifi/scan`);
  if (!res.ok) throw new Error(`Failed to scan wifi: ${res.status}`);
  const data = await res.json();
  return data.results;
}

export async function setWifiSsid(ssid: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/ssid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set SSID: ${res.status}`);
  return data;
}

export async function setWifiPassword(password: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set password: ${res.status}`);
  return data;
}

export async function setWifiChannel(channel: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Failed to set channel: ${res.status}`);
  return data;
}

export async function fetchDhcpLeases(): Promise<Record<string, unknown>[]> {
  const res = await authFetch(`${BASE}/api/network/dhcp/leases`);
  if (!res.ok) throw new Error(`Failed to fetch DHCP leases: ${res.status}`);
  const data = await res.json();
  return data.leases;
}

export async function fetchFirewallConfig(): Promise<FirewallConfig> {
  const res = await authFetch(`${BASE}/api/network/firewall`);
  if (!res.ok) throw new Error(`Failed to fetch firewall config: ${res.status}`);
  return res.json();
}

export async function blockNetworkDevice(mac: string, name?: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/block`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac, name }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to block device: ${res.status}`);
  return data;
}

export async function unblockNetworkDevice(mac: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/unblock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mac }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to unblock device: ${res.status}`);
  return data;
}

export async function addNetworkPortForward(
  name: string,
  srcPort: string,
  destIp: string,
  destPort: string,
  proto: string = "tcp"
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/port-forward`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, src_port: srcPort, dest_ip: destIp, dest_port: destPort, proto }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to add port forward: ${res.status}`);
  return data;
}

export async function fetchRouterSystemInfo(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/system`);
  if (!res.ok) throw new Error(`Failed to fetch router system info: ${res.status}`);
  return res.json();
}

export type NetworkOperation = {
  id: string;
  // DASH-07: "unknown" is a distinct, non-success terminal state used when the
  // orchestrator can't account for the operation (404). It must NOT be treated
  // as "applied" — see fetchNetworkOperation.
  state: "pending" | "applied" | "rolled_back" | "unknown";
  startedAt: number;
  finishedAt: number | null;
  reason: string | null;
};

export async function confirmNetworkCommand(
  token: string,
  operation: string,
  entityId?: string,
): Promise<{ operationId: string | null }> {
  // WARP-41: echo the operation (and optionally the entity) from the 202
  // response so the orchestrator can reject a token that was issued for a
  // different pending op.
  // WARP-40: return operationId so the caller can poll for apply-vs-rollback.
  const res = await authFetch(`${BASE}/api/network/command/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationToken: token, operation, entityId }),
  });
  if (!res.ok) throw new Error(`Failed to confirm command: ${res.status}`);
  const body = await res.json();
  return { operationId: body?.operationId ?? null };
}

export async function fetchNetworkOperation(id: string): Promise<NetworkOperation> {
  const res = await authFetch(`${BASE}/api/network/operations/${encodeURIComponent(id)}`);
  if (res.status === 404) {
    // DASH-07: the orchestrator returns 404 for an operation it can't account
    // for. That's genuinely indeterminate — the op may have expired after a
    // refresh, never applied, been rolled back, or the id was wrong. We must
    // NOT report "applied" (a false success that could tell the operator a
    // firewall/port-forward change took effect when it may not have). Surface a
    // distinct terminal "unknown" state so the UI can ask the user to re-check
    // the device list rather than asserting success.
    return {
      id,
      state: "unknown",
      startedAt: 0,
      finishedAt: null,
      reason: "We couldn't confirm this change — re-check the device list.",
    };
  }
  if (!res.ok) throw new Error(`Failed to fetch operation: ${res.status}`);
  return res.json();
}

// --- Cameras / Frigate ---

export async function fetchCameras(): Promise<CameraInfo[]> {
  const res = await authFetch(`${BASE}/api/cameras`);
  if (!res.ok) throw new Error(`Failed to fetch cameras: ${res.status}`);
  const data = await res.json();
  return data.cameras ?? [];
}

export async function fetchCameraDetail(name: string): Promise<CameraInfo & { recentEvents: DetectionEvent[] }> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(`Failed to fetch camera: ${res.status}`);
  return res.json();
}

export async function fetchCameraEvents(limit = 20, camera?: string): Promise<DetectionEvent[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (camera) params.set("camera", camera);
  const url = camera
    ? `${BASE}/api/cameras/${encodeURIComponent(camera)}/events?${params}`
    : `${BASE}/api/cameras/events/recent?${params}`;
  const res = await authFetch(url);
  if (!res.ok) throw new Error(`Failed to fetch camera events: ${res.status}`);
  const data = await res.json();
  return data.events ?? [];
}

/** Toggle the retain-indefinitely flag on an event ("Saved" in the UI). */
export async function setEventRetain(
  eventId: string,
  retain: boolean,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/events/${encodeURIComponent(eventId)}/retain`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ retain }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
}

// --- Reviews (Frigate 0.13+) ---

export async function fetchReviewsFiltered(
  filter: ReviewFilter,
): Promise<FilteredReviewsResult> {
  const params = new URLSearchParams();
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.severity?.length) params.set("severity", filter.severity.join(","));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.reviewed !== undefined) params.set("reviewed", filter.reviewed ? "1" : "0");
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const res = await authFetch(`${BASE}/api/cameras/reviews?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  return res.json();
}

export async function markReviewViewed(reviewId: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/reviews/${encodeURIComponent(reviewId)}/viewed`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Failed to mark review viewed: ${res.status}`);
}

// --- Recordings + timeline (Phase 3.1) ---

export async function fetchRecordingsSummary(
  cameraName: string,
): Promise<RecordingDay[]> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/recordings/summary`,
  );
  if (!res.ok) throw new Error(`Failed to fetch recording summary: ${res.status}`);
  const body = (await res.json()) as { days: RecordingDay[] };
  return body.days;
}

export async function fetchRecordingSegments(
  cameraName: string,
  after: number,
  before: number,
): Promise<RecordingSegment[]> {
  const params = new URLSearchParams({ after: String(after), before: String(before) });
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/recordings?${params}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch recordings: ${res.status}`);
  const body = (await res.json()) as { segments: RecordingSegment[] };
  return body.segments;
}

export async function fetchTimeline(
  cameraName: string,
  after: number,
  before: number,
): Promise<TimelineEntry[]> {
  const params = new URLSearchParams({ after: String(after), before: String(before) });
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/timeline?${params}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch timeline: ${res.status}`);
  const body = (await res.json()) as { entries: TimelineEntry[] };
  return body.entries;
}

/** Returns the proxied mp4 playback URL for a time range (≤30 min).
 *  Use the HLS variant for longer scrubs. */
export function getRecordingPlaybackUrl(
  cameraName: string,
  after: number,
  before: number,
): string {
  return `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/playback?after=${after}&before=${before}`;
}

/** Returns the proxied HLS m3u8 URL for a time range. No 30-min cap;
 *  the browser fetches segments lazily as the operator scrubs. */
export function getRecordingHlsUrl(
  cameraName: string,
  after: number,
  before: number,
): string {
  return `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/playback.m3u8?after=${after}&before=${before}`;
}

// --- Per-camera settings (Phase 4.1) ---

export async function fetchCameraSettings(
  cameraName: string,
): Promise<CameraSettings> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/settings`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { settings: CameraSettings };
  return body.settings;
}

// --- Camera system status (Phase 5) ---

export async function fetchCameraSystemStatus(): Promise<CameraSystemStatus> {
  const res = await authFetch(`${BASE}/api/cameras/system`);
  if (!res.ok) throw new Error(`Failed to fetch system status: ${res.status}`);
  const body = (await res.json()) as { status: CameraSystemStatus };
  return body.status;
}

// --- Face recognition + LPR (Phase 7.5 / 7.6) ---

export async function fetchKnownFaces(): Promise<KnownFace[]> {
  const res = await authFetch(`${BASE}/api/cameras/faces`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const body = (await res.json()) as { faces: KnownFace[] };
  return body.faces;
}

export async function deleteKnownFace(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/faces/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(`Failed: ${res.status}`);
}

export async function deleteFaceImage(
  name: string,
  imageName: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/faces/${encodeURIComponent(name)}/images/${encodeURIComponent(imageName)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) throw new Error(`Failed: ${res.status}`);
}

/** Ask Frigate to (re)generate a GenAI description for an event. */
export async function regenerateEventDescription(
  eventId: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/events/${encodeURIComponent(eventId)}/regenerate-description`,
    { method: "POST" },
  );
  if (!res.ok && res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
}

export async function tagEventAsFace(
  eventId: string,
  faceName: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/faces/${encodeURIComponent(faceName)}/from-event/${encodeURIComponent(eventId)}`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
}

export async function fetchKnownPlates(): Promise<KnownPlate[]> {
  const res = await authFetch(`${BASE}/api/cameras/plates`);
  if (!res.ok) throw new Error(`Failed: ${res.status}`);
  const body = (await res.json()) as { plates: KnownPlate[] };
  return body.plates;
}

export async function nameKnownPlate(plate: string, name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/plates/${encodeURIComponent(plate)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
}

export async function deleteKnownPlate(plate: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/plates/${encodeURIComponent(plate)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) throw new Error(`Failed: ${res.status}`);
}

// --- Web Push subscription (Phase 7.2 / 7.3) ---

export async function fetchVapidPublicKey(): Promise<string> {
  const res = await authFetch(`${BASE}/api/devices/push/vapid-public-key`);
  if (!res.ok) throw new Error(`Push not configured (${res.status})`);
  const body = (await res.json()) as { publicKey: string };
  return body.publicKey;
}

export async function registerPushSubscription(
  sub: PushSubscription,
  deviceClientId?: string,
): Promise<void> {
  const json = sub.toJSON();
  const res = await authFetch(`${BASE}/api/devices/push/subscribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      endpoint: json.endpoint,
      keys: json.keys,
      deviceClientId,
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
}

export async function unregisterPushSubscription(endpoint: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/devices/push/subscribe`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to unsubscribe: ${res.status}`);
  }
}

export async function sendTestPush(): Promise<{ sent: number; pruned: number }> {
  const res = await authFetch(`${BASE}/api/devices/push/test`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  return res.json();
}

// --- Notification prefs (Phase 6.3) ---

export async function fetchCameraNotifications(
  cameraName: string,
): Promise<NotificationPrefs> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/notifications`,
  );
  if (!res.ok) throw new Error(`Failed to fetch notifications: ${res.status}`);
  return res.json();
}

export async function updateCameraNotifications(
  cameraName: string,
  prefs: NotificationPrefs,
): Promise<NotificationPrefs> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/notifications`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(prefs),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  return res.json();
}

// --- PTZ (Phase 6.1) ---

export async function fetchPtzCapabilities(
  cameraName: string,
): Promise<PtzCapabilities> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/ptz`,
  );
  if (!res.ok) throw new Error(`Failed to fetch PTZ caps: ${res.status}`);
  return res.json();
}

export async function ptzMove(
  cameraName: string,
  action: PtzAction,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/ptz`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `PTZ failed: ${res.status}`);
  }
}

export async function ptzGoToPreset(
  cameraName: string,
  preset: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/ptz/preset`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preset }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Preset failed: ${res.status}`);
  }
}

/** Restart Frigate. Returns the orchestrator's response which may
 *  include a confirmation token (tier-2 confirmation flow). */
export async function restartFrigate(
  confirmationToken?: string,
): Promise<{ status: string; confirmationToken?: string; reason?: string }> {
  const res = await authFetch(`${BASE}/api/cameras/system/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirmationToken ? { confirmationToken } : {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 202) {
    throw new Error(
      (body as { error?: string }).error || `Failed: ${res.status}`,
    );
  }
  return body as { status: string; confirmationToken?: string; reason?: string };
}

export async function patchCameraSettings(
  cameraName: string,
  patch: CameraSettingsPatch,
): Promise<CameraSettings> {
  const res = await authFetch(
    `${BASE}/api/cameras/${encodeURIComponent(cameraName)}/settings`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { settings: CameraSettings };
  return body.settings;
}

/**
 * Semantic search over events (Frigate 0.14+ embeddings). Returns the
 * same FilteredEventsResult shape as fetchEventsFiltered so the
 * Events page can swap data sources without re-mapping rows. Throws
 * with the orchestrator's hint message if the embeddings stack isn't
 * enabled.
 */
export async function searchEventsSemantic(
  query: string,
  filter: EventFilter & { searchType?: "thumbnail" | "description" } = {},
): Promise<FilteredEventsResult> {
  const params = new URLSearchParams();
  params.set("query", query);
  if (filter.searchType) params.set("search_type", filter.searchType);
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.labels?.length) params.set("labels", filter.labels.join(","));
  if (filter.minScore !== undefined) params.set("min_score", String(filter.minScore));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const res = await authFetch(`${BASE}/api/cameras/events/search?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Filtered + paginated events fetch for the Events page. Mirrors the
 * GET /api/cameras/events query surface — pass through whatever the
 * caller has set in the EventFilter and let the route validate. The
 * response carries `nextCursor` (or null at end-of-data) which feeds
 * back as `before` on the next call.
 */
export async function fetchEventsFiltered(
  filter: EventFilter,
): Promise<FilteredEventsResult> {
  const params = new URLSearchParams();
  if (filter.cameras?.length) params.set("cameras", filter.cameras.join(","));
  if (filter.labels?.length) params.set("labels", filter.labels.join(","));
  if (filter.minScore !== undefined) params.set("min_score", String(filter.minScore));
  if (filter.before !== undefined) params.set("before", String(filter.before));
  if (filter.after !== undefined) params.set("after", String(filter.after));
  if (filter.hasClip !== undefined) params.set("has_clip", filter.hasClip ? "1" : "0");
  if (filter.hasSnapshot !== undefined) params.set("has_snapshot", filter.hasSnapshot ? "1" : "0");
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const res = await authFetch(`${BASE}/api/cameras/events?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchDiscoveredCameras(): Promise<DiscoveredCamera[]> {
  const res = await authFetch(`${BASE}/api/cameras/discovered`);
  if (!res.ok) throw new Error(`Failed to fetch discovered cameras: ${res.status}`);
  return res.json();
}

export async function acceptDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${id}/accept`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to accept camera: ${res.status}`);
}

export async function rejectDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${id}/reject`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to reject camera: ${res.status}`);
}

export async function enableCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/enable`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to enable camera: ${res.status}`);
}

export async function disableCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/disable`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to disable camera: ${res.status}`);
}

export async function removeCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to remove camera: ${res.status}`);
}

export function getCameraSnapshotUrl(name: string): string {
  return `${BASE}/api/cameras/${encodeURIComponent(name)}/snapshot`;
}

/**
 * Long-lived MJPEG live feed. Drop the URL into an <img src=> and the
 * browser will render it as a continuous stream — Frigate serves
 * `multipart/x-mixed-replace` and modern browsers handle it natively.
 * The orchestrator proxies Frigate's `/api/{name}` so the camera IP is
 * never exposed to the browser and auth is enforced.
 */
export function getCameraLiveUrl(name: string): string {
  return `${BASE}/api/cameras/${encodeURIComponent(name)}/live`;
}

/** Frigate's auto-composited birdseye MJPEG. Same `<img src=>` pattern
 *  as a single-camera feed. Returns 404 from the orchestrator if Frigate
 *  doesn't have birdseye configured. */
export function getBirdseyeLiveUrl(): string {
  return `${BASE}/api/cameras/birdseye/live`;
}

// --- Camera groups ---

export async function fetchCameraGroups(): Promise<CameraGroupInfo[]> {
  const res = await authFetch(`${BASE}/api/cameras/groups`);
  if (!res.ok) throw new Error(`Failed to fetch camera groups: ${res.status}`);
  const body = (await res.json()) as { groups: CameraGroupInfo[] };
  return body.groups;
}

export async function createCameraGroup(input: {
  name: string;
  icon?: string | null;
  /** Frigate camera names (CameraInfo.name) to seed as initial members. */
  cameraNames?: string[];
}): Promise<CameraGroupInfo> {
  const res = await authFetch(`${BASE}/api/cameras/groups`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { group: CameraGroupInfo };
  return body.group;
}

export async function updateCameraGroup(
  id: string,
  patch: { name?: string; icon?: string | null; sortOrder?: number },
): Promise<CameraGroupInfo> {
  const res = await authFetch(`${BASE}/api/cameras/groups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error((data as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { group: CameraGroupInfo };
  return body.group;
}

export async function deleteCameraGroup(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/groups/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to delete group: ${res.status}`);
  }
}

export async function addCameraGroupMembers(
  groupId: string,
  cameraNames: string[],
): Promise<CameraGroupInfo> {
  const res = await authFetch(
    `${BASE}/api/cameras/groups/${encodeURIComponent(groupId)}/members`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cameraNames }),
    },
  );
  if (!res.ok) throw new Error(`Failed to add members: ${res.status}`);
  const body = (await res.json()) as { group: CameraGroupInfo };
  return body.group;
}

export async function removeCameraGroupMember(
  groupId: string,
  cameraName: string,
): Promise<CameraGroupInfo> {
  const res = await authFetch(
    `${BASE}/api/cameras/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(cameraName)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Failed to remove member: ${res.status}`);
  const body = (await res.json()) as { group: CameraGroupInfo };
  return body.group;
}

// --- Camera pins (per-user prefs) ---

export async function fetchCameraPins(): Promise<CameraPinInfo[]> {
  const res = await authFetch(`${BASE}/api/cameras/pins`);
  if (!res.ok) throw new Error(`Failed to fetch camera pins: ${res.status}`);
  const body = (await res.json()) as { pins: CameraPinInfo[] };
  return body.pins;
}

export async function addCameraPin(cameraName: string): Promise<CameraPinInfo> {
  const res = await authFetch(`${BASE}/api/cameras/pins`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { pin: CameraPinInfo };
  return body.pin;
}

export async function removeCameraPin(cameraName: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/cameras/pins/${encodeURIComponent(cameraName)}`,
    { method: "DELETE" },
  );
  // 204 has no body; 404 is treated as already-unpinned (idempotent).
  if (!res.ok && res.status !== 404) {
    throw new Error(`Failed to unpin camera: ${res.status}`);
  }
}

export async function reorderCameraPins(
  cameraNames: string[],
): Promise<CameraPinInfo[]> {
  const res = await authFetch(`${BASE}/api/cameras/pins/reorder`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cameraNames }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Failed: ${res.status}`);
  }
  const body = (await res.json()) as { pins: CameraPinInfo[] };
  return body.pins;
}

export async function addCameraManual(
  name: string,
  rtspUrl: string,
  manufacturer?: string,
  model?: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, rtspUrl, manufacturer, model }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to add camera: ${res.status}`);
  }
}

export async function triggerCameraScan(): Promise<{ status: string; known?: number; pending?: number; message?: string }> {
  const res = await authFetch(`${BASE}/api/cameras/scan`, { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
  return res.json();
}

// --- Matter Devices ---

export async function fetchMatterDevices(): Promise<MatterGrouped> {
  const res = await authFetch(`${BASE}/api/matter/devices`);
  if (!res.ok) throw new Error(`Failed to fetch Matter devices: ${res.status}`);
  return res.json();
}

export async function fetchMatterDevice(nodeId: string): Promise<MatterDevice> {
  const res = await authFetch(`${BASE}/api/matter/devices/${nodeId}`);
  if (!res.ok) throw new Error(`Failed to fetch device: ${res.status}`);
  return res.json();
}

export async function sendMatterCommand(
  nodeId: string,
  command: string,
  data?: Record<string, unknown>
): Promise<unknown> {
  const res = await authFetch(
    `${BASE}/api/matter/devices/${nodeId}/command`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, data }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to send command: ${res.status}`);
  }
  return res.json();
}

export async function discoverMatterDevices(): Promise<{ devices: MatterDiscoveredDevice[]; count: number }> {
  const res = await authFetch(`${BASE}/api/matter/discover`);
  if (!res.ok) throw new Error(`Failed to discover devices: ${res.status}`);
  return res.json();
}

export async function commissionMatterDevice(pairingCode: string): Promise<{ nodeId: string }> {
  const res = await authFetch(`${BASE}/api/matter/commission`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pairing_code: pairingCode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to commission device: ${res.status}`);
  }
  return res.json();
}

export async function decommissionMatterDevice(nodeId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/matter/devices/${nodeId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to decommission device: ${res.status}`);
}

// --- Models ---

export async function fetchModels(): Promise<ModelsResponse> {
  const res = await authFetch(`${BASE}/api/llm/models`);
  if (!res.ok) throw new Error(`Failed to fetch models: ${res.status}`);
  return res.json();
}

export async function sendChat(
  request: ChatRequest & {
    signal?: AbortSignal;
    /** WARP-304: continue an existing conversation. Omitted on the first turn. */
    conversationId?: string;
    /** WARP-304: client-supplied idempotency key. Required after WARP-304. */
    turnId?: string;
  },
): Promise<Response> {
  const { signal, ...body } = request;
  return authFetch(`${BASE}/api/llm/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * WARP-304: shape returned by `GET /api/llm/conversations/:id`. The
 * dashboard hydrates `useChat.messages` from this on page mount when the
 * URL carries a `?c=<id>` hash.
 */
export interface PersistedConversation {
  id: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolCalls:
      | Array<{
          id: string;
          name: string;
          args: Record<string, unknown>;
          ok?: boolean;
          status?: string;
          message?: string;
          data?: unknown;
        }>
      | null;
    toolCallId: string | null;
    turnId: string | null;
    /**
     * Lifecycle status of the persisted row. The client uses
     * it to drive failureKind on reloaded messages. Optional because
     * older orchestrator builds didn't return it; treat missing as
     * `completed` defensively.
     */
    status?: "pending" | "streaming" | "completed" | "failed" | "aborted";
    createdAt: string;
  }>;
}

export async function fetchConversation(
  conversationId: string,
): Promise<PersistedConversation | null> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Failed to fetch conversation: ${res.status}`);
  }
  return res.json() as Promise<PersistedConversation>;
}

/**
 * WARP-331 — list a user's conversations newest-first. Paginated.
 * Powers the chat history sidebar on /chat.
 */
export interface ConversationSummary {
  id: string;
  title: string | null;
  model: string | null;
  provider: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listConversations(args: {
  limit: number;
  offset: number;
}): Promise<ConversationSummary[]> {
  const qs = new URLSearchParams({
    limit: String(args.limit),
    offset: String(args.offset),
  });
  const res = await authFetch(`${BASE}/api/llm/conversations?${qs}`);
  if (!res.ok) throw new Error(`Failed to list conversations: ${res.status}`);
  const body = (await res.json()) as { conversations: ConversationSummary[] };
  return body.conversations;
}

/** WARP-331 — rename a conversation. Server trims + clamps to 64 chars.
 *  Returns the canonical stored title. No `updatedAt` is returned because
 *  the service intentionally does not bump the DB column on rename (rename
 *  is metadata; see chat-persistence.service.ts). */
export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<{ id: string; title: string }> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    let body: { error?: string } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    throw new Error(body.error || `Failed to rename conversation: ${res.status}`);
  }
  return res.json() as Promise<{ id: string; title: string }>;
}

/** WARP-331 — delete a conversation. Returns true on 200, false on 404. */
export async function deleteConversation(conversationId: string): Promise<boolean> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    { method: "DELETE" },
  );
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`);
  return true;
}

// --- Brain memory (chat attachments) ---

/** Response shape from POST /api/files/brain/upload. */
export interface BrainUploadResponse {
  itemId: string;
  status: "indexing";
}

/**
 * Upload a chat-attached file to the orchestrator. The route writes the
 * bytes to /data/brain-memory/<userId>/<itemId>/ and publishes
 * droplet/files/brain/uploaded — the file-indexer picks it up and the
 * dashboard receives status flips via the WebSocket bridge on
 * `droplet/files/<userId>/brain/indexed`.
 *
 * `chatId` is optional — if set, the orchestrator stamps it onto the
 * BrainMemoryItem row's `originatingChatId` so a future "scope to this
 * conversation" filter (Phase 2) can do the join.
 */
export async function uploadBrainFile(
  file: File,
  chatId?: string,
): Promise<BrainUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  if (chatId) form.append("chatId", chatId);
  const res = await authFetch(`${BASE}/api/files/brain/upload`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    let body: { error?: string; mimeType?: string; maxBytes?: number } = {};
    try {
      body = await res.json();
    } catch {
      // ignore
    }
    if (res.status === 413) {
      const cap = body.maxBytes ? `${Math.round(body.maxBytes / 1024 / 1024)}MB` : "the size limit";
      throw new Error(`File is too large (over ${cap}).`);
    }
    if (res.status === 415) {
      throw new Error(
        body.mimeType
          ? `Unsupported file type: ${body.mimeType}`
          : "Unsupported file type",
      );
    }
    throw new Error(body.error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

// --- Provider keys ---

export async function saveProviderKey(
  provider: string,
  apiKey: string
): Promise<void> {
  const res = await authFetch(`${BASE}/api/llm/keys/${provider}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_key: apiKey }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save key: ${body}`);
  }
}

export async function listProviderKeys(): Promise<string[]> {
  const res = await authFetch(`${BASE}/api/llm/keys`);
  if (!res.ok) throw new Error(`Failed to list keys: ${res.status}`);
  const data = await res.json();
  return data.providers;
}

export async function deleteProviderKey(provider: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/llm/keys/${provider}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete key: ${res.status}`);
}

// --- Outbound email channel (BUG-11) ---

/** The redacted SMTP-channel config the orchestrator returns (no secret). */
export interface EmailChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string;
  security: "starttls" | "tls" | "none";
  /** Whether a password is stored — the password itself is never returned. */
  hasPassword: boolean;
}

/** What the operator submits. `password` is write-only: omit to keep existing. */
export interface EmailChannelUpdate {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password?: string;
  fromAddress: string;
  fromName: string;
  security: "starttls" | "tls" | "none";
}

export async function getEmailChannel(): Promise<EmailChannelConfig> {
  const res = await authFetch(`${BASE}/api/settings/email`);
  if (!res.ok) throw new Error(`Failed to load email settings: ${res.status}`);
  return res.json();
}

export async function saveEmailChannel(
  update: EmailChannelUpdate,
): Promise<EmailChannelConfig> {
  const res = await authFetch(`${BASE}/api/settings/email`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to save email settings: ${body}`);
  }
  return res.json();
}

// WARP-311: the dashboard's legacy session-CRUD helpers (createSession,
// listSessions, getSession, updateSessionTitle, deleteSession,
// sendSessionChat) targeted the orchestrator's removed
// `/api/llm/sessions/*` proxy routes. They were never imported by any
// page after WARP-104; persistent conversation state now lives behind
// `/api/llm/conversations/*` (WARP-304) — `fetchConversation` above is
// the only consumer.

// --- File operations ---

export async function fetchFiles(path: string): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  return res.json();
}

export function getDownloadUrl(path: string): string {
  return `${BASE}/api/files/download?path=${encodeURIComponent(path)}`;
}

export async function uploadFiles(
  path: string,
  files: FileList | File[],
  onProgress?: (percent: number) => void
): Promise<void> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }

  if (onProgress) {
    // Use XMLHttpRequest for progress events
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${BASE}/api/files/upload?path=${encodeURIComponent(path)}`);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.responseText}`));
        }
      };

      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.send(formData);
    });
  }

  const res = await authFetch(
    `${BASE}/api/files/upload?path=${encodeURIComponent(path)}`,
    { method: "POST", body: formData }
  );
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Upload failed: ${body}`);
  }
}

export async function deleteFile(path: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function createDirectory(path: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to create directory: ${res.status}`);
}

export async function createShareLink(path: string): Promise<ShareInfo> {
  const res = await authFetch(`${BASE}/api/files/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error(`Failed to create share: ${res.status}`);
  return res.json();
}

export async function fetchShares(path: string): Promise<ShareInfo[]> {
  const res = await authFetch(`${BASE}/api/files/shares?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch shares: ${res.status}`);
  const data = await res.json();
  return data.shares;
}

// --- File management (Phase 1) — rename / move / copy / bulk / trash / versions ---

export async function renameFile(
  path: string,
  newName: string
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, newName }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to rename: ${res.status}`);
  }
  const data = await res.json();
  return data.renamed;
}

export async function moveFile(
  from: string,
  to: string,
  overwrite = false
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, overwrite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to move: ${res.status}`);
  }
  const data = await res.json();
  return data.moved;
}

export async function copyFile(
  from: string,
  to: string,
  overwrite = false
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, overwrite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to copy: ${res.status}`);
  }
  const data = await res.json();
  return data.copied;
}

export async function bulkDeleteFiles(
  paths: string[]
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk delete failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function bulkMoveFiles(
  paths: string[],
  toDir: string,
  overwrite = false
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, toDir, overwrite }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk move failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function bulkCopyFiles(
  paths: string[],
  toDir: string,
  overwrite = false
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paths, toDir, overwrite }),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk copy failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function fetchTrash(): Promise<TrashItemInfo[]> {
  const res = await authFetch(`${BASE}/api/files/trash`);
  if (!res.ok) {
    if (res.status === 501) return [];
    throw new Error(`Failed to fetch trash: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

export async function restoreTrashItem(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/trash/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(`Failed to restore: ${res.status}`);
}

export async function deleteTrashItem(name: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/files/trash/item?name=${encodeURIComponent(name)}`,
    { method: "DELETE" }
  );
  if (!res.ok) throw new Error(`Failed to purge trash item: ${res.status}`);
}

export async function emptyTrash(): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/trash`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to empty trash: ${res.status}`);
}

export async function fetchVersions(
  path: string
): Promise<{ fileId: number; versions: FileVersionInfo[] }> {
  const res = await authFetch(
    `${BASE}/api/files/versions?path=${encodeURIComponent(path)}`
  );
  if (!res.ok) {
    if (res.status === 501) return { fileId: 0, versions: [] };
    if (res.status === 404) return { fileId: 0, versions: [] };
    throw new Error(`Failed to fetch versions: ${res.status}`);
  }
  return res.json();
}

export async function restoreVersion(path: string, versionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/versions/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, versionId }),
  });
  if (!res.ok) throw new Error(`Failed to restore version: ${res.status}`);
}

// --- Phase 2: favorites / recents / search / thumbnails / shares v2 ---

export async function toggleFavorite(path: string, favorite: boolean): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, favorite }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update favorite: ${res.status}`);
  }
}

export async function fetchFavorites(): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files/favorites`);
  if (!res.ok) throw new Error(`Failed to fetch favorites: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function fetchRecents(limit = 50): Promise<FileEntryInfo[]> {
  const res = await authFetch(`${BASE}/api/files/recents?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to fetch recents: ${res.status}`);
  const data = await res.json();
  return data.items ?? [];
}

export async function searchFiles(
  query: string,
  opts: { mime?: string; limit?: number } = {}
): Promise<FileEntryInfo[]> {
  const params = new URLSearchParams({ q: query });
  if (opts.mime) params.set("mime", opts.mime);
  if (opts.limit) params.set("limit", String(opts.limit));
  const res = await authFetch(`${BASE}/api/files/search?${params.toString()}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Search failed: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** Build a thumbnail URL for <img src=...>. The orchestrator streams bytes + caches. */
export function getThumbnailUrl(path: string, x = 256, y = 256): string {
  return `${BASE}/api/files/thumbnail?path=${encodeURIComponent(path)}&x=${x}&y=${y}`;
}

export async function createShare(
  path: string,
  opts: ShareCreateOptions = { shareType: 3 }
): Promise<ShareDetail> {
  const res = await authFetch(`${BASE}/api/files/share`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...opts }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Share failed: ${res.status}`);
  }
  return res.json();
}

export async function updateShare(
  shareId: number,
  opts: ShareUpdateOptions
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/share/${shareId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Share update failed: ${res.status}`);
  }
}

export async function deleteShare(shareId: number): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/share/${shareId}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Share delete failed: ${res.status}`);
}

export async function fetchSharedWithMe(): Promise<ShareDetail[]> {
  const res = await authFetch(`${BASE}/api/files/shared-with-me`);
  if (!res.ok) throw new Error(`Failed to fetch shared-with-me: ${res.status}`);
  const data = await res.json();
  return data.shares ?? [];
}

// --- WARP-307: Calendar place autocomplete ---

export interface PlaceSuggestion {
  displayName: string;
  lat: string;
  lon: string;
  type: string | null;
}

/**
 * Hit the orchestrator's Nominatim proxy for fuzzy location suggestions.
 * Returns `[]` on any error so the combobox falls back to free-text.
 */
export async function fetchPlaces(
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<PlaceSuggestion[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const params = new URLSearchParams({ q, limit: String(limit) });
  try {
    const res = await authFetch(`${BASE}/api/calendar/places?${params}`, { signal });
    if (!res.ok) return [];
    const data = await res.json();
    return Array.isArray(data?.places) ? (data.places as PlaceSuggestion[]) : [];
  } catch {
    return [];
  }
}

// --- Phase 4: Semantic content search ---

export interface SemanticSearchResult {
  path: string;
  score: number;
  text: string;
}

export async function searchFileContent(
  query: string,
  limit = 20
): Promise<SemanticSearchResult[]> {
  const params = new URLSearchParams({ q: query, limit: String(limit) });
  const res = await authFetch(`${BASE}/api/files/search/content?${params}`);
  if (!res.ok) {
    if (res.status === 503) return []; // AI gateway down — graceful degrade
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Semantic search failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results ?? [];
}

/**
 * WARP-310: readiness probe for the AI / semantic search toggle. The
 * Files page's SearchBar polls this when the user flips the toggle so
 * it can show a green / yellow / red status pill rather than letting
 * the user type into a search box that returns nothing because the
 * indexer never ran or pgvector isn't installed.
 */
export interface SearchReadinessStatus {
  /** ready = gateway + pgvector + ≥1 indexed chunk; indexing = still empty; unavailable = something is down. */
  state: "ready" | "indexing" | "unavailable";
  gatewayHealthy: boolean;
  pgvectorReady: boolean;
  indexedCount: number;
  lastIndexedAt: string | null;
}

export async function fetchSearchStatus(): Promise<SearchReadinessStatus> {
  const res = await authFetch(`${BASE}/api/files/search/status`);
  if (!res.ok) {
    // Treat any non-200 as "unavailable" so a misconfigured deployment
    // surfaces clearly in the UI rather than throwing an error toast.
    return {
      state: "unavailable",
      gatewayHealthy: false,
      pgvectorReady: false,
      indexedCount: 0,
      lastIndexedAt: null,
    };
  }
  return (await res.json()) as SearchReadinessStatus;
}

// --- Phase 3: device clients + pairing + user admin ---

export async function createPairingCode(data: {
  deviceName: string;
  deviceType: "desktop" | "mobile";
  platform: "macos" | "windows" | "linux" | "ios" | "android" | "other";
}): Promise<PairingCodeInfo> {
  const res = await authFetch(`${BASE}/api/devices/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to generate pairing code: ${res.status}`);
  }
  return res.json();
}

export async function getPairingCodeStatus(code: string): Promise<PairingCodeStatus> {
  const res = await authFetch(`${BASE}/api/devices/pair/${code}/status`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Status lookup failed: ${res.status}`);
  }
  return res.json();
}

export async function fetchDeviceClients(): Promise<DeviceClientInfo[]> {
  const res = await authFetch(`${BASE}/api/devices/clients`);
  if (!res.ok) throw new Error(`Failed to fetch device clients: ${res.status}`);
  const data = await res.json();
  return data.clients ?? [];
}

export async function revokeDeviceClient(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/devices/clients/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to revoke device: ${res.status}`);
  }
}

export async function updateUser(
  username: string,
  data: {
    displayName?: string;
    email?: string;
    quota?: string;
    password?: string;
  }
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users/${username}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update user: ${res.status}`);
  }
}

export async function setUserEnabled(username: string, enabled: boolean): Promise<void> {
  const action = enabled ? "enable" : "disable";
  const res = await authFetch(`${BASE}/api/auth/users/${username}/${action}`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to ${action} user: ${res.status}`);
  }
}

// --- Remote Access (WireGuard VPN) ---

// ── WARP-446: Coverage extender APs ──

export async function fetchApDevices(): Promise<{
  aps: import("./types").ApDeviceInfo[];
  // ADR-005 LRU cap on the discovered-list. Surfaces in the panel so
  // the operator knows when an mDNS flood is filling the queue.
  discoveredCap: number;
  discoveredCapReached: boolean;
}> {
  const res = await authFetch(`${BASE}/api/aps`);
  if (!res.ok) throw new Error(`Failed to fetch extender APs: ${res.status}`);
  return res.json();
}

export async function fetchDiscoveredApDevices(): Promise<{
  discovered: import("./types").ApDeviceInfo[];
  cap: number;
  capReached: boolean;
}> {
  const res = await authFetch(`${BASE}/api/aps/discovered`);
  if (!res.ok) throw new Error(`Failed to fetch discovered extenders: ${res.status}`);
  return res.json();
}

export async function approveApDevice(
  mac: string,
  body: {
    ssid: string;
    encryptionKey: string;
    radio?: string;
    encryption?: string;
    network?: string;
    displayName?: string;
  },
): Promise<{
  ap: import("./types").ApDeviceInfo;
  operationId: string | null;
}> {
  // Colons in MAC are allowed unencoded in path segments per RFC 3986 §3.3.
  const res = await authFetch(`${BASE}/api/aps/${mac}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    // WARP-446 (blocker #7): the orchestrator surfaces a typed
    // `code` on every ApOnboardError (PROVISIONING_TIMEOUT,
    // ROUTER_UNREACHABLE, WIRELESS_CONFIG_REJECTED, UNKNOWN). Attach
    // it to the thrown Error so the panel's AP_ONBOARD_ERROR_COPY
    // table can key on the code rather than regex-matching the raw
    // message.
    const e = new Error(err.error || `Failed to approve extender: ${res.status}`);
    if (err.code) (e as Error & { code?: string }).code = err.code;
    throw e;
  }
  return res.json();
}

export async function decommissionApDevice(
  mac: string,
): Promise<{
  ap: import("./types").ApDeviceInfo;
  operationId: string | null;
}> {
  const res = await authFetch(`${BASE}/api/aps/${mac}/decommission`, {
    method: "POST",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || `Failed to decommission extender: ${res.status}`);
    if (err.code) (e as Error & { code?: string }).code = err.code;
    throw e;
  }
  return res.json();
}

export async function fetchVpnStatus(): Promise<VpnStatusInfo> {
  const res = await authFetch(`${BASE}/api/vpn/status`);
  if (!res.ok) throw new Error(`Failed to fetch Remote Access status: ${res.status}`);
  return res.json();
}

export async function fetchVpnPeers(): Promise<{ peers: VpnPeerInfo[] }> {
  const res = await authFetch(`${BASE}/api/vpn/peers`);
  if (!res.ok) throw new Error(`Failed to fetch peers: ${res.status}`);
  return res.json();
}

export async function createVpnPeer(deviceLabel: string): Promise<VpnPeerCreatedInfo> {
  const res = await authFetch(`${BASE}/api/vpn/peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLabel }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create peer: ${res.status}`);
  }
  return res.json();
}

export async function deleteVpnPeer(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/vpn/peers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to revoke peer: ${res.status}`);
  }
}

// --- DuckDNS ---

export async function fetchDuckDnsStatus(): Promise<DuckDnsStatus> {
  const res = await authFetch(`${BASE}/api/ddns/duckdns`);
  if (res.status === 403) {
    // Surface admin-only as a typed condition the page can render specially.
    throw new Error("403 Admin access required");
  }
  if (!res.ok) throw new Error(`Failed to fetch DuckDNS status: ${res.status}`);
  return res.json();
}

export async function setDuckDnsConfig(opts: {
  subdomain: string;
  // Optional: omit entirely when the customer is keeping a previously
  // stored token. The orchestrator + routing service preserve the
  // existing password value in that case rather than rewriting cleartext.
  token?: string;
  enabled?: boolean;
}): Promise<DuckDnsStatus> {
  const res = await authFetch(`${BASE}/api/ddns/duckdns`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update DuckDNS: ${res.status}`);
  }
  return res.json();
}


// --- WARP-204: /knowledge view (recent + semantic search + brain memory) ---

/** WARP-214 — source-channel signal: what extractor produced the text. */
export type SubtitleSource =
  | "asr_transcript"
  | "embedded"
  | "frame_ocr";

/** WARP-214 — one step in the recursion chain for an attachment / archive member. */
export interface ChainStep {
  filename: string;
  mime: string;
  parentItemId?: string | null;
}

/** WARP-214 — free-form per-chunk metadata. Loose-typed so future extractors can extend. */
export interface ChunkMetadata {
  chain?: ChainStep[];
  subtitle_source?: SubtitleSource | null;
  // Reserve room for future extractor fields without forcing migrations.
  [key: string]: unknown;
}

/** WARP-214 — brain-memory item status — drives the StatusChip rendering. */
export type BrainMemoryItemStatus =
  | "queued_for_transcription"
  | "indexing"
  | "ready"
  | "failed";

/** A row from FileContentChunk shaped for the dashboard. */
export interface KnowledgeChunkItem {
  id: string;
  ncFileId: number;
  path: string;
  chunkIdx: number;
  snippet: string;
  indexedAt: string;
  source: "nextcloud" | "brain";
  brainItemId: string | null;
  pageNumber: number | null;
  // WARP-214: surfaced verbatim from the orchestrator. Null on legacy rows.
  metadata?: ChunkMetadata | null;
}

export interface RecentKnowledgeResponse {
  items: KnowledgeChunkItem[];
  nextBefore: string | null;
}

/** A semantic-search hit shaped for the dashboard + chat citation chips. */
export interface KnowledgeSearchHit {
  source: "nextcloud" | "brain";
  path: string;
  brainItemId?: string | null;
  pageNumber?: number | null;
  score: number;
  snippet: string;
  // WARP-214: surfaced verbatim from the orchestrator. Null on legacy rows.
  metadata?: ChunkMetadata | null;
  /**
   * WARP-287: opaque Nextcloud file id, surfaced so the dashboard can
   * build canonical refs (downloads, admin reindex). Optional because
   * legacy hits / brain hits may not carry it yet — callers fall back
   * to `path` for routing when this is missing.
   */
  ncFileId?: string | null;
  /**
   * WARP-287: per-chunk anchor decoded by the orchestrator. `null` on
   * legacy chunks; the dashboard renders those via `<FileCitation>`.
   * Loose type here because the wire schema is owned by the
   * `@droplet/shared-types` `AnchorSchema` — we trust the orchestrator
   * to validate before publishing.
   */
  anchor?: unknown;
  /**
   * WARP-287: full chunk text (not the snippet — the citation viewer
   * for emails renders this in the modal). Optional; falls back to
   * `snippet` when absent.
   */
  chunkText?: string | null;
  /** WARP-287: MIME type of the underlying file (derived path fallback in UI). */
  mimeType?: string | null;
}

export interface SearchKnowledgeResponse {
  hits: KnowledgeSearchHit[];
}

/** A brain-memory item — best-effort until WARP-203/205 ship the routes. */
export interface BrainMemoryItemInfo {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
  originatingChatId?: string | null;
  // WARP-214: status drives the StatusChip; failureReason surfaces in tooltip.
  status?: BrainMemoryItemStatus;
  failureReason?: string | null;
}

/**
 * Recent indexed chunks for the authed user. The dashboard groups the
 * flat list by Today/Yesterday/This week/This month/Earlier.
 */
export async function getRecentFiles(opts: {
  limit?: number;
  before?: string;
  source?: "nextcloud" | "brain";
} = {}): Promise<RecentKnowledgeResponse> {
  const params = new URLSearchParams();
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.before) params.set("before", opts.before);
  if (opts.source) params.set("source", opts.source);
  const qs = params.toString();
  const url = `${BASE}/api/files/knowledge/recent${qs ? `?${qs}` : ""}`;
  const res = await authFetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load recent files: ${res.status}`);
  }
  return res.json();
}

/**
 * Semantic search over the indexed file chunks. Returns 503 with
 * `search-not-yet-available` until WARP-202 lands the shared
 * file-search.service module — callers should surface that as a
 * graceful "search will be online soon" UI rather than as an error.
 */
export async function searchKnowledge(opts: {
  q: string;
  limit?: number;
  source?: "nextcloud" | "brain";
  since?: string;
}): Promise<SearchKnowledgeResponse | { unavailable: true; retryAfterSeconds?: number }> {
  const params = new URLSearchParams({ q: opts.q });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.source) params.set("source", opts.source);
  if (opts.since) params.set("since", opts.since);
  const res = await authFetch(`${BASE}/api/files/knowledge/search?${params.toString()}`);
  if (res.status === 503) {
    const body = await res.json().catch(() => ({}));
    return { unavailable: true, retryAfterSeconds: body.retryAfterSeconds };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Search failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Brain memory items for the authed user. Best-effort: until WARP-203
 * ships the `/api/files/brain` route this returns an empty list and
 * an `unavailable` flag so the dashboard tab can render a friendly
 * placeholder rather than an error toast.
 */
export async function getBrainMemoryItems(): Promise<{
  items: BrainMemoryItemInfo[];
  unavailable?: boolean;
}> {
  const res = await authFetch(`${BASE}/api/files/brain`);
  if (res.status === 404) {
    return { items: [], unavailable: true };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load brain memory: ${res.status}`);
  }
  const data = await res.json();
  return { items: data.items ?? [] };
}

/**
 * WARP-214 + WARP-218: promote a queued brain memory item to immediate
 * transcription. Discreet "Transcribe now" overflow action on the StatusChip.
 *
 * Returns 404 when WARP-218 isn't merged yet — callers catch
 * `TranscribeNowUnavailable` and hide the menu item.
 */
export class TranscribeNowUnavailable extends Error {
  constructor() {
    super("transcribe-now-not-available");
    this.name = "TranscribeNowUnavailable";
  }
}

export async function transcribeNow(
  itemId: string,
): Promise<{ status: BrainMemoryItemStatus }> {
  const res = await authFetch(
    `${BASE}/api/files/brain/${encodeURIComponent(itemId)}/transcribe-now`,
    { method: "POST" },
  );
  if (res.status === 404) {
    throw new TranscribeNowUnavailable();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `transcribe-now failed: ${res.status}`);
  }
  return res.json();
}

// --- Tools (WARP-555) ---

/**
 * Read-only catalog of the built-in tools the agent can call, grouped by
 * domain, for the `/tools` surface. Backed by `GET /api/llm/tools/catalog`
 * which reads `@droplet/tools-core`'s in-process registry (no MCP child),
 * so it stays available even when the agent runtime is mid-restart. The
 * orchestrator RBAC-filters write tools for non-privileged roles.
 */
export async function fetchToolCatalog(): Promise<ToolCatalogResponse> {
  const res = await authFetch(`${BASE}/api/llm/tools/catalog`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load tools: ${res.status}`);
  }
  return res.json();
}
