import {
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BATCH_BYTES,
} from "@droplet/shared-types";
import type {
  CameraInfo,
  CameraGroupInfo,
  CameraPinInfo,
  CameraSettings,
  CameraSettingsPatch,
  CameraSystemStatus,
  CameraStorageSummary,
  CameraBudget,
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
  CurrentWifi,
  DetectionEvent,
  DeviceInfo,
  DiscoveredCamera,
  CameraCandidateList,
  CameraScanResult,
  MatterCapabilities,
  MatterDevice,
  MatterDiscoveredDevice,
  MatterGrouped,
  Room,
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
  ModelsCatalogPayload,
  NetworkCommandResult,
  NetworkOverview,
  StorageStats,
  DrivesResponse,
  PoolsResponse,
  PoolInfo,
  DriveLabel,
  WirelessScanResult,
  AuthUser,
  RosterUser,
  InviteCreateRequest,
  CreateUserRole,
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
  OverlayLinkToken,
  PendingOverlayEnrollment,
  OverlayApproveResult,
  VoiceStatusInfo,
  VoiceSayResult,
  VoiceCalibrationInfo,
  VoiceCalibrationApply,
  VoiceMeasureResult,
  VoiceEchoCheckResult,
  VoiceRestartResult,
  VoiceCalibrationModeResult,
  VoiceProfilesResult,
  VoiceEnrollStartResult,
  VoiceEnrollCaptureResult,
  VoiceEnrollVerifyResult,
  VoiceEnrollCommitResult,
  VoiceActivityItem,
  BoxNameCheckResult,
  BoxNameSetResult,
  BoxNameCurrentResult,
  BoxNameRenameResult,
  ToolCatalogResponse,
  DocsStatus,
  DocEditorSession,
  UsagePolicy,
  UsageWithMeta,
  AdminFilesUsageResponse,
  Department,
  DepartmentDetail,
  DepartmentRight,
  CreateDepartmentPayload,
  DepartmentMembership,
  AccessRole,
  AccessRolePayload,
  AccessSyncState,
  AccessStartingPoint,
  AccessExceptionInput,
  EffectiveAccess,
} from "./types";
import type { RouterPortDisableGuard } from "@/lib/types/router-ports";
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

export async function fetchUsers(): Promise<{ users: RosterUser[] }> {
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
  // WARP-1042: optional CANONICAL role (Role enum minus `service`). Omitted →
  // the orchestrator defaults to `family`; the server enforces the
  // roleOutranks cap so a caller can never assign a role above their own.
  role?: CreateUserRole,
): Promise<void> {
  const res = await authFetch(`${BASE}/api/auth/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email,
      password,
      displayName,
      mustChangePassword,
      ...(role !== undefined ? { role } : {}),
    }),
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

/** Step 1: create a pool — returns a confirm token (does NOT create yet).
 *  WARP-1337: `displayName` optionally names the pool at birth — on the
 *  confirmed create the orchestrator seeds the StoragePool row with it, so
 *  the pool never shows up as a bare md device / GUID mount. */
export async function requestCreatePool(input: {
  device: string;
  level: PoolInfo["level"];
  members: string[];
  confirmPhrase: string;
  displayName?: string;
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

/** WARP-936 step 1: format an existing (e.g. created-but-never-formatted)
 *  pool — returns a confirm token (does NOT format yet). The owner confirms
 *  via confirmPoolCommand / confirmStorageCommand to execute. The host
 *  script's typed-phrase gate requires `confirmPhrase` to name the md device
 *  (buildConfirmPhrase(["md127"]) → "ERASE md127"). */
export async function requestFormatPool(
  device: string,
  input: { confirmPhrase: string; fstype?: string },
): Promise<PoolCommandToken> {
  const res = await authFetch(
    `${BASE}/api/storage/pools/${encodeURIComponent(device)}/format`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    },
  );
  if (res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not start pool format: ${res.status}`);
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

/** WARP-1048 step 1: reclaim a pool-MEMBER disk into standalone use — returns
 *  a confirm token (does NOT touch the array yet). `device` is the WHOLE-disk
 *  kernel name ("sda"); `md` is the bare md<N> array it currently belongs to.
 *  The host script detaches the member (mdadm --fail/--remove +
 *  --zero-superblock) before the wipe+reformat+mount adopt flow. The owner
 *  confirms via confirmStorageCommand to actually execute. The OS disk is
 *  refused server-side by the host script. */
export async function reclaimDrive(input: {
  device: string;
  md: string;
  wipeMethod?: "quick" | "secure";
  fstype?: string;
  label?: string;
  confirmPhrase: string;
}): Promise<PoolCommandToken> {
  const res = await authFetch(`${BASE}/api/storage/drives/reclaim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (res.status !== 202) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Could not start drive reclaim: ${res.status}`);
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
  // WARP-1141: the bridge reports uuid:"" when the filesystem has no
  // /dev/disk/by-uuid link (degraded / auto-read-only pools). An empty uuid
  // builds PATCH /api/storage/drives/ — a different route — so fail loudly
  // here instead of letting the label vanish into a mis-routed request.
  if (!uuid) {
    throw new Error(
      "This drive doesn't have a stable identifier right now, so it can't be renamed.",
    );
  }
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
    throw storageWriteError(body, res.status, "Failed to update drive");
  }
  return res.json();
}

/**
 * WARP-1141: rename failures must translate to actionable copy, not the
 * generic files-domain fallback ("We couldn't load those files…") that made a
 * blocked rename read as a load hiccup. Carry the HTTP status (+ the server's
 * typed `code` when present) on the thrown error so `translateError`'s
 * status/code dispatch can fire. Mirrors `throwNetworkWriteError`'s shape.
 */
function storageWriteError(
  body: { error?: unknown; code?: unknown },
  status: number,
  fallback: string,
): Error {
  const err = new Error(
    (typeof body.error === "string" && body.error) || `${fallback}: ${status}`,
  ) as Error & { status?: number; code?: string };
  err.status = status;
  if (typeof body.code === "string") err.code = body.code;
  return err;
}

/**
 * WARP-1048: rename (+ annotate) a storage pool. Owner/admin-only server-side,
 * mirrors updateDriveLabel. `device` is the bare md<N> name. First call for a
 * pool requires `displayName`; the server resolves the pool's live RAID level
 * from the bridge to create the row. Returns the full StoragePool row.
 */
export async function updatePoolLabel(
  device: string,
  patch: {
    displayName?: string;
    notes?: string | null;
  },
): Promise<PoolInfo> {
  const res = await authFetch(
    `${BASE}/api/storage/pools/${encodeURIComponent(device)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw storageWriteError(body, res.status, "Failed to update pool");
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

/** Cert-lifecycle snapshot from the PUBLIC tls-status route (ADR-023 §3,
 *  WARP-1302). Carries no secrets — state, the CT-public FQDN, and whether
 *  HQ issuance is configured at all. */
export interface TlsStatus {
  state: string;
  fqdn: string | null;
  hqConfigured: boolean;
}

export async function fetchTlsStatus(): Promise<TlsStatus> {
  // Public endpoint (no auth) — the same payload the gateway's plain-HTTP
  // status page polls. WARP-1342: dashboard chrome reads `fqdn` to upgrade
  // the identity chip off the droplet.local fallback.
  const res = await fetch(`${BASE}/api/tls/status`, {
    credentials: "include",
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch TLS status: ${res.status}`);
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
 * because the place to finish the work later differs by step — Wi-Fi settings
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

/**
 * WARP-1714: the Wi-Fi this household is broadcasting, so the Wi-Fi card opens
 * showing the network it's about to edit. `source` names where the answer came
 * from (the router's own radio, or a coverage AP); `source: null` with a
 * populated `detail` means we couldn't read it and why — which is NOT the same
 * as "no Wi-Fi is set", and the card must not render the two identically.
 */
export async function fetchCurrentWifi(): Promise<CurrentWifi> {
  const res = await authFetch(`${BASE}/api/network/wifi/current`);
  if (!res.ok) throw new Error(`Failed to fetch current Wi-Fi: ${res.status}`);
  return res.json();
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

/** Band-steering state of the external Droplet AP (WARP-1703). `supported`
 *  false = no approved Droplet access point is online (or its software
 *  predates the feature) — the card then shows an honest unavailable state. */
export interface BandSteeringStatus {
  supported: boolean;
  enabled: boolean;
}

export async function fetchBandSteering(): Promise<BandSteeringStatus> {
  const res = await authFetch(`${BASE}/api/network/wifi/band-steering`);
  if (!res.ok) throw new Error(`Failed to fetch band steering status: ${res.status}`);
  return res.json();
}

/** Toggle band steering on the Droplet AP. Tier 1 — applies immediately;
 *  poll the returned operationId for the apply-vs-rollback outcome. */
export async function setBandSteering(enabled: boolean): Promise<NetworkCommandResult> {
  const res = await authFetch(`${BASE}/api/network/wifi/band-steering`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throwNetworkWriteError(data, res.status, "Failed to update band steering");
  return data;
}

// ── WARP-1712: the access point's own Wi-Fi ──
//
// Read live off the AP every time — there is no cached copy anywhere, so the
// Network tab's form and the Coverage Extenders card can never disagree.

/** One radio on the AP, config joined with live iwinfo state. */
export interface ApRadioInfo {
  section: string;
  radio: string | null;
  /** '2g' / '5g' / '6g' as the AP reports it. */
  band: string | null;
  ssid: string | null;
  encryption: string | null;
  /** Configured channel — 'auto' is a legal value. */
  channel: string | null;
  htmode: string | null;
  disabled: boolean;
  /** The interface that owns the household name (the one writes target). */
  primary: boolean;
  ifname: string | null;
  up: boolean | null;
  live_channel: number | null;
  live_htmode: string | null;
  clients: number | null;
}

export interface ApDeviceHardwareInfo {
  model: string | null;
  firmware: string | null;
  hostname: string | null;
  uptime_seconds: number | null;
}

/** Household AP Wi-Fi. `supported: false` = no approved Droplet AP online. */
export interface ApWifiStatus {
  supported: boolean;
  ssid: string | null;
  /** What the AP names the 5 GHz network (`<ssid>-5g` when steering is off). */
  fiveGhzSsid: string | null;
  /** The live per-unit passphrase, revealable rather than ssh-only. */
  key: string | null;
  encryption: string | null;
  bandSteering: boolean | null;
  apCount: number;
  /** False = the online APs aren't all broadcasting the same name. */
  inSync: boolean;
}

/** Per-AP live detail behind a Coverage Extenders card. */
export interface ApWirelessDetail {
  mac: string;
  supported: boolean;
  ap_detail?: string;
  band_steering?: boolean | null;
  ssid?: string | null;
  key?: string | null;
  encryption?: string | null;
  five_ghz_ssid?: string | null;
  radios: ApRadioInfo[];
  device?: ApDeviceHardwareInfo;
}

export async function fetchApWifi(): Promise<ApWifiStatus> {
  const res = await authFetch(`${BASE}/api/network/wifi/ap`);
  if (!res.ok) throw new Error(`Failed to fetch access point Wi-Fi: ${res.status}`);
  return res.json();
}

/**
 * Set the AP's network name and/or passphrase. A name-only save is Tier 1 and
 * applies immediately; a save carrying a passphrase is Tier 2 and answers 202
 * `confirmation_required` — the caller confirms, then polls the operation.
 */
export async function setApWifi(body: {
  ssid?: string;
  key?: string;
}): Promise<NetworkCommandResult & { ssid?: string | null; fiveGhzSsid?: string | null }> {
  const res = await authFetch(`${BASE}/api/network/wifi/ap`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throwNetworkWriteError(data, res.status, "Failed to update access point Wi-Fi");
  }
  return data;
}

export async function fetchApWirelessDetail(mac: string): Promise<ApWirelessDetail> {
  // Colons in a MAC are legal unencoded in a path segment (RFC 3986 §3.3).
  const res = await authFetch(`${BASE}/api/aps/${mac}/wireless`);
  if (!res.ok) throw new Error(`Failed to fetch access point radios: ${res.status}`);
  return res.json();
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

/**
 * WARP-1907 — the server refused a jack write that needs the extra
 * acknowledgement, and told us which guard and why.
 *
 * Thrown for the race the cached read cannot cover: a jack published with
 * `disable_guard: null` that gains a cable between the poll and the click. The
 * panel catches this and raises its second, destructive confirm from
 * `guard.reason` — the same escalation it would have shown had the read been
 * current. Without it the user meets a bare "409" and retrying fails until the
 * next poll.
 */
export class RouterPortRefusedError extends Error {
  readonly code = "PORT_WRITE_REFUSED" as const;
  readonly guard: RouterPortDisableGuard;
  constructor(guard: RouterPortDisableGuard) {
    super(guard.reason);
    this.name = "RouterPortRefusedError";
    this.guard = guard;
  }
}

/** Narrow the orchestrator's `detail` without trusting it into the union. */
function asPortGuard(value: unknown): RouterPortDisableGuard | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { code?: unknown; reason?: unknown };
  if (v.code !== "WAN_PORT" && v.code !== "MANAGEMENT_PORT") return null;
  if (typeof v.reason !== "string" || !v.reason) return null;
  return { code: v.code, reason: v.reason };
}

/**
 * WARP-1907 — turn a physical ROUTER jack on or off.
 *
 * `force` is the user's second acknowledgement, and only ever set by the
 * escalated confirm dialog. The routing service refuses a disable of the WAN
 * jack or of a live management jack with 409 without it, so sending it
 * speculatively would quietly delete that guard for every write.
 */
export async function routerSetPortEnabled(
  port: string,
  enabled: boolean,
  force = false,
): Promise<NetworkCommandResult> {
  const res = await authFetch(
    `${BASE}/api/network/ports/${encodeURIComponent(port)}/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled, force }),
    },
  );
  const data = await res.json();
  if (!res.ok && !data.requiresConfirmation) {
    // A guard refusal is not a dead end — it is a question the panel can ask.
    const guard = data?.code === "PORT_WRITE_REFUSED" ? asPortGuard(data.detail) : null;
    if (guard) throw new RouterPortRefusedError(guard);
    // Everything else keeps `message`/`code`/`status` so `translateError` can
    // do its job instead of meeting a bare Error.
    throw Object.assign(
      new Error(data.message || data.error || `Failed to set port state: ${res.status}`),
      { code: data.code, status: res.status },
    );
  }
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
  if (!res.ok) throw await confirmFailure(res);
  const body = await res.json();
  return { operationId: body?.operationId ?? null };
}

/**
 * WARP-1907 — build the error for a refused confirm WITHOUT discarding the body.
 *
 * This layer used to read only `res.status`, which made the guard escalation
 * unreachable on the path that actually runs. A jack write is always classified
 * Tier 2, so the mint POST returns 202 and the 409 `PORT_WRITE_REFUSED` — the
 * race where a jack gains a cable between the cached read and the click — can
 * only ever arrive HERE, on the confirm. `routerSetPortEnabled` translates that
 * code, but it only ever sees the mint response, so the panel met a bare
 * `Error`, `err instanceof RouterPortRefusedError` never matched, and the
 * documented second confirm never opened.
 *
 * Shared with the switch, Wi-Fi, DHCP and firewall confirms, so it stays
 * generic: preserve `code`/`status` for `translateError` the way
 * `routerSetPortEnabled` already does, and keep the old string as the fallback
 * for a body that carries no message of its own.
 */
async function confirmFailure(res: Response): Promise<Error> {
  // A refused confirm is not guaranteed to be JSON — a proxy 502 is HTML — so
  // the error path must degrade to the generic error rather than throw a
  // parse failure over the top of the real one.
  const data = await res.json().catch(() => null);
  const guard = data?.code === "PORT_WRITE_REFUSED" ? asPortGuard(data.detail) : null;
  if (guard) return new RouterPortRefusedError(guard);
  return Object.assign(
    new Error(data?.message || data?.error || `Failed to confirm command: ${res.status}`),
    { code: data?.code, status: res.status },
  );
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

/**
 * WARP-1893 — rename a camera to a household-facing label.
 *
 * Writes `displayName` only. The camera's `name` is the Frigate config key
 * that owns its recording paths and event history, so it is never changed —
 * this is a label, and existing footage is unaffected. Takes effect
 * immediately with no NVR restart, which is why it saves through its own
 * endpoint rather than the settings patch.
 */
export async function renameCamera(
  name: string,
  displayName: string,
): Promise<{ status: string; camera: string; displayName: string }> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to rename camera: ${res.status}`);
  }
  return (await res.json()) as { status: string; camera: string; displayName: string };
}

/** WARP-1851 — read a camera's current storage allocation. */
export async function fetchCameraBudget(name: string): Promise<CameraBudget> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/budget`);
  if (!res.ok) throw new Error(`Failed to fetch camera budget: ${res.status}`);
  return (await res.json()) as CameraBudget;
}

/**
 * WARP-1851 — set or clear a camera's storage budget.
 *
 * `budgetBytes: null` clears it and returns the camera to manual
 * retention. Clearing never deletes footage; the response says so.
 */
export async function setCameraBudget(
  name: string,
  budgetBytes: number | null,
): Promise<CameraBudget> {
  const res = await authFetch(`${BASE}/api/cameras/${encodeURIComponent(name)}/budget`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ budgetBytes }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `Failed to set budget: ${res.status}`);
  }
  return (await res.json()) as CameraBudget;
}

/**
 * WARP-1850 — per-camera storage breakdown.
 *
 * Unlike the system status, this deliberately throws when the orchestrator
 * answers 503: an empty breakdown would read as "no camera is using disk",
 * and the caller must show a degraded state instead of a reassuring zero.
 */
export async function fetchCameraStorage(): Promise<CameraStorageSummary> {
  const res = await authFetch(`${BASE}/api/cameras/storage`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Failed to fetch camera storage: ${res.status}`);
  }
  return (await res.json()) as CameraStorageSummary;
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

