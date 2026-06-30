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
  MatterCapabilities,
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
  FileEntryInfo,
  FileSpaceId,
  FileSpacesResponse,
  FileVersionInfo,
  FileCommentInfo,
  FileTagInfo,
  TrashItemInfo,
  BulkOperationResult,
  FirewallConfig,
  HealthResponse,
  ModelsResponse,
  ModelsPagePayload,
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
  ShareRecipient,
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
  DocsStatus,
  DocEditorSession,
} from "./types";
import type {
  EmailAccount,
  EmailAccountsResponse,
  EmailFilter,
  ThreadSummary,
  ThreadsResponse,
  ThreadDetail,
  ThreadAnalysis,
  DraftRow,
  CreateDraftInput,
  PatchDraftInput,
  SendDraftResult,
} from "./types-email";
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
  displayName?: string,
  // WARP-165 — the front-panel claim code, sent ONLY when the physical-presence
  // claim gate is on (checkClaimGateEnabled). Omitted on the default un-gated
  // path so the request body is byte-identical to before. The orchestrator
  // verifies it read-only against the persisted ClaimCode and answers 403
  // CLAIM_CODE_REQUIRED / CLAIM_CODE_INVALID, surfaced via the thrown `code`.
  claimCode?: string,
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/setup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      displayName,
      ...(claimCode ? { claimCode } : {}),
    }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Setup failed") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}

/**
 * WARP-165 — probe whether the physical-presence claim gate is on. Reads the
 * same public, pre-auth `GET /api/auth/setup` endpoint as `checkSetupRequired`
 * (which now also returns `claimGateEnabled`). The setup wizard's Account step
 * uses this to decide whether to show the claim-code field and require it.
 *
 * Fail-SAFE toward NOT showing the field: any non-2xx, network error, timeout,
 * or a body that omits an explicit `true` resolves to `false`. A box where the
 * gate is genuinely on will get an explicit `true`; anything indeterminate must
 * not block a legitimate first-run setup behind a field the server won't
 * actually enforce — mirrors the default-OFF, never-lock-out posture of the
 * gate itself.
 */
export async function checkClaimGateEnabled(): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SETUP_PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/api/auth/setup`, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!res.ok) return false;
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      return false;
    }
    return (data as { claimGateEnabled?: unknown } | null)?.claimGateEnabled === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
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
  displayName?: string,
  // WARP-824: when true (the default), the new user must change this temporary
  // password on first login. Passed through to POST /auth/users which sets the
  // explicit `User.mustChangePassword` flag.
  mustChangePassword = true,
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, displayName, mustChangePassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Failed to create user") as Error & { code?: string };
    err.code = data.code;
    throw err;
  }
}

/**
 * WARP-824 — self-service password change. Used by the forced-change screen an
 * admin-created user lands on, and reusable for any user rotating their own
 * password. Posts the current + new password to the orchestrator, which
 * verifies the current one, enforces the shared policy on the new one, and
 * clears the forced-change flag. Throws an Error carrying the server `code`
 * (INVALID_PASSWORD / WEAK_PASSWORD / SAME_PASSWORD) so the UI can map it to
 * friendly copy.
 */
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/change-password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.error || "Failed to change password") as Error & { code?: string };
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
export async function enrollTotp(signal?: AbortSignal): Promise<TotpEnrollResponse> {
  const res = await authFetch(`${BASE}/api/auth/totp/enroll`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    // WARP-931 — preserve the orchestrator's typed code + status so callers can
    // distinguish e.g. 409 TOTP_ALREADY_ENABLED (returning to an already-set-up
    // 2FA step) from a genuine enroll failure, instead of dropping it to a bare
    // message that translateError can't map.
    throw Object.assign(
      new Error(data.error || "Could not start two-factor setup"),
      { ...(typeof data?.code === "string" ? { code: data.code } : {}), status: res.status },
    );
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
    throw Object.assign(
      new Error(data.error || "That code didn't match. Try again."),
      { ...(typeof data?.code === "string" ? { code: data.code } : {}), status: res.status },
    );
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

/** WARP-662 step 1: adopt (wipe + reformat + mount) a previously-used disk —
 *  returns a confirm token (does NOT wipe yet). `device` is the WHOLE-disk
 *  kernel name (e.g. "sdb" / "nvme0n1"), never a partition. The owner confirms
 *  via confirmPoolCommand to actually execute. The OS disk is refused
 *  server-side by the host script. */
export async function requestAdoptDrive(input: {
  device: string;
  wipeMethod: "quick" | "secure";
  fstype?: string;
  label?: string;
  confirmPhrase: string;
}): Promise<PoolCommandToken> {
  const res = await authFetch(`${BASE}/api/storage/drives/adopt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not start drive adopt: ${res.status}`);
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
 * WARP-828 — the Settings "Danger zone" reformat-a-drive entry points.
 *
 * These are the AC-named, typed aliases for the two-step destructive flow the
 * pool/adopt UI already uses. They wrap the same orchestrator routes
 * (`POST /api/storage/drives/adopt` → 202 token, then
 * `POST /api/storage/command/confirm`) so there is ONE wire path and one place
 * the contract lives; the Danger zone calls these by their intent-named handles
 * rather than the pool-flavoured originals.
 */

/** Step 1: request a confirm token to wipe + reformat + mount a whole disk.
 *  `device` is the WHOLE-disk kernel name ("sdb" / "nvme0n1"), never a
 *  partition — derive it from a DriveInfo with `wholeDiskName()`. Returns 202 +
 *  a single-use token; nothing is erased until {@link confirmStorageCommand}.
 *  Owner/admin only + OS-disk refusal are enforced server-side. */
export async function adoptDrive(input: {
  device: string;
  wipeMethod: "quick" | "secure";
  fstype?: string;
  label?: string;
  confirmPhrase: string;
}): Promise<PoolCommandToken> {
  return requestAdoptDrive(input);
}

/** Step 2: confirm + execute a queued destructive storage op. MUST echo the
 *  `service` + `resourceId` from the minted token (the server refuses a
 *  mismatch). Owner/admin only, enforced server-side. */
export async function confirmStorageCommand(input: {
  confirmationToken: string;
  service: string;
  resourceId: string;
}): Promise<{ ok: boolean; error?: string }> {
  return confirmPoolCommand(input);
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
  // WARP-816: the radio is broadcasting the Droplet's own Wi-Fi on its only
  // radio and can't station-scan. A stable capability fact (HTTP 409), distinct
  // from a successful scan that finds zero networks.
  | "SCAN_UNSUPPORTED"
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

/**
 * WARP-807: codes that mean "the router/routing service can't be reached right
 * now" — a soft, recoverable condition during onboarding (the box's AP may not
 * be up yet), NOT a destructive failure the customer must fix. The orchestrator
 * returns these at HTTP 503.
 */
const ROUTER_UNREACHABLE_CODES: ReadonlySet<RouterErrorCode> = new Set([
  "UNREACHABLE",
  "TIMEOUT",
  "DISABLED",
]);

/**
 * The fixed lead-in of the wizard's "router isn't reachable" notice. The
 * trailing destination is supplied per-surface (see {@link routerUnreachableNotice})
 * because the place to finish the work later differs by step — Wi-Fi/DuckDNS
 * live at the "Network" page, WireGuard peers at "Remote Access". The caller
 * renders the destination as a monospaced span, so it is intentionally kept out
 * of this prefix. (WARP-807 UX review: the old single string pointed everyone at
 * "Settings", which has none of these controls — a dead end.)
 */
export const ROUTER_UNREACHABLE_PREFIX =
  "Your router isn't reachable yet — you can finish this from";

/** The actionable notice, split so the caller can monospace the destination. */
export interface RouterUnreachableNotice {
  /** Lead-in sentence up to (but excluding) the destination name. */
  prefix: string;
  /** The dashboard surface that owns this setting, e.g. "Network". */
  destination: string;
}

/**
 * If `e` represents a router-reachability problem (a `RouterStatusError` with an
 * UNREACHABLE/TIMEOUT/DISABLED code, or any error carrying HTTP 503), return the
 * actionable notice the wizard should render in place of the raw message — split
 * into `{ prefix, destination }` so the caller can monospace the destination and
 * append " later." Otherwise return `null` so the caller falls back to the real
 * error text.
 *
 * @param destination the dashboard surface where this setting can be finished
 *   later (e.g. "Network" for the Internet step, "Remote Access" for VPN).
 */
export function routerUnreachableNotice(
  e: unknown,
  destination: string,
): RouterUnreachableNotice | null {
  const notice = (): RouterUnreachableNotice => ({
    prefix: ROUTER_UNREACHABLE_PREFIX,
    destination,
  });
  if (e instanceof RouterStatusError) {
    if (ROUTER_UNREACHABLE_CODES.has(e.code) || e.status === 503) {
      return notice();
    }
    return null;
  }
  // Defensive: a plain error that still carries a 503 status (shouldn't happen
  // for the typed write paths, but keeps callers robust to other surfaces).
  if (
    e &&
    typeof e === "object" &&
    (e as { status?: unknown }).status === 503
  ) {
    return notice();
  }
  return null;
}

/**
 * WARP-807: shared error-mapper for network WRITE endpoints. The orchestrator's
 * global error handler returns a flat `{ error, message, code }` body. When a
 * trusted RouterError surfaces (e.g. a 503 with code UNREACHABLE), throw a typed
 * `RouterStatusError` so the wizard can branch on `code`/`status` and render an
 * actionable message instead of the raw text. Falls back to a plain `Error`
 * (preserving the prior behavior) for everything else.
 *
 * The caller must pass the already-parsed body (or `{}` on a non-JSON response).
 */
function throwNetworkWriteError(
  body: { error?: unknown; message?: unknown; code?: unknown },
  status: number,
  fallback: string,
): never {
  const code = typeof body.code === "string" ? (body.code as RouterErrorCode) : undefined;
  const message =
    (typeof body.message === "string" && body.message) ||
    (typeof body.error === "string" && body.error) ||
    `${fallback}: ${status}`;
  if (code) {
    throw new RouterStatusError(code, message, status);
  }
  throw new Error(message);
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

/** One row of the full interface enumeration. `present:false` = configured but
 *  not live on this box (render "not on this box", never a fake "down").
 *  `zone`/`address` are null when not joinable/reported, never fabricated. */
export interface NetworkInterfaceRow {
  name: string;
  device: string | null;
  proto: string | null;
  address: string | null;
  zone: string | null;
  up: boolean;
  present: boolean;
}

export async function fetchInterfaces(): Promise<NetworkInterfaceRow[]> {
  const res = await authFetch(`${BASE}/api/network/interfaces`);
  if (!res.ok) throw new Error(`Failed to fetch interfaces: ${res.status}`);
  const data = await res.json();
  return data.interfaces;
}

/** KAN-10: editable fields for an interface create/edit. Only set fields are
 *  sent; `force` is the explicit extra-confirm for a management-interface write. */
export interface InterfaceWriteFields {
  proto?: string;
  device?: string;
  ipaddr?: string;
  netmask?: string;
  gateway?: string;
  force?: boolean;
}

/** KAN-10: add a network interface. Tier 2 — answers 202 confirmation_required,
 *  which the caller confirms via confirmNetworkCommand. Editing /etc/config/network
 *  is high blast radius (a wrong setting can cut this dashboard's connection), so
 *  the orchestrator never applies on the first POST. */
export async function createInterface(
  name: string,
  fields: InterfaceWriteFields & { proto: string },
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/interfaces`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...fields }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.requiresConfirmation) {
    throwNetworkWriteError(data, res.status, "Failed to add interface");
  }
  return data;
}

