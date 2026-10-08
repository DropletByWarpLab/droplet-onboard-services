/**
 * WARP-3904 — shared by the three connect-from-chat tools
 * (`list_connections`, `start_connection`, `disconnect_connection`).
 *
 * Pure helpers only: no HTTP lives here, so each handler keeps its own
 * `ctx.http.orchestrator.*` call in its own file, which is where the
 * `tool-routes.test.ts` drift gate reads it from.
 *
 * Two rules the whole family keeps:
 *   - NO SECRET crosses a tool. A tool sends and returns descriptors; the
 *     person types a key into the card the dashboard renders, and the browser
 *     posts it straight to the box (shared-types `chat-connect.ts`).
 *   - The orchestrator's error body is never echoed into a result. A failure
 *     becomes a short code and one human line; the status number is the only
 *     detail that travels.
 */
import type { PrecheckRefusal, Role, ToolContext, ToolResult } from "../../types.js";

/** The same human set as `email_accounts`: owner, admin and member (family). */
const CONNECT_ROLES: ReadonlySet<string> = new Set<Role>(["owner", "admin", "family"]);

export const ROLE_MESSAGE = "connections are available to owner, admin, and member roles only";

/** The route's own 403: a member can act on personal rows, not box-wide ones. */
export const ROUTE_FORBIDDEN_MESSAGE =
  "Droplet refused that for this person's role. Box-wide connections can only be added or removed by an owner or admin.";

export function fail(code: string, message: string, details?: unknown): PrecheckRefusal {
  return {
    ok: false,
    status: "error",
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

/**
 * Role first, then identity, both with zero HTTP. The orchestrator route
 * resolves the acting person's canonical role again; this is the early,
 * cheap refusal, not the authority.
 */
export function gate(ctx: ToolContext): PrecheckRefusal | null {
  if (!CONNECT_ROLES.has(ctx.role ?? "")) return fail("FORBIDDEN", ROLE_MESSAGE);
  if (!ctx.userId) return fail("AUTH_REQUIRED", "auth_required");
  return null;
}

/**
 * The trusted MCP principal forwards a human identity; the route resolves
 * their role and ownership server-side before returning or changing anything.
 */
export function actingHeaders(ctx: ToolContext): Record<string, string> {
  return { Accept: "application/json", "X-Droplet-User": ctx.userId ?? "" };
}

/** Parsed JSON body, or `null` when the body is not JSON. Never throws. */
export async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * A non-2xx answer with no special meaning for the tool. 401 and 403 keep
 * their own codes so the model can tell "sign in" from "not your role";
 * everything else is `code` plus the status number, never the body.
 */
export function httpFailure(status: number, code: string, line: string, advice?: string): ToolResult {
  if (status === 401) return fail("AUTH_REQUIRED", "auth_required");
  if (status === 403) return fail("FORBIDDEN", ROUTE_FORBIDDEN_MESSAGE);
  return fail(code, `${line} (orchestrator returned ${status}).${advice ? ` ${advice}` : ""}`);
}
