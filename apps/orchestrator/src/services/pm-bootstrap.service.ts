/**
 * Plane CE instance bootstrap (WARP-860).
 *
 * Plane CE v0.24.1 ships with NO headless setup path: a fresh instance
 * renders the "Welcome aboard Plane — set up your instance" god-mode wall
 * until a human completes the instance-admin sign-up form. It also has no
 * OIDC support (that's a paid-edition feature — the WARP-505 IdP can't be
 * its RP), and its `/api/v1/` token API exposes NO workspace create/list,
 * so the original WARP-507 onboarding (X-API-Key against /api/v1) could
 * never have provisioned anything.
 *
 * This service drives the same HTTP surface Plane's own web frontend uses:
 *
 *   1. `GET  /api/instances/`                 — is_setup_done gate (idempotency)
 *   2. `GET  /auth/get-csrf-token/`           — CSRF secret for the form views
 *   3. `POST /api/instances/admins/sign-up/`  — Django form view; creates the
 *      instance admin user AND flips is_setup_done. Responds 302 always;
 *      errors come back as `?error_code=` on the redirect Location.
 *   4. `POST /auth/sign-in/`                  — mints the `session-id` cookie.
 *      NOTE: the instance-admin console login sets `admin-session-id`, which
 *      Plane's session middleware only reads on `/api/instances/*` paths —
 *      useless for the app API. The regular sign-in is the one that matters.
 *   5. App API (`/api/workspaces/...`) with that cookie — Plane overrides
 *      DRF's SessionAuthentication with a CSRF-exempt subclass
 *      (plane/authentication/session.py), so the cookie alone suffices.
 *
 * Admin identity: DROPLET_PM_ADMIN_EMAIL + a password derived (HMAC) from
 * DROPLET_PM_ADMIN_TOKEN — deterministic across restarts, 64 hex chars
 * (zxcvbn score 4; Plane requires >= 3), and distinct from the raw token so
 * surfacing it to the owner in the wizard never leaks the token itself.
 *
 * Fail-CLOSED: every error path throws PmBootstrapError; callers surface
 * the failure to the wizard rather than pretending the stack is up.
 */

import { createHmac } from "node:crypto";

import pino from "pino";

import { config } from "../config.js";

const logger = pino({ name: "pm-bootstrap" });

const HTTP_TIMEOUT_MS = 15_000;

export class PmBootstrapError extends Error {
  constructor(
    message: string,
    readonly code:
      | "PM_NOT_CONFIGURED"
      | "PM_UNREACHABLE"
      | "INSTANCE_SETUP_FAILED"
      | "SIGN_IN_FAILED"
      | "NO_WORKSPACE"
      | "TOKEN_MINT_FAILED",
  ) {
    super(message);
    this.name = "PmBootstrapError";
  }
}

export function planeAdminEmail(): string {
  return config.DROPLET_PM_ADMIN_EMAIL;
}

/**
 * Deterministic Plane admin password. HMAC of a fixed label keyed by the
 * admin token — NOT the raw token, so showing the password to the owner
 * (PmStep success card) doesn't hand out the token used elsewhere.
 */
export function planeAdminPassword(): string {
  if (!config.DROPLET_PM_ADMIN_TOKEN) {
    throw new PmBootstrapError(
      "DROPLET_PM_ADMIN_TOKEN is not set — cannot derive the Plane admin password",
      "PM_NOT_CONFIGURED",
    );
  }
  return createHmac("sha256", config.DROPLET_PM_ADMIN_TOKEN)
    .update("plane-admin-password.v1")
    .digest("hex");
}