/** KAN-10: edit a network interface. Tier 2 — same confirm dance as create. */
export async function editInterface(
  name: string,
  fields: InterfaceWriteFields,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/interfaces/${encodeURIComponent(name)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(fields),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.requiresConfirmation) {
    throwNetworkWriteError(data, res.status, "Failed to edit interface");
  }
  return data;
}

/** KAN-10: restart the whole networking stack. Owner-only, Tier 3 — the
 *  orchestrator answers the POST with a 202 + token; the Restart click IS the
 *  consent, so echo it straight back through confirmNetworkCommand. Returns the
 *  operationId (or null) so the caller can show a "restarting…" state. */
export async function restartNetwork(): Promise<{ operationId: string | null }> {
  const res = await authFetch(`${BASE}/api/network/restart`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 202) {
    if (!body?.confirmationToken || !body?.operation) {
      throw new Error("Unexpected 202 response: missing confirmationToken or operation");
    }
    return confirmNetworkCommand(body.confirmationToken, body.operation);
  }
  if (res.ok) {
    return { operationId: body?.operationId ?? null };
  }
  if (res.status === 403) {
    throw new Error(
      (body as { error?: string }).error || "Only the owner can restart networking.",
    );
  }
  throw new Error(
    (body as { error?: string }).error || `Failed to restart networking: ${res.status}`,
  );
}

/** Read-only host-radio detail. Fields are null when iwinfo doesn't report
 *  them (shown as "not reported"); `supported:false`/`hostRadio:true` is the
 *  single combined-radio shape (no independent enable/disable). */
export interface RadioDetail {
  supported: boolean;
  hostRadio: boolean;
  broadcasting: boolean;
  channel: number | null;
  htmode: string | null;
  txpower: number | null;
  country: string | null;
  mode: string | null;
}

export async function fetchRadioDetail(): Promise<RadioDetail> {
  const res = await authFetch(`${BASE}/api/network/wifi/radio`);
  if (!res.ok) throw new Error(`Failed to fetch radio detail: ${res.status}`);
  return res.json();
}

export async function fetchWifiSettings(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/wifi`);
  if (!res.ok) throw new Error(`Failed to fetch wifi settings: ${res.status}`);
  return res.json();
}

export async function scanWifiNetworks(): Promise<WirelessScanResult[]> {
  const res = await authFetch(`${BASE}/api/network/wifi/scan`);
  if (!res.ok) {
    // WARP-816: the orchestrator returns 409 with a flat typed body
    // `{ code: "SCAN_UNSUPPORTED", message }` when the radio is in AP mode and
    // can't station-scan. Surface it as a RouterStatusError so the WiFi panel
    // renders calm "scanning unavailable while broadcasting" copy + disables
    // Scan, instead of an empty list — and never the raw code (WARP-807).
    let body: { code?: unknown; message?: unknown } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON fallthrough */
    }
    const code = typeof body.code === "string" ? (body.code as RouterErrorCode) : undefined;
    if (code) {
      const message =
        (typeof body.message === "string" && body.message) || `Failed to scan wifi: ${res.status}`;
      throw new RouterStatusError(code, message, res.status);
    }
    throw new Error(`Failed to scan wifi: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

export async function setWifiSsid(ssid: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/ssid`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to set SSID");
  return data;
}

export async function setWifiPassword(password: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/password`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to set password");
  return data;
}

export async function setWifiChannel(
  channel: string,
  // WARP-871: pass the LIVE radio section name (read from GET /api/network/wifi)
  // rather than relying on the orchestrator route's `radio0` default, which
  // doesn't exist on the single-box AP radio. Omit to keep the server default.
  radioSection?: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/channel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      radioSection ? { channel, radio_section: radioSection } : { channel },
    ),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to set channel");
  return data;
}

