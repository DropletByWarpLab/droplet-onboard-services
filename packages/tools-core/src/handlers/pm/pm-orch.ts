/**
 * Orchestrator-backed client for the `pm_*` tool handlers (ADR-026).
 *
 * Replaces the old Plane HTTP client: the handlers now reach the orchestrator's
 * NATIVE PM surface (`/api/pm/*`, backed by the Pm* Prisma models) through
 * `ctx.http.orchestrator` — the mcp-server auto-injects the service-principal
 * Bearer JWT, so there is no token to mint or inject. Tool dispatch routing
 * through the orchestrator (not a third-party container) is the canonical path
 * per architecture-guard.
 *
 * The tool wire shapes (`PlaneWorkspace`/`PlaneProject`/`PlaneWorkItem`,
 * preserved here under their original names so the MCP contract is byte-stable)
 * are mapped from the orchestrator's rich camelCase shapes by the mappers below.
 *
 * Errors: a non-2xx orchestrator response becomes `OrchPmError(message, status)`;
 * handlers map 404 → PM_WORK_ITEM_NOT_FOUND and everything else → PM_API_ERROR,
 * exactly as before. Non-OrchPmError throwables bubble to the agent loop.
 */

import type { ToolContext } from "../../types.js";

// ── Wire shapes (unchanged — the MCP contract) ───────────────────────────────

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

export class OrchPmError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "OrchPmError";
  }
}

// ── Native (orchestrator) shapes we read ─────────────────────────────────────

interface ApiProject {
  id: string;
  name: string;
  identifier: string;
  workspaceSlug: string;
}

interface ApiWorkItem {
  id: string;
  name: string;
  descriptionHtml: string | null;
  stateId: string | null;
  state: { name: string } | null;
  assignees: string[];
  labels: Array<{ name: string }>;
  createdAt: string;
  updatedAt: string;
}

// ── Mappers: native → wire ───────────────────────────────────────────────────

export function toPlaneProject(p: ApiProject): PlaneProject {
  return { id: p.id, name: p.name, identifier: p.identifier, workspace: p.workspaceSlug };
}

export function toPlaneWorkItem(w: ApiWorkItem): PlaneWorkItem {
  return {
    id: w.id,
    name: w.name,
    description_html: w.descriptionHtml ?? undefined,
    // Contract `state` is a single string; surface the human state name
    // (falling back to its id) so the LLM reads "In Progress", not a UUID.
    state: w.state?.name ?? w.stateId ?? undefined,
    assignees: w.assignees ?? [],
    labels: (w.labels ?? []).map((l) => l.name),
    created_at: w.createdAt,
    updated_at: w.updatedAt,
  };
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

const ORCH_TIMEOUT_MS = 8000;

export async function callOrch<T = unknown>(
  ctx: ToolContext,
  method: "get" | "post" | "patch" | "delete",
  path: string,
  body?: unknown,
): Promise<T> {
  const http = ctx.http.orchestrator;

  // WARP-887: the old Promise.race fired the 8s timeout but never cancelled the
  // in-flight request, so a slow orchestrator leaked an open socket per pm_*
  // call (the agent loop fires several pm_* tools per turn). On the deadline we
  // now do BOTH: reject the race (a self-enforcing 504 that settles callOrch
  // even if a transport ignored the signal — preserving the old guarantee) AND
  // abort the request so the socket is actually released. reject() runs BEFORE
  // abort() so the race settles on the 504, not the transport's AbortError,
  // keeping the error type + handler mapping (404 → PM_WORK_ITEM_NOT_FOUND,
  // else → PM_API_ERROR) byte-identical to before.
  const controller = new AbortController();
  const opts = { headers: { Accept: "application/json" }, signal: controller.signal };

  let timerId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timerId = setTimeout(() => {
      reject(new OrchPmError("orchestrator timeout", 504));
      controller.abort();
    }, ORCH_TIMEOUT_MS);
  });

  const callPromise = (async (): Promise<Response> => {
    switch (method) {
      case "get":
        return http.get(path, opts);
      case "delete":
        return http.delete(path, opts);
      case "post":
        return http.post(path, body, opts);
      case "patch":
        return http.patch(path, body, opts);
    }
  })().finally(() => clearTimeout(timerId));
  // Once the timeout wins the race, the request's post-abort rejection is moot —
  // swallow it so a late AbortError can't surface as an unhandled rejection.
  callPromise.catch(() => {});

  const res = await Promise.race([callPromise, timeoutPromise]);
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      typeof json.error === "string" ? json.error : `orchestrator returned ${res.status}`;
    throw new OrchPmError(message, res.status);
  }
  return json as T;
}