/**
 * Cameras found on the network but not yet added, plus whether the scanner is
 * even running (WARP-1847). Use this over fetchDiscoveredCameras() anywhere the
 * "discovery isn't running" case has to read differently from "found nothing".
 */
export async function fetchCameraCandidates(): Promise<CameraCandidateList> {
  const res = await authFetch(`${BASE}/api/cameras/discovered`);
  if (!res.ok) throw new Error(`Failed to fetch discovered cameras: ${res.status}`);
  const body = await res.json();
  // Tolerate the pre-WARP-1847 bare-array shape so a dashboard newer than the
  // orchestrator it's talking to still renders (mixed-version box mid-deploy).
  if (Array.isArray(body)) return { cameras: body, discoveryOnline: true };
  return {
    cameras: Array.isArray(body?.cameras) ? body.cameras : [],
    discoveryOnline: body?.discoveryOnline !== false,
  };
}

/** Candidate list only. Kept for callers that don't need the online flag. */
export async function fetchDiscoveredCameras(): Promise<DiscoveredCamera[]> {
  return (await fetchCameraCandidates()).cameras;
}

export async function acceptDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${encodeURIComponent(id)}/accept`, {
    method: "POST",
  });
  if (!res.ok) {
    // The orchestrator mirrors camera-discovery's 422 prose ("stream did not
    // verify — the RTSP path or credentials are likely wrong"), which is the
    // whole answer for the operator. Surface it instead of a status code.
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to accept camera: ${res.status}`);
  }
}

export async function rejectDiscoveredCamera(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/cameras/discovered/${encodeURIComponent(id)}/reject`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Failed to ignore camera: ${res.status}`);
  }
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

/**
 * Run a discovery sweep and return what it found. The scan is synchronous
 * upstream, so `cameras` is already the post-scan list — no polling needed
 * (WARP-1847; this used to return counts the caller couldn't act on).
 */