/**
 * Stand up the isolated guest Wi-Fi network (own SSID + firewall zone, internet
 * only). Tier 2 — the orchestrator may answer 202 `confirmation_required`; the
 * caller confirms via {@link confirmNetworkCommand} (the Save click is the
 * consent) and then polls the returned operation.
 */
export async function createGuestWifi(
  ssid: string,
  password: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/guest`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ssid, password }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to set up guest Wi-Fi");
  return data;
}

/** Current guest Wi-Fi state. `password` is the PSK (owner/admin read) for the QR.
 *  `supported` is false on shapes that can't provision a guest network yet (the
 *  single-box hostapd AP) — the card then shows an honest unavailable state. */
export interface GuestWifiStatus {
  configured: boolean;
  enabled: boolean;
  ssid: string | null;
  password: string | null;
  supported: boolean;
}

export async function fetchGuestWifi(): Promise<GuestWifiStatus> {
  const res = await authFetch(`${BASE}/api/network/wifi/guest`);
  if (!res.ok) throw new Error(`Failed to fetch guest Wi-Fi status: ${res.status}`);
  return res.json();
}

/** Tear down the guest network. Applies immediately (drops guests only). */
export async function removeGuestWifi(): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/guest`, { method: "DELETE" });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to turn off guest Wi-Fi");
  return data;
}

/** UPnP / NAT-PMP state. `available` false = miniupnpd isn't on the box. */
export interface UpnpStatus {
  available: boolean;
  enabled: boolean;
}

export async function fetchUpnp(): Promise<UpnpStatus> {
  const res = await authFetch(`${BASE}/api/network/upnp`);
  if (!res.ok) throw new Error(`Failed to fetch UPnP status: ${res.status}`);
  return res.json();
}

/** Toggle UPnP/NAT-PMP. Tier 2 — may answer 202 `confirmation_required`. */
export async function setUpnp(enabled: boolean): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/upnp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to update UPnP");
  return data;
}

export async function fetchDhcpLeases(): Promise<Record<string, unknown>[]> {
  const res = await authFetch(`${BASE}/api/network/dhcp/leases`);
  if (!res.ok) throw new Error(`Failed to fetch DHCP leases: ${res.status}`);
  const data = await res.json();
  return data.leases;
}

/** LAN DHCP pool range + lease time. Fields are null when the box omits them
 *  (a default applies — not "broken"). */
export interface DhcpPool {
  start: string | null;
  limit: string | null;
  leasetime: string | null;
}

export async function fetchDhcpPool(): Promise<DhcpPool> {
  const res = await authFetch(`${BASE}/api/network/dhcp/pool`);
  if (!res.ok) throw new Error(`Failed to fetch DHCP pool: ${res.status}`);
  return res.json();
}

/** Reshape the LAN DHCP pool. Tier 2 — may answer 202 `confirmation_required`,
 *  which the caller confirms via confirmNetworkCommand. */
export async function setDhcpPool(
  start: number,
  limit: number,
  leasetime: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/dhcp/pool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start, limit, leasetime }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.requiresConfirmation) {
    throwNetworkWriteError(data, res.status, "Failed to update DHCP pool");
  }
  return data;
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

/** Add a generic firewall traffic rule. Tier-2 → may return confirmation_required. */
export async function addFirewallRule(rule: {
  name: string;
  src: string;
  dest: string;
  proto?: string;
  destPort?: string;
  srcPort?: string;
  target?: string;
}): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/rule`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: rule.name,
      src: rule.src,
      dest: rule.dest,
      proto: rule.proto ?? "tcp",
      dest_port: rule.destPort,
      src_port: rule.srcPort,
      target: rule.target ?? "REJECT",
    }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to add rule: ${res.status}`);
  return data;
}

/** Set a zone's default input/output/forward policy. Tier-2 → confirmation_required. */
export async function setZonePolicy(policy: {
  zone: string;
  input?: string;
  output?: string;
  forward?: string;
}): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/firewall/zone-policy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(policy),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) throw new Error(data.error || `Failed to set zone policy: ${res.status}`);
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

/**
 * WARP-871: reserve a fixed IP for a device by MAC (DHCP static lease). The
 * orchestrator route (POST /api/network/dhcp/static-lease, owner/admin) maps
 * this to add_static_lease — Tier 1, applies immediately, so there is no 202
 * confirmation step. Returns the NetworkCommandResult (with operationId at
 * runtime) so callers can poll for the safe-apply outcome if they want.
 */
export async function addStaticDhcpLease(
  name: string,
  mac: string,
  ip: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/dhcp/static-lease`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mac, ip }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to add reservation");
  return data;
}

/**
 * WARP-871: set the upstream/custom DNS resolvers the router forwards to
 * (POST /api/network/dns, owner/admin, Tier 1). The orchestrator requires a
 * non-empty list; the UI validates each entry is an IP client-side.
 */
export async function setDnsServers(
  servers: string[],
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/dns`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ servers }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to set DNS servers");
  return data;
}

export async function fetchRouterSystemInfo(): Promise<Record<string, unknown>> {
  const res = await authFetch(`${BASE}/api/network/system`);
  if (!res.ok) throw new Error(`Failed to fetch router system info: ${res.status}`);
  return res.json();
}

// WARP-871: local DNS host-records (name → IP), e.g. nas.lan → 192.168.50.20.
export interface DnsHostRecord {
  section: string;
  hostname: string;
  ip: string;
}

export async function fetchDnsHostnames(): Promise<DnsHostRecord[]> {
  const res = await authFetch(`${BASE}/api/network/dhcp/hostnames`);
  if (!res.ok) throw new Error(`Failed to fetch DNS names: ${res.status}`);
  const data = await res.json();
  return data.entries ?? [];
}

export async function addDnsHostname(
  hostname: string,
  ip: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/dhcp/hostnames`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname, ip }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to add DNS name");
  return data;
}

export async function deleteDnsHostname(
  hostname: string,
): Promise<NetworkCommandResult> {
  const res = await authFetch(
    `${BASE}/api/network/dhcp/hostnames/${encodeURIComponent(hostname)}`,
    { method: "DELETE" },
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to delete DNS name");
  return data;
}

export type DeploymentPosture =
  | "PRIMARY_ROUTER"
  | "DOWNSTREAM_ROUTER"
  | "UNKNOWN";

export interface NetworkTopology {
  posture: DeploymentPosture;
  evidence?: Record<string, unknown>;
}

/**
 * WARP-871: read the deployment posture (ADR-018) for the Overview badge.
 * Best-effort — returns null on any failure so a topology hiccup never breaks
 * the Overview tab.
 */
export async function getNetworkTopology(): Promise<NetworkTopology | null> {
  try {
    const res = await authFetch(`${BASE}/api/network/topology`);
    if (!res.ok) return null;
    return (await res.json()) as NetworkTopology;
  } catch {
    return null;
  }
}

/** Read-only droplet-ai ubus RPC access. Scope chips reflect the live on-box
 *  ACL. Rotate/Revoke aren't here — they're honest-gated (disabled) in the UI. */
export interface AiNetworkAccess {
  user: string;
  endpoint: string;
  readScopes: string[];
  writeScopes: string[];
  session: { active: boolean; expiresAt: number | null; rotates: string };
}

export async function fetchAiNetworkAccess(): Promise<AiNetworkAccess> {
  const res = await authFetch(`${BASE}/api/network/ai-access`);
  if (!res.ok) throw new Error(`Failed to fetch AI agent access: ${res.status}`);
  return res.json();
}

/** Editable system controls + honest gates. `statusLed.supported` /
 *  `country.editable` are false on shapes that can't drive them (single-box). */
export interface SystemControls {
  hostname: string | null;
  ntpEnabled: boolean;
  statusLed: { supported: boolean; enabled: boolean };
  country: { value: string | null; editable: boolean };
}

export async function fetchSystemControls(): Promise<SystemControls> {
  const res = await authFetch(`${BASE}/api/network/system/controls`);
  if (!res.ok) throw new Error(`Failed to fetch system controls: ${res.status}`);
  return res.json();
}

/** Change the hostname. Tier 2 — may answer 202 `confirmation_required`. */
export async function setHostname(hostname: string): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/system/hostname`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hostname }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !data.requiresConfirmation) {
    throwNetworkWriteError(data, res.status, "Failed to change hostname");
  }
  return data;
}

