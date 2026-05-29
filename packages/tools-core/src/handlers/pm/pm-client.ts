/**
 * WARP-509 — Plane HTTP client for the four `pm_*` write tools.
 *
 * The handlers (create-work-item, update-work-item, add-work-item-comment,
 * transition-work-item) all reach Plane through this single module so the
 * URL / auth / error-mapping policy stays in one place. The orchestrator
 * matches the broader Droplet contract: service-principals proxy through
 * the orchestrator, so this client targets `DROPLET_PM_API_URL` over the
 * compose bridge network and presents `DROPLET_PM_ADMIN_TOKEN` as
 * `X-API-Key` (Plane's accepted shape).
 *
 * Errors:
 *   - HTTP 4xx / 5xx           → throw PlaneApiError with `.status`
 *   - Network / DNS / timeout  → throw PlaneApiError with status 0
 *   - JSON parse failure       → throw PlaneApiError with status 0 + raw text
 *
 * The handlers catch `PlaneApiError` and translate to the tool-result
 * code surface (PM_WORK_ITEM_NOT_FOUND on 404, PM_API_ERROR otherwise).
 * Anything else is a bug — let it bubble to the agent loop's catch.
 */

const HTTP_TIMEOUT_MS = 8_000;

export class PlaneApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "PlaneApiError";
  }
}

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
      "DROPLET_PM_API_URL not configured — refusing PM write",
      0,
    );
  }
  return base;
}

/**
 * Returns `X-API-Key` if `DROPLET_PM_ADMIN_TOKEN` is set, empty header
 * map otherwise. The Plane upstream rejects unauthenticated calls
 * with 401 in either case; we let that surface as PlaneApiError(401)
 * rather than refuse at the client layer.
 */
function authHeaders(): Record<string, string> {
  const tok = process.env.DROPLET_PM_ADMIN_TOKEN ?? "";
  return tok ? { "X-API-Key": tok } : {};
}

async function call<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const url = new URL(path, resolveBase()).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        ...authHeaders(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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

// --- Public API consumed by handlers/ ---

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
): Promise<unknown> {
  return call(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/`,
    fields,
  );
}

export async function updateWorkItem(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  fields: UpdateWorkItemFields,
): Promise<unknown> {
  return call(
    "PATCH",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
    fields,
  );
}

export async function addWorkItemComment(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  comment_html: string,
): Promise<unknown> {
  return call(
    "POST",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/comments/`,
    { comment_html },
  );
}

export async function transitionWorkItem(
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
  state_id: string,
): Promise<unknown> {
  return call(
    "PATCH",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
    { state_id },
  );
}
