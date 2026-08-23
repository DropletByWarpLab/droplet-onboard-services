/**
 * WARP-2115 / ADR-041 — the pure decisions behind a Microsoft 365 link.
 *
 * Kept free of I/O (no prisma, no network, no clock of its own) so the parts
 * that are easy to get quietly wrong are cheap to test exhaustively.
 *
 * The important one is `classifyAuthFailure`. Entra reports "your grant no
 * longer works" and "your app registration is not accepted here" through
 * overlapping error codes, but they need opposite responses:
 *
 *   - a dead grant is NORMAL. Refresh tokens roll on a 90-day window; an admin
 *     password reset, a revoked consent, or a box left off past the window all
 *     kill it. The person signs in again and everything resumes. Surfacing
 *     that as an "error" would be both alarming and unactionable.
 *   - a rejected app registration is OURS to fix. Telling the customer to sign
 *     in again just loops them through a flow that cannot succeed.
 */

/** How long a device-code sign-in stays valid. Microsoft expires the code in
 *  ~15 minutes; we sweep at 15 so a stale PENDING_CONSENT row can never
 *  outlive the code it is waiting on. */
export const PENDING_FLOW_TTL_MS = 15 * 60 * 1000;

/**
 * The four ways an authentication attempt can end badly. They are separated
 * because each needs a genuinely different response, and collapsing any two of
 * them produces a bug a customer feels:
 *
 *   - `NEEDS_RECONNECT` — the grant is dead. Ask the person to sign in again.
 *   - `ERROR` — configuration or tenant policy. Signing in again cannot help.
 *   - `TRANSIENT` — the network or Microsoft wobbled. **Change nothing.** A
 *     healthy box that loses WAN for thirty seconds during a refresh must not
 *     be downgraded; ERROR is terminal, and the sync engine (WARP-2118) skips
 *     rows in it, so a blip would silently and permanently stop syncing.
 *   - `ABANDONED` — the person closed the tab or clicked Cancel. Nothing is
 *     wrong; the connection simply goes back to DISCONNECTED so they can try
 *     again. Reporting this as an error would be alarming and untrue.
 */
export type AuthFailureKind = "NEEDS_RECONNECT" | "ERROR" | "TRANSIENT" | "ABANDONED";

/** The shape MSAL errors give us. Both fields are optional because MSAL is not
 *  consistent about which one carries the reason — hence we match on both. */
export interface EntraFailureLike {
  errorCode?: string;
  errorMessage?: string;
  /** HTTP status where MSAL surfaces one — 429/5xx are transient. */
  statusCode?: number;
}

/** OAuth-level codes that always mean "the person must interact again". */
const RECONNECT_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
  "login_required",
]);

/** OAuth-level codes that always mean "the app registration is the problem". */
const CONFIG_ERROR_CODES: ReadonlySet<string> = new Set([
  "unauthorized_client",
  "invalid_client",
  "invalid_request",
  "unsupported_grant_type",
]);

/**
 * The person walked away from the sign-in. Not a fault of any kind: they
 * closed the tab, let the code lapse, or pressed Cancel. The connection
 * returns to DISCONNECTED so they can simply start again.
 */
const ABANDONED_ERROR_CODES: ReadonlySet<string> = new Set([
  "authorization_declined",
  "access_denied",
  "expired_token",
  "device_code_expired",
  "user_cancelled",
  "user_timeout_reached",
]);

/**
 * The network or Microsoft wobbled. These MUST NOT change a healthy
 * connection's state — see AuthFailureKind. MSAL surfaces transport problems
 * with these codes, and Entra's own 429/5xx family lands here too.
 */
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  "network_error",
  "temporarily_unavailable",
  "request_timeout",
  "server_error",
  "service_unavailable",
  "no_network_connectivity",
  "post_request_failed",
  "endpoints_resolution_error",
  "openid_config_error",
  "unable_to_load_token",
  "throttled_error",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

/**
 * AADSTS codes that mean re-consent, checked against `errorMessage` because
 * MSAL often reports the generic `invalid_grant` at the code level and puts
 * the actual reason in the message.
 */
const RECONNECT_AADSTS: readonly string[] = [
  "AADSTS50173", // grant expired / revoked (password change, admin revoke)
  "AADSTS700082", // refresh token expired due to inactivity
  "AADSTS50078", // re-authentication required
  "AADSTS50076", // MFA required for this resource
  "AADSTS65001", // user or admin has not consented
  "AADSTS50058", // silent sign-in attempted with no session
];

/**
 * AADSTS codes that mean configuration/policy, NOT a dead grant. These are
 * checked BEFORE the reconnect codes because Entra pairs some of them with a
 * generic `invalid_grant` at the code level — most importantly AADSTS50199,
 * where the tenant blocks device code flow. That one must not read as
 * "reconnect": the person has to use the auth-code path instead, and looping
 * them back through device code would fail identically every time.
 */
