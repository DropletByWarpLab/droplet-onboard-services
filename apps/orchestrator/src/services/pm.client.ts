/**
 * Plane API client — orchestrator-side (used by routes/mobile/pm.ts
 * and the pm-onboard wizard endpoint).
 *
 * Distinct from `packages/tools-core/src/handlers/pm/pm-client.ts`,
 * which the mcp-server child process uses for the LLM-tool path. They
 * intentionally do NOT share code: the tool-side client lives inside
 * the mcp-server's import graph and resolves env at module load; the
 * orchestrator-side client takes `adminKey` as a parameter so request
 * handlers can short-circuit on missing config (returning 400 to the
 * mobile caller) instead of throwing TypeError("Invalid URL").
 *
 * Auth: `X-API-Key: ${adminKey}`. NOT `Authorization: Bearer`.
 *
 * Errors:
 *   - HTTP 4xx / 5xx → PlaneApiError with `.status` + `.detail`
 *   - Network / DNS / timeout → PlaneApiError(0)
 *
 * Callers branch on `err.status === 404` to translate to the route-
 * specific "not found" message — see `mapPmError` in
 * routes/mobile/pm.ts for the contextual 404 fanout.
 */

import { config } from "../config.js";

const HTTP_TIMEOUT_MS = 8_000;

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
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(message);
    this.name = "PlaneApiError";
  }
}

function resolveBase(): string {
  const base = config.DROPLET_PM_API_URL;
  if (!base) {
    throw new PlaneApiError(
      "DROPLET_PM_API_URL not configured",
      0,
      "missing config",
    );
  }
  return base;
}

async function call<T>(
  adminKey: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  options: {
    body?: unknown;
    queryParams?: Record<string, string | number | undefined>;
  } = {},
): Promise<T> {
  if (!adminKey) {
    throw new PlaneApiError(
      "DROPLET_PM_ADMIN_TOKEN not configured",
      0,
      "missing config",
    );
  }
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
        "X-API-Key": adminKey,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const detail = await resp.text().catch(() => "");
      throw new PlaneApiError(
        `Plane ${method} ${path} returned ${resp.status}`,
        resp.status,
        detail,
      );
    }
    if (resp.status === 204) return undefined as unknown as T;
    return (await resp.json()) as T;
  } catch (err) {
    if (err instanceof PlaneApiError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new PlaneApiError(
        `Plane ${method} ${path} timed out after ${HTTP_TIMEOUT_MS}ms`,
        0,
        "timeout",
      );
    }
    throw new PlaneApiError(
      `Plane ${method} ${path} network error`,
      0,
      err instanceof Error ? err.message : String(err),
    );
  } finally {
    clearTimeout(timer);
  }
}

export async function listWorkspaces(adminKey: string): Promise<PlaneWorkspace[]> {
  return call<PlaneWorkspace[]>(adminKey, "GET", "/api/v1/workspaces/");
}

export async function listProjects(
  adminKey: string,
  workspace_slug: string,
  per_page: number,
): Promise<PlaneProject[]> {
  return call<PlaneProject[]>(
    adminKey,
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/`,
    { queryParams: { per_page } },
  );
}

export async function listWorkItems(
  adminKey: string,
  workspace_slug: string,
  project_id: string,
  options: { perPage?: number; state?: string; assignee?: string } = {},
): Promise<PlaneWorkItem[]> {
  return call<PlaneWorkItem[]>(
    adminKey,
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/`,
    {
      queryParams: {
        per_page: options.perPage,
        state: options.state,
        assignee: options.assignee,
      },
    },
  );
}

export async function getWorkItem(
  adminKey: string,
  workspace_slug: string,
  project_id: string,
  work_item_id: string,
): Promise<PlaneWorkItem> {
  return call<PlaneWorkItem>(
    adminKey,
    "GET",
    `/api/v1/workspaces/${encodeURIComponent(workspace_slug)}/projects/${encodeURIComponent(project_id)}/issues/${encodeURIComponent(work_item_id)}/`,
  );
}