/** Toggle the appliance's OpenWrt NTP daemon. Tier 1 — applies immediately. */
export async function setNtp(enabled: boolean): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/system/ntp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to update time sync");
  return data;
}

// --- Managed switch writes (ADDON-network-switch-management.md §7) ---------
//
// Each is a Tier-2 (Write) command: the POST returns a 202 with a
// confirmation token (`requiresConfirmation: true`), which the caller then
// echoes back through `confirmNetworkCommand` to actually apply. We mirror
// the firewall block/unblock contract precisely — a non-ok response is only
// an error when the server did NOT ask for confirmation (the 202 itself is
// the happy path, not a failure). See useSwitch for the dance.

export async function switchSetPortVlan(
  port: number,
  vlanId: number,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/switch/ports/${port}/vlan`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vlan_id: vlanId }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation)
    throw new Error(data.error || `Failed to change VLAN: ${res.status}`);
  return data;
}

export async function switchSetPortPoe(
  port: number,
  enabled: boolean,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/switch/ports/${port}/poe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation)
    throw new Error(data.error || `Failed to toggle PoE: ${res.status}`);
  return data;
}

export async function switchSetPortEnabled(
  port: number,
  enabled: boolean,
): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/switch/ports/${port}/enable`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation)
    throw new Error(data.error || `Failed to set port state: ${res.status}`);
  return data;
}

export async function switchProvision(): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/switch/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation)
    throw new Error(data.error || `Failed to re-apply switch config: ${res.status}`);
  return data;
}

export type NetworkOperation = {
  id: string;
  // DASH-07: "unknown" is a distinct, non-success terminal state used when the
  // orchestrator can't account for the operation (404). It must NOT be treated
  // as "applied" — see fetchNetworkOperation.
  // "rejected" (routing service) is a neutral no-change terminal state for a 4xx
  // (auth / validation) — the request was refused before any router change, so
  // it is neither a success ("applied") nor a reverted change ("rolled_back").
  state: "pending" | "applied" | "rejected" | "rolled_back" | "unknown";
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

/**
 * Reboot the router (WARP-871). Owner-only (the orchestrator route enforces
 * it). "reboot" is a Tier-3 operation confirmable via the dashboard, so the
 * POST returns 202 + a confirmation token; the Restart click IS the consent,
 * so we echo it straight back through confirmNetworkCommand. Returns the
 * operationId (or null) so the caller can show a "rebooting…" state.
 */
export async function rebootRouter(): Promise<{ operationId: string | null }> {
  const res = await authFetch(`${BASE}/api/network/system/reboot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const body = await res.json().catch(() => ({}));
  if (res.status === 202) {
    if (!body?.confirmationToken || !body?.operation) {
      throw new Error(
        "Unexpected 202 response: missing confirmationToken or operation",
      );
    }
    return confirmNetworkCommand(body.confirmationToken, body.operation);
  }
  if (res.ok) {
    // Tier dropped to immediate (no confirmation needed) — already executing.
    return { operationId: body?.operationId ?? null };
  }
  if (res.status === 403) {
    throw new Error(
      (body as { error?: string }).error ||
        "Only the owner can restart the router.",
    );
  }
  throw new Error(
    (body as { error?: string }).error || `Failed to restart router: ${res.status}`,
  );
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

/** Consume a camera-domain Tier-2 confirmation token (WARP-861).
 *  Pairs with POST /api/cameras/command/confirm — the camera analogue of
 *  /switch/command/confirm. The operation echo is required (WARP-41). */
async function confirmCameraCommand(
  confirmationToken: string,
  operation: string,
): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/command/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationToken, operation }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `Confirm failed: ${res.status}`);
  }
}

export async function disableCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/disable`, { method: "POST" });
  if (!res.ok) throw new Error(`Failed to disable camera: ${res.status}`);
  // disable_camera is Tier 2: the route 202s with a token and does nothing
  // until the token is consumed (WARP-861 — previously this silently
  // no-opped). The user already confirmed in the UI dialog that invoked us,
  // so complete the two-step handshake here.
  if (res.status === 202) {
    const body = (await res.json().catch(() => ({}))) as { confirmationToken?: string };
    if (!body.confirmationToken) throw new Error("Disable requires confirmation but no token was issued");
    await confirmCameraCommand(body.confirmationToken, "disable_camera");
  }
}

export async function removeCamera(name: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`Failed to remove camera: ${res.status}`);
  // delete_camera is Tier 2 — same two-step handshake as disableCamera.
  if (res.status === 202) {
    const body = (await res.json().catch(() => ({}))) as { confirmationToken?: string };
    if (!body.confirmationToken) throw new Error("Remove requires confirmation but no token was issued");
    await confirmCameraCommand(body.confirmationToken, "delete_camera");
  }
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

/**
 * KAN-5: issue a Matter device command and RETURN the response body.
 *
 * A Tier-2 write (lock/unlock, climate setpoint >= 30C) answers HTTP 202
 * `{ status: "confirmation_required", confirmationToken, service, … }` — which
 * is NOT `res.ok`, so the old code fell into the error branch / discarded the
 * body and the write became a silent no-op. We treat 202 as a first-class
 * success: parse it and hand the confirmation_required body back so the caller
 * can surface a confirm affordance and complete via {@link confirmMatterCommand}.
 *
 * Returns the raw orchestrator body (the Tier-1 success object on 200, or the
 * confirmation_required object on 202). Genuine error statuses (400/404/429/5xx)
 * still throw with the server message.
 */
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
  // authFetch returns a native Response; 202 has ok=true per the Fetch spec so
  // the plain !res.ok guard is sufficient — the caller always reads the body.
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to send command: ${res.status}`);
  }
  return res.json();
}

/**
 * KAN-5: confirm + execute a Tier-2 Matter command the orchestrator staged with
 * a 202 `confirmation_required`. POSTs the single-use `confirmationToken` plus
 * the `service` echoed from that 202 (the confirm route REJECTS a missing or
 * mismatched service). On success the orchestrator dispatches the command to
 * the device; the caller should then refresh device state.
 */
export async function confirmMatterCommand(
  nodeId: string,
  confirmationToken: string,
  service: string,
): Promise<{ confirmed: boolean; nodeId: string }> {
  const res = await authFetch(
    `${BASE}/api/matter/devices/${nodeId}/confirm`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmationToken, service }),
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to confirm command: ${res.status}`);
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
    // WARP-851: carry the HTTP status so translateError's status-based
    // dispatch can map the orchestrator's curated commissioning copy
    // (e.g. the 502 discovery failure → network-discovery copy) instead
    // of flattening every failure onto the generic device fallback.
    const err = new Error(
      body.error || `Failed to commission device: ${res.status}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * WARP-851: controller capability surface. Lets the wizard and
 * /devices/add-matter be honest about which commissioning paths work on
 * this box (no BLE today — devices needing Bluetooth first-time setup
 * can't pair until WARP-850 lands).
 */
export async function fetchMatterCapabilities(): Promise<MatterCapabilities> {
  const res = await authFetch(`${BASE}/api/matter/capabilities`);
  if (!res.ok) throw new Error(`Failed to fetch Matter capabilities: ${res.status}`);
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

/**
 * WARP-836 — the read-only Models surface payload (`GET /api/models`).
 *
 * Distinct from {@link fetchModels} (`/api/llm/models`, the chat model
 * selector): this is the status page composer the orchestrator's
 * `models-summary.service` returns — local LLMs + cloud opt-in providers +
 * GPU/latency/spend KPIs. Authenticated GET (open to any principal per
 * ADR-004 §3); `authFetch` carries the session + 401-refresh. `local` may be
 * `[]` when ai-gateway is down, which is a valid 200 the page renders.
 */
export async function fetchModelsPage(): Promise<ModelsPagePayload> {
  const res = await authFetch(`${BASE}/api/models`);
  if (!res.ok) throw new Error(`Failed to fetch models page: ${res.status}`);
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
 * WARP-640 — outcome of a confirmed scene run, i.e. the 200 body from
 * `POST /api/scenes/:id/run` once the single-use confirmation token has been
 * accepted. `successCount < actionCount` means a partial run (some device
 * actions failed); the per-action breakdown rides along in `results`.
 */
export interface SceneRunOutcome {
  sceneId: string;
  successCount: number;
  actionCount: number;
  results: Array<{
    idx: number;
    deviceNodeId: string;
    command: string;
    ok: boolean;
    status?: string;
    error?: string;
  }>;
}

/**
 * WARP-640 — complete an in-chat `run_scene` confirmation. The chat chip mints
 * nothing itself: the orchestrator already replied `202 confirmation_required`
 * with a single-use `confirmationToken`, which the "Approve & run" button
 * echoes straight back here. The route consumes the token (replay-proof) and
 * runs the scene server-side, so the dashboard never has to forge the
 * `?confirm=true` gate the way an operator-initiated run would. A non-2xx
 * (expired/replayed token → 403, pressure → 429, run failure → 5xx) throws so
 * the chip can flip to its failed state and let the user re-ask.
 */
export async function runSceneConfirmed(
  sceneId: string,
  confirmationToken: string,
): Promise<SceneRunOutcome> {
  const res = await authFetch(`${BASE}/api/scenes/${sceneId}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmationToken }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(
      data.error || data.message || `Failed to run scene (${res.status})`,
    ) as Error & { code?: string; status?: number };
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * A smart-home routine (Scene, WARP-474) as listed by `GET /api/scenes` — a
 * named batch of device actions an owner can run in one tap. `actionCount` is
 * how many device commands the routine fires.
 */
