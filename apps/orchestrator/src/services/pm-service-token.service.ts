/**
 * Plane service API token — runtime provisioning (WARP-860).
 *
 * Ground truth from a live Plane CE v0.24.1 (2026-06-11):
 *
 *   - `DROPLET_PM_ADMIN_TOKEN` is registered NOWHERE in Plane (zero rows
 *     in its APIToken table) — every `/api/v1` call sent with it 401s.
 *     The env var's only legitimate remaining use is deriving the Plane
 *     admin password (pm-bootstrap.service.ts).
 *   - `POST /api/workspaces/<slug>/service-api-tokens/` (session-cookie
 *     app API, `{}` body) is the real provisioning endpoint: first call
 *     answers 201 + `{"token":"plane_api_..."}`; every repeat answers
 *     200 and re-returns the SAME token. Idempotent — so an in-memory
 *     cache, re-provisioned per orchestrator boot, is the entire
 *     persistence story. No DB row, no schema migration, no env var
 *     (the value is server-generated and cannot be configured).
 *   - The minted token authenticates `/api/v1` via the `X-API-Key`
 *     header both existing clients already send.
 *   - Workspace discovery must use `GET /api/users/me/workspaces/`
 *     (the session app API Plane's own sidebar uses). `GET
 *     /api/workspaces/` 400s and `GET /api/v1/workspaces/` 404s on CE.
 *
 * Consumers: routes/mobile/pm.ts, pm-rbac.service.ts, and the agent
 * loop (llm-agent.service.ts forwards the token per `pm_*` dispatch via
 * `_meta.pmToken`; see McpCallContext).
 *
 * Fail-CLOSED: every error path throws — never a guessed/empty token.
 * PmBootstrapError (Plane unreachable / sign-in failed) propagates
 * untouched; this module's own failures are PmServiceTokenError.
 *
 * NEVER log the token value anywhere.
 */

import pino from "pino";

import {
  getAppSessionCookie,
  planeAppApi,
} from "./pm-bootstrap.service.js";

const logger = pino({ name: "pm-service-token" });

export class PmServiceTokenError extends Error {
  constructor(
    message: string,
    readonly code: "PM_NOT_ONBOARDED" | "PROVISION_FAILED" | "WORKSPACE_LIST_FAILED",
  ) {
    super(message);
    this.name = "PmServiceTokenError";
  }
}

export interface PlaneWorkspaceSummary {
  id: string;
  slug: string;
  name: string;
}

// In-memory cache. Plane re-returns the same token on every repeat
// provisioning call, so losing this on restart costs one extra POST —
// nothing to persist.
let cachedToken: string | null = null;
// Single-flight: concurrent first-callers (e.g. parallel pm_* tool
// dispatches on a cold cache) share one provisioning run. Cleared in
// finally so failures are NEVER cached.
let inFlight: Promise<string> | null = null;

/**
 * Workspace list via the session app API, projected to {id, slug, name}.
 * Handles both the bare-array and `{results}` response shapes (mirrors
 * pm-onboard.ts's findWorkspaceByName).
 */
async function listWorkspacesWithSession(
  sessionCookie: string,
): Promise<PlaneWorkspaceSummary[]> {
  const { status, body } = await planeAppApi<
    PlaneWorkspaceSummary[] | { results?: PlaneWorkspaceSummary[] }
  >("/api/users/me/workspaces/", sessionCookie);
  if (status !== 200) {
    throw new PmServiceTokenError(
      `Plane GET /api/users/me/workspaces/ returned ${status}`,
      "WORKSPACE_LIST_FAILED",
    );
  }
  const all = Array.isArray(body) ? body : body.results ?? [];
  return all.map((w) => ({ id: w.id, slug: w.slug, name: w.name }));
}

/**
 * List the Plane workspaces the bootstrap admin can see. Used by the
 * mobile `/api/mobile/pm/workspaces` route and the agent loop's
 * `pm_list_workspaces` injection — Plane CE's `/api/v1` has no
 * workspace list, so the session app API is the only source.
 */
export async function listPlaneWorkspaces(): Promise<PlaneWorkspaceSummary[]> {
  const session = await getAppSessionCookie();
  return listWorkspacesWithSession(session);
}