export async function triggerCameraScan(): Promise<CameraScanResult> {
  const res = await authFetch(`${BASE}/api/cameras/scan`, { method: "POST" });
  if (!res.ok) throw new Error(`Scan failed: ${res.status}`);
  const body = await res.json();
  return {
    status: typeof body?.status === "string" ? body.status : "scan_complete",
    known: body?.known,
    pending: body?.pending,
    message: body?.message,
    cameras: Array.isArray(body?.cameras) ? body.cameras : [],
    // A scan that reached camera-discovery proves it's running; the explicit
    // scan_unavailable envelope is the one case where it isn't.
    discoveryOnline: body?.status !== "scan_unavailable",
  };
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

// --- WARP-1396: rooms + device aliases (the household map) ---

export async function fetchRooms(): Promise<Room[]> {
  const res = await authFetch(`${BASE}/api/matter/rooms`);
  if (!res.ok) throw new Error(`Failed to fetch rooms: ${res.status}`);
  const body = (await res.json()) as { rooms: Room[] };
  return body.rooms;
}

async function roomWrite(
  path: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  const res = await authFetch(`${BASE}/api/matter/${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(j.message || `Request failed: ${res.status}`);
  }
  return res;
}

export async function createRoom(name: string, icon: string): Promise<Room> {
  const res = await roomWrite("rooms", "POST", { name, icon });
  return res.json();
}

export async function updateRoom(
  id: string,
  patch: { name?: string; icon?: string; sortOrder?: number },
): Promise<Room> {
  const res = await roomWrite(`rooms/${encodeURIComponent(id)}`, "PATCH", patch);
  return res.json();
}

export async function deleteRoom(id: string): Promise<void> {
  await roomWrite(`rooms/${encodeURIComponent(id)}`, "DELETE");
}

/** Rename and/or (re)assign a device's room in one call. `name: null`/`""`
 *  clears the alias; `roomId: null` moves it to "No room yet". */
export async function setDeviceAlias(
  nodeId: string,
  patch: { name?: string | null; roomId?: string | null },
): Promise<{ nodeId: string; name: string | null; roomId: string | null }> {
  const res = await roomWrite(
    `devices/${encodeURIComponent(nodeId)}/alias`,
    "PUT",
    patch,
  );
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

export async function discoverMatterDevices(
  signal?: AbortSignal,
): Promise<{ devices: MatterDiscoveredDevice[]; count: number }> {
  // WARP-1281 (review follow-up on #996): callers may bound the browse —
  // the wizard aborts at 25s so a stalled transport can't wedge its serial
  // chain. Guarded with instanceof because useSmartHome uses this function
  // directly as an SWR fetcher, and SWR invokes fetchers with the string
  // KEY as the first argument — that must not reach fetch() as `signal`.
  const res = await authFetch(`${BASE}/api/matter/discover`, {
    signal: signal instanceof AbortSignal ? signal : undefined,
  });
  if (!res.ok) {
    // WARP-1281: carry the HTTP status (same pattern as
    // commissionMatterDevice / WARP-851) so the setup wizard can tell
    // "Matter controller not started" (503) apart from a transient
    // transport failure and surface an honest service-down state
    // instead of fake-scanning.
    const err = new Error(
      `Failed to discover devices: ${res.status}`,
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
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

/**
 * WARP-1469: nudge a still-paired but offline device to reconnect now. The
 * controller answers immediately ({ status: "reconnecting" }); the actual
 * result lands later via the /api/matter/devices/events SSE stream (the
 * device list flips connectionState), so callers just revalidate + poll.
 */
export async function reconnectMatterDevice(
  nodeId: string,
): Promise<{ status: string; nodeId: string }> {
  const res = await authFetch(`${BASE}/api/matter/devices/${nodeId}/reconnect`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Failed to reconnect device: ${res.status}`);
  return res.json();
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

/**
 * WARP-1112 — change the box's active local chat model (`PATCH
 * /api/models/active`). Owner/admin only (the orchestrator enforces the
 * role; a 403 surfaces here as an error). `model` must be an installed local
 * model tag — the server validates against the live list and 400s
 * `not_installed` otherwise. Returns the new active model + whether it
 * actually changed (a no-op re-select returns `changed:false`).
 */
export async function setActiveModel(
  model: string,
): Promise<{ activeModel: string; changed: boolean }> {
  const res = await authFetch(`${BASE}/api/models/active`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  if (!res.ok) {
    // Surface the orchestrator's typed error so the page can word it
    // honestly (not_installed / ai_service_unreachable / 403).
    let detail = `Failed to set active model: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail || body?.error) detail = body.detail ?? body.error;
    } catch {
      /* non-JSON error body — keep the status-code message */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * WARP-836 — measure a local model's throughput (`POST /api/models/:name/
 * benchmark`). Owner/admin only. Explicit by design: benchmarking loads the
 * model (and with one-model-at-a-time can briefly evict the resident chat
 * model), so it's never run automatically. Returns the measured tokens/sec.
 */
export async function benchmarkModel(
  name: string,
): Promise<{ tokensPerSec: number; measuredAt: string }> {
  const res = await authFetch(
    `${BASE}/api/models/${encodeURIComponent(name)}/benchmark`,
    { method: "POST" },
  );
  if (!res.ok) {
    let detail = `Failed to measure model speed: ${res.status}`;
    try {
      const body = await res.json();
      if (body?.detail || body?.error) detail = body.detail ?? body.error;
    } catch {
      /* non-JSON error body — keep the status-code message */
    }
    throw new Error(detail);
  }
  return res.json();
}

/**
 * WARP-1827 — the eligible model catalog (`GET /api/models/catalog`): what
 * this box COULD run (VRAM-gated appliance-side by the inference-manager),
 * with per-model `pulled` flags. Authenticated GET, open to any principal
 * (ADR-004 §3, same as the page payload). Uncached end-to-end so `pulled`
 * is always fresh.
 */
export async function fetchModelsCatalog(): Promise<ModelsCatalogPayload> {
  const res = await authFetch(`${BASE}/api/models/catalog`);
  if (!res.ok) throw new Error(`Failed to fetch model catalog: ${res.status}`);
  return res.json();
}

/**
 * WARP-1827 — start a catalog download (`POST /api/models/:name/pull`,
 * owner/admin) and hand back the RAW response: on 200 the body is an NDJSON
 * progress stream the caller reads incrementally (same pattern as
 * {@link sendChat}); non-2xx bodies carry the orchestrator's typed error
 * (not_eligible / already_pulled / insufficient_disk / ai_service_unreachable)
 * for the caller to word honestly.
 */
export async function startModelPull(name: string): Promise<Response> {
  return authFetch(`${BASE}/api/models/${encodeURIComponent(name)}/pull`, {
    method: "POST",
    headers: { Accept: "application/x-ndjson" },
  });
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
     * WARP-904 — the model/provider this specific turn actually ran on,
     * or null/absent on rows persisted before this column existed.
     */
    model?: string | null;
    provider?: string | null;
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
  /** WARP-1917 — pinned to the top of the sidebar. Optional (missing on
   *  older orchestrator builds → treated as unpinned); `pinnedAt` orders
   *  the Pinned section, most recent pin first. */
  pinned?: boolean;
  pinnedAt?: string | null;
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
  /** WARP-905: the applied ingest policy. 'await_approval' means the upload
   * is HELD (not embedded) until it is approved. Absent on partial-deploy
   * windows before WARP-905 lands → treat as 'auto_embed'. */
  ingestPolicy?: BrainIngestPolicy;
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
 *
 * WARP-905: `ingestPolicy` is optional — pass 'await_approval' to HOLD the
 * upload for human approval instead of embedding it immediately. Omitted /
 * 'auto_embed' preserves the historical embed-on-upload behaviour.
 */
export async function uploadBrainFile(
  file: File,
  chatId?: string,
  ingestPolicy?: BrainIngestPolicy,
): Promise<BrainUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  if (chatId) form.append("chatId", chatId);
  if (ingestPolicy) form.append("ingestPolicy", ingestPolicy);
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

/**
 * WARP-905 — release a brain-memory item that was HELD under
 * ingestPolicy='await_approval'. Flips the policy to 'auto_embed' and
 * re-drives ingestion (the file-indexer, now unblocked, extracts + embeds;
 * audio/video go through the transcription worker). The subsequent status
 * flips arrive over the WS bridge like any other upload.
 */
export async function approveBrainItem(
  itemId: string,
): Promise<{ itemId: string; status: BrainMemoryItemStatus; ingestPolicy: BrainIngestPolicy }> {
  const res = await authFetch(
    `${BASE}/api/files/brain/${encodeURIComponent(itemId)}/approve`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Approve failed: ${res.status}`);
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
  category: "Tone" | "Workflow" | "Scope" | "Schedule" | "Other" | "Business";
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

/** WARP-1917 — pin (true) or unpin (false) a chat in the history sidebar.
 *  Server-side state on the conversation row; the PATCH deliberately does
 *  not bump updatedAt, so unpinning restores the chronological position. */
export async function setConversationPinned(
  conversationId: string,
  pinned: boolean,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/llm/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinned }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(
      body.error ||
        `Failed to ${pinned ? "pin" : "unpin"} conversation: ${res.status}`,
    );
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

// --- WARP-1121: business profile + onboarding interview ---

export type BusinessOnboardingState =
  | "not_started"
  | "in_progress"
  | "completed"
  | "skipped"
  | "re_running";

/** GET /api/business-profile is role-split server-side: owner/admin get every
 *  field; family gets `summary` only; guest/service get `{}`. Everything is
 *  optional here so one type serves all roles. */
export interface BusinessProfileView {
  onboardingState?: BusinessOnboardingState;
  interviewChatId?: string | null;
  /** WARP-1668 — owner/admin only: is the parked interview session one THIS
   *  user can actually open? `interviewChatId` cannot answer that (sessions
   *  are owner-scoped and the FK is `onDelete: SetNull`), so the server
   *  resolves it. Absent ⇒ treat as false: an orchestrator that predates the
   *  field must not paint a resume banner that cannot act. */
  interviewResumable?: boolean;
  summary?: string;
  whatWeDo?: string;
  customers?: string;
  teamShape?: string;
  toolsUsed?: string;
  typicalDay?: string;
  goals?: string;
  lastSource?: "onboarding" | "settings" | null;
  reviewNudgeState?: "none" | "due" | "dismissed";
  updatedAt?: string;
}

export async function fetchBusinessProfile(): Promise<BusinessProfileView> {
  const res = await authFetch(`${BASE}/api/business-profile`);
  if (!res.ok) throw new Error(`Failed to load business profile: ${res.status}`);
  return res.json();
}

export async function patchBusinessProfile(
  update: Partial<Record<
    "summary" | "whatWeDo" | "customers" | "teamShape" | "toolsUsed" | "typicalDay" | "goals",
    string
  >>,
): Promise<BusinessProfileView> {
  const res = await authFetch(`${BASE}/api/business-profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) throw new Error(`Failed to save business profile: ${res.status}`);
  return res.json();
}

export interface OnboardingStartResult {
  conversationId: string;
  state: BusinessOnboardingState;
  created: boolean;
}

/** 409 = another admin moved the state first (finished-elsewhere banner). */
export async function startBusinessOnboarding(): Promise<OnboardingStartResult> {
  const res = await authFetch(`${BASE}/api/business-onboarding/start`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`onboarding_start_${res.status}`);
  return res.json();
}

export async function skipBusinessOnboarding(): Promise<{
  from: BusinessOnboardingState;
  state: BusinessOnboardingState;
}> {
  const res = await authFetch(`${BASE}/api/business-onboarding/skip`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`onboarding_skip_${res.status}`);
  return res.json();
}

export interface OnboardingCommitPayload {
  profile?: Partial<Record<
    "whatWeDo" | "customers" | "teamShape" | "toolsUsed" | "typicalDay" | "goals",
    string
  >>;
  summary?: string;
  facts?: Array<{ category: string; fact: string; audience: string }>;
}

export async function commitBusinessOnboarding(
  payload: OnboardingCommitPayload,
): Promise<{ state: BusinessOnboardingState; factsSaved: number }> {
  const res = await authFetch(`${BASE}/api/business-onboarding/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`onboarding_commit_${res.status}`);
  return res.json();
}

export async function dismissReviewNudge(): Promise<void> {
  const res = await authFetch(`${BASE}/api/business-profile/review-dismiss`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`review_dismiss_${res.status}`);
}

// --- AI personality (WARP-1119, Settings → Workspace → AI personality) ---

export type PersonaPreset =
  | "warm_friendly"
  | "professional_precise"
  | "founder"
  | "direct_technical";
export type PersonaVerbosity = "concise" | "balanced" | "detailed";

/**
 * GET /api/persona is role-split server-side (WARP-1118 §7.3): owner/admin
 * receive every field; family/guest receive `preset` + `verbosity` only.
 * Everything beyond those two is therefore optional here — the card gates
 * its edit surface on the caller's role, not on field presence.
 */
export interface PersonaSettings {
  preset: PersonaPreset;
  verbosity: PersonaVerbosity;
  useFirstNames?: boolean;
  customInstructions?: string;
  updatedBy?: string | null;
  updatedAt?: string;
}

export interface PersonaUpdate {
  preset?: PersonaPreset;
  verbosity?: PersonaVerbosity;
  useFirstNames?: boolean;
  customInstructions?: string;
}

export async function fetchPersona(): Promise<PersonaSettings> {
  const res = await authFetch(`${BASE}/api/persona`);
  if (!res.ok) throw new Error(`Failed to load personality settings: ${res.status}`);
  return res.json();
}

/** PATCH only the changed fields (the route requires at least one). A 400 —
 *  e.g. customInstructions over the 1200-char cap — throws; the card keeps
 *  the user's edits and shows the failed state (reject, never truncate). */
export async function patchPersona(update: PersonaUpdate): Promise<PersonaSettings> {
  const res = await authFetch(`${BASE}/api/persona`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(update),
  });
  if (!res.ok) {
    throw new Error(`Failed to save personality settings: ${res.status}`);
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
  // WARP-1623: send the space for EVERY non-personal space, matching every
  // other space-threaded helper below. The original gate named "shared"
  // literally, from when FileSpaceId was a two-member union; WARP-1261 widened
  // it to `dept:<uuid>` server-side and this branch silently dropped those, so
  // a library listing resolved through personal semantics and returned the
  // caller's home root. Personal still sends nothing, which keeps that request
  // URL (and its SWR cache key) byte-identical to the pre-WARP-883 shape.
  if (space !== "personal") qs.set("space", space);
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

/**
 * Same bytes as `getDownloadUrl`, served for RENDERING rather than saving.
 *
 * The preview modal hands this URL to `<object>` / `<video>` / `<audio>`, and
 * those tags obey `Content-Disposition: attachment` by downloading — so a
 * preview built on the plain download URL pops a Save-As dialog over an empty
 * modal instead of showing the file. `?disposition=inline` asks the orchestrator
 * for `Content-Disposition: inline` plus a real Content-Type.
 *
 * The server grants inline only for a safelist of inert media types (no
 * `text/html`, no `image/svg+xml` — both execute script on our own origin), and
 * falls back to an attachment for anything else. So this is safe to use for any
 * file: a non-previewable one simply behaves as it does today.
 */
export function getPreviewUrl(path: string): string {
  return `${BASE}/api/files/download?path=${encodeURIComponent(path)}&disposition=inline`;
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

// WARP-1262 (T10): every write call below takes an optional `space` — the
// orchestrator's write routes now resolve+gate the operational path
// server-side (`?space=`/body `space`, mirroring the read routes' own
// contract at `fetchFiles` above). Kept out of the request entirely for
// "personal" so the URL/body shape — and any test/cache assertions pinned
// to it — stays byte-identical to before WARP-883 introduced spaces.
/**
 * Thrown when part of a multi-batch selection failed to upload.
 *
 * WARP-1666: selections past `MAX_FILES_PER_UPLOAD` go out as several requests,
 * so "the upload failed" stopped being the whole truth — some files are already
 * on the box. `uploaded` is how many actually landed. Successful batches are
 * deliberately NOT rolled back: the caller surfaces the count and the user
 * retries to pick up the remainder.
 *
 * WARP-1843: a failed batch no longer aborts the run — the remaining batches
 * are still attempted, so the files that didn't land can be a non-contiguous
 * slice of the selection. `failedFiles` names them (in selection order) and
 * `cause` carries the FIRST batch failure as the representative error. The
 * original `uploaded` / `total` / `cause` shape is unchanged for existing
 * callers.
 */
export class UploadBatchError extends Error {
  readonly name = "UploadBatchError";

  constructor(
    readonly uploaded: number,
    readonly total: number,
    readonly cause: unknown,
    /** Names of the files that did NOT land, in selection order (WARP-1843). */
    readonly failedFiles: readonly string[] = []
  ) {
    super(`Uploaded ${uploaded} of ${total} files`);
  }
}

/**
 * WARP-1912 — shape a non-2xx upload answer into a STRUCTURED error.
 *
 * `translateError` never surfaces `err.message` (the no-echo rule), so a
 * plain `Error("Upload failed: <body>")` flattened every rejection into the
 * generic files fallback — which is exactly how a too-large .dmg (nginx's
 * 100M `client_max_body_size` answers 413 with an HTML page; the
 * orchestrator's per-user multer cap answers 413 with JSON) read as "try
 * again in a moment" for a file that can never fit. Same fix as WARP-1914's
 * `FileSearchError`: the HTTP status plus the orchestrator's stable wire
 * `code` / `limitMb` ride on the error so `uploadOutcomeMessage` can name
 * the real reason. The raw body stays in `message` for DevTools only.
 */
function uploadRejectionError(status: number, body: string): Error {
  let code: string | undefined;
  let limitMb: number | undefined;
  try {
    const parsed = JSON.parse(body) as {
      code?: unknown;
      limitMb?: unknown;
    };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.limitMb === "number") limitMb = parsed.limitMb;
  } catch {
    /* non-JSON (nginx HTML error page) — the status carries the truth */
  }
  return Object.assign(new Error(`Upload failed: ${body}`), {
    status,
    code,
    limitMb,
  });
}

/** POST a single batch — never more files than the server accepts at once. */
async function uploadBatch(
  url: string,
  batch: File[],
  onFraction?: (fraction: number) => void
): Promise<void> {
  const formData = new FormData();
  for (const file of batch) {
    formData.append("files", file);
  }

  if (onFraction) {
    // Use XMLHttpRequest for progress events
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) {
          onFraction(e.loaded / e.total);
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(uploadRejectionError(xhr.status, xhr.responseText));
        }
      };

      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.send(formData);
    });
  }

  const res = await authFetch(url, { method: "POST", body: formData });
  if (!res.ok) {
    const body = await res.text();
    throw uploadRejectionError(res.status, body);
  }
}

/**
 * Split a selection into request-sized batches, preserving selection order.
 *
 * WARP-1843: a batch must respect BOTH caps the server side enforces —
 * `MAX_FILES_PER_UPLOAD` files (multer) and `MAX_UPLOAD_BATCH_BYTES` summed
 * file bytes (safely under nginx's `/api/` `client_max_body_size 100M`, which
 * 413-rejects an over-cap request wholesale). Packing is first-fit
 * sequential: each file joins the current batch unless doing so would break a
 * cap, in which case the current batch is sealed and a new one starts. Files
 * are never reordered.
 *
 * A single file larger than the whole byte ceiling still ships, alone in its
 * own batch: the server is the authority on per-file / per-user size caps, so
 * the client never pre-rejects — nginx / the orchestrator answer with the
 * honest 413 / policy error for exactly that file.
 */
function packUploadBatches(all: File[]): File[][] {
  const batches: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;

  for (const file of all) {
    const wouldBreakCap =
      current.length >= MAX_FILES_PER_UPLOAD ||
      currentBytes + file.size > MAX_UPLOAD_BATCH_BYTES;
    if (current.length > 0 && wouldBreakCap) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += file.size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Upload a selection to `path`, in batches the server will actually accept.
 *
 * WARP-1666: a folder-sized selection exceeds the per-request cap, and the
 * server rejects an over-cap request WHOLESALE — so posting everything at once
 * meant zero files landed. Batching is what makes large selections work at all.
 *
 * WARP-1843: batches are packed by size as well as count (see
 * {@link packUploadBatches}), and a failed batch no longer strands the ones
 * behind it — the run continues, and the failure is reported at the end.
 *
 * Batches run sequentially, not concurrently: each is buffered in the
 * orchestrator's memory before it reaches Nextcloud, so parallel batches would
 * multiply peak memory on the box for no user-visible gain.
 *
 * `onProgress` is weighted by bytes across the WHOLE selection, so the bar
 * advances monotonically to 100% instead of resetting once per batch. A failed
 * batch's bytes are counted as consumed, so later batches can only move the
 * bar forward (never backwards past a batch that died mid-transfer).
 *
 * Throws {@link UploadBatchError} after all batches have been attempted if any
 * of them failed; successful batches stay uploaded.
 */
export async function uploadFiles(
  path: string,
  files: FileList | File[],
  onProgress?: (percent: number) => void,
  space: FileSpaceId = "personal"
): Promise<void> {
  const qs = new URLSearchParams({ path });
  if (space !== "personal") qs.set("space", space);
  const url = `${BASE}/api/files/upload?${qs.toString()}`;

  const all = Array.from(files);
  const totalBytes = all.reduce((sum, f) => sum + f.size, 0);
  let uploaded = 0;
  let sentBytes = 0;
  let lastPercent = 0;
  const failedFiles: string[] = [];
  let firstFailure: unknown;

  for (const batch of packUploadBatches(all)) {
    const batchBytes = batch.reduce((sum, f) => sum + f.size, 0);

    try {
      await uploadBatch(
        url,
        batch,
        onProgress &&
          ((fraction) => {
            const done = sentBytes + fraction * batchBytes;
            const percent =
              totalBytes > 0 ? Math.round((done / totalBytes) * 100) : 100;
            // Clamp: a batch that failed mid-transfer already advanced the
            // bar with a partial fraction, and its bytes are counted as
            // consumed below — never report a smaller number than before.
            lastPercent = Math.max(lastPercent, Math.min(100, percent));
            onProgress(lastPercent);
          })
      );
      uploaded += batch.length;
    } catch (err) {
      // WARP-1843: don't strand the tail — record the failure, keep going.
      if (failedFiles.length === 0) firstFailure = err;
      failedFiles.push(...batch.map((f) => f.name));
    }

    // Failed or not, this batch's bytes are consumed for progress weighting;
    // skipping them would make the next batch's progress step backwards.
    sentBytes += batchBytes;
  }

  if (failedFiles.length > 0) {
    throw new UploadBatchError(uploaded, all.length, firstFailure, failedFiles);
  }
}

export async function deleteFile(
  path: string,
  space: FileSpaceId = "personal"
): Promise<void> {
  const qs = new URLSearchParams({ path });
  if (space !== "personal") qs.set("space", space);
  const res = await authFetch(`${BASE}/api/files?${qs.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to delete: ${res.status}`);
}

export async function createDirectory(
  path: string,
  space: FileSpaceId = "personal"
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/mkdir`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(space === "personal" ? { path } : { path, space }),
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
  newName: string,
  space: FileSpaceId = "personal"
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      space === "personal" ? { path, newName } : { path, newName, space }
    ),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to rename: ${res.status}`);
  }
  const data = await res.json();
  return data.renamed;
}

// WARP-1262 (T10): `fromSpace`/`toSpace` independently default to "personal"
// — the orchestrator's cross-space dual-check gates each side on its own
// right (move: contributor/contributor; copy: reader/contributor).
export async function moveFile(
  from: string,
  to: string,
  overwrite = false,
  fromSpace: FileSpaceId = "personal",
  toSpace: FileSpaceId = "personal"
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      overwrite,
      ...(fromSpace !== "personal" ? { fromSpace } : {}),
      ...(toSpace !== "personal" ? { toSpace } : {}),
    }),
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
  overwrite = false,
  fromSpace: FileSpaceId = "personal",
  toSpace: FileSpaceId = "personal"
): Promise<{ from: string; to: string }> {
  const res = await authFetch(`${BASE}/api/files/copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      overwrite,
      ...(fromSpace !== "personal" ? { fromSpace } : {}),
      ...(toSpace !== "personal" ? { toSpace } : {}),
    }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to copy: ${res.status}`);
  }
  const data = await res.json();
  return data.copied;
}

