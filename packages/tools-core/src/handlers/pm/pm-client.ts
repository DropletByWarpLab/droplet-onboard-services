/**
 * Plane HTTP client for the `pm_*` tool handlers (WARP-508 read +
 * WARP-509 write).
 *
 * The handlers (list/get/search work items + create/update/comment/
 * transition) all reach Plane through this single module so the URL /
 * auth / error-mapping policy stays in one place. Per spec WARP-498:
 * "All HTTP calls go through packages/tools-core/src/handlers/pm/
 * pm-client.ts — single auth + retry + error-mapping point." Mirrors
 * the orchestrator-side client in apps/orchestrator/src/services/
 * pm.client.ts but lives in tools-core because each tool handler runs
 * in the mcp-server child process and doesn't share the orchestrator's
 * import graph.
 *
 * Auth (WARP-860, ground truth from a live Plane CE v0.24.1 on
 * 2026-06-11): `X-API-Key: <token>`. NOT `Authorization: Bearer`. The
 * token is the RUNTIME-PROVISIONED Plane service API token the
 * orchestrator mints via `POST /api/workspaces/<slug>/service-api-tokens/`
 * (see apps/orchestrator/src/services/pm-service-token.service.ts) and
 * forwards per-call as `ctx.pmApiKey` → the trailing `apiKey` param on
 * every fn here. When no param arrives (legacy / HTTP-transport path)
 * we fall back to `DROPLET_PM_ADMIN_TOKEN` — note that env var is NOT
 * registered in Plane's APIToken table, so that path 401s against a
 * stock CE box; it exists only to keep the old behavior reachable.
 *
 * CE surface limits (also live-probed): `/api/v1` is workspace-scoped
 * only — no `/api/v1/workspaces/` list, no `/search/`, no `/members/`.
 * The handlers translate those 404s for the model.
 *
 * Errors:
 *   - HTTP 4xx / 5xx           → PlaneApiError with `.status`
 *   - Network / DNS / timeout  → PlaneApiError with status 0
 *   - JSON parse failure       → PlaneApiError with status 0
 *
 * The handlers catch `PlaneApiError` and translate to the tool-result
 * code surface (PM_AUTH_FAILED on 401, PM_WORK_ITEM_NOT_FOUND on 404,
 * PM_SEARCH_UNAVAILABLE on the search 404, PM_API_ERROR otherwise).
 * Anything else is a bug — let it bubble to the agent loop's catch.
 *
 * Per architecture-guard rule 4 — chat traffic does NOT touch this
 * client. Control-plane integration only.
 */

const HTTP_TIMEOUT_MS = 8_000;

// --- Public types ---

export interface PlaneWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
  workspace: string;
}

export interface PlaneWorkItem {
  id: string;
  name: string;
  description_html?: string;
  state?: string;
  assignees?: string[];
  labels?: string[];
  created_at: string;
  updated_at: string;
}

export class PlaneApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PlaneApiError";
  }
}

// --- Internals ---

/**
 * Resolve the Plane base URL at call-time (not module-load) so a test
 * that swaps `process.env.DROPLET_PM_API_URL` between cases sees the
 * fresh value, and so a missing env var surfaces a typed
 * `PlaneApiError` instead of `TypeError("Invalid URL")` on the first
 * `new URL(...)`. Same fail-closed posture as the pm-rbac service.
 */
function resolveBase(): string {
  const base = process.env.DROPLET_PM_API_URL ?? "";
  if (!base) {
    throw new PlaneApiError(
      "DROPLET_PM_API_URL not configured — refusing PM call",
      0,
    );
  }
  return base;
}

/**
 * WARP-860 — prefer the per-call `apiKey` (the runtime-provisioned
 * service token forwarded from `ctx.pmApiKey`); fall back to the legacy
 * `DROPLET_PM_ADMIN_TOKEN` env var (HTTP-transport / pre-provisioning
 * path). Neither set → empty header map: Plane rejects with 401 and we
 * let that surface as PlaneApiError(401) rather than refuse at the
 * client layer — keeps the error path uniform across reads and writes.
 */