async function provision(): Promise<string> {
  // One session reused for BOTH the workspace list and the token POST —
  // don't sign in twice.
  const session = await getAppSessionCookie();

  const workspaces = await listWorkspacesWithSession(session);
  if (workspaces.length === 0) {
    throw new PmServiceTokenError(
      "Plane has no workspace yet — run the wizard PM step (POST /api/pm/onboard) first",
      "PM_NOT_ONBOARDED",
    );
  }
  const workspace = workspaces[0];
  if (workspaces.length > 1) {
    logger.info(
      { workspaceSlug: workspace.slug, workspaceCount: workspaces.length },
      "multiple Plane workspaces — provisioning the service token against the first",
    );
  }

  const { status, body } = await planeAppApi<{ token?: unknown }>(
    `/api/workspaces/${encodeURIComponent(workspace.slug)}/service-api-tokens/`,
    session,
    { method: "POST", body: {} },
  );
  // 201 = freshly minted; 200 = Plane re-returned the existing token
  // (verified idempotent on CE v0.24.1).
  if (status !== 200 && status !== 201) {
    throw new PmServiceTokenError(
      `Plane POST service-api-tokens returned ${status}`,
      "PROVISION_FAILED",
    );
  }
  const token = body?.token;
  if (typeof token !== "string" || token.length === 0) {
    throw new PmServiceTokenError(
      "Plane POST service-api-tokens returned no token",
      "PROVISION_FAILED",
    );
  }

  // NEVER log the token itself.
  logger.info(
    {
      workspaceSlug: workspace.slug,
      created: status === 201,
      event_type: "pm_service_token_provisioned",
    },
    "Plane service API token provisioned",
  );
  return token;
}

/**
 * The Plane service API token — cached after the first successful
 * provisioning, single-flighted while one is running.
 *
 * @throws PmServiceTokenError (PM_NOT_ONBOARDED / PROVISION_FAILED /
 *   WORKSPACE_LIST_FAILED) — and lets PmBootstrapError propagate.
 */
export async function getPmServiceToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  if (inFlight) return inFlight;
  inFlight = provision()
    .then((token) => {
      cachedToken = token;
      return token;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/** Drop the cached token so the next call re-provisions (e.g. after a
 *  Plane 401 — the workspace may have been reset under us). */
export function invalidatePmServiceToken(): void {
  cachedToken = null;
}

/**
 * Per-dispatch `_meta` fields for a `pm_*` tool call, shared by every
 * MCP dispatch path (chat agent loop, ToolSpec run-now walker,
 * tool-schedule ticker). Non-`pm_` tools get `{}` for free.
 *
 * Resolution failures return `{}` instead of throwing — the dispatch
 * proceeds without a token and the handler surfaces an honest
 * PM_AUTH_FAILED, mirroring the enhancement posture: a flaky PM stack
 * must never block the tool loop itself.
 */
export async function pmCallContextForTool(
  toolName: string,
): Promise<{ pmToken?: string; pmWorkspaces?: PlaneWorkspaceSummary[] }> {
  if (!toolName.startsWith("pm_")) return {};
  let pmToken: string;
  try {
    pmToken = await getPmServiceToken();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), toolName },
      "could not resolve the Plane service token — dispatching without it",
    );
    return {};
  }
  if (toolName !== "pm_list_workspaces") return { pmToken };
  // Plane CE has no /api/v1 workspace list — inject the session-app-API
  // list so pm_list_workspaces can answer at all. Best-effort: without
  // it the handler falls through to the HTTP call and names the gap.
  try {
    return { pmToken, pmWorkspaces: await listPlaneWorkspaces() };
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "could not resolve the Plane workspace list for pm_list_workspaces",
    );
    return { pmToken };
  }
}

/**
 * Run `fn` with the (possibly cached) service token. If it throws and
 * `isAuthError(err)` holds, invalidate the cache, re-provision once,
 * and retry exactly once; any other error — and a second auth failure —
 * rethrows.
 */
export async function withPmServiceToken<T>(
  fn: (token: string) => Promise<T>,
  isAuthError: (err: unknown) => boolean,
): Promise<T> {
  const token = await getPmServiceToken();
  try {
    return await fn(token);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    logger.warn(
      "Plane rejected the service token — re-provisioning and retrying once",
    );
    invalidatePmServiceToken();
    const fresh = await getPmServiceToken();
    return fn(fresh);
  }
}
