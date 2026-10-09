/**
 * WARP-1685 — `team_chat_send_meeting_invite` LLM tool (Tier 2, write +
 * handler-enforced confirmation).
 *
 * Schedules a meeting inside a Messages thread on the acting human's
 * behalf: resolves the recipients, creates (or dedupes into) the thread,
 * then POSTs the meeting — which the orchestrator commits together with
 * its meeting_invite card and mirrors onto the organizer's local
 * calendar. Recipients RSVP from the card in Messages.
 *
 * Same two-phase contract as team_chat_send_message (share_file posture):
 * the unconfirmed phase validates fully — including the future-startsAt
 * check — and resolves the recipients (reads only, ZERO writes); only
 * `confirmed: true` dispatches, as X-Droplet-User = ctx.userId. In chat the
 * dispatch interceptor challenges before this handler runs, so the person
 * approves the interceptor's card (argument shapes only, WARP-2469), never
 * this handler's text; the unconfirmed phase runs as `precheck`
 * (WARP-3403) so a meeting the orchestrator would refuse, or a recipient
 * who is nobody in the Workspace, is refused before that card.
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

const MAX_RECIPIENTS = 24;
const MAX_TITLE_CHARS = 200;
const MAX_LOCATION_CHARS = 200;
const MAX_NOTE_CHARS = 2000;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 1440;

const inputSchema = {
  type: "object",
  properties: {
    recipients: {
      type: "array",
      items: { type: "string" },
      description:
        "Usernames or email addresses of people in this Workspace (members or external guests) to invite. One recipient reuses the 1:1 thread; several create a group. The organizer is included automatically.",
    },
    title: {
      type: "string",
      description: "Meeting title (1-200 characters).",
    },
    starts_at: {
      type: "string",
      description: "ISO-8601 start time. Must be in the future.",
    },
    duration_minutes: {
      type: "integer",
      minimum: MIN_DURATION_MINUTES,
      maximum: MAX_DURATION_MINUTES,
      description: "Optional length in minutes (1-1440).",
    },
    location: {
      type: "string",
      description: "Optional location (1-200 characters).",
    },
    note: {
      type: "string",
      description: "Optional note for the invite (1-2000 characters).",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved this exact meeting invite in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with the details to relay to the user for approval.",
    },
  },
  required: ["recipients", "title", "starts_at"],
  additionalProperties: false,
} as const;

/** WARP-3403 — the address lookup `resolveTargets` calls (in this file for the WARP-1455 drift gate). */
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
  if (!ctx.userId) {
    return err("AUTH_REQUIRED", "auth_required");
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (title.length === 0 || title.length > MAX_TITLE_CHARS) {
    return err("INVALID_ARGS", `title must be 1-${MAX_TITLE_CHARS} characters`);
  }

  const startsAtRaw = typeof args.starts_at === "string" ? args.starts_at.trim() : "";
  const startsAt = new Date(startsAtRaw);
  if (startsAtRaw.length === 0 || Number.isNaN(startsAt.getTime())) {
    return err("INVALID_ARGS", "starts_at must be an ISO-8601 timestamp");
  }
  if (startsAt.getTime() <= Date.now()) {
    return err("INVALID_ARGS", "starts_at must be in the future");
  }

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
  // The organizer is dropped against the roster's `me` (WARP-3196), never
  // by comparing a username with ctx.userId: over HTTP that is a User.id.
  let recipients = [...new Set(args.recipients.map((r) => r.trim()))];

  let durationMinutes: number | undefined;
  if (args.duration_minutes !== undefined) {
    if (
      typeof args.duration_minutes !== "number" ||
      !Number.isInteger(args.duration_minutes) ||
      args.duration_minutes < MIN_DURATION_MINUTES ||
      args.duration_minutes > MAX_DURATION_MINUTES
    ) {
      return err(
        "INVALID_ARGS",
        `duration_minutes must be an integer between ${MIN_DURATION_MINUTES} and ${MAX_DURATION_MINUTES}`,
      );
    }
    durationMinutes = args.duration_minutes;
  }

  let location: string | undefined;
  if (args.location !== undefined) {
    if (
      typeof args.location !== "string" ||
      args.location.trim().length === 0 ||
      args.location.trim().length > MAX_LOCATION_CHARS
    ) {
      return err("INVALID_ARGS", `location must be 1-${MAX_LOCATION_CHARS} characters`);
    }
    location = args.location.trim();
  }

  let note: string | undefined;
  if (args.note !== undefined) {
    if (
      typeof args.note !== "string" ||
      args.note.trim().length === 0 ||
      args.note.trim().length > MAX_NOTE_CHARS
    ) {
      return err("INVALID_ARGS", `note must be 1-${MAX_NOTE_CHARS} characters`);
    }
    note = args.note.trim();
  }

  // Unconfirmed phase — AFTER validation, BEFORE any WRITE (share_file).
  // The recipients are resolved exactly as the confirmed phase does, so a
  // recipient it would refuse (unknown, nobody in the Workspace, only the
  // organizer) is refused here. WARP-3403: `precheck` below runs this
  // before the interceptor asks, so those refusals come before the approval
  // card. The confirmation_required text is only what a direct caller
  // gets; nobody approves it. Messages switched off (the roster's 404) is
  // refused too; any other roster hiccup falls back to the typed
  // recipients, and the confirmed phase validates them again.
  if (args.confirmed !== true) {
    let names = recipients;
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
      // Unreachable roster — the confirmed phase reads it again and fails loudly.
    }
    // Explicit zone (review): the readable form renders in the CONTAINER's
    // timezone — naming it ("6:00 PM UTC") keeps the approval honest when
    // that differs from the user's wall clock. Component options, not
    // dateStyle/timeStyle: ECMA-402 refuses to combine the style shortcuts
    // with timeZoneName.
    const whenReadable = startsAt.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    const extras = [
      durationMinutes !== undefined ? `${durationMinutes} min` : null,
      location !== undefined ? `at ${truncateForPreview(location, 60)}` : null,
    ]
      .filter((x): x is string => x !== null)
      .join(", ");
    // The note is model-composed and rides on the invite card — the user
    // must SEE it before approving (review; parity with send-message's
    // body preview).
    const notePreview = note !== undefined ? truncateForPreview(note) : undefined;
    return confirmationRequired(
      `I'd like to invite ${names.join(", ")} to "${title}" starting ${whenReadable}${extras.length > 0 ? ` (${extras})` : ""}. ` +
        (notePreview !== undefined ? `Note on the invite: "${notePreview}". ` : "") +
        "A meeting invite card will be posted in Messages and the meeting will land on the organizer's calendar. " +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      {
        type: "team_chat_send_meeting_invite",
        recipients,
        title,
        startsAt: startsAt.toISOString(),
        ...(durationMinutes !== undefined ? { durationMinutes } : {}),
        ...(location !== undefined ? { location } : {}),
        ...(notePreview !== undefined ? { notePreview } : {}),
      },
    );
  }

  // Phase 2 — roster → thread → meeting, all as the acting human. (HTTP
  // dispatches live HERE, not in _roster.ts: the WARP-1455 drift gate
  // reads this file.)
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

  const res = await ctx.http.orchestrator.post(
    `/api/team-chat/threads/${encodeURIComponent(thread.threadId)}/meetings`,
    {
      title,
      startsAt: startsAtRaw,
      ...(durationMinutes !== undefined ? { durationMinutes } : {}),
      ...(location !== undefined ? { location } : {}),
      ...(note !== undefined ? { note } : {}),
    },
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
    return err("INVALID_ARGS", detail?.error ?? "invalid meeting");
  }
  if (!res.ok) {
    return err("TEAM_CHAT_SEND_FAILED", `orchestrator returned ${res.status}`);
  }
  // Guarded success parse (review): a malformed 2xx body returns the
  // typed failure instead of throwing out of the handler.
  const data = (await res.json().catch(() => null)) as {
    meeting?: { id?: string; threadId?: string; title?: string; startsAt?: string };
  } | null;
  if (!data?.meeting?.id) {
    return err("TEAM_CHAT_SEND_FAILED", "orchestrator returned a malformed response");
  }
  return {
    ok: true,
    data: {
      type: "team_chat_send_meeting_invite",
      meetingId: data.meeting.id,
      threadId: data.meeting.threadId ?? thread.threadId,
      title: data.meeting.title ?? title,
      startsAt: data.meeting.startsAt ?? startsAt.toISOString(),
      recipients,
      summary: "Meeting invite posted in Messages; recipients can RSVP from the card.",
    },
  };
}

const tool: Tool = {
  name: "team_chat_send_meeting_invite",
  description:
    "Invite usernames or email addresses of people in this Workspace to a Messages meeting (direct/group thread, RSVP, organizer calendar and reminder). Relay confirmation_required details; only after explicit approval repeat SAME call with confirmed: true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  // WARP-3403 — the unconfirmed phase above, run before the interceptor asks.
  precheck: unconfirmedPhaseAsPrecheck(handler),
  handler,
};

export default tool;