export interface Scene {
  id: string;
  name: string;
  icon: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  actionCount: number;
}

/** List the saved routines (scenes). Any signed-in role may read. */
export async function fetchScenes(): Promise<Scene[]> {
  const res = await authFetch(`${BASE}/api/scenes`);
  if (!res.ok) {
    throw new Error(`Failed to load routines (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data?.scenes) ? data.scenes : [];
}

/**
 * Operator-initiated routine run. A routine batches Tier-2 device actions, so
 * the server gates it: the dashboard pops its own confirm dialog and then calls
 * with `?confirm=true` (mirrors the scenes page contract — the chat path uses a
 * minted token via {@link runSceneConfirmed} instead). A non-2xx throws so the
 * caller can surface the failure.
 */
export async function runScene(sceneId: string): Promise<SceneRunOutcome> {
  const res = await authFetch(
    `${BASE}/api/scenes/${sceneId}/run?confirm=true`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.error || data.message || `Failed to run routine (${res.status})`,
    );
  }
  return res.json();
}

/** One device action in a routine: fire `command` (with optional `args`) on a device. */
export interface SceneActionInput {
  deviceNodeId: string;
  command: string;
  args?: Record<string, unknown>;
}
export interface SceneActionDetail extends SceneActionInput {
  id: string;
  idx: number;
}
/** A routine plus its ordered actions — `GET/POST/PATCH /api/scenes[/:id]`. */
export interface SceneDetail {
  id: string;
  name: string;
  icon: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  actions: SceneActionDetail[];
}

/** Full routine + ordered actions. */
export async function getScene(id: string): Promise<SceneDetail> {
  const res = await authFetch(`${BASE}/api/scenes/${id}`);
  if (!res.ok) throw new Error(`Failed to load routine (${res.status})`);
  return res.json();
}

/** Create a routine (owner/admin). Actions are saved in array order. */
export async function createScene(body: {
  name: string;
  icon?: string | null;
  actions: SceneActionInput[];
}): Promise<SceneDetail> {
  const res = await authFetch(`${BASE}/api/scenes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to create routine (${res.status})`);
  }
  return res.json();
}

/**
 * Update a routine (owner/admin). Send `actions` in display order — the server
 * rewrites `idx` from the array (the drag-reorder save path). Pass `icon: null`
 * to clear an icon; omit a field to leave it unchanged.
 */
export async function updateScene(
  id: string,
  patch: { name?: string; icon?: string | null; actions?: SceneActionInput[] },
): Promise<SceneDetail> {
  const res = await authFetch(`${BASE}/api/scenes/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update routine (${res.status})`);
  }
  return res.json();
}

/** Delete a routine (owner/admin). */
export async function deleteScene(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/scenes/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to delete routine (${res.status})`);
  }
}

/**
 * feat/scene-schedules — a recurring cadence bound to a routine (Scene). The
 * orchestrator's scene-schedule ticker runs the routine when `nextFireAt`
 * passes, then advances it from `rrule`. `rrule` is UTC-only (FREQ=DAILY|WEEKLY
 * with BYHOUR/BYMINUTE/BYDAY) — the editor converts the owner's local wall-clock
 * time to UTC before sending. `nextFireAt`/`lastFiredAt` are ISO instants;
 * `lastFiredAt` is null until the first fire.
 */