async function planeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = new URL(path, config.DROPLET_PM_API_URL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    return await fetch(url.toString(), {
      // The Django form views answer 302 on success AND failure — never
      // follow; the Location querystring is the error channel.
      redirect: "manual",
      ...init,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new PmBootstrapError(
        `Plane ${path} timed out after ${HTTP_TIMEOUT_MS}ms`,
        "PM_UNREACHABLE",
      );
    }
    throw new PmBootstrapError(
      `Plane ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
      "PM_UNREACHABLE",
    );
  } finally {
    clearTimeout(timer);
  }
}

interface InstanceStatus {
  isSetupDone: boolean;
}

async function fetchInstanceStatus(): Promise<InstanceStatus> {
  const res = await planeFetch("/api/instances/");
  if (!res.ok) {
    throw new PmBootstrapError(
      `GET /api/instances/ returned ${res.status}`,
      "PM_UNREACHABLE",
    );
  }
  const body = (await res.json()) as { instance?: { is_setup_done?: boolean } };
  return { isSetupDone: body.instance?.is_setup_done === true };
}

/** CSRF secret for Plane's Django form views. The csrftoken cookie may be
 *  flagged Secure (WEB_URL is https) and dropped by strict jars over the
 *  in-cluster http hop — so we take the token from the JSON body and send
 *  it back as BOTH the cookie and the X-CSRFToken header ourselves. */
async function fetchCsrfToken(): Promise<string> {
  const res = await planeFetch("/auth/get-csrf-token/");
  if (!res.ok) {
    throw new PmBootstrapError(
      `GET /auth/get-csrf-token/ returned ${res.status}`,
      "PM_UNREACHABLE",
    );
  }
  const body = (await res.json()) as { csrf_token?: string };
  if (!body.csrf_token) {
    throw new PmBootstrapError("CSRF endpoint returned no token", "PM_UNREACHABLE");
  }
  return body.csrf_token;
}

function csrfHeaders(token: string): Record<string, string> {
  return {
    Cookie: `csrftoken=${token}`,
    "X-CSRFToken": token,
    "Content-Type": "application/x-www-form-urlencoded",
  };
}

/** Error code from a Django form view's 302 Location, if any. */
function redirectErrorCode(res: Response): string | null {
  const location = res.headers.get("location") ?? "";
  const match = /[?&]error_code=([^&]+)/.exec(location);
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Complete Plane's god-mode instance setup if it hasn't been done.
 * Idempotent — a set-up instance returns immediately.
 */
export async function ensureInstanceSetup(): Promise<void> {
  const status = await fetchInstanceStatus();
  if (status.isSetupDone) return;

  const csrf = await fetchCsrfToken();
  const form = new URLSearchParams({
    email: planeAdminEmail(),
    password: planeAdminPassword(),
    first_name: "Droplet",
    last_name: "Admin",
    company_name: "Droplet",
    // Django BooleanField parses "False"/"True" (capitalised) — lowercase
    // "false" 500s with "value must be either True or False" (verified live).
    is_telemetry_enabled: "False",
  });

  const res = await planeFetch("/api/instances/admins/sign-up/", {
    method: "POST",
    headers: csrfHeaders(csrf),
    body: form.toString(),
  });

  const errorCode = redirectErrorCode(res);
  // The Location querystring carries error_message=ADMIN_ALREADY_EXIST etc.;
  // error_code is numeric (5150). Look at both.
  const location = res.headers.get("location") ?? "";
  const adminExists = /ADMIN(_USER)?_ALREADY_EXIST/.test(location);
  if (errorCode && errorCode !== "0" && !adminExists) {
    throw new PmBootstrapError(
      `Plane instance sign-up rejected: ${errorCode}`,
      "INSTANCE_SETUP_FAILED",
    );
  }

  // The view answers 302 with no JSON on success — verify by re-reading.
  // GET /api/instances/ is wrapped in Plane's cache decorator and can lag a
  // just-completed setup (observed live on .87) — ADMIN_ALREADY_EXIST plus a
  // setup-done re-read is the normal "someone got here first" case, while
  // ADMIN_ALREADY_EXIST with setup still pending is a genuinely wedged
  // half-state (admin row created, is_setup_done never flipped) that has no
  // HTTP repair path. Sleep briefly to let the cache invalidate, then retry
  // once before declaring the instance wedged.
  await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
  let after = await fetchInstanceStatus();
  if (!after.isSetupDone) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    after = await fetchInstanceStatus();
  }
  if (!after.isSetupDone) {
    throw new PmBootstrapError(
      adminExists
        ? "Plane instance is wedged: an instance admin exists but setup never completed — repair requires `manage.py shell` (set Instance.is_setup_done=True)"
        : `Plane instance setup did not complete (status ${res.status})`,
      "INSTANCE_SETUP_FAILED",
    );
  }
  logger.info(
    { adminEmail: planeAdminEmail(), event_type: "pm_instance_bootstrapped" },
    "completed Plane instance setup",
  );
}

/**
 * Portable Set-Cookie extractor that works on both Node 18 and Node >= 19.7.
 *
 * `Headers.getSetCookie()` was added in Node 19.7 (undici 5.21). On Node 18
 * the raw `set-cookie` header is a comma-joined concatenation of all cookie
 * strings. Splitting on "," is unsafe because cookie Expires directives also
 * contain commas ("Thu, 01 Jan 2026 00:00:00 GMT"). We instead extract the
 * two cookie names Plane is known to set by regex, which is reliable for
 * well-formed values (no semicolons or commas inside the value portion).
 */
function getSetCookies(res: Response): string[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (typeof (res.headers as any).getSetCookie === "function") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (res.headers as any).getSetCookie() as string[];
  }
  // Node 18 fallback: extract known cookie names from the raw header.
  const raw = res.headers.get("set-cookie") ?? "";
  const result: string[] = [];
  const csrfMatch = raw.match(/csrftoken=[^;,]+/);
  const sessionMatch = raw.match(/session-id=[^;,]+/);
  if (csrfMatch) result.push(csrfMatch[0]);
  if (sessionMatch) result.push(sessionMatch[0]);
  return result;
}

/**
 * Sign the bootstrap admin in through the REGULAR app flow and return the
 * `session-id` cookie pair for app-API calls. (Plane's session middleware
 * routes `/api/instances/*` to a separate `admin-session-id` cookie, so an
 * admin-console login cannot drive `/api/workspaces/...`.)
 */
export async function getAppSessionCookie(): Promise<string> {
  const csrf = await fetchCsrfToken();
  const form = new URLSearchParams({
    email: planeAdminEmail(),
    password: planeAdminPassword(),
    csrfmiddlewaretoken: csrf,
  });

  const res = await planeFetch("/auth/sign-in/", {
    method: "POST",
    headers: csrfHeaders(csrf),
    body: form.toString(),
  });

  const errorCode = redirectErrorCode(res);
  if (errorCode && errorCode !== "0") {
    throw new PmBootstrapError(
      `Plane admin sign-in rejected: ${errorCode}`,
      "SIGN_IN_FAILED",
    );
  }

  // undici exposes every Set-Cookie via getSetCookie() (Node >= 19.7).
  // On Node 18 the API is absent and the raw header is a comma-joined
  // concatenation of all Set-Cookie values. A naive split on "," is
  // unreliable (cookies can include commas in Expires directives), so
  // we extract the known cookie names by regex on the raw string.
  const setCookies: string[] = getSetCookies(res);
  const sessionCookie = setCookies
    .map((c) => c.split(";")[0]?.trim())
    .find((c) => c?.startsWith("session-id="));
  if (!sessionCookie) {
    throw new PmBootstrapError(
      `Plane sign-in returned no session-id cookie (status ${res.status})`,
      "SIGN_IN_FAILED",
    );
  }
  return sessionCookie;
}

// First boot runs Plane's DB migrations before pm-api answers — give the
// stack ~10 minutes of patience before declaring the bootstrap failed.
const BOOTSTRAP_RETRY_DELAY_MS = 30_000;
const BOOTSTRAP_MAX_ATTEMPTS = 20;

/**
 * Fire-and-forget startup hook (index.ts): kill the god-mode wall as soon
 * as the PM stack is reachable, so the embedded Plane works even when the
 * owner skipped the wizard's PM step. Bounded retries; never throws.
 */
export function bootstrapPlaneInstanceInBackground(): void {
  if (!config.DROPLET_PM_ADMIN_TOKEN) {
    logger.info(
      "DROPLET_PM_ADMIN_TOKEN unset — skipping Plane instance bootstrap",
    );
    return;
  }
  void (async () => {
    for (let attempt = 1; attempt <= BOOTSTRAP_MAX_ATTEMPTS; attempt++) {
      try {
        await ensureInstanceSetup();
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt === BOOTSTRAP_MAX_ATTEMPTS) {
          logger.warn(
            { err: message, attempts: attempt },
            "Plane instance bootstrap gave up — the PM wall stays until /api/pm/onboard runs",
          );
          return;
        }
        logger.info(
          { err: message, attempt },
          "Plane instance bootstrap not ready yet — retrying",
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, BOOTSTRAP_RETRY_DELAY_MS);
          // Don't hold the process open during shutdown just for a retry.
          timer.unref();
        });
      }
    }
  })();
}

