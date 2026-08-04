/**
 * WARP-1685 — `team_chat_send_message` LLM tool (Tier 2, write +
 * handler-enforced confirmation).
 *
 * Sends a member-to-member Messages text on the acting human's behalf —
 * either to named recipients (the 1:1 thread is deduped by the
 * orchestrator; a multi-recipient send creates a group) or into an
 * existing thread by id.
 *
 * Two-phase contract (the share_file posture): the first call returns
 * `confirmation_required` (ZERO HTTP) previewing who gets what; only a
 * re-issue with `confirmed: true` — after the user explicitly approves —
 * dispatches. Identity: every orchestrator call carries X-Droplet-User =
 * ctx.userId (WARP-202 username), so the message is attributed to the
 * acting human and flows through the exact participant/module checks a
 * direct dashboard call gets (handlers/email/send.ts posture).
 */
import { confirmationRequired } from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  actingHeaders,
  err,
  pickParticipantIds,
  readRosterResponse,
  readThreadResponse,
  truncateForPreview,
} from "./_roster.js";

const MAX_BODY_CHARS = 4000;
const MAX_RECIPIENTS = 24;

const inputSchema = {
  type: "object",
  properties: {
    recipients: {
      type: "array",
      items: { type: "string" },
      description:
        "Member USERNAMES to message. One recipient = a direct message (existing 1:1 threads are reused); several = a new group. Provide exactly one of recipients / thread_id.",
    },
    thread_id: {
      type: "string",
      description:
        "Existing conversation id to post into (from a previous send). Provide exactly one of recipients / thread_id.",
    },
    body: {
      type: "string",
      description: "The message text (1-4000 characters).",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved sending this exact message in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with a preview to relay to the user for approval.",
    },
  },
  required: ["body"],
  additionalProperties: false,
} as const;

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  // No acting identity to forward → fail closed, zero HTTP (email_send).
  if (!ctx.userId) {
    return err("AUTH_REQUIRED", "auth_required");
  }

  const body = typeof args.body === "string" ? args.body.trim() : "";
  if (body.length === 0 || body.length > MAX_BODY_CHARS) {
    return err(
      "INVALID_ARGS",
      `body must be 1-${MAX_BODY_CHARS} characters of message text`,
    );
  }

  const hasRecipients = args.recipients !== undefined;
  const hasThreadId = args.thread_id !== undefined;
  if (hasRecipients === hasThreadId) {
    return err(
      "INVALID_ARGS",
      "provide exactly one of recipients (usernames) or thread_id",
    );
  }

  let recipients: string[] = [];
  if (hasRecipients) {
    if (
      !Array.isArray(args.recipients) ||
      args.recipients.length === 0 ||
      args.recipients.length > MAX_RECIPIENTS ||
      !args.recipients.every(
        (r): r is string => typeof r === "string" && r.trim().length > 0,
      )
    ) {
      return err(
        "INVALID_ARGS",
        `recipients must be 1-${MAX_RECIPIENTS} member usernames`,
      );
    }
    recipients = [...new Set(args.recipients.map((r) => r.trim()))].filter(
      (r) => r !== ctx.userId,
    );
    if (recipients.length === 0) {
      return err(
        "INVALID_ARGS",
        "recipients must include someone other than yourself",
      );
    }
  }

  const threadIdArg =
    typeof args.thread_id === "string" && args.thread_id.trim().length > 0
      ? args.thread_id.trim()
      : null;
  if (hasThreadId && !threadIdArg) {
    return err("INVALID_ARGS", "thread_id must be a non-empty conversation id");
  }

  // Confirmation gate — AFTER validation (a malformed call should fail
  // loudly, not ask the user to approve it) and BEFORE any WRITE. The
  // roster is read best-effort so the approval copy shows DISPLAY NAMES
  // ("Bob B", not "bob" — UX review); any roster hiccup falls back to
  // the typed usernames, and phase 2 still validates them loudly.
  if (args.confirmed !== true) {
    let names = recipients;
    if (hasRecipients) {
      try {
        const rosterRes = await ctx.http.orchestrator.get(
          "/api/team-chat/contacts",
          { headers: actingHeaders(ctx) },
        );
        const roster = await readRosterResponse(rosterRes);
        if (roster.ok) {
          const byUsername = new Map(
            roster.contacts.map((c) => [c.username, c] as const),
          );
          names = recipients.map((u) => {
            const display = byUsername.get(u)?.displayName;
            return display && display.length > 0 ? display : u;
          });
        }
      } catch {
        // Preview-only read — usernames are an honest fallback.
      }
    }
    const target = hasRecipients ? names.join(", ") : "the existing conversation";
    const preview = truncateForPreview(body);
    return confirmationRequired(
      `I'd like to send a Messages chat to ${target}: "${preview}". ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      {
        type: "team_chat_send_message",
        ...(hasRecipients ? { recipients } : { threadId: threadIdArg }),
        preview,
      },
    );
  }

  // Phase 2 — resolve the destination thread. (HTTP dispatches live HERE,
  // not in _roster.ts: the WARP-1455 drift gate reads this file.)
  let threadId = threadIdArg;
  if (threadId === null) {
    const rosterRes = await ctx.http.orchestrator.get("/api/team-chat/contacts", {
      headers: actingHeaders(ctx),
    });
    const roster = await readRosterResponse(rosterRes);
    if (!roster.ok) return roster.result;
    const picked = pickParticipantIds(roster.contacts, recipients);
    if (!picked.ok) return picked.result;
    const threadRes = await ctx.http.orchestrator.post(
      "/api/team-chat/threads",
      {
        kind: picked.participantIds.length === 1 ? "direct" : "group",
        participantIds: picked.participantIds,
      },
      { headers: actingHeaders(ctx) },
    );
    const thread = await readThreadResponse(threadRes);
    if (!thread.ok) return thread.result;
    threadId = thread.threadId;
  }

  const res = await ctx.http.orchestrator.post(
    `/api/team-chat/threads/${encodeURIComponent(threadId)}/messages`,
    { kind: "text", body },
    { headers: actingHeaders(ctx) },
  );
  if (res.status === 404) {
    return err(
      "NOT_FOUND",
      "Conversation not found — you may not be a member of it, or Messages is turned off.",
    );
  }
  if (res.status === 401) {
    return err("AUTH_REQUIRED", "auth_required");
  }
  if (res.status === 400) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    return err("INVALID_ARGS", detail?.error ?? "invalid message");
  }
  if (!res.ok) {
    return err("TEAM_CHAT_SEND_FAILED", `orchestrator returned ${res.status}`);
  }
  const data = (await res.json()) as { message: { id: string; threadId: string } };
  return {
    ok: true,
    data: {
      type: "team_chat_send_message",
      threadId: data.message.threadId ?? threadId,
      messageId: data.message.id,
      ...(hasRecipients ? { recipients } : {}),
      summary: "Message sent.",
    },
  };
}

const tool: Tool = {
  name: "team_chat_send_message",
  description:
    "Send a Messages (team chat) text to other members on the user's behalf. recipients = member USERNAMES (one = direct message, several = a new group), or pass thread_id to continue an existing conversation. Two-step: the first call returns confirmation_required previewing the recipients and text — relay it to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
