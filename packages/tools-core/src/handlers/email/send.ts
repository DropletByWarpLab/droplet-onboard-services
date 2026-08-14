/**
 * WARP-466 (D2) — `email_send` LLM tool.
 *
 * Write tier + requires confirmation. Dispatches an existing EmailDraft
 * via `POST /api/email/drafts/:id/send`. The orchestrator route enforces
 * the off-LAN `outbound_email` gate and flips the draft to status=queued;
 * the email-indexer's outbound poller drives the SMTP transaction.
 *
 * The tool itself doesn't read the operator's mailbox before sending —
 * the draft is the source of truth. Operators (or the chat surface) can
 * edit the draft via the dashboard before sending.
 *
 * WARP-1453 — role-gated to owner/admin (the send route's human set —
 * family may draft but never send) and identity-forwarding:
 * X-Droplet-User = ctx.userId so the orchestrator scopes the draft's
 * account by the acting human, not `_service:mcp`.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const TOOL_NAME = "email_send";

/** WARP-845 — audience ladder (same table as handlers/memory/recall.ts). */
const ROLE_RANK: Record<string, number> = {
  owner: 3,
  admin: 2,
  family: 1,
  service: 1,
  guest: 0,
};
const ADMIN_RANK = 2;

/**
 * Draft address columns are `unknown` on the wire (Prisma Json). Accept the
 * array form and the single-string form, drop anything else, and never throw —
 * a malformed column must degrade to "no recipients named", which the prompt
 * states plainly, rather than blocking the confirmation entirely.
 */
function addressList(value: unknown): string[] {
  if (typeof value === "string") return value.trim() === "" ? [] : [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter((v) => v !== "");
}

const inputSchema = {
  type: "object",
  properties: {
    draftId: {
      type: "string",
      description: "EmailDraft.id to send. Must currently have status=draft.",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required naming the recipients and subject, and the user approves from that prompt.",
    },
  },
  required: ["draftId"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // WARP-1453 — role gate FIRST (send route's human set: owner/admin;
  // family/service/guest/absent all refused) with zero HTTP.
  if ((ROLE_RANK[ctx.role ?? ""] ?? 0) < ADMIN_RANK) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "FORBIDDEN",
        message: "sending email requires the owner or admin role",
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
  const draftId = typeof args.draftId === "string" ? args.draftId : "";
  if (!draftId) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "draftId is required" },
    };
  }
  // WARP-2008 — confirmation gate. `requiresConfirmation: true` was declared
  // and the description promised a dashboard confirmation, but nothing
  // enforced it at either layer: one model-emitted tool call sent real
  // outbound mail. The route's 202 is not a gate — it is emitted AFTER the
  // draft has already been flipped to queued and the Activity row written.
  //
  // The draft is read first so the prompt can name the actual recipients. A
  // prompt that says "send draft cl9x…" is not a confirmation.
  const draftRes = await ctx.http.orchestrator.get(
    `/api/email/drafts/${encodeURIComponent(draftId)}`,
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (draftRes.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "Draft not found" },
    };
  }
  if (!draftRes.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SEND_FAILED",
        message: `could not read the draft to confirm it — orchestrator returned ${draftRes.status}`,
      },
    };
  }
  const draft = (await draftRes.json().catch(() => ({}))) as {
    subject?: string;
    status?: string;
    toAddrs?: unknown;
    ccAddrs?: unknown;
    bccAddrs?: unknown;
  };
  if (draft.status !== undefined && draft.status !== "draft") {
    return {
      ok: false,
      status: "error",
      error: { code: "ALREADY_DISPATCHED", message: "Draft already dispatched" },
    };
  }

  const recipients = [
    ...addressList(draft.toAddrs),
    ...addressList(draft.ccAddrs),
    ...addressList(draft.bccAddrs),
  ];
  const subject = typeof draft.subject === "string" ? draft.subject : "(no subject)";

  // Bound to the recipient set and subject, not just the draft id: a draft can
  // be edited between approval and send, and an approval to mail one person
  // must not become an approval to mail someone else.
  const fingerprint = confirmationFingerprint([TOOL_NAME, draftId, recipients, subject]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    const who = recipients.length > 0 ? recipients.join(", ") : "(no recipients set)";
    return confirmationRequired(
      `I'd like to send the email "${subject}" to ${who}. ` +
        "This leaves the Droplet as real outbound mail and cannot be recalled. " +
        "Ask the user to approve. You cannot approve on their behalf.",
      { type: TOOL_NAME, draftId, subject, recipients },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  const res = await ctx.http.orchestrator.post(
    `/api/email/drafts/${encodeURIComponent(draftId)}/send`,
    {},
    // WARP-1453: forwarded acting-human identity (see header comment).
    { headers: { Accept: "application/json", "X-Droplet-User": ctx.userId } },
  );
  if (res.status === 451) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "OFF_LAN_BLOCKED",
        message:
          "Outbound email is disabled by the off-LAN allowlist. An admin can enable outbound_email in Settings → Off-LAN allowlist.",
      },
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "NOT_FOUND", message: "Draft not found" },
    };
  }
  if (res.status === 409) {
    return {
      ok: false,
      status: "error",
      error: { code: "ALREADY_DISPATCHED", message: "Draft already dispatched" },
    };
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "EMAIL_SEND_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as {
    id: string;
    status: string;
    message?: string;
  };
  return {
    ok: true,
    data: {
      type: "email_send",
      draftId: data.id,
      status: data.status,
      summary:
        data.message ??
        "Queued for SMTP send by the email-indexer service.",
    },
  };
}

const tool: Tool = {
  name: "email_send",
  description:
    "Send a drafted email. Write tier. Two-step: the first call returns confirmation_required naming the subject and every recipient — relay that to the user. Approval is handled outside this conversation; you cannot approve on their behalf. Refuses with off_lan_blocked when Settings → Off-LAN allowlist has `outbound_email` disabled.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