/**
 * Session-authenticated app-API call (JSON). Plane's BaseSessionAuthentication
 * is CSRF-exempt, so the session cookie is the whole handshake.
 */
export async function planeAppApi<T>(
  path: string,
  sessionCookie: string,
  init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  const res = await planeFetch(path, {
    method: init.method ?? "GET",
    headers: {
      Cookie: sessionCookie,
      Accept: "application/json",
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  let body: T;
  try {
    body = (await res.json()) as T;
  } catch {
    throw new PmBootstrapError(
      `Plane ${path} returned non-JSON body (status ${res.status})`,
      "PM_UNREACHABLE",
    );
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// WARP-867 — session-cached app-API access + the Plane service API token.
//
// Plane CE's `/api/v1/` token API has NO workspace list and NO search (its
// url modules are cycle/intake/issue/member/module/project/state only), and
// the only mintable credential is a SERVER-GENERATED service token
// (`POST /api/workspaces/:slug/service-api-tokens/` — idempotent, returns
// the existing is_service token). So the orchestrator mints that token at
// runtime through the bootstrap admin's session and serves it to the v1
// consumers (pm-rbac, pm.client, tools-core pm handlers via
// GET /api/pm/service-token); workspace listing + search are proxied over
// the session app API instead of the nonexistent v1 routes.
// ---------------------------------------------------------------------------

// Plane sessions live 7 days — cache the cookie and re-login on 401 rather
// than paying the CSRF + sign-in dance on every proxied call.
let cachedSession: string | null = null;
let cachedServiceToken: string | null = null;

/** Drop the cached service token (e.g. after Plane returned 401 for it —
 *  a wiped pm DB invalidates old tokens). Next call re-mints. */
export function invalidatePlaneServiceToken(): void {
  cachedServiceToken = null;
}

/** Drop the cached session cookie (e.g. after Plane returned 403 for a
 *  DRF expired-session response). Next app-API call will re-authenticate. */
export function invalidatePlaneSession(): void {
  cachedSession = null;
}

async function getCachedSession(): Promise<string> {
  if (cachedSession) return cachedSession;
  await ensureInstanceSetup();
  cachedSession = await getAppSessionCookie();
  return cachedSession;
}

/** Session-cached app-API call; one retry with a fresh sign-in on 401. */
async function planeAppApiAuthed<T>(
  path: string,
  init: { method?: "GET" | "POST" | "PATCH"; body?: unknown } = {},
): Promise<{ status: number; body: T }> {
  let res = await planeAppApi<T>(path, await getCachedSession(), init);
  if (res.status === 401) {
    cachedSession = null;
    res = await planeAppApi<T>(path, await getCachedSession(), init);
  }
  return res;
}

export interface PlaneWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
}

/** Workspaces visible to the bootstrap admin (it owns every workspace
 *  pm-onboard creates). Uses `/api/users/me/workspaces/` — the bare
 *  `GET /api/workspaces/` list 400s on CE v0.24.1 (cache-decorator quirk). */
export async function listPlaneWorkspaces(): Promise<PlaneWorkspaceSummary[]> {
  const { status, body } = await planeAppApiAuthed<
    Array<{ id: string; slug: string; name: string }>
  >("/api/users/me/workspaces/");
  if (status !== 200 || !Array.isArray(body)) {
    throw new PmBootstrapError(
      `Plane workspace list returned ${status}`,
      "PM_UNREACHABLE",
    );
  }
  return body.map((w) => ({ id: w.id, slug: w.slug, name: w.name }));
}

/** Free-text work-item search via the app API's global-search endpoint
 *  (`results.issue`); the v1 token API has no search at all. */
export async function searchPlaneWorkItems(
  workspaceSlug: string,
  query: string,
): Promise<unknown[]> {
  const { status, body } = await planeAppApiAuthed<{
    results?: { issue?: unknown[] };
  }>(
    `/api/workspaces/${encodeURIComponent(workspaceSlug)}/search/?search=${encodeURIComponent(query)}`,
  );
  if (status !== 200) {
    throw new PmBootstrapError(
      `Plane search returned ${status}`,
      "PM_UNREACHABLE",
    );
  }
  return body?.results?.issue ?? [];
}

/**
 * The Plane service API token for `/api/v1/` calls (X-Api-Key header).
 * Minted lazily through the first workspace (service tokens are
 * workspace-scoped to mint but authenticate the admin user everywhere)
 * and cached for the process lifetime; the mint endpoint is idempotent
 * so a restart re-fetches the SAME token.
 *
 * Throws NO_WORKSPACE until PM onboarding has created a workspace —
 * every v1 route is workspace-scoped anyway, so there is nothing the
 * token could be used for before that.
 */
export async function getPlaneServiceToken(): Promise<string> {
  if (cachedServiceToken) return cachedServiceToken;
  const workspaces = await listPlaneWorkspaces();
  if (workspaces.length === 0) {
    throw new PmBootstrapError(
      "no Plane workspace exists yet — complete PM onboarding first",
      "NO_WORKSPACE",
    );
  }
  const slug = workspaces[0].slug;
  const res = await planeAppApiAuthed<{ token?: string }>(
    `/api/workspaces/${encodeURIComponent(slug)}/service-api-tokens/`,
    { method: "POST", body: { label: "droplet-orchestrator" } },
  );
  if ((res.status !== 200 && res.status !== 201) || !res.body?.token) {
    throw new PmBootstrapError(
      `Plane service-token mint returned ${res.status}`,
      "TOKEN_MINT_FAILED",
    );
  }
  cachedServiceToken = res.body.token;
  logger.info(
    { workspaceSlug: slug, created: res.status === 201, event_type: "pm_service_token_ready" },
    "Plane service API token ready",
  );
  return cachedServiceToken;
}