export interface SceneSchedule {
  id: string;
  sceneId: string;
  rrule: string;
  /** KAN-6 — IANA zone the rrule's wall-clock time is interpreted in. */
  timezone: string;
  nextFireAt: string;
  enabled: boolean;
  createdBy: string | null;
  lastFiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** List the schedules for a routine. Any signed-in role may read. */
export async function fetchSceneSchedules(
  sceneId: string,
): Promise<SceneSchedule[]> {
  const res = await authFetch(`${BASE}/api/scenes/${sceneId}/schedules`);
  if (!res.ok) {
    throw new Error(`Failed to load schedules (${res.status})`);
  }
  const data = await res.json();
  return Array.isArray(data?.schedules) ? data.schedules : [];
}

/**
 * Create a schedule for a routine (owner/admin). `rrule` is a supported
 * wall-clock RRULE (the server 400s a malformed one) and `timezone` is the
 * IANA zone its BYHOUR/BYMINUTE are interpreted in — the editor builds both
 * from the owner's chosen days + local time and the browser's zone (KAN-6).
 * `timezone` is optional; the server defaults it to "UTC" for an older
 * client, preserving the pre-KAN-6 behaviour.
 */
export async function createSceneSchedule(
  sceneId: string,
  rrule: string,
  timezone?: string,
): Promise<SceneSchedule> {
  const res = await authFetch(`${BASE}/api/scenes/${sceneId}/schedules`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(timezone ? { rrule, timezone } : { rrule }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(
      data.error || data.detail || `Failed to create schedule (${res.status})`,
    );
  }
  return res.json();
}

/** Enable / disable a schedule (owner/admin). Re-enabling recomputes nextFireAt. */
export async function toggleSceneSchedule(
  sceneId: string,
  scheduleId: string,
  enabled: boolean,
): Promise<SceneSchedule> {
  const res = await authFetch(
    `${BASE}/api/scenes/${sceneId}/schedules/${scheduleId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to update schedule (${res.status})`);
  }
  return res.json();
}

/** Delete a schedule (owner/admin). */
export async function deleteSceneSchedule(
  sceneId: string,
  scheduleId: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/scenes/${sceneId}/schedules/${scheduleId}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to delete schedule (${res.status})`);
  }
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
  /** WARP-844 — persisted caller system prompt, or null/absent. */
  systemPrompt?: string | null;
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
          /**
           * WARP-640 — re-issue handle for an in-chat confirmation (run_scene).
           * Returned by the orchestrator so a reloaded chip in
           * `confirmation_required` can still render "Approve & run". (review #497)
           */
          confirmation?: {
            kind: string;
            sceneId?: string;
            confirmationToken: string;
          };
        }>
      | null;
    toolCallId: string | null;
    turnId: string | null;
    /**
     * WARP-458 — concatenated reasoning trace persisted for this
     * assistant row, or null/absent when the model produced none.
     */
    reasoning?: string | null;
    /** WARP-844 — thumbs rating, or null when unrated. */
    feedback?: "up" | "down" | null;
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
  /** WARP-845 — owning project, or null when ungrouped. */
  projectId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export async function listConversations(args: {
  limit: number;
  offset: number;
  /** WARP-844 — search needle matching the title or any message content. */
  q?: string;
  /** WARP-845 — restrict to one project's chats (sidebar folder expand). */
  projectId?: string;
}): Promise<ConversationSummary[]> {
  const qs = new URLSearchParams({
    limit: String(args.limit),
    offset: String(args.offset),
  });
  if (args.q) qs.set("q", args.q);
  if (args.projectId) qs.set("projectId", args.projectId);
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
  /**
   * The item's status at response time. A fresh upload is "indexing" (or
   * "queued_for_transcription" for audio/video). A WARP-864 dedup hit
   * against an already-processed file returns that item's CURRENT status
   * — e.g. "ready" — so the chip can reflect it immediately.
   */
  status: "indexing" | "queued_for_transcription" | "ready" | "failed";
  /** WARP-864: true when identical bytes were already uploaded and the
   * existing item was reused instead of ingesting a duplicate. */
  deduplicated?: boolean;
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

// --- Voice input (WARP-844) ---

export class SttUnavailable extends Error {
  constructor() {
    super("stt-unavailable");
    this.name = "SttUnavailable";
  }
}

/**
 * Transcribe raw 16-bit LE mono PCM via the orchestrator's Wyoming STT
 * proxy. Throws SttUnavailable on 503 (whisper sidecar not deployed —
 * macOS dev or non-linux profile) so the composer can hide the mic.
 */
export async function transcribeAudio(
  pcm: ArrayBuffer,
  rate: number,
): Promise<{ text: string }> {
  const res = await authFetch(`${BASE}/api/stt?rate=${rate}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: pcm,
  });
  if (res.status === 503) throw new SttUnavailable();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Transcription failed: ${res.status}`);
  }
  return res.json();
}

// --- Edit & resend (WARP-844) ---

/**
 * Truncate a conversation from a message onward (the message itself plus
 * everything after it). Called before re-sending an edited prompt so the
 * persisted thread matches the visible one.
 */
export async function truncateConversation(
  conversationId: string,
  messageId: string,
): Promise<{ deleted: number }> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to truncate: ${res.status}`);
  }
  return res.json();
}

/**
 * WARP-844 — set (or clear, with null) the thumbs rating on an assistant
 * message. On this appliance the signal feeds the admin retrieval-eval
 * loop rather than any cloud RLHF.
 */
export async function setMessageFeedback(
  conversationId: string,
  messageId: string,
  feedback: "up" | "down" | null,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/feedback`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ feedback }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to save feedback: ${res.status}`);
  }
}

// --- Durable memory facts (WARP-461) ---

/** One durable memory fact — workspace-global, injected into the chat
 *  base prompt and managed via /api/memory/facts. */
export interface MemoryFact {
  id: string;
  category: "Tone" | "Workflow" | "Scope" | "Schedule" | "Other";
  fact: string;
  addedBy: string;
  evidenceChatId: string | null;
  active: boolean;
  /** WARP-845 — who the fact is distributed to (minimum-role ladder
   *  owner > admin > family > guest). */
  audience: "owner" | "admin" | "family" | "guest";
  addedAt: string;
  updatedAt: string;
}

export async function listMemoryFacts(
  opts: { category?: MemoryFact["category"]; active?: boolean; limit?: number } = {},
): Promise<{ facts: MemoryFact[] }> {
  const params = new URLSearchParams();
  if (opts.category) params.set("category", opts.category);
  if (opts.active !== undefined) params.set("active", String(opts.active));
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const qs = params.toString();
  const res = await authFetch(`${BASE}/api/memory/facts${qs ? `?${qs}` : ""}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load memory: ${res.status}`);
  }
  return res.json();
}

export async function createMemoryFact(input: {
  category: MemoryFact["category"];
  fact: string;
  evidenceChatId?: string;
  audience?: MemoryFact["audience"];
}): Promise<{ fact: MemoryFact }> {
  const res = await authFetch(`${BASE}/api/memory/facts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to save fact: ${res.status}`);
  }
  return res.json();
}

export async function updateMemoryFact(
  id: string,
  patch: {
    category?: MemoryFact["category"];
    fact?: string;
    active?: boolean;
    audience?: MemoryFact["audience"];
  },
): Promise<{ fact: MemoryFact }> {
  const res = await authFetch(
    `${BASE}/api/memory/facts/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update fact: ${res.status}`);
  }
  return res.json();
}

export async function deleteMemoryFact(id: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/memory/facts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete fact: ${res.status}`);
  }
}

// --- Chat projects (WARP-845) ---

/** A per-user chat project: a sidebar folder plus a default persona the
 *  dashboard seeds into new chats started inside it. */
export interface ChatProject {
  id: string;
  name: string;
  systemPrompt: string | null;
  chatCount: number;
  createdAt: string;
  updatedAt: string;
}

export async function listChatProjects(): Promise<{ projects: ChatProject[] }> {
  const res = await authFetch(`${BASE}/api/llm/projects`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load projects: ${res.status}`);
  }
  return res.json();
}

export async function createChatProject(input: {
  name: string;
  systemPrompt?: string | null;
}): Promise<{ project: ChatProject }> {
  const res = await authFetch(`${BASE}/api/llm/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create project: ${res.status}`);
  }
  return res.json();
}

export async function updateChatProject(
  id: string,
  patch: { name?: string; systemPrompt?: string | null },
): Promise<{ project: ChatProject }> {
  const res = await authFetch(
    `${BASE}/api/llm/projects/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update project: ${res.status}`);
  }
  return res.json();
}

export async function deleteChatProject(id: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/llm/projects/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete project: ${res.status}`);
  }
}

/** Move a conversation into (or out of, with null) one of the caller's
 *  projects. Chats survive project deletion server-side (FK SET NULL). */
export async function setConversationProject(
  conversationId: string,
  projectId: string | null,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to move conversation: ${res.status}`);
  }
}

// --- Context pins (WARP-460) ---

/** One per-session context pin — injected into the system prompt on
 *  every turn of the session by the orchestrator (routes/llm.ts). */
export interface ContextPin {
  id: string;
  sessionId: string;
  kind: "folder" | "file" | "email_thread" | "camera" | "camera_window";
  ref: string;
  meta?: Record<string, unknown> | null;
  addedAt: string;
}

export async function listContextPins(
  sessionId: string,
): Promise<{ pins: ContextPin[] }> {
  const res = await authFetch(
    `${BASE}/api/llm/${encodeURIComponent(sessionId)}/pins`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load pins: ${res.status}`);
  }
  return res.json();
}

export async function createContextPin(
  sessionId: string,
  pin: { kind: ContextPin["kind"]; ref: string; meta?: Record<string, unknown> },
): Promise<{ pin: ContextPin }> {
  const res = await authFetch(
    `${BASE}/api/llm/${encodeURIComponent(sessionId)}/pins`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pin),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to add pin: ${res.status}`);
  }
  return res.json();
}