// WARP-1262 (T10): bulk ops act on a SINGLE space (every path in the batch +
// the destination dir resolved under the same space) — see the orchestrator
// route comment for why this isn't a dual-check like single move/copy.
export async function bulkDeleteFiles(
  paths: string[],
  space: FileSpaceId = "personal"
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(space === "personal" ? { paths } : { paths, space }),
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
  overwrite = false,
  space: FileSpaceId = "personal"
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      space === "personal"
        ? { paths, toDir, overwrite }
        : { paths, toDir, overwrite, space }
    ),
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
  overwrite = false,
  space: FileSpaceId = "personal"
): Promise<BulkOperationResult[]> {
  const res = await authFetch(`${BASE}/api/files/bulk-copy`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      space === "personal"
        ? { paths, toDir, overwrite }
        : { paths, toDir, overwrite, space }
    ),
  });
  if (!res.ok && res.status !== 207) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Bulk copy failed: ${res.status}`);
  }
  const data = await res.json();
  return data.results;
}

/** Discriminator carried by `TrashUnsupportedError`. */
export const TRASH_UNSUPPORTED = "TRASH_UNSUPPORTED";

/**
 * WARP-1555 — thrown by `fetchTrash` when the box's storage backend has no
 * trashbin and the orchestrator answers 501.
 *
 * This used to resolve to `[]`, which rendered as "Trash is empty" — the one
 * message you must never show a user whose deleted files are in fact gone
 * for good. "Unsupported" is a distinct state and gets distinct copy.
 */
export class TrashUnsupportedError extends Error {
  readonly code = TRASH_UNSUPPORTED;

  constructor() {
    super("This storage backend has no trash bin");
    this.name = "TrashUnsupportedError";
  }
}

/**
 * Structural check rather than `instanceof`, so the guard still holds across
 * module boundaries (mocked api modules, bundler duplicates).
 */
export function isTrashUnsupportedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === TRASH_UNSUPPORTED
  );
}

export async function fetchTrash(): Promise<TrashItemInfo[]> {
  const res = await authFetch(`${BASE}/api/files/trash`);
  if (!res.ok) {
    if (res.status === 501) throw new TrashUnsupportedError();
    throw new Error(`Failed to fetch trash: ${res.status}`);
  }
  const data = await res.json();
  return data.items ?? [];
}

export async function restoreTrashItem(
  name: string,
  space: FileSpaceId = "personal"
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/trash/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(space === "personal" ? { name } : { name, space }),
  });
  if (!res.ok) throw new Error(`Failed to restore: ${res.status}`);
}

export async function deleteTrashItem(
  name: string,
  space: FileSpaceId = "personal"
): Promise<void> {
  const qs = new URLSearchParams({ name });
  if (space !== "personal") qs.set("space", space);
  const res = await authFetch(`${BASE}/api/files/trash/item?${qs.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error(`Failed to purge trash item: ${res.status}`);
}

