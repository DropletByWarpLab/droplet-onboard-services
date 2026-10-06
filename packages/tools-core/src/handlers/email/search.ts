/**
 * WARP-466 (D2) — `email_search` LLM tool.
 *
 * Search persisted EmailThread / EmailMessage rows via the
 * orchestrator's `/api/email/:accountId/threads` filter surface.
 * Read tier — safe to call without confirmation.
 *
 * WARP-1453 — the orchestrator route admits the mcp service principal
 * and scopes accounts by the forwarded `X-Droplet-User` (ctx.userId).
 * The handler gates on the forwarded human role (owner/admin/family,
 * mirroring the route's human set) BEFORE any HTTP leaves, and refuses
 * with AUTH_REQUIRED when no user identity is available to forward.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** WARP-845 — audience ladder (same table as handlers/memory/recall.ts). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const FAMILY_RANK = 1;

const inputSchema = {
  type: "object",
  properties: {
    accountId: {
      type: "string",
      description: "Mailbox ID from email_accounts.",
    },
    query: {
      type: "string",
      maxLength: 200,
      description: "Local text search; omit to list threads.",
    },
    filter: {
      type: "string",
      enum: ["inbox", "triaged", "archived", "droplet"],
      description:
        "Triage tab; droplet selects threads with Droplet drafts in any tab.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 100,
      description: "Max threads to return (default 20).",
    },
  },
  required: ["accountId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // WARP-1453 — role gate FIRST (route human set: owner/admin/family);
  // absent role → guest view → FORBIDDEN with zero HTTP.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < FAMILY_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "email search is available to owner, admin, and member roles only",
      },
    };
  }
  // WARP-1453 — no user identity to forward → fail closed, zero HTTP.
  if (!ctx.userId) {
    return {
      ok: false,
      status: "error",
      error: { code: "AUTH_REQUIRED", message: "auth_required" },
    };
  }
  const accountId = typeof args.accountId === "string" ? args.accountId : "";
  if (!accountId) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "accountId is required" },
    };
  }
  if (args.query !== undefined && (typeof args.query !== "string" || args.query.length > 200)) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "query must be a string of at most 200 characters" },
    };
  }
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const filter =
    typeof args.filter === "string" ? args.filter : "inbox";
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(100, Math.floor(args.limit)))
      : 20;
  const params = new URLSearchParams({ filter, limit: String(limit) });
  if (query) params.set("query", query);
  const res = await ctx.http.orchestrator.get(
    `/api/email/${encodeURIComponent(accountId)}/threads?${params.toString()}`,
    // WARP-1453: X-Droplet-User carries the acting human's username —
    // the orchestrator honors it ONLY for the trusted mcp principal.
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SEARCH_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as {
    filter: string;
    threads: Array<{
      id: string;
      subject: string;
      lastSender: string | null;
      snippet: string | null;
      lastMessageAt: string;
      triageStatus: string;
      draftedByDroplet: boolean;
    }>;
  };
  return {
    ok: true,
    data: {
      type: "email_search",
      filter: data.filter,
      ...(query ? { query } : {}),
      threadCount: data.threads.length,
      threads: data.threads,
    },
  };
}

const tool: Tool = {
  name: "email_search",
  description:
    "Search local subjects, senders, snippets and bodies; omit query to list. Get accountId from email_accounts. Default inbox; returns thread summaries. email_read opens one.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
