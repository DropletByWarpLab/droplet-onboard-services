/**
 * WARP-1685 — `team_chat_send_message` LLM tool (Tier 2, write +
 * handler-enforced confirmation).
 *
 * Sends a member-to-member Messages text on the acting human's behalf —
 * either to named recipients (the 1:1 thread is deduped by the
 * orchestrator; a multi-recipient send creates a group) or into an
 * existing thread by id.
 *
 * Two-phase contract (the share_file posture): an unconfirmed call validates
 * and resolves the recipients (reads only, ZERO writes) and returns
 * `confirmation_required`; only a call with `confirmed: true` dispatches. In
 * chat the dispatch interceptor challenges before this handler runs, so the
 * person approves the interceptor's card (argument shapes only, WARP-2469),
 * never this handler's text; the unconfirmed phase runs as `precheck`
 * (WARP-3349) to refuse a send that cannot happen before that card. Identity: every orchestrator call carries X-Droplet-User =
 * ctx.userId (username on stdio, User.id over HTTP), so the message is
 * attributed to the acting human and flows through the exact
 * participant/module checks a
 * direct dashboard call gets (handlers/email/send.ts posture).
 */
import { confirmationRequired } from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import {
  actingHeaders,
  err,
  readRosterResponse,
  readThreadResponse,
  resolveTargets,
  truncateForPreview,
  unconfirmedPhaseAsPrecheck,
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
        "Usernames or email addresses of people in this Workspace (members or external guests). One recipient = a direct message (existing 1:1 threads are reused); several = a new group. Provide exactly one of recipients / thread_id.",
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

/** WARP-3349 — the address lookup `resolveTargets` calls (in this file for the WARP-1455 drift gate). */
function lookupAddresses(ctx: ToolContext) {
  return (emails: string[]) =>
    ctx.http.orchestrator.post(
      "/api/team-chat/contacts/lookup",
      { emails },
      { headers: actingHeaders(ctx) },
    );
}

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
        `recipients must be 1-${MAX_RECIPIENTS} usernames or email addresses of people in this Workspace`,
      );
    }
    // The sender is dropped against the roster's `me` (WARP-3196), never
    // by comparing a username with ctx.userId: over HTTP that is a User.id.
    recipients = [...new Set(args.recipients.map((r) => r.trim()))];
  }

  const threadIdArg =
    typeof args.thread_id === "string" && args.thread_id.trim().length > 0
      ? args.thread_id.trim()
      : null;
  if (hasThreadId && !threadIdArg) {
    return err("INVALID_ARGS", "thread_id must be a non-empty conversation id");
  }

  // Unconfirmed phase — AFTER validation (a malformed call should fail
  // loudly, not ask the user to approve it) and BEFORE any WRITE. The
  // recipients are resolved exactly as phase 2 does, so a recipient phase 2
  // would refuse (unknown, not a member, only the sender) is refused here.
  // WARP-3349: `precheck` below runs this before the interceptor asks, so
  // those refusals come before the approval card. The confirmation_required
  // text is only what a direct caller gets; nobody approves it. Messages
  // switched off (the roster's 404) is refused too; any other roster hiccup
  // falls back to the typed recipients, and phase 2 validates them again.
  if (args.confirmed !== true) {
    let names = recipients;
    if (hasRecipients) {
      try {
        const rosterRes = await ctx.http.orchestrator.get(
          "/api/team-chat/contacts",
          { headers: actingHeaders(ctx) },
        );
        const roster = await readRosterResponse(rosterRes);
        if (!roster.ok && rosterRes.status === 404) return roster.result;
        if (roster.ok) {
          const resolved = await resolveTargets(roster, recipients, lookupAddresses(ctx));
          if (!resolved.ok) return resolved.result;
          recipients = resolved.others.flatMap((c) => (c.username ? [c.username] : []));
          names = resolved.others.map((c) => c.displayName || c.username || c.id);
        }
      } catch {
        // Unreachable roster — phase 2 reads it again and fails loudly.
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
    const resolved = await resolveTargets(roster, recipients, lookupAddresses(ctx));
    if (!resolved.ok) return resolved.result;
    // resolveRecipients only matches rows that carry a username.
    recipients = resolved.others.flatMap((c) => (c.username ? [c.username] : []));
    const threadRes = await ctx.http.orchestrator.post(
      "/api/team-chat/threads",
      {
        kind: resolved.others.length === 1 ? "direct" : "group",
        participantIds: resolved.others.map((c) => c.id),
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
  // Guarded success parse (review): a malformed 2xx body returns the
  // typed failure instead of throwing out of the handler.
  const data = (await res.json().catch(() => null)) as {
    message?: { id?: string; threadId?: string };
  } | null;
  if (!data?.message?.id) {
    return err("TEAM_CHAT_SEND_FAILED", "orchestrator returned a malformed response");
  }
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
    "Default for messaging people; use email only when the user asks for email. Send to usernames or email addresses of people in this Workspace; never guess one from a job title; ask if ambiguous. One=direct, several=group; thread_id continues thread. Relay confirmation_required recipients/text; only after explicit approval repeat SAME call with confirmed: true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-3349 — the unconfirmed phase above, run before the interceptor asks.
  precheck: unconfirmedPhaseAsPrecheck(handler),
  handler,
};

export default tool;