export async function emptyTrash(space: FileSpaceId = "personal"): Promise<void> {
  const qs = space !== "personal" ? `?space=${encodeURIComponent(space)}` : "";
  const res = await authFetch(`${BASE}/api/files/trash${qs}`, { method: "DELETE" });
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

export async function restoreVersion(
  path: string,
  versionId: string,
  space: FileSpaceId = "personal"
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/versions/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      space === "personal" ? { path, versionId } : { path, versionId, space }
    ),
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

export async function toggleFavorite(
  path: string,
  favorite: boolean,
  space: FileSpaceId = "personal"
): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/favorite`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      space === "personal" ? { path, favorite } : { path, favorite, space }
    ),
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

/**
 * WARP-1914 — error thrown by the Files-page search helpers on a non-2xx
 * response. Carries the HTTP status plus the orchestrator's stable wire
 * `code` (e.g. `semantic_unavailable`) so `translateError(err,
 * "search-semantic")` can dispatch on structure. A plain `Error` here meant
 * the translator — which never surfaces `err.message` — flattened every
 * search failure into the files-domain fallback ("We couldn't load those
 * files right now…"), the QA-reported generic banner. Mirrors
 * `ShareRequestError` below.
 */
export class FileSearchError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "FileSearchError";
    this.status = status;
    this.code = code;
  }
}

async function throwFileSearchError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    code?: unknown;
  };
  throw new FileSearchError(
    typeof body.error === "string" ? body.error : `${fallback}: ${res.status}`,
    res.status,
    typeof body.code === "string" ? body.code : undefined
  );
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
    await throwFileSearchError(res, "Search failed");
  }
  const data = await res.json();
  return data.items ?? [];
}

/** Build a thumbnail URL for <img src=...>. The orchestrator streams bytes + caches. */
export function getThumbnailUrl(path: string, x = 256, y = 256): string {
  return `${BASE}/api/files/thumbnail?path=${encodeURIComponent(path)}&x=${x}&y=${y}`;
}

/**
 * WARP-1148/1149 — error thrown by the share mutation helpers on a non-2xx
 * response. Carries the HTTP status plus the wire `error` string as `code` so
 * `translateError(err, "share")` can dispatch on stable codes (e.g.
 * `module_disabled` from a module-gated build) and on the Nextcloud OCS
 * policy-message shapes, instead of flattening every failure into a plain
 * Error whose message the translator must discard.
 */
export class ShareRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ShareRequestError";
    this.status = status;
    this.code = code;
  }
}

async function throwShareError(res: Response, fallback: string): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  const wire = typeof body.error === "string" ? body.error : undefined;
  throw new ShareRequestError(wire || `${fallback}: ${res.status}`, res.status, wire);
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
  if (!res.ok) await throwShareError(res, "Share failed");
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
  if (!res.ok) await throwShareError(res, "Share update failed");
}

export async function deleteShare(shareId: number): Promise<void> {
  const res = await authFetch(`${BASE}/api/files/share/${shareId}`, {
    method: "DELETE",
  });
  if (!res.ok) await throwShareError(res, "Share delete failed");
}

export async function fetchSharedWithMe(): Promise<ShareDetail[]> {
  const res = await authFetch(`${BASE}/api/files/shared-with-me`);
  if (!res.ok) throw new Error(`Failed to fetch shared-with-me: ${res.status}`);
  const data = await res.json();
  return data.shares ?? [];
}

/**
 * WARP-941 — outbound shares: everything the current user has shared to
 * people, groups, or links. Backs the "Shared by me" tab (the outbound
 * sibling of fetchSharedWithMe).
 */
export async function fetchSharedByMe(): Promise<ShareDetail[]> {
  const res = await authFetch(`${BASE}/api/files/shares-by-me`);
  if (!res.ok) throw new Error(`Failed to fetch shares-by-me: ${res.status}`);
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
  /** WARP-1502 — short primary label (place's own name / first display_name
   *  segment). Optional so a stale-cache old-shape item still parses. */
  name?: string;
  /** WARP-1502 — concise "City, ST" locality context. Empty/absent when none. */
  context?: string;
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
    // WARP-1139: a 503 (AI gateway / pgvector down) used to return [] here,
    // which rendered as "No content matches" — a dishonest empty state that
    // masked a broken search stack. Surface it as an error instead.
    // WARP-1914: the error is STRUCTURED (status + wire code), because the
    // friendly-copy translator discards `err.message` — a plain Error meant
    // even this honest failure rendered as the generic files banner.
    await throwFileSearchError(res, "Content search failed");
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
  /**
   * WARP-1139/WARP-1140 — explicit per-file indexer state (FileIndexStatus):
   * files the indexer has seen but not finished (`pendingCount`) or given up
   * on (`failedCount`). Optional: an orchestrator predating the migration
   * omits them. Drives the honest "still indexing" empty state.
   */
  pendingCount?: number;
  failedCount?: number;
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
    const body = await res.json().catch(() => ({} as { error?: unknown }));
    // WARP-1150: keep the HTTP status and any machine-readable error token on
    // the thrown error so the dialog can map it to step-appropriate copy via
    // translateError (which never renders err.message verbatim). Without
    // these, every create failure flattened to the domain fallback.
    const message =
      typeof body.error === "string"
        ? body.error
        : `Failed to generate pairing code: ${res.status}`;
    const err = new Error(message) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (typeof body.error === "string") err.code = body.error;
    throw err;
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

// ── WARP-1271 (T19a): per-user usage settings ──
// `userId` here is the LOCAL User UUID (RosterUser.userId), never the
// Nextcloud username `updateUser`/`setUserEnabled` above key on — a
// different namespace (WARP-947).

export async function fetchUserUsage(userId: string): Promise<UsageWithMeta> {
  const res = await authFetch(`${BASE}/api/people/${userId}/usage`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch usage: ${res.status}`);
  }
  return res.json();
}

export async function updateUserUsage(
  userId: string,
  data: { storageQuotaBytes?: string | null; maxUploadSizeMb?: number | null },
): Promise<{ policy: UsagePolicy }> {
  const res = await authFetch(`${BASE}/api/people/${userId}/usage`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update usage: ${res.status}`);
  }
  return res.json();
}

/** Admin usage roster — per-user + per-department storage (WARP-1271). */
export async function fetchAdminFilesUsage(): Promise<AdminFilesUsageResponse> {
  const res = await authFetch(`${BASE}/api/admin/files/usage`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to fetch usage roster: ${res.status}`);
  }
  return res.json();
}

// ── WARP-1270 (T18): Departments & teams ──
// Rights map 1:1 to the ADR-029 permission truth (reader/contributor/manager);
// the PATCH member-right call is the only writer (design brief §3).

export async function listDepartments(): Promise<{ departments: Department[] }> {
  const res = await authFetch(`${BASE}/api/departments`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to list departments: ${res.status}`);
  }
  return res.json();
}

export async function getDepartment(id: string): Promise<DepartmentDetail> {
  const res = await authFetch(`${BASE}/api/departments/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to load department: ${res.status}`) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function createDepartment(
  payload: CreateDepartmentPayload,
): Promise<{ department: Department; warning: string | null }> {
  const res = await authFetch(`${BASE}/api/departments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to create department: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function createTeam(
  departmentId: string,
  payload: CreateDepartmentPayload,
): Promise<{ team: Department }> {
  const res = await authFetch(
    `${BASE}/api/departments/${encodeURIComponent(departmentId)}/teams`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to create team: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function archiveDepartment(id: string): Promise<{ department: Department }> {
  const res = await authFetch(`${BASE}/api/departments/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to archive: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function restoreDepartment(id: string): Promise<{ department: Department }> {
  const res = await authFetch(`${BASE}/api/departments/${encodeURIComponent(id)}/restore`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to restore: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function addDepartmentMember(
  departmentId: string,
  userId: string,
  right: DepartmentRight,
): Promise<{ membership: DepartmentMembership }> {
  const res = await authFetch(
    `${BASE}/api/departments/${encodeURIComponent(departmentId)}/members`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, right }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to add member: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function updateDepartmentMemberRight(
  departmentId: string,
  userId: string,
  right: DepartmentRight,
): Promise<{ membership: DepartmentMembership }> {
  const res = await authFetch(
    `${BASE}/api/departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ right }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to update rights: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
  }
  return res.json();
}

export async function removeDepartmentMember(
  departmentId: string,
  userId: string,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(body.error || `Failed to remove member: ${res.status}`) as Error & {
      code?: string;
    };
    err.code = body.code;
    throw err;
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
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
      code?: unknown;
    };
    // WARP-1283: carry the orchestrator's typed `code` + the HTTP status on
    // the thrown error (the storageWriteError / WARP-851 commissionMatterDevice
    // precedent) so the wizard's VpnStep can render specific copy when the
    // routing sidecar is unavailable (503 + code ROUTING_UNAVAILABLE) instead
    // of the generic error page. `message` is preferred over `error` because
    // the global error handler puts the detail there ({ error: <category>,
    // message: <detail>, code }); the route's own typed 503 uses `error`.
    const err = new Error(
      (typeof body.message === "string" && body.message) ||
        (typeof body.error === "string" && body.error) ||
        `Failed to fetch Remote Access status: ${res.status}`,
    ) as Error & { status?: number; code?: string };
    err.status = res.status;
    if (typeof body.code === "string") err.code = body.code;
    throw err;
  }
  return res.json();
}

/**
 * List the caller's devices.
 *
 * WARP-1763: `liveStateAvailable` is false when the orchestrator could not read
 * the router's WireGuard peer list. In that case every peer's `provisioned` and
 * `lastHandshakeAt` are absent, and the UI must say so rather than render the
 * devices as never-connected — a routing sidecar restarting is not a fleet of
 * dead phones. Older orchestrators omit the flag entirely; treat that as
 * unavailable too, since they also send no live fields to interpret.
 */
export async function fetchVpnPeers(): Promise<{
  peers: VpnPeerInfo[];
  liveStateAvailable?: boolean;
}> {
  const res = await authFetch(`${BASE}/api/vpn/peers`);
  if (!res.ok) throw new Error(`Failed to fetch peers: ${res.status}`);
  return res.json();
}

/**
 * Mint a WireGuard peer. `mode` selects how the device dials the box:
 *
 *   "home" — Endpoint is the box's discovered home-facing LAN IP
 *            (resolveHomeEndpointHost on the orchestrator). Works today on the
 *            home/office network. This is the DEFAULT for every user-facing
 *            surface (WARP-1391): the orchestrator route's own default is "away"
 *            (a byte-identical pre-hybrid compat contract, PR #897), and away
 *            bakes the split-horizon public FQDN Endpoint — a public-NXDOMAIN
 *            address (WARP-954 / ADR-023) the stock WireGuard app can't
 *            handshake, so an omitted mode silently minted a dead config.
 *   "away" — operator-only: dials the public FQDN / relay endpoint. Reachable
 *            via the direct API; the dashboard never mints it.
 */
export async function createVpnPeer(
  deviceLabel: string,
  mode: "home" | "away" = "home",
): Promise<VpnPeerCreatedInfo> {
  const res = await authFetch(`${BASE}/api/vpn/peers`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deviceLabel, mode }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throwNetworkWriteError(body, res.status, "Failed to create peer");
  }
  return res.json();
}

/**
 * Revoke a device.
 *
 * Carries `code` and `status` onto the thrown error, because not every failure
 * here means "nothing happened". `REVOKE_STAGED` (502) is the one where the
 * router accepted the config change but never applied it — the device is still
 * on the network — and `translateError` can only tell the owner that if the
 * code survives the throw. A bare `new Error(message)` flattened it to the
 * generic "we couldn't update remote access right now" retry copy.
 */
export async function deleteVpnPeer(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/vpn/peers/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(
      body.error || `Failed to revoke peer: ${res.status}`,
    ) as Error & { code?: string; status?: number };
    if (typeof body.code === "string") err.code = body.code;
    err.status = res.status;
    throw err;
  }
}

// ── WARP-1475: overlay QR-enroll (ADR-030) ──
//
// Owner/admin mints a link token → the QR encodes it → a phone scans + redeems
// it (no bearer) which STAGES a pending enrollment → the owner approves/denies
// here. Approval is the load-bearing gate that turns a scan into an enrolled
// overlay device (the box only vouches to HQ on approve).

/**
 * Mint a single-use overlay link token (owner/admin). The plaintext token in
 * the response is returned ONCE — the caller renders it into a QR and forgets
 * it on dialog close. NEVER log the returned token. Minting supersedes any
 * prior available token for this owner.
 */
export async function mintOverlayLinkToken(): Promise<OverlayLinkToken> {
  const res = await authFetch(`${BASE}/api/vpn/overlay/link-tokens`, {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(
      body.error || `Failed to mint link token: ${res.status}`,
    ) as Error & { status?: number; code?: string };
    e.status = res.status;
    if (typeof body.error === "string") e.code = body.error;
    throw e;
  }
  return res.json();
}

/** List staged overlay enrollments awaiting owner review (owner/admin). */
export async function fetchPendingOverlayEnrollments(): Promise<
  PendingOverlayEnrollment[]
> {
  const res = await authFetch(`${BASE}/api/vpn/overlay/pending-enrollments`);
  if (!res.ok) {
    throw new Error(`Failed to fetch pending enrollments: ${res.status}`);
  }
  return res.json();
}

/**
 * Approve a staged enrollment (owner/admin). This is the point the box vouches
 * the device to HQ. On failure the thrown error carries the orchestrator's
 * typed `code` (409: `already_being_approved` / `wg_key_conflict` /
 * `overlay_device_cap_reached` / `cannot approve a <state> enrollment`; 503:
 * the vouch-retry sentence) plus the HTTP `status`, so the page can render
 * honest per-case copy via `overlayApproveErrorCopy`.
 */
export async function approveOverlayEnrollment(
  id: string,
): Promise<OverlayApproveResult> {
  const res = await authFetch(
    `${BASE}/api/vpn/overlay/pending-enrollments/${encodeURIComponent(id)}/approve`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(
      body.error || `Failed to approve enrollment: ${res.status}`,
    ) as Error & { status?: number; code?: string };
    e.status = res.status;
    if (typeof body.error === "string") e.code = body.error;
    throw e;
  }
  return res.json();
}

/** Deny a staged enrollment (owner/admin). */
export async function denyOverlayEnrollment(
  id: string,
): Promise<{ state: "denied" }> {
  const res = await authFetch(
    `${BASE}/api/vpn/overlay/pending-enrollments/${encodeURIComponent(id)}/deny`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const e = new Error(
      body.error || `Failed to deny enrollment: ${res.status}`,
    ) as Error & { status?: number; code?: string };
    e.status = res.status;
    if (typeof body.error === "string") e.code = body.error;
    throw e;
  }
  return res.json();
}

// --- WARP-1036: voice assistant (setup-wizard step + status) ---

/**
 * True when an error thrown by `fetchVoiceStatus` / `sayVoiceTest` means
 * "voice-io isn't deployed here at all" (the orchestrator proxy's explicit
 * 503 `voice_unavailable` — macOS dev, or the `linux` compose profile
 * inactive). The wizard's voice step auto-skips ONLY on this (WARP-933:
 * a generic error must surface, never silently skip).
 */
export function isVoiceUnavailableError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err as Error & { code?: string }).code === "voice_unavailable"
  );
}