const CONFIG_AADSTS: readonly string[] = [
  "AADSTS700016", // application not found in this tenant
  "AADSTS50199", // device code flow blocked by policy / requires confirmation
  "AADSTS7000215", // invalid client secret
  "AADSTS900023", // invalid tenant identifier
  "AADSTS90002", // tenant not found
];

function haystack(err: EntraFailureLike): string {
  return `${err.errorCode ?? ""} ${err.errorMessage ?? ""}`;
}

/**
 * Decide whether an authentication failure should move the connection to
 * NEEDS_RECONNECT (ask the person to sign in again) or ERROR (we or the tenant
 * must change something first).
 *
 * Defaults to ERROR for anything unrecognised: an unknown failure that we
 * wrongly call "reconnect" turns into a customer repeatedly signing in against
 * a problem that sign-in cannot solve, which is the worse failure mode.
 */
export function classifyAuthFailure(err: EntraFailureLike): AuthFailureKind {
  const text = haystack(err);
  const code = (err.errorCode ?? "").trim();

  // Transport first: a network failure carries no meaningful OAuth code, and
  // misreading one as ERROR permanently downgrades a healthy connection.
  if (TRANSIENT_ERROR_CODES.has(code)) return "TRANSIENT";
  if (isRetryableStatus(err.statusCode)) return "TRANSIENT";

  // Abandonment before the grant codes: `expired_token` is an OAuth code, but
  // in the device-code flow it just means the person never finished.
  if (ABANDONED_ERROR_CODES.has(code)) return "ABANDONED";

  // Config/policy wins over the generic OAuth code — see CONFIG_AADSTS.
  if (CONFIG_AADSTS.some((c) => text.includes(c))) return "ERROR";
  if (RECONNECT_AADSTS.some((c) => text.includes(c))) return "NEEDS_RECONNECT";

  if (CONFIG_ERROR_CODES.has(code)) return "ERROR";
  if (RECONNECT_ERROR_CODES.has(code)) return "NEEDS_RECONNECT";

  return "ERROR";
}

/** 429 and the 5xx family are Microsoft-side wobbles, not a dead grant. */
function isRetryableStatus(status: number | undefined): boolean {
  if (typeof status !== "number") return false;
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Has an in-flight sign-in stopped being valid?
 *
 * A missing deadline counts as expired. That is deliberate: the in-memory
 * device-code flow does not survive an orchestrator restart, and a
 * PENDING_CONSENT row with no deadline would otherwise never be swept — the
 * person could never start a new sign-in because one would always appear to be
 * in progress.
 */
export function isPendingFlowExpired(
  pendingFlowExpiresAt: Date | null | undefined,
  now: Date,
): boolean {
  if (!pendingFlowExpiresAt) return true;
  return pendingFlowExpiresAt.getTime() <= now.getTime();
}

/** Max length of a persisted `lastError`. Entra payloads can be enormous and
 *  this column is rendered in the dashboard. */
const MAX_ERROR_LEN = 500;

/**
 * Patterns for material that must never reach `lastError` — which is persisted,
 * rendered in the dashboard, and liable to end up in logs. Entra sometimes
 * echoes request parameters back inside an error message, so a naive
 * pass-through can persist the very token the cache encryption exists to
 * protect.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `name=<secret>` / `name: <secret>` — keep the NAME, drop the value, so the
  // message still says which credential was involved.
  [
    /\b(refresh_token|access_token|id_token|device_code|user_code|client_secret|code_verifier|assertion|code)\s*[=:]\s*\S+/gi,
    "$1=[redacted]",
  ],
  [/\bBearer\s+\S+/gi, "Bearer [redacted]"],
  // A BARE JWT has no name and no delimiter, so it must be replaced WHOLESALE.
  // Appending a label to the match (the earlier bug) left the token intact.
  [/\bey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g, "[redacted-jwt]"],
  // MSAL/Entra secrets and codes are long opaque runs; a bare one with no
  // surrounding name would otherwise survive every rule above.
  [/\b[A-Za-z0-9_-]{40,}\b/g, "[redacted]"],
];

/**
 * Turn an Entra failure into something safe to persist and show.
 *
 * Keeps the AADSTS identifier where present — that is the one token of the
 * message that makes a failure diagnosable and searchable — while stripping
 * credential material and bounding the length.
 */
export function redactAuthError(err: EntraFailureLike): string {
  const code = (err.errorCode ?? "").trim();
  // Fall back to a plain Error's `message` so a non-MSAL failure (a DNS error,
  // a Prisma error) keeps its text instead of collapsing to "no reason given".
  let message = (
    err.errorMessage ??
    (err as { message?: string }).message ??
    ""
  ).trim();

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    message = message.replace(pattern, replacement);
  }

  const combined = [code, message].filter(Boolean).join(": ").trim();
  if (!combined) return "Microsoft sign-in failed without giving a reason.";

  return combined.length > MAX_ERROR_LEN
    ? `${combined.slice(0, MAX_ERROR_LEN - 1)}…`
    : combined;
}
