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
 * phase 1 validates fully — including the future-startsAt check, so the
 * user never approves a meeting the orchestrator would refuse — and
 * returns `confirmation_required` with ZERO HTTP; only `confirmed: true`
 * after an explicit yes dispatches, as X-Droplet-User = ctx.userId.
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
        "Member USERNAMES to invite. One recipient reuses the 1:1 thread; several create a group. The organizer is included automatically.",
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
      `recipients must be 1-${MAX_RECIPIENTS} member usernames`,
    );
  }
  const recipients = [...new Set(args.recipients.map((r) => r.trim()))].filter(
    (r) => r !== ctx.userId,
  );
  if (recipients.length === 0) {
    return err("INVALID_ARGS", "recipients must include someone other than yourself");
  }

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

  // Confirmation gate — AFTER validation, BEFORE any WRITE (share_file).
  // The roster is read best-effort so the approval copy shows DISPLAY
  // NAMES; the timestamp renders in the readable local form (UX review —
  // raw ISO-UTC is machine copy). The ISO original stays in `details`.
  if (args.confirmed !== true) {
    let names = recipients;
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
    "Invite members to a meeting through Messages (team chat) on the user's behalf. recipients = member USERNAMES; the meeting card is posted in the (deduped 1:1 or new group) thread, recipients RSVP from it, and the meeting lands on the organizer's local calendar with a reminder before start. Two-step: the first call returns confirmation_required with the meeting details — relay them to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