async function throwVoiceError(res: Response, fallback: string): Promise<never> {
  const body = await res.json().catch(() => ({}));
  const e = new Error(
    typeof body.detail === "string"
      ? body.detail
      : body.error || `${fallback}: ${res.status}`,
  ) as Error & { code?: string; status?: number };
  if (res.status === 503 && body.error === "voice_unavailable") {
    e.code = "voice_unavailable";
  } else if (typeof body.error === "string") {
    e.code = body.error;
  }
  e.status = res.status;
  throw e;
}

export async function fetchVoiceStatus(): Promise<VoiceStatusInfo> {
  const res = await authFetch(`${BASE}/api/voice/status`);
  if (!res.ok) await throwVoiceError(res, "Failed to fetch voice status");
  return res.json();
}

/** Speaker test — the box says `text` out loud through its own speaker.
 *  Blocks for the playback duration server-side. */
export async function sayVoiceTest(text: string): Promise<VoiceSayResult> {
  const res = await authFetch(`${BASE}/api/voice/say`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) await throwVoiceError(res, "Speaker test failed");
  return res.json();
}

// --- WARP-1055: /voice surface — calibration wizard + health checks ---

/** Persisted calibration record, or `{calibrated: false}`. */
export async function fetchVoiceCalibration(): Promise<VoiceCalibrationInfo> {
  const res = await authFetch(`${BASE}/api/voice/calibration`);
  if (!res.ok) await throwVoiceError(res, "Failed to fetch voice calibration");
  return res.json();
}

/**
 * The wizard's SINGLE write (§10 `Write · confirm to apply`) — persists
 * the measured calibration on the box and applies the tuned input gain
 * + wake threshold live.
 */
export async function applyVoiceCalibration(
  payload: VoiceCalibrationApply,
): Promise<VoiceCalibrationInfo> {
  const res = await authFetch(`${BASE}/api/voice/calibration`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) await throwVoiceError(res, "Failed to apply calibration");
  return res.json();
}

/*
 * WARP-1520 — the box's mic capture is EXCLUSIVE hardware. voice-io
 * guards every capture window (`/audio/measure`, `/audio/echo-check`,
 * `/audio/test-record`, and the enrollment captures via
 * `_capture_speaker_pcm`) with one non-blocking lock and answers an
 * instant 409 to any overlap. Fired freely from here, a discarded-but-
 * still-recording window (Back / Try again / reopening the wizard while
 * a 5–6 s measure was mid-flight server-side) turned EVERY follow-up
 * capture into a 409 that rendered as "the microphone didn't respond"
 * on a healthy mic — and each retry collided again.
 *
 * So every api function that lands on a capture-lock endpoint queues
 * through this module-level gate: a new capture waits for the previous
 * one to settle instead of colliding. Worst-case queue wait is bounded
 * (~30 s: the orchestrator proxy caps each capture at 45 s, and
 * `authFetch` imposes no client timeout on the initial request, so a
 * queued wait can't trip one). The chain must survive rejections — a
 * failed capture releases the gate but still rejects to ITS caller.
 * Status/calibration-mode calls are deliberately NOT gated: they don't
 * touch the capture device and must never queue behind a measure.
 */
let captureChain: Promise<void> = Promise.resolve();

async function exclusiveCapture<T>(run: () => Promise<T>): Promise<T> {
  const prev = captureChain;
  let release!: () => void;
  captureChain = new Promise<void>((r) => (release = r));
  await prev;
  try {
    return await run();
  } finally {
    release();
  }
}

/**
 * One wizard capture — the box records `seconds` of mic audio and
 * reports RMS + peak in dBFS. Blocks server-side for the capture
 * window, so callers should show their own countdown/progress UI.
 */
