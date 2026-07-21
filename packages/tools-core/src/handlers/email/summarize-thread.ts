/**
 * WARP-466 (D2) — `email_summarize_thread` LLM tool.
 *
 * Returns the orchestrator's section 2.4 analysis card for a thread —
 * summary + callouts + suggested actions + related references. The
 * orchestrator route internally drives the agent loop; this tool is a
 * thin wrapper so chat (or another spec step) can fetch it without
 * duplicating retrieval.
 *
 * WARP-1453 — role-gated (owner/admin/family, the route's human set)
 * and identity-forwarding: X-Droplet-User = ctx.userId so the
 * orchestrator scopes accounts by the acting human, not `_service:mcp`.
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
    accountId: { type: "string" },
    threadId: { type: "string" },
  },
  required: ["accountId", "threadId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // WARP-1453 — role gate FIRST; absent role → guest view → FORBIDDEN
  // with zero HTTP.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < FAMILY_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "email analysis is available to owner, admin, and family roles only",
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
  const threadId = typeof args.threadId === "string" ? args.threadId : "";
  if (!accountId || !threadId) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "INVALID_ARGS",
        message: "accountId and threadId are required",
      },
    };
  }
  const res = await ctx.http.orchestrator.get(
    `/api/email/${encodeURIComponent(accountId)}/threads/${encodeURIComponent(threadId)}/analysis`,
    // WARP-1453: forwarded acting-human identity (see header comment).
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "Thread not found" },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SUMMARIZE_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as Record<string, unknown>;
  return {
    ok: true,
    data: { type: "email_analysis", ...data },
  };
}

const tool: Tool = {
  name: "email_summarize_thread",
  description:
    "Produce a structured analysis of an email thread for the §2.4 AI side panel: short summary, callouts (named entities, dates, asks), suggested actions (with safety tier), and related references (files / other threads / cameras / tools). Backed by the orchestrator's internal agent-loop analysis endpoint — no retrieval duplicated here.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