function authHeaders(apiKey?: string): Record<string, string> {
  const tok = apiKey || process.env.DROPLET_PM_ADMIN_TOKEN || "";
  return tok ? { "X-API-Key": tok } : {};
}

async function call<T>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: {
    body?: unknown;
    queryParams?: Record<string, string | number | undefined>;
    apiKey?: string;
  } = {},
): Promise<T> {
  const url = new URL(path, resolveBase());
  if (options.queryParams) {
    for (const [k, v] of Object.entries(options.queryParams)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(options.apiKey),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new PlaneApiError(
        `Plane ${method} ${path} returned ${resp.status}: ${text.slice(0, 256)}`,
        resp.status,
      );
    }
    if (text.length === 0) return undefined as unknown as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PlaneApiError(
        `Plane ${method} ${path} returned invalid JSON: ${text.slice(0, 256)}`,
        0,
      );
    }
  } catch (err) {
    if (err instanceof PlaneApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new PlaneApiError(
        `Plane ${method} ${path} timed out after ${HTTP_TIMEOUT_MS}ms`,
        0,
      );
    }
    throw new PlaneApiError(
      `Plane ${method} ${path} network error: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  } finally {
    clearTimeout(timer);
  }
}

// --- Read API (WARP-508) ---

export async function listWorkspaces(apiKey?: string): Promise<PlaneWorkspace[]> {
  return call<PlaneWorkspace[]>("GET", "/api/v1/workspaces/", { apiKey });
}

export async function listProjects(
  workspace_slug: string,
  per_page?: number,
  apiKey?: string,
): Promise<PlaneProject[]> {
  return call<PlaneProject[]>(
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/`,
    { queryParams: { per_page }, apiKey },
  );
}

export async function listWorkItems(
  workspace_slug: string,
  project_id: string,
  options: { perPage?: number; state?: string; assignee?: string } = {},
  apiKey?: string,
): Promise<PlaneWorkItem[]> {
  return call<PlaneWorkItem[]>(
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/`,
    {
      queryParams: {
        per_page: options.perPage,
        state: options.state,
        assignee: options.assignee,
      },
      apiKey,
    },
  );
}

export async function getWorkItem(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  apiKey?: string,
): Promise<PlaneWorkItem> {
  return call<PlaneWorkItem>(
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
    { apiKey },
  );
}

export async function searchWorkItems(
  workspace_slug: string,
  query: string,
  per_page?: number,
  apiKey?: string,
): Promise<PlaneWorkItem[]> {
  return call<PlaneWorkItem[]>(
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/search/`,
    { queryParams: { query, per_page }, apiKey },
  );
}

// --- Write API (WARP-509) ---

export interface CreateWorkItemFields {
  name: string;
  description_html?: string;
  assignees?: string[];
  labels?: string[];
}

export interface UpdateWorkItemFields {
  name?: string;
  description_html?: string;
  state_id?: string;
  assignees?: string[];
  labels?: string[];
}

export async function createWorkItem(
  workspace_slug: string,
  project_id: string,
  fields: CreateWorkItemFields,
  apiKey?: string,
): Promise<unknown> {
  return call(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/`,
    { body: fields, apiKey },
  );
}

export async function updateWorkItem(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  fields: UpdateWorkItemFields,
  apiKey?: string,
): Promise<unknown> {
  return call(
    "PATCH",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
    { body: fields, apiKey },
  );
}

export async function addWorkItemComment(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  comment_html: string,
  apiKey?: string,
): Promise<unknown> {
  return call(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/comments/`,
    { body: { comment_html }, apiKey },
  );
}

export async function transitionWorkItem(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  state_id: string,
  apiKey?: string,
): Promise<unknown> {
  return call(
    "PATCH",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
    { body: { state_id }, apiKey },
  );
}