export async function measureVoiceLevel(
  kind: "noise_floor" | "speech_peak",
  seconds?: number,
): Promise<VoiceMeasureResult> {
  return exclusiveCapture(async () => {
    const body: { kind: string; seconds?: number } = { kind };
    if (seconds !== undefined) body.seconds = seconds;
    const res = await authFetch(`${BASE}/api/voice/measure`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwVoiceError(res, "Measurement failed");
    return res.json();
  });
}

/** Fully automatic speaker→mic loop check (wizard step 4). */
export async function runVoiceEchoCheck(): Promise<VoiceEchoCheckResult> {
  return exclusiveCapture(async () => {
    const res = await authFetch(`${BASE}/api/voice/echo-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) await throwVoiceError(res, "Echo check failed");
    return res.json();
  });
}

// --- WARP-1599: the voice kill switch ---

/**
 * Switch the whole wake pipeline on or off, box-wide and persisted.
 * Owner/admin only — the orchestrator route enforces that; the
 * dashboard never gates a write it doesn't own.
 *
 * Deliberately NOT queued behind `exclusiveCapture`: the toggle holds
 * no capture window, and an off must never wait on a measurement that
 * is holding the mic. voice-io serializes concurrent toggles itself and
 * answers 409, which `throwVoiceError` carries up as `status: 409` for
 * callers to surface as "already switching" rather than a dead box.
 */
export async function setVoiceEnabled(
  enabled: boolean,
): Promise<{ enabled: boolean }> {
  const res = await authFetch(`${BASE}/api/voice/enabled`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) await throwVoiceError(res, "Failed to switch voice");
  return res.json();
}

// --- WARP-1057: mic-processor (XVF3800 DSP) restart ---

/**
 * Reboot the wedged mic processor (`xvf_host REBOOT 1` on the box).
 * The mic goes quiet for ~10 s while the DSP re-enumerates; callers
 * re-poll `/api/voice/status` until `input_flatlined` clears.
 */
export async function restartVoiceProcessor(): Promise<VoiceRestartResult> {
  const res = await authFetch(`${BASE}/api/voice/restart-processor`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  if (!res.ok) await throwVoiceError(res, "Processor restart failed");
  return res.json();
}

// --- WARP-1059: calibration mode (wizard-scoped wake suppression) ---

/**
 * Enter (or renew) calibration mode on the box: wakes keep counting
 * (the wizard's step-3 ticker rides `last_wake_at`) but are not
 * handled — no STT capture, no LLM call, no reply spoken through the
 * speaker mid-measurement. Auto-expires after `ttlS` (voice-io default
 * when omitted), so callers renew while the wizard stays open.
 */
export async function enterVoiceCalibrationMode(
  ttlS?: number,
): Promise<VoiceCalibrationModeResult> {
  const body: { ttl_s?: number } = {};
  if (ttlS !== undefined) body.ttl_s = ttlS;
  const res = await authFetch(`${BASE}/api/voice/calibration-mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) await throwVoiceError(res, "Failed to enter calibration mode");
  return res.json();
}

/** Exit calibration mode. Idempotent — safe to fire from any wizard
 *  close path; the TTL expiry is the fail-safe when this never runs. */
export async function exitVoiceCalibrationMode(): Promise<VoiceCalibrationModeResult> {
  const res = await authFetch(`${BASE}/api/voice/calibration-mode`, {
    method: "DELETE",
  });
  if (!res.ok) await throwVoiceError(res, "Failed to exit calibration mode");
  return res.json();
}

// --- WARP-1056: per-person voiceprints (Flow B enrollment) ---

/** §3.3 listing — enrolled voiceprints + whether the box can enroll. */
export async function fetchVoiceProfiles(): Promise<VoiceProfilesResult> {
  const res = await authFetch(`${BASE}/api/voice/profiles`);
  if (!res.ok) await throwVoiceError(res, "Failed to fetch voice profiles");
  return res.json();
}

/** Open a Flow B session for an EXISTING person (the orchestrator 404s
 *  `person_not_found` otherwise — enrollment never creates a person). */
export async function startVoiceEnrollment(
  userId: string,
): Promise<VoiceEnrollStartResult> {
  const res = await authFetch(`${BASE}/api/voice/enroll/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  if (!res.ok) await throwVoiceError(res, "Couldn't start voice enrollment");
  return res.json();
}

/**
 * Capture one scripted line on the BOX mic (§5 step 2). Blocks
 * server-side for the ~5 s recording window — the wizard shows the
 * listening ring meanwhile. `replaceIndex` is the per-line "Redo".
 */
export async function captureVoiceEnrollmentLine(
  sessionId: string,
  replaceIndex?: number,
): Promise<VoiceEnrollCaptureResult> {
  // WARP-1520 — lands on voice-io's `_capture_speaker_pcm`, which takes
  // the same exclusive capture lock as the wizard measures.
  return exclusiveCapture(async () => {
    const body: { sessionId: string; replaceIndex?: number } = { sessionId };
    if (replaceIndex !== undefined) body.replaceIndex = replaceIndex;
    const res = await authFetch(`${BASE}/api/voice/enroll/capture`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) await throwVoiceError(res, "Voice capture failed");
    return res.json();
  });
}

/** §5 step 3 — "One more time, no script." Captures + matches on-box. */
export async function verifyVoiceEnrollment(
  sessionId: string,
): Promise<VoiceEnrollVerifyResult> {
  // WARP-1520 — also a `_capture_speaker_pcm` capture; see exclusiveCapture.
  return exclusiveCapture(async () => {
    const res = await authFetch(`${BASE}/api/voice/enroll/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!res.ok) await throwVoiceError(res, "Voice check failed");
    return res.json();
  });
}

/** The ONE write of Flow B ("Save [Name]'s voice"). */
export async function commitVoiceEnrollment(
  sessionId: string,
): Promise<VoiceEnrollCommitResult> {
  const res = await authFetch(`${BASE}/api/voice/enroll/commit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) await throwVoiceError(res, "Couldn't save the voice profile");
  return res.json();
}

/** Cancel path — "Cancel deletes these recordings now" (discards the
 *  in-memory session on the box immediately; idempotent). */
export async function cancelVoiceEnrollment(sessionId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/voice/enroll/${sessionId}`, {
    method: "DELETE",
  });
  if (!res.ok) await throwVoiceError(res, "Couldn't discard the enrollment");
}

/** Remove a voiceprint — immediate and complete on the box (§10
 *  destructive Write; callers gate it behind the red confirm). */
export async function removeVoiceProfile(userId: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/voice/profiles/${userId}`, {
    method: "DELETE",
  });
  if (!res.ok) await throwVoiceError(res, "Couldn't remove the voice profile");
}

// --- WARP-1058: recent voice activity (§3.4 feed) ---

/**
 * The /voice page's max-5 feed, from the generic signed activity
 * surface filtered to kind=voice (the same rows the audit log's
 * "See all in Activity" deep-link shows). `person` is lifted from the
 * row's refs — present on wake rows ("Guest" until enrollment lands),
 * absent on §6.3 self-heal rows.
 */
export async function fetchVoiceActivity(limit = 5): Promise<VoiceActivityItem[]> {
  const res = await authFetch(`${BASE}/api/activity?kind=voice&limit=${limit}`);
  if (!res.ok) throw new Error("Failed to fetch voice activity");
  const json = (await res.json()) as {
    items: Array<{
      id: string;
      at: string;
      what: string;
      severity: VoiceActivityItem["severity"];
      refs: Record<string, unknown> | null;
    }>;
  };
  return json.items.map((item) => ({
    id: item.id,
    atS: Math.floor(new Date(item.at).getTime() / 1000),
    what: item.what,
    severity: item.severity,
    person:
      typeof item.refs?.person === "string" ? (item.refs.person as string) : null,
  }));
}

// --- WARP-979: Secured / name-your-box ---

/**
 * WARP-979 — check an owner-typed box name against the shared ruleset +
 * (best-effort) availability. Called debounced from the "Secured" setup step as
 * the owner types. Public endpoint — runs during first-run onboarding before an
 * account may exist, so we call `fetch` directly (no auth refresh to ride).
 * The AbortSignal lets the caller cancel a stale in-flight check.
 */
export async function checkBoxName(
  name: string,
  signal?: AbortSignal,
): Promise<BoxNameCheckResult> {
  const res = await fetch(
    `${BASE}/api/setup/box-name/check?name=${encodeURIComponent(name)}`,
    { credentials: "same-origin", signal },
  );
  if (!res.ok) throw new Error(`Failed to check box name: ${res.status}`);
  return res.json();
}

/**
 * WARP-979 — persist the chosen box name so the box's tls-issuance requests
 * `<name>.droplet-us.com`. Public onboarding endpoint (re-gated server-side once
 * the appliance is claimed). Throws on a non-2xx so the step can surface the
 * inline error and NOT advance.
 */
export async function setBoxName(name: string): Promise<BoxNameSetResult> {
  const res = await fetch(`${BASE}/api/setup/box-name`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throwNetworkWriteError(body, res.status, "Failed to save box name");
  }
  return res.json();
}

/**
 * WARP-1039 — read the CURRENTLY saved box name back: `{ name, fqdn }`, both
 * null when no name has been chosen yet. Same public-onboarding posture as the
 * POST (the orchestrator re-gates it once the appliance is claimed), so plain
 * `fetch` with the session cookie riding along. The AddressStep rehydrates its
 * input from this on mount; the VpnStep precheck uses it to render the honest
 * "address is being set up" blocked view.
 */
export async function fetchBoxName(): Promise<BoxNameCurrentResult> {
  const res = await fetch(`${BASE}/api/setup/box-name`, {
    credentials: "same-origin",
  });
  if (!res.ok) throw new Error(`Failed to fetch box name: ${res.status}`);
  return res.json();
}

/**
 * WARP-1109 — CHANGE the box's secured address in place. The orchestrator
 * RELEASES the current name at HQ, then claims the NEW name and re-issues the
 * cert under the new FQDN. Same public-onboarding posture as the POST (re-gated
 * server-side once the appliance is claimed). Throws on a non-2xx so the step
 * surfaces the inline error and does NOT advance — a 409 name-taken on the new
 * name carries `code: "BOX_NAME_TAKEN"` (+ suggestions) so the picker can show
 * the conflict.
 */
export async function renameBox(name: string): Promise<BoxNameRenameResult> {
  const res = await fetch(`${BASE}/api/setup/box-name/rename`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ name }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throwNetworkWriteError(body, res.status, "Failed to rename box");
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

/**
 * WARP-905 — per-item ingest policy. Orthogonal to `status`: this is the gate
 * the file-indexer consults before embedding a chat-attached upload.
 *   - auto_embed     → embed on upload (the default; historical behaviour).
 *   - await_approval → hold the upload until a human approves it (the
 *                      "pending decision" state surfaced in the files/brain UI).
 */
export type BrainIngestPolicy = "auto_embed" | "await_approval";

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
  // WARP-905: 'await_approval' means the item is HELD — surfaced as an
  // "Awaiting approval" affordance instead of the status pill. Absent on
  // legacy rows / partial-deploy windows → treated as 'auto_embed'.
  ingestPolicy?: BrainIngestPolicy;
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

// --- Module capabilities (nav-gating for user-facing modules) ---

export interface AppCapabilities {
  /** The Projects (native PM, ADR-026) surface is enabled on this Droplet. */
  projects: boolean;
}

/**
 * Probe which user-facing modules this Droplet is serving (WARP-1154/1155).
 * Unlike `/api/admin/capabilities` this is readable by EVERY authenticated
 * role — family/guest see the Projects nav entry too, so its gate can't live
 * behind an admin-only probe. The consuming hook fails OPEN (module shown):
 * a surface only hides when the orchestrator explicitly answers `false`.
 */
export async function fetchAppCapabilities(): Promise<AppCapabilities> {
  const res = await authFetch(`${BASE}/api/capabilities`);
  if (!res.ok) throw new Error(`Failed to fetch app capabilities: ${res.status}`);
  return res.json();
}

/**
 * WARP-1368 — Settings → Features panel. Mirrors the orchestrator's
 * ModulesView (services/modules.service.ts): every registry module with its
 * two orthogonal axes (deploy-time `available`, operator `enabled`) plus the
 * derived `effective`. `core` modules are never toggleable.
 */
export interface AppModuleState {
  id: string;
  label: string;
  description: string;
  category: "workspace" | "operations";
  core: boolean;
  available: boolean;
  enabled: boolean;
  effective: boolean;
  /**
   * WARP-1585 — a module this one declares it cannot function without (`docs`
   * requires `files`: documents open from the file libraries). Optional on the
   * wire so an orchestrator that predates the field reads as "no dependency"
   * rather than breaking the panel.
   */
  requires?: string;
  /** `requires` is declared and that parent is not effective, so neither is
   *  this. Reported separately from `available` / `enabled` so a panel can say
   *  WHY instead of showing a module that silently refuses to switch on —
   *  `enabled` still carries the operator's stored intent. */
  requiresUnmet?: boolean;
}

export interface AppModulesView {
  businessType: string | null;
  modules: AppModuleState[];
}

/** Full module states for the Settings Features panel (any signed-in role may
 *  read; the PATCH below is the admin-only half). */
export async function fetchAppModules(): Promise<AppModulesView> {
  const res = await authFetch(`${BASE}/api/modules`);
  if (!res.ok) throw new Error(`Failed to fetch modules: ${res.status}`);
  return res.json();
}

/**
 * Toggle a user-facing module on/off (WARP-1306) — the owner/admin enable
 * path behind the honest "module off" states (e.g. ProjectsDisabled). PATCH
 * /api/admin/modules/:id is owner/admin-gated server-side (403
 * `admin_required` otherwise); callers gate the affordance on the caller's
 * role and treat this as the action, never the authority.
 */
export async function setAppModuleEnabled(
  moduleId: string,
  enabled: boolean,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/admin/modules/${encodeURIComponent(moduleId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(
      body.message || `Failed to update the module: ${res.status}`,
    );
  }
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

// --- WARP-540: OTA updates operator surface (/settings/updates) ---

/** One DeviceUpdate row as the orchestrator serializes it (no manifest). */
export interface UpdateRelease {
  id: string;
  status:
    | "pending"
    | "superseded"
    | "verifying"
    | "applying"
    | "committed"
    | "rolled_back"
    | "failed"
    | "rejected";
  channel: string;
  releaseTag: string | null;
  gitSha: string;
  builtAt: string;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The WARP-538 operator knobs persisted on the box. */
export interface UpdateAgentSettings {
  channel: string;
  applyWindowCron: string;
  autoApply: boolean;
}

export interface UpdatesStatus {
  /** Newest committed OTA release; null = still on the factory image. */
  current: UpdateRelease | null;
  /** Newest pending / verifying / applying row, if any. */
  pending: UpdateRelease | null;
  /** Most recently decided terminal row (committed/rolled_back/failed/rejected). */
  lastVerdict: UpdateRelease | null;
  /** WARP-539 rollback-also-failed verdict — render the red banner. */
  degraded: boolean;
  settings: UpdateAgentSettings;
  /** False on boxes without the host compose socket — apply-now is disabled. */
  applyAvailable: boolean;
}

export type CheckNowOutcome =
  | "no_release"
  | "fetch_failed"
  | "verify_failed"
  | "channel_mismatch"
  | "already_known"
  | "pending_created";

export interface CheckNowResult {
  outcome: CheckNowOutcome;
  detail?: string;
  gitSha?: string;
  deviceUpdateId?: string;
}

export async function getUpdatesStatus(): Promise<UpdatesStatus> {
  const res = await authFetch(`${BASE}/api/updates/status`);
  if (!res.ok) throw new Error(`Failed to load update status: ${res.status}`);
  return res.json();
}

export async function getUpdatesHistory(limit = 50): Promise<UpdateRelease[]> {
  const res = await authFetch(`${BASE}/api/updates/history?limit=${limit}`);
  if (!res.ok) throw new Error(`Failed to load update history: ${res.status}`);
  const body = (await res.json()) as { updates: UpdateRelease[] };
  return body.updates;
}

export async function checkForUpdatesNow(): Promise<CheckNowResult> {
  const res = await authFetch(`${BASE}/api/updates/check-now`, { method: "POST" });
  if (!res.ok) throw new Error(`Update check failed: ${res.status}`);
  return res.json();
}

/**
 * Force the pending release to apply immediately. Resolves on the 202
 * dispatch; progress is read back through getUpdatesStatus (the row's
 * status is the cursor). Throws with the server's error code on 409/503
 * (`apply_unavailable`, `apply_in_progress`, `nothing_pending`).
 */
export async function applyUpdateNow(): Promise<{ deviceUpdateId: string }> {
  const res = await authFetch(`${BASE}/api/updates/apply-now`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to start the update: ${res.status}`);
  }
  return res.json();
}

/** Skip the pending release (it stays skipped until a newer one appears). */
export async function skipPendingUpdate(): Promise<{ deviceUpdateId: string }> {
  const res = await authFetch(`${BASE}/api/updates/skip`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to skip the release: ${res.status}`);
  }
  return res.json();
}

export async function saveUpdateSettings(
  patch: Partial<UpdateAgentSettings>,
): Promise<UpdateAgentSettings> {
  const res = await authFetch(`${BASE}/api/updates/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to save update settings: ${res.status}`);
  }
  return res.json();
}

// ── WARP-1532 (RBAC v2 T8): Access & Roles ──
// Contract-driven off ADR-032 §5 (ACCESS-AND-ROLES-ARCHITECTURE-BRIEF) while
// the backend routes (T3+) build in parallel. Conventions: local User.id
// UUIDs everywhere (never the Nextcloud username — WARP-881), BigInt fields
// string-encoded, mutation responses carry `syncState` where the change
// cascades (→ the "Saved. Applying…" pattern). Owner/admin only + the
// role-mutation-guard rails server-side; the UI renders the same rails as
// honest disabled states but is never trusted.

export async function listAccessRoles(): Promise<{ roles: AccessRole[] }> {
  const res = await authFetch(`${BASE}/api/access/roles`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to list roles: ${res.status}`);
  }
  return res.json();
}

export async function getAccessRole(id: string): Promise<{ role: AccessRole }> {
  const res = await authFetch(`${BASE}/api/access/roles/${encodeURIComponent(id)}`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load role: ${res.status}`);
  }
  return res.json();
}

export async function createAccessRole(
  payload: AccessRolePayload,
): Promise<{ role: AccessRole; syncState?: AccessSyncState }> {
  const res = await authFetch(`${BASE}/api/access/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to create role: ${res.status}`);
  }
  return res.json();
}

/** Duplicate = POST with `sourceRoleId` (§5). The server copies the grant
 *  set and derives a fresh name/slug; the UI then opens the copy to edit. */
export async function duplicateAccessRole(
  sourceRoleId: string,
): Promise<{ role: AccessRole; syncState?: AccessSyncState }> {
  const res = await authFetch(`${BASE}/api/access/roles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sourceRoleId }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to duplicate role: ${res.status}`);
  }
  return res.json();
}

export async function updateAccessRole(
  id: string,
  patch: Partial<AccessRolePayload> & { state?: "active" | "archived" },
): Promise<{
  role: AccessRole;
  syncState?: AccessSyncState;
  /** WARP-1576 — present only when this PATCH CLEARED the role's storage
   *  default: how many members had no person-level quota and therefore keep
   *  whatever Nextcloud currently enforces until someone edits it. The server
   *  deliberately pushes nothing in that case (a cleared default means
   *  "unmanaged", never "unlimited" — WARP-1531's semantics), so this count
   *  is the operator's only signal that people were left on a retained
   *  value. */
  retainedQuotaCount?: number;
}> {
  const res = await authFetch(`${BASE}/api/access/roles/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to update role: ${res.status}`);
  }
  return res.json();
}

/** Archive keeps the row (assignable no more); the design's non-destructive
 *  sibling of delete. */
export async function archiveAccessRole(
  id: string,
): Promise<{ role: AccessRole; syncState?: AccessSyncState }> {
  return updateAccessRole(id, { state: "archived" });
}

/** WARP-1560 — archive's symmetric partner. The server treats the
 *  transition as its own event: it writes an "Access role restored"
 *  Activity row and, when the role carries a storage default that members
 *  are back to inheriting, kicks the usage reconciler and answers
 *  `pending` — so the caller's sync chip has something true to say. */
export async function restoreAccessRole(
  id: string,
): Promise<{ role: AccessRole; syncState?: AccessSyncState }> {
  return updateAccessRole(id, { state: "active" });
}

export async function deleteAccessRole(id: string): Promise<void> {
  const res = await authFetch(`${BASE}/api/access/roles/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to delete role: ${res.status}`);
  }
}

/** Bind people (local User.id UUIDs) to a role. Server-side this sets each
 *  person's Role enum from the role's startingPoint, fires WARP-116 session
 *  revocation, and writes Activity — hence the pending syncState. */
export async function assignAccessRole(
  id: string,
  userIds: string[],
): Promise<{ syncState: AccessSyncState }> {
  const res = await authFetch(`${BASE}/api/access/roles/${encodeURIComponent(id)}/assign`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userIds }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to assign role: ${res.status}`);
  }
  return res.json();
}