export async function deleteContextPin(
  sessionId: string,
  pinId: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/llm/${encodeURIComponent(sessionId)}/pins/${encodeURIComponent(pinId)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to remove pin: ${res.status}`);
  }
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

export async function fetchFiles(
  path: string,
  space: FileSpaceId = "personal"
): Promise<FileEntryInfo[]> {
  const qs = new URLSearchParams({ path });
  // Only send the space param for the shared space — keeps the personal
  // request URL (and its SWR cache key) byte-identical to the pre-WARP-883
  // shape so nothing else has to change.
  if (space === "shared") qs.set("space", "shared");
  const res = await authFetch(`${BASE}/api/files?${qs.toString()}`);
  if (!res.ok) throw new Error(`Failed to fetch files: ${res.status}`);
  return res.json();
}

// WARP-883 (ADR-027 WS-5) — which Files spaces exist for this user. Drives the
// My Files / Shared switcher; the switcher hides itself when shared is absent.
export async function fetchSpaces(): Promise<FileSpacesResponse> {
  const res = await authFetch(`${BASE}/api/files/spaces`);
  if (!res.ok) throw new Error(`Failed to fetch spaces: ${res.status}`);
  return res.json();
}

export function getDownloadUrl(path: string): string {
  return `${BASE}/api/files/download?path=${encodeURIComponent(path)}`;
}

// --- WARP-882: in-browser editing + co-authoring ---

/**
 * Document-server availability. Drives the gated "Edit" affordance — the button
 * only renders when this returns `ready` AND the file is an editable Office MIME
 * (no dead buttons). Cheap + ~10s-cached server-side.
 */
export async function getDocsStatus(): Promise<DocsStatus> {
  const res = await authFetch(`${BASE}/api/files/docs/status`);
  if (!res.ok) throw new Error(`docs status failed: ${res.status}`);
  return res.json();
}

/**
 * Open an editor session for a file. The orchestrator decides edit-vs-view
 * SERVER-SIDE (owner / NC update permission); the client never asks for a mode.
 * Throws on 401 (re-login), 503 (engine unavailable), 404 (file gone).
 */
export async function getEditorSession(path: string): Promise<DocEditorSession> {
  const res = await authFetch(
    `${BASE}/api/files/${encodeFilePathParam(path)}/editor-session`,
  );
  if (!res.ok) {
    // Read the body ONCE — a Response stream can't be consumed twice.
    let detail = "";
    try {
      const body = await res.text();
      try {
        detail = JSON.parse(body)?.code ?? body;
      } catch {
        detail = body;
      }
    } catch {
      /* body unavailable */
    }
    // Attach structured props so callers can branch on status/code without
    // parsing the message string (avoids coupling to the exact message format).
    throw Object.assign(
      new Error(`editor session failed: ${res.status}${detail ? ` (${detail})` : ""}`),
      { status: res.status, code: detail || undefined },
    );
  }
  return res.json();
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

// WARP-883 (WS-1 fast-follow): the backend now returns the full ShareDetail
// shape for a path's existing shares, so the ShareDialog can render them with
// expiry/password/permissions. Returns [] on a missing `shares` field.
export async function fetchShares(path: string): Promise<ShareDetail[]> {
  const res = await authFetch(`${BASE}/api/files/shares?path=${encodeURIComponent(path)}`);
  if (!res.ok) throw new Error(`Failed to fetch shares: ${res.status}`);
  const data = await res.json();
  return (data.shares ?? []) as ShareDetail[];
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

// --- WARP-881 / WS-3 (ADR-027): native file comments + tags ---

/**
 * Encode a Nextcloud file path for the `:filePath(*)` wildcard routes:
 * encode each segment (so `#`, `?`, spaces are safe) but KEEP the slashes
 * so the server's wildcard still sees the directory structure. Strips a
 * leading slash — the route re-adds it.
 */
function encodeFilePathParam(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

export async function fetchFileComments(path: string): Promise<FileCommentInfo[]> {
  const res = await authFetch(
    `${BASE}/api/files/${encodeFilePathParam(path)}/comments`,
  );
  if (!res.ok) {
    if (res.status === 404) return [];
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch comments: ${res.status}`);
  }
  const data = await res.json();
  return data.comments ?? [];
}

export async function addFileComment(
  path: string,
  body: string,
): Promise<FileCommentInfo> {
  const res = await authFetch(
    `${BASE}/api/files/${encodeFilePathParam(path)}/comments`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body }),
    },
  );
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Failed to add comment: ${res.status}`);
  }
  const data = await res.json();
  return data.comment;
}

export async function deleteFileComment(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/comments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Failed to delete comment: ${res.status}`);
  }
}

export async function fetchFileTags(path: string): Promise<FileTagInfo[]> {
  const res = await authFetch(`${BASE}/api/files/${encodeFilePathParam(path)}/tags`);
  if (!res.ok) {
    if (res.status === 404) return [];
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch tags: ${res.status}`);
  }
  const data = await res.json();
  return data.tags ?? [];
}

export async function addFileTag(path: string, label: string): Promise<FileTagInfo> {
  const res = await authFetch(`${BASE}/api/files/${encodeFilePathParam(path)}/tags`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Failed to add tag: ${res.status}`);
  }
  const data = await res.json();
  return data.tag;
}

export async function deleteFileTag(path: string, label: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/files/${encodeFilePathParam(path)}/tags/${encodeURIComponent(label)}`,
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 204) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Failed to delete tag: ${res.status}`);
  }
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

/**
 * WARP-879 / WS-1 — household members the internal-sharing picker can target.
 * The orchestrator reads the local directory (ADR-013), so this is reachable
 * by every household role, not just admins.
 */
export async function fetchShareRecipients(): Promise<ShareRecipient[]> {
  const res = await authFetch(`${BASE}/api/files/share-recipients`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch share recipients: ${res.status}`);
  }
  const data = await res.json();
  return data.recipients ?? [];
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

/**
 * WARP-880 / WS-2 — content-search modes:
 *   - semantic: pgvector cosine similarity (needs the AI gateway)
 *   - keyword:  lexical full-text (websearch_to_tsquery); works gateway-down
 *   - hybrid:   embed + RRF fusion of lexical + vector arms
 */
export type FileSearchMode = "semantic" | "keyword" | "hybrid";

