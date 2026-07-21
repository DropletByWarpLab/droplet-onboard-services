/**
 * WARP-466 (D2) — `email_draft_reply` LLM tool.
 *
 * Create a Droplet-drafted reply in the EmailDraft table. The reply
 * stays as `status=draft` until the operator pushes send (which is the
 * separate `email_send` tool, write tier + confirm). This tool sets
 * `draftedByDroplet=true` so the §2.4 "Droplet drafts" tab badges
 * the thread.
 *
 * Read tier from the LLM's perspective — it ONLY writes a row to the
 * EmailDraft table, never sends mail. The dashboard can show / edit /
 * confirm; only `email_send` actually dispatches SMTP.
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
    threadId: {
      type: "string",
      description: "EmailThread.id this reply belongs to.",
    },
    toAddrs: {
      type: "array",
      items: { type: "string" },
      minItems: 1,
      description:
        "Recipient addresses. Usually the original sender + any other thread participants.",
    },
    ccAddrs: {
      type: "array",
      items: { type: "string" },
      description: "Optional CC addresses.",
    },
    subject: {
      type: "string",
      description: "Reply subject (typically `Re: <original>`).",
    },
    body: {
      type: "string",
      description: "Plain-text body of the reply.",
    },
  },
  required: ["accountId", "toAddrs", "subject", "body"],
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
        message: "email drafting is available to owner, admin, and family roles only",
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
  const payload = {
    threadId: typeof args.threadId === "string" ? args.threadId : null,
    toAddrs: Array.isArray(args.toAddrs) ? args.toAddrs : [],
    ccAddrs: Array.isArray(args.ccAddrs) ? args.ccAddrs : undefined,
    subject: typeof args.subject === "string" ? args.subject : "",
    body: typeof args.body === "string" ? args.body : "",
    draftedByDroplet: true,
  };
  const res = await ctx.http.orchestrator.post(
    `/api/email/${encodeURIComponent(accountId)}/drafts`,
    payload,
    // WARP-1453: forwarded acting-human identity (see header comment).
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (!res.ok) {
    let detail: string | null = null;
    try {
      const body = (await res.json()) as { error?: string };
      detail = body?.error ?? null;
    } catch {
      // ignore
    }
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_DRAFT_FAILED",
        message: detail ?? `orchestrator returned ${res.status}`,
      },
    };
  }
  const draft = (await res.json()) as { id: string; status: string };
  return {
    ok: true,
    data: {
      type: "email_draft",
      draftId: draft.id,
      status: draft.status,
      summary: "Reply drafted. The operator can review and send it.",
    },
  };
}

const tool: Tool = {
  name: "email_draft_reply",
  description:
    "Draft a reply to an email thread. Writes to EmailDraft with draftedByDroplet=true so the operator sees it in the Droplet drafts tab. Does NOT send — `email_send` (write + confirm) is required to dispatch.",
  inputSchema,
  // Persists an EmailDraft row → WRITE. Without requiresWrite:true the
  // orchestrator's WRITE_TOOLS set in routes/llm.ts excludes this tool
  // and any family-role session can persist drafts without write-tier
  // RBAC clearance. requiresConfirmation stays false because the *send*
  // is the destructive surface — drafting is reversible (operator can
  // delete the draft before send).
  requiresWrite: true,
  requiresConfirmation: false,
  handler,
};

export default tool;