/** Per-person role change. A custom role sends `{ accessRoleId }`; assigning
 *  a built-in tier sends `{ accessRoleId: null, tier }` (User.accessRoleId
 *  null = plain built-in tier — the §2 backward-compatible shape). */
export async function setPersonAccess(
  userId: string,
  body: { accessRoleId: string | null; tier?: AccessStartingPoint },
): Promise<{ syncState: AccessSyncState }> {
  const res = await authFetch(`${BASE}/api/people/${encodeURIComponent(userId)}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const resBody = await res.json().catch(() => ({}));
    throw new Error(resBody.error || `Failed to change role: ${res.status}`);
  }
  return res.json();
}

/** The §3 resolver output — powers the read-only effective-access drawer
 *  and every honest disabled state. */
export async function fetchEffectiveAccess(userId: string): Promise<EffectiveAccess> {
  const res = await authFetch(
    `${BASE}/api/people/${encodeURIComponent(userId)}/effective-access`,
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to load effective access: ${res.status}`);
  }
  return res.json();
}

/** Replace the (small, feature-axis-only) exception list — PUT semantics
 *  per §5 so the editor never diffs rows client-side. */
export async function putAccessExceptions(
  userId: string,
  exceptions: AccessExceptionInput[],
): Promise<{ exceptions: AccessExceptionInput[] }> {
  const res = await authFetch(
    `${BASE}/api/people/${encodeURIComponent(userId)}/access-exceptions`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ exceptions }),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Failed to save exceptions: ${res.status}`);
  }
  return res.json();
}

// --- Team chat (WARP-1683, /messages) ---

/**
 * UX review (WARP-1683): the Messages surface renders `err.message`
 * verbatim, so raw status codes / server error tokens must never ride on
 * the thrown Error. Every team-chat helper funnels failures here — the
 * diagnostic detail goes to the console, the user gets plain copy.
 */
async function teamChatFail(
  op: string,
  userMessage: string,
  res: Response,
): Promise<never> {
  const detail = await res.text().catch(() => "");
  console.error(`[team-chat] ${op} failed: ${res.status} ${detail}`);
  throw new Error(userMessage);
}

export interface TeamChatContact {
  id: string;
  displayName: string;
  username: string;
  role: string;
}

export type TeamChatMessageKind =
  | "text"
  | "file_share"
  | "ai_chat_share"
  | "meeting_invite"
  | "meeting_reminder";

// --- Meetings (WARP-1685) ---

export type TeamChatRsvpResponse = "accepted" | "declined";

export interface TeamChatMeetingRsvp {
  userId: string;
  response: TeamChatRsvpResponse;
  respondedAt: string;
  /** Present on GET /meetings/:id; the message-list payload leaves names
   *  to the thread's participant roster the client already holds. */
  displayName?: string | null;
}

export interface TeamChatMeeting {
  id: string;
  threadId: string;
  inviteMessageId: string | null;
  calendarEventId: string | null;
  title: string;
  startsAt: string;
  durationMinutes: number | null;
  location: string | null;
  /** WARP-1874 — https-only video-call link, alongside (not instead of)
   *  `location`. Re-validated at render before it becomes an href. */
  meetingUrl: string | null;
  note: string | null;
  createdById: string;
  status: "scheduled" | "cancelled";
  reminderMinutesBefore: number;
  reminderStatus: "pending" | "sent" | "not_needed";
  createdAt: string;
  rsvps: TeamChatMeetingRsvp[];
}

export interface TeamChatMessage {
  id: string;
  threadId: string;
  senderId: string;
  senderDisplayName: string | null;
  kind: TeamChatMessageKind;
  /** Text body, or the forward's optional caption. */
  body: string | null;
  sharedNcFileId: number | null;
  sharedFileName: string | null;
  sharedFilePath: string | null;
  /**
   * WARP-1898 — the Files space `sharedFilePath` is relative to
   * ("personal" | "shared" | "dept:<uuid>"), resolved server-side.
   * `null` on messages sent before that ticket and means UNKNOWN — treat
   * it as such, never as "personal": assuming personal is exactly what
   * used to drop recipients into their own files.
   */
  sharedFileSpace: FileSpaceId | null;
  sharedChatSessionId: string | null;
  /** WARP-1685 — set on meeting_invite / meeting_reminder; the live
   *  meeting (incl. RSVPs) rides along so cards render in one fetch. */
  meetingId: string | null;
  meeting: TeamChatMeeting | null;
  createdAt: string;
}

export interface TeamChatThreadSummary {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  createdById: string;
  createdAt: string;
  lastMessageAt: string;
  participants: Array<{
    userId: string;
    displayName: string | null;
    username: string | null;
  }>;
  lastMessage: TeamChatMessage | null;
  unreadCount: number;
}

export interface TeamChatTranscript {
  title: string | null;
  messages: Array<{ role: string; content: string; createdAt: string }>;
}

export type TeamChatSendBody =
  | { kind: "text"; body: string }
  | {
      kind: "file_share";
      ncFileId: number;
      fileName: string;
      filePath: string;
      /**
       * WARP-1898 — the space `filePath` is relative to, as the picker knew
       * it. Only a fallback: the server re-derives from the file registry
       * and that wins whenever a row exists (a pick from the picker's
       * SEARCH tab spans spaces, so the selector can be wrong).
       */
      space?: FileSpaceId;
      caption?: string;
    }
  | { kind: "ai_chat_share"; chatSessionId: string; caption?: string };

export async function fetchTeamChatContacts(): Promise<TeamChatContact[]> {
  const res = await authFetch(`${BASE}/api/team-chat/contacts`);
  if (!res.ok) {
    return teamChatFail("contacts", "Couldn't load people. Try again.", res);
  }
  const body = (await res.json()) as { contacts: TeamChatContact[] };
  return body.contacts;
}

export async function fetchTeamChatThreads(): Promise<TeamChatThreadSummary[]> {
  const res = await authFetch(`${BASE}/api/team-chat/threads`);
  if (!res.ok) {
    return teamChatFail("threads", "Couldn't load conversations. Try again.", res);
  }
  const body = (await res.json()) as { threads: TeamChatThreadSummary[] };
  return body.threads;
}

/** Create a DM/group. The server dedupes direct pairs — a repeat create
 *  returns the existing thread (200) instead of a new row (201). */
export async function createTeamChatThread(args: {
  kind: "direct" | "group";
  participantIds: string[];
  title?: string;
}): Promise<{ id: string }> {
  const res = await authFetch(`${BASE}/api/team-chat/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    return teamChatFail(
      "create-thread",
      "Couldn't start the conversation. Try again.",
      res,
    );
  }
  const body = (await res.json()) as { thread: { id: string } };
  return body.thread;
}

export async function fetchTeamChatMessages(
  threadId: string,
  opts: { cursor?: string; limit?: number } = {},
): Promise<{ messages: TeamChatMessage[]; nextCursor: string | null }> {
  const qs = new URLSearchParams();
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit) qs.set("limit", String(opts.limit));
  const qsStr = qs.toString();
  const suffix = qsStr.length > 0 ? `?${qsStr}` : "";
  const res = await authFetch(
    `${BASE}/api/team-chat/threads/${encodeURIComponent(threadId)}/messages${suffix}`,
  );
  if (!res.ok) {
    return teamChatFail("messages", "Couldn't load messages. Try again.", res);
  }
  return res.json() as Promise<{
    messages: TeamChatMessage[];
    nextCursor: string | null;
  }>;
}

export async function sendTeamChatMessage(
  threadId: string,
  body: TeamChatSendBody,
): Promise<TeamChatMessage> {
  const res = await authFetch(
    `${BASE}/api/team-chat/threads/${encodeURIComponent(threadId)}/messages`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    return teamChatFail("send", "Couldn't send. Try again.", res);
  }
  const out = (await res.json()) as { message: TeamChatMessage };
  return out.message;
}

export async function markTeamChatThreadRead(threadId: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/team-chat/threads/${encodeURIComponent(threadId)}/read`,
    { method: "POST" },
  );
  if (!res.ok) {
    return teamChatFail("mark-read", "Couldn't update read status.", res);
  }
}

export async function fetchTeamChatTranscript(
  messageId: string,
): Promise<TeamChatTranscript> {
  const res = await authFetch(
    `${BASE}/api/team-chat/messages/${encodeURIComponent(messageId)}/transcript`,
  );
  if (!res.ok) {
    return teamChatFail(
      "transcript",
      "Couldn't open the transcript. Try again.",
      res,
    );
  }
  return res.json() as Promise<TeamChatTranscript>;
}

export interface TeamChatMeetingCreateBody {
  title: string;
  /** ISO timestamp; the server refuses past starts. */
  startsAt: string;
  durationMinutes?: number;
  location?: string;
  /** https only — the server refuses anything else with 400. */
  meetingUrl?: string;
  note?: string;
  reminderMinutesBefore?: number;
}

/** Schedule a meeting in a thread — the server commits the meeting + its
 *  invite card together and mirrors a local CalendarEvent best-effort. */
export async function createTeamChatMeeting(
  threadId: string,
  body: TeamChatMeetingCreateBody,
): Promise<{ meeting: TeamChatMeeting; message: TeamChatMessage }> {
  const res = await authFetch(
    `${BASE}/api/team-chat/threads/${encodeURIComponent(threadId)}/meetings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    return teamChatFail(
      "create-meeting",
      "Couldn't schedule the meeting. Try again.",
      res,
    );
  }
  return res.json() as Promise<{
    meeting: TeamChatMeeting;
    message: TeamChatMessage;
  }>;
}

/** Accept/decline a meeting — an upsert, so flipping the answer is fine. */
export async function rsvpTeamChatMeeting(
  meetingId: string,
  response: TeamChatRsvpResponse,
): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/team-chat/meetings/${encodeURIComponent(meetingId)}/rsvp`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response }),
    },
  );
  if (!res.ok) {
    // UX review: on the cancelled race the generic "Try again" is false
    // advice next to a Cancelled banner — say what likely happened.
    // Same log-then-plain-copy shape as teamChatFail.
    const detail = await res.text().catch(() => "");
    console.error(`[team-chat] rsvp failed: ${res.status} ${detail}`);
    throw new Error(
      detail.includes("meeting_cancelled")
        ? "Couldn't send your answer — the meeting may have been cancelled."
        : "Couldn't send your answer. Try again.",
    );
  }
}

/** Organizer-only cancel — flips the meeting to cancelled and posts the
 *  cancellation note in the thread. */
export async function cancelTeamChatMeeting(meetingId: string): Promise<void> {
  const res = await authFetch(
    `${BASE}/api/team-chat/meetings/${encodeURIComponent(meetingId)}/cancel`,
    { method: "POST" },
  );
  if (!res.ok) {
    return teamChatFail(
      "cancel-meeting",
      "Couldn't cancel the meeting. Try again.",
      res,
    );
  }
}

export async function fetchTeamChatUnreadCount(): Promise<number> {
  const res = await authFetch(`${BASE}/api/team-chat/unread-count`);
  // Review: the sidebar polls this on EVERY page every ~20s. With the
  // team_chat module off, the gate 404s the whole surface — that's an
  // expected steady state, not an error: a quiet zero, no console spam.
  // (The poll keeps running, so re-enabling the module recovers alone.)
  if (res.status === 404) return 0;
  if (!res.ok) {
    return teamChatFail("unread-count", "Couldn't load unread count.", res);
  }
  const body = (await res.json()) as { total: number };
  return body.total;
}
