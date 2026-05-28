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
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

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
    { headers: { Accept: "application/json" } },
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
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