export async function searchFileContent(
  query: string,
  limit = 20,
  mode: FileSearchMode = "semantic"
): Promise<SemanticSearchResult[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    mode,
  });
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
    throwNetworkWriteError(body, res.status, "Failed to create peer");
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
    throwNetworkWriteError(body, res.status, "Failed to update DuckDNS");
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
export async function getBrainMemoryItems(
  opts: {
    /** Filter to items uploaded in one chat (BrainMemoryItem.originatingChatId).
     *  Used to rehydrate the composer's attachment chips on conversation load. */
    originatingChatId?: string;
  } = {},
): Promise<{
  items: BrainMemoryItemInfo[];
  unavailable?: boolean;
}> {
  const params = new URLSearchParams();
  if (opts.originatingChatId) {
    params.set("originatingChatId", opts.originatingChatId);
  }
  const qs = params.toString();
  const res = await authFetch(`${BASE}/api/files/brain${qs ? `?${qs}` : ""}`);
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

// --- Admin capabilities (nav-gating for optional admin surfaces) ---

export interface AdminCapabilities {
  /** /admin/claude-activity is wired (GitHub token OR Jira configured). */
  claudeActivity: boolean;
  /** /admin/rag-eval is wired (RAG_EVAL_URL set). */
  ragEval: boolean;
}

/**
 * Probe which optional admin surfaces the orchestrator has configured, so the
 * sidebar can hide nav entries that would otherwise lead to a dead page
 * (#14 Activity, #15 RAG eval). Admin-only on the backend (403 for non-admins);
 * the consuming hook treats any failure as "all off".
 */
export async function fetchCapabilities(): Promise<AdminCapabilities> {
  const res = await authFetch(`${BASE}/api/admin/capabilities`);
  if (!res.ok) throw new Error(`Failed to fetch capabilities: ${res.status}`);
  return res.json();
}

// --- WARP-825: Settings Danger Zone — factory reset ---

/** Lifecycle of a factory-reset job, mirroring the orchestrator ResetJobStatus
 *  enum. There is no `succeeded` — a completed reset wipes the db this row lives
 *  in; the dashboard treats `dispatched` as terminal-success for its progress
 *  view. */
export type ResetJobStatus = "requested" | "dispatched" | "failed";

export interface ResetJob {
  id: string;
  status: ResetJobStatus;
  targetName: string;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ResetStatusResponse {
  /**
   * MASKED hint of the device name (e.g. "d••••••t"). The API deliberately
   * never returns the verbatim confirm value — the owner types the real name
   * from Settings → Device information, and the server validates it. (A
   * verbatim value here let the modal display the exact string to copy/paste,
   * removing the per-device type-to-confirm friction.) `job.targetName` in
   * this response is masked with the same rule.
   */
  targetHint: string;
  /** The latest reset job, or null on a box that has never been reset. */
  job: ResetJob | null;
}

/** GET the reset status: a masked hint of the target name + the latest job. */
export async function getResetStatus(): Promise<ResetStatusResponse> {
  const res = await authFetch(`${BASE}/api/system/reset`);
  if (!res.ok) throw new Error(`Failed to load reset status: ${res.status}`);
  return res.json();
}

/**
 * Trigger the factory reset. `confirm` is the device name the owner typed; it is
 * re-validated SERVER-side (the client gate is not the authority). Resolves to
 * the dispatched job; throws with the orchestrator's friendly message on a
 * mismatch (400), an in-flight reset (409), or an unavailable executor (503).
 */
export async function triggerFactoryReset(confirm: string): Promise<{
  status: ResetJobStatus;
  id: string;
  targetName: string;
}> {
  const res = await authFetch(`${BASE}/api/system/reset`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Factory reset failed: ${res.status}`);
  }
  return res.json();
}

// --- Diagnostics log bundle (WARP-823) ---

export interface LogBundleOptions {
  /** Look-back window in hours (1-168). Defaults server-side to 24. */
  windowHours?: number;
  /** Optional single-service filter. */
  service?: string;
}

/**
 * Download the secret-redacted diagnostics log bundle as a .zip Blob.
 *
 * POSTs to `/api/logs/bundle` (owner/admin only) and returns the archive bytes.
 * The orchestrator redacts every secret value before the bytes leave the box;
 * the caller just hands the Blob to the browser's download plumbing. On any
 * non-2xx the bridge/route error message is surfaced for the friendly UI line —
 * never a stack.
 */
export async function downloadLogBundle(
  opts: LogBundleOptions = {},
): Promise<Blob> {
  const res = await authFetch(`${BASE}/api/logs/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error || body.message || `Couldn't collect logs: ${res.status}`,
    );
  }
  return res.blob();
}

// --- Email (WARP-837) ---
//
// Front-end client for the orchestrator's `/api/email/*` routes (verified
// against origin/main). Reads follow the file's throw-on-non-2xx convention;
// the one deliberate exception is `sendDraft`, which maps the server's 451
// `off_lan_blocked` into a TYPED result rather than throwing, so the UI can
// render a calm, actionable message instead of a crash (mirrors the 202/429
// typed-result shape used by `retryFailedContextItem`).

/** List the household's connected mailboxes (RBAC-scoped server-side). */
export async function fetchEmailAccounts(): Promise<EmailAccount[]> {
  const res = await authFetch(`${BASE}/api/email/accounts`);
  if (!res.ok) throw new Error(`Failed to fetch email accounts: ${res.status}`);
  const body = (await res.json()) as EmailAccountsResponse;
  return body.accounts ?? [];
}

/**
 * List threads in `filter` for an account. The filter is wired into the query
 * string the route reads; a foreign / missing account returns 404 (the IDOR
 * guard) which we surface as a throw for the hook's error channel.
 */
export async function fetchEmailThreads(
  accountId: string,
  filter: EmailFilter,
): Promise<ThreadSummary[]> {
  const params = new URLSearchParams({ filter });
  const res = await authFetch(
    `${BASE}/api/email/${encodeURIComponent(accountId)}/threads?${params}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch threads: ${res.status}`);
  const body = (await res.json()) as ThreadsResponse;
  return body.threads ?? [];
}

/** Fetch a full thread with its messages (ascending receivedAt). */
export async function fetchEmailThread(
  accountId: string,
  threadId: string,
): Promise<ThreadDetail> {
  const res = await authFetch(
    `${BASE}/api/email/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}`,
  );
  if (!res.ok) throw new Error(`Failed to fetch thread: ${res.status}`);
  return res.json();
}

/**
 * Fetch the AI side-panel analysis for a thread. The route answers 503 when the
 * analysis service isn't wired yet — we throw so SWR's retry kicks in (the
 * orchestrator comment explicitly chose 503 over 500 for that reason).
 */
export async function fetchThreadAnalysis(
  accountId: string,
  threadId: string,
): Promise<ThreadAnalysis> {
  const res = await authFetch(
    `${BASE}/api/email/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}/analysis`,
  );
  if (!res.ok) throw new Error(`Failed to fetch thread analysis: ${res.status}`);
  return res.json();
}

/** Create a draft on an account (optionally tied to a thread). Returns 201. */
export async function createDraft(
  accountId: string,
  input: CreateDraftInput,
): Promise<DraftRow> {
  const res = await authFetch(
    `${BASE}/api/email/${encodeURIComponent(accountId)}/drafts`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create draft: ${res.status}`);
  }
  return res.json();
}

/** Edit a draft. 409 once the draft is no longer in `draft` status. */
export async function patchDraft(
  id: string,
  patch: PatchDraftInput,
): Promise<DraftRow> {
  const res = await authFetch(
    `${BASE}/api/email/drafts/${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update draft: ${res.status}`);
  }
  return res.json();
}

/**
 * The friendly fallback shown if the server's 451 carries no `message`. Mirrors
 * the off-LAN allowlist vocabulary (FEATURES §8) and points the user at the one
 * place this is changed — Settings — never this surface.
 */
const OFF_LAN_BLOCKED_FALLBACK =
  "Sending email leaves your Droplet, and outbound email is currently turned off. An admin can enable it in Settings under the off-LAN allowlist.";

/**
 * Queue a draft for send (owner/admin only, server-enforced). Returns a TYPED
 * result:
 *   - 202 → `{ status: "queued", id }`
 *   - 451 → `{ status: "off_lan_blocked", message, channel }` (NOT a throw) so
 *           the UI renders an actionable "outbound email is off" message.
 * Any other non-2xx (404 not found, 409 already dispatched, 5xx) throws.
 */
export async function sendDraft(id: string): Promise<SendDraftResult> {
  const res = await authFetch(
    `${BASE}/api/email/drafts/${encodeURIComponent(id)}/send`,
    { method: "POST" },
  );
  if (res.status === 451) {
    const body = (await res.json().catch(() => ({}))) as {
      message?: string;
      channel?: string;
    };
    return {
      status: "off_lan_blocked",
      message: body.message || OFF_LAN_BLOCKED_FALLBACK,
      channel: body.channel || "outbound_email",
    };
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to send draft: ${res.status}`);
  }
  const body = (await res.json()) as { id: string; status: string };
  return { status: "queued", id: body.id };
}
