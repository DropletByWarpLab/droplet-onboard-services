/**
 * WARP-1683 — Team chat v1: internal member-to-member messaging (DMs +
 * small groups) with two forward types — a Files document and an AI-chat
 * transcript. LAN-local only; Prisma-backed; no new services.
 *
 *   GET  /team-chat/contacts                      — roster for the picker
 *   GET  /team-chat/threads                       — caller's threads + unread
 *   POST /team-chat/threads                       — create (direct deduped)
 *   GET  /team-chat/threads/:id/messages          — cursor page, newest-first
 *   POST /team-chat/threads/:id/messages          — text | file_share | ai_chat_share
 *   POST /team-chat/threads/:id/read              — set caller's lastReadAt
 *   GET  /team-chat/messages/:messageId/transcript — the ai_chat_share snapshot
 *   GET  /team-chat/unread-count                  — cheap total for the badge
 *
 * WARP-1685 — meetings inside threads:
 *   POST /team-chat/threads/:id/meetings          — schedule + invite card
 *   GET  /team-chat/meetings/:id                  — meeting + named RSVPs
 *   POST /team-chat/meetings/:id/rsvp             — accept/decline (upsert)
 *   POST /team-chat/meetings/:id/cancel           — organizer-only
 *
 * Access model:
 *   - Humans only (owner/admin/family/guest) — no service principals,
 *     with ONE pinned exception (WARP-1685): the routes the two team-chat
 *     LLM tools dispatch through (contacts roster, thread create, message
 *     send, meeting create) ALSO admit the trusted `_service:mcp`
 *     principal via requireRoleOrMcpService, acting AS the X-Droplet-User
 *     username exactly like routes/email.ts effectiveUser(): the header is
 *     honored ONLY for that principal (a human session's header is
 *     IGNORED — no impersonation path), the forwarded identity must
 *     resolve to an ACTIVE human (fail closed → 401), and the resolved
 *     user then flows through the IDENTICAL participant/role checks below.
 *   - Everything thread-scoped is PARTICIPANT-ONLY, and a non-participant
 *     gets 404, never 403 (no existence leak — ADR-027 posture).
 *   - All ownership/filter columns hold the LOCAL `User.id` UUID
 *     (`req.user.id`), NEVER the username. ONE deliberate exception: the
 *     ai_chat_share ownership check compares `ChatSession.userId` against
 *     `req.user.username`, because that is what routes/llm.ts (WARP-304)
 *     actually persists there — matching its real semantics, for that
 *     check only.
 *   - file_share re-runs the Files metadata gate for the SENDER
 *     (resolveFileDepartment → checkSpaceAccess, exactly the
 *     routes/files.ts gateFileSpaceAccess composition): you can only
 *     forward a file you could open yourself. Unregistered files fall
 *     back to personal-space semantics (allowed — the message stores only
 *     the sender-supplied display name/path; recipients still pass
 *     /files' own access control when they follow the link).
 *     WARP-1898 — that same resolveFileDepartment result also decides
 *     `sharedFileSpace`, the space the stored `sharedFilePath` is RELATIVE
 *     TO. It has to be persisted: without it the recipient's link carried
 *     no `space`, and /files' deliberately-silent personal-space default
 *     then resolved the SENDER's path inside the RECIPIENT's namespace —
 *     landing them in their own files with no error. Forwarding still
 *     grants NOTHING; it remains a pointer, so a personal-space file stays
 *     unreachable to everyone but its owner. What changed is that the
 *     dashboard can now SAY so instead of failing silently.
 *   - ai_chat_share snapshots {title, messages:[{role, content,
 *     createdAt}]} at send time — an IMMUTABLE forward that survives the
 *     source conversation's later deletion (FK SetNull) and never leaks
 *     tool-call internals (tool rows and empty/stub contents are skipped).
 *
 * The `team_chat` module gate (404 when the module is off) is mounted by
 * `mountModuleGates` in app.ts off the registry's `/api/team-chat` prefix —
 * the registry is the one vocabulary; nothing to re-declare here.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { PrismaClient, Prisma } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { checkSpaceAccess, departmentSpaceToken } from "../middleware/space.js";
import { resolveFileDepartment } from "../services/file-registry.service.js";
import { createLogger } from "../lib/logger.js";
// WARP-1874 — the single https-only gate for a value that becomes an href.
import { meetingUrlSchema } from "../lib/meeting-url.js";

const logger = createLogger("team-chat");

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** The four human tiers — service principals never message. */
const HUMAN_ROLES = ["owner", "admin", "family", "guest"] as const;

/**
 * WARP-1685 — CalendarEvent.endsAt is required; a meeting created without
 * a duration mirrors onto the organizer's calendar as the calendar-world
 * standard one-hour block. Display surfaces still show "no duration".
 */
const DEFAULT_CALENDAR_EVENT_MINUTES = 60;

/** WARP-1685 — tx sentinel: the cancel claim found the meeting already
 *  cancelled (double-click / double-tab race) → 409, no message posted. */
class MeetingAlreadyCancelledError extends Error {
  constructor() {
    super("meeting_already_cancelled");
    this.name = "MeetingAlreadyCancelledError";
  }
}

interface Caller {
  /** LOCAL User.id UUID — the scoping key for every team-chat column. */
  id: string;
  /** Login handle — used ONLY for the ChatSession ownership comparison. */
  username: string;
  role: string;
}

function callerOf(req: Request): Caller | null {
  const u = (req as AuthedRequest).user;
  if (!u?.id || !u.username || !u.role) return null;
  return { id: u.id, username: u.username, role: u.role };
}

// ── zod schemas (validated BEFORE any prisma call) ──────────────────

const createThreadSchema = z.object({
  kind: z.enum(["direct", "group"]),
  participantIds: z.array(z.string().min(1)).min(1).max(24),
  title: z.string().trim().min(1).max(80).optional(),
});

const listMessagesQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const sendMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    body: z.string().trim().min(1).max(4000),
  }),
  z.object({
    kind: z.literal("file_share"),
    ncFileId: z.number().int().positive(),
    // Display cache, stamped onto the message at send time. The PICKER is
    // the source (it just listed these from /api/files); the access
    // DECISION below never trusts them — it keys off ncFileId alone.
    fileName: z.string().trim().min(1).max(255),
    filePath: z.string().trim().min(1).max(1024),
    // WARP-1898 — the space `filePath` is relative to, in the WIRE
    // vocabulary GET /api/files/spaces reports ("shared" is the household
    // alias; the space GATE's own vocabulary calls that "household" —
    // routes/files.ts translates at its boundary). A navigation hint for
    // the recipient's deep link, never an access decision, and only a
    // FALLBACK: the registry below wins whenever it has a row. Validated
    // anyway so a malformed value can reach neither the DB nor a rendered
    // URL. Optional — an older client simply doesn't send it.
    space: z
      .union([
        z.literal("personal"),
        z.literal("shared"),
        z
          .string()
          .regex(
            /^dept:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
      ])
      .optional(),
    caption: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal("ai_chat_share"),
    chatSessionId: z.string().uuid(),
    caption: z.string().trim().max(1000).optional(),
  }),
]);

// WARP-1685 — meeting create. `startsAt` stays a string here; the route
// parses + future-checks it explicitly so a garbage date and a past date
// each get their own clear 400 (zod-before-prisma either way).
const createMeetingSchema = z.object({
  title: z.string().trim().min(1).max(200),
  startsAt: z.string().trim().min(1),
  durationMinutes: z.number().int().min(1).max(1440).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  // WARP-1874 — a video-call link, alongside (not instead of) the physical
  // location. https only; the schema yields the normalized href.
  meetingUrl: meetingUrlSchema.optional(),
  note: z.string().trim().min(1).max(2000).optional(),
  reminderMinutesBefore: z.number().int().min(1).max(10_080).optional(),
});

const rsvpSchema = z.object({
  response: z.enum(["accepted", "declined"]),
});

// ── DTOs ────────────────────────────────────────────────────────────

interface ContactDto {
  id: string;
  displayName: string;
  username: string;
  role: string;
}

/** WARP-1685 — the meeting row shape the DTOs render from. */
interface MeetingRowLike {
  id: string;
  threadId: string;
  inviteMessageId: string | null;
  calendarEventId: string | null;
  title: string;
  startsAt: Date;
  durationMinutes: number | null;
  location: string | null;
  meetingUrl: string | null;
  note: string | null;
  createdById: string;
  status: string;
  reminderMinutesBefore: number;
  reminderStatus: string;
  createdAt: Date;
  rsvps?: Array<{
    userId: string;
    response: string;
    respondedAt: Date;
  }>;
}

/**
 * WARP-1685 — meeting wire shape. RSVPs ride along whenever the relation
 * was loaded (message list, meeting GET) so the invite card renders —
 * including its RSVP chips — in one fetch. `names` optionally resolves
 * display names for the RSVP list (meeting GET); the message list leaves
 * them to the thread's participant roster the client already holds.
 */
function toMeetingDto(m: MeetingRowLike, names?: Map<string, ContactDto>) {
  return {
    id: m.id,
    threadId: m.threadId,
    inviteMessageId: m.inviteMessageId,
    calendarEventId: m.calendarEventId,
    title: m.title,
    startsAt: m.startsAt.toISOString(),
    durationMinutes: m.durationMinutes,
    location: m.location,
    meetingUrl: m.meetingUrl,
    note: m.note,
    createdById: m.createdById,
    status: m.status,
    reminderMinutesBefore: m.reminderMinutesBefore,
    reminderStatus: m.reminderStatus,
    createdAt: m.createdAt.toISOString(),
    rsvps: (m.rsvps ?? []).map((r) => ({
      userId: r.userId,
      ...(names ? { displayName: names.get(r.userId)?.displayName ?? null } : {}),
      response: r.response,
      respondedAt: r.respondedAt.toISOString(),
    })),
  };
}

function toMessageDto(
  m: {
    id: string;
    threadId: string;
    senderId: string;
    kind: string;
    body: string | null;
    sharedNcFileId: number | null;
    sharedFileName: string | null;
    sharedFilePath: string | null;
    sharedFileSpace: string | null;
    sharedChatSessionId: string | null;
    meetingId?: string | null;
    meeting?: MeetingRowLike | null;
    createdAt: Date;
  },
  senderName?: string,
) {
  return {
    id: m.id,
    threadId: m.threadId,
    senderId: m.senderId,
    senderDisplayName: senderName ?? null,
    kind: m.kind,
    body: m.body,
    sharedNcFileId: m.sharedNcFileId,
    sharedFileName: m.sharedFileName,
    sharedFilePath: m.sharedFilePath,
    // WARP-1898 — null on rows written before that ticket. The client reads
    // null as UNKNOWN, never as personal: guessing personal is precisely
    // what sent recipients into their own files.
    sharedFileSpace: m.sharedFileSpace,
    sharedChatSessionId: m.sharedChatSessionId,
    // WARP-1685 — present (possibly null) on every message; populated when
    // the meeting relation was loaded (meeting_invite / meeting_reminder).
    meetingId: m.meetingId ?? null,
    meeting: m.meeting ? toMeetingDto(m.meeting) : null,
    createdAt: m.createdAt.toISOString(),
  };
}

/** The transcript snapshot's wire/storage shape. */
interface TranscriptSnapshot {
  title: string | null;
  messages: Array<{ role: string; content: string; createdAt: string }>;
}

export function createTeamChatRouter(prisma: PrismaClient): Router {
  const router = Router();
  const guard = requireRole(...HUMAN_ROLES);
  // WARP-1685 — the four routes the team-chat LLM tools dispatch through
  // additionally admit the trusted `_service:mcp` principal (and ONLY that
  // principal — voice/email-indexer's coarse "service" role still 403s).
  const guardOrMcp = requireRoleOrMcpService(...HUMAN_ROLES);

  /** Same trusted-principal check as routes/email.ts isMcpService(). */
  function isMcpService(req: Request): boolean {
    const u = (req as AuthedRequest).user;
    return u?.id === "_service:mcp" && u.role === "service";
  }

  /**
   * WARP-1685 — the effective human identity a request acts as (the
   * routes/email.ts effectiveUser()/assertAccountAccessible composition,
   * folded into one resolver because every team-chat decision needs the
   * full id/username/role triple).
   *
   * For the trusted mcp service principal ONLY, the identity is the
   * X-Droplet-User USERNAME the tool handlers forward (`ctx.userId`,
   * threaded from the chat session via MCP `_meta.userId` — WARP-202
   * username semantics). It must resolve to an ACTIVE human in the
   * directory; missing header, unknown user, deactivated user, or a
   * service row all yield null → 401, never a fallback identity. For
   * every other caller the header is IGNORED and the session's own
   * req.user rules — a human session cannot impersonate this way.
   */
  async function resolveCaller(req: Request): Promise<Caller | null> {
    if (!isMcpService(req)) return callerOf(req);
    const forwarded = (req.header("x-droplet-user") ?? "").trim();
    if (!forwarded) return null;
    const row = await prisma.user.findFirst({
      where: {
        username: forwarded,
        directoryStatus: "ACTIVE",
        role: { in: [...HUMAN_ROLES] },
      },
      select: { id: true, username: true, role: true },
    });
    return row ?? null;
  }

  /** Contact projection for roster + name resolution. */
  const contactSelect = {
    id: true,
    displayName: true,
    username: true,
    role: true,
  } as const;

  async function contactsByIds(ids: string[]): Promise<Map<string, ContactDto>> {
    if (ids.length === 0) return new Map();
    const rows = await prisma.user.findMany({
      where: { id: { in: [...new Set(ids)] } },
      select: contactSelect,
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Membership probe — the participant-only boundary. Null = not yours. */
  async function participantRow(threadId: string, userId: string) {
    return prisma.teamChatParticipant.findUnique({
      where: { threadId_userId: { threadId, userId } },
    });
  }

  // ── Roster ──────────────────────────────────────────────────────

  // Exists because GET /api/auth/users is owner/admin-only; the picker
  // needs names for every human tier. Minimal projection, ACTIVE humans
  // only — never service principals, never deactivated rows.
  // WARP-1685: guardOrMcp — the send tools resolve recipient usernames to
  // User.ids through this roster, acting as the forwarded human.
  router.get("/team-chat/contacts", guardOrMcp, async (req, res, next) => {
    try {
      const me = await resolveCaller(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const contacts = await prisma.user.findMany({
        where: {
          directoryStatus: "ACTIVE",
          role: { in: [...HUMAN_ROLES] },
        },
        select: contactSelect,
        orderBy: { displayName: "asc" },
      });
      res.json({ contacts });
    } catch (err) {
      next(err);
    }
  });

  // ── Thread list ─────────────────────────────────────────────────

  router.get("/team-chat/threads", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const myParts = await prisma.teamChatParticipant.findMany({
        where: { userId: me.id },
      });
      if (myParts.length === 0) {
        res.json({ threads: [] });
        return;
      }
      const lastReadByThread = new Map(myParts.map((p) => [p.threadId, p.lastReadAt]));
      const threads = await prisma.teamChatThread.findMany({
        where: { id: { in: myParts.map((p) => p.threadId) } },
        include: {
          participants: true,
          // WARP-1685: the preview message carries its meeting so the
          // thread list can say "Meeting: <title>".
          messages: {
            orderBy: { createdAt: "desc" },
            take: 1,
            include: { meeting: true },
          },
        },
        orderBy: { lastMessageAt: "desc" },
      });
      const names = await contactsByIds(
        threads.flatMap((t) => t.participants.map((p) => p.userId)),
      );
      // One indexed count per thread (thread counts are small; the cheap
      // aggregate for the badge is /unread-count below).
      const unreadCounts = await Promise.all(
        threads.map((t) =>
          prisma.teamChatMessage.count({
            where: {
              threadId: t.id,
              senderId: { not: me.id },
              createdAt: { gt: lastReadByThread.get(t.id) ?? new Date(0) },
            },
          }),
        ),
      );
      res.json({
        threads: threads.map((t, i) => ({
          id: t.id,
          kind: t.kind,
          title: t.title,
          createdById: t.createdById,
          createdAt: t.createdAt.toISOString(),
          lastMessageAt: t.lastMessageAt.toISOString(),
          participants: t.participants.map((p) => ({
            userId: p.userId,
            displayName: names.get(p.userId)?.displayName ?? null,
            username: names.get(p.userId)?.username ?? null,
          })),
          lastMessage: t.messages[0]
            ? toMessageDto(t.messages[0], names.get(t.messages[0].senderId)?.displayName)
            : null,
          unreadCount: unreadCounts[i],
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Thread creation ─────────────────────────────────────────────

  // WARP-1685: guardOrMcp — team_chat_send_message / _send_meeting_invite
  // create (or dedupe into) the thread through this route as the acting
  // human; the participant-validation below is identical either way.
  router.post("/team-chat/threads", guardOrMcp, async (req, res, next) => {
    try {
      const me = await resolveCaller(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const parsed = createThreadSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_thread",
          details: parsed.error.flatten(),
        });
        return;
      }
      // The caller is implicit; drop self + duplicates from the list.
      const others = [...new Set(parsed.data.participantIds)].filter(
        (id) => id !== me.id,
      );
      if (parsed.data.kind === "direct" && others.length !== 1) {
        res.status(400).json({ error: "direct_requires_one_participant" });
        return;
      }
      if (parsed.data.kind === "group" && others.length < 2) {
        res.status(400).json({ error: "group_requires_two_participants" });
        return;
      }
      // Every named participant must be a real, ACTIVE human. One query;
      // any miss (unknown / deactivated / service) refuses the create.
      const found = await prisma.user.findMany({
        where: {
          id: { in: others },
          directoryStatus: "ACTIVE",
          role: { in: [...HUMAN_ROLES] },
        },
        select: { id: true },
      });
      if (found.length !== others.length) {
        res.status(400).json({ error: "invalid_participants" });
        return;
      }
      if (parsed.data.kind === "direct") {
        // Dedupe: one direct thread per pair. `direct` threads always have
        // exactly two participants (enforced at creation, no join surface),
        // so both-some is a sufficient match.
        const existing = await prisma.teamChatThread.findFirst({
          where: {
            kind: "direct",
            AND: [
              { participants: { some: { userId: me.id } } },
              { participants: { some: { userId: others[0] } } },
            ],
          },
          include: { participants: true },
        });
        if (existing) {
          res.status(200).json({ thread: threadCreatedDto(existing) });
          return;
        }
      }
      const created = await prisma.teamChatThread.create({
        data: {
          kind: parsed.data.kind,
          title: parsed.data.title ?? null,
          createdById: me.id,
          participants: {
            create: [me.id, ...others].map((userId) => ({ userId })),
          },
        },
        include: { participants: true },
      });
      res.status(201).json({ thread: threadCreatedDto(created) });
    } catch (err) {
      next(err);
    }
  });

  function threadCreatedDto(t: {
    id: string;
    kind: string;
    title: string | null;
    createdById: string;
    createdAt: Date;
    lastMessageAt: Date;
    participants: Array<{ userId: string }>;
  }) {
    return {
      id: t.id,
      kind: t.kind,
      title: t.title,
      createdById: t.createdById,
      createdAt: t.createdAt.toISOString(),
      lastMessageAt: t.lastMessageAt.toISOString(),
      participants: t.participants.map((p) => ({ userId: p.userId })),
    };
  }

  // ── Messages: list ──────────────────────────────────────────────

  router.get("/team-chat/threads/:id/messages", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const query = listMessagesQuerySchema.safeParse(req.query);
      if (!query.success) {
        res.status(400).json({
          error: "invalid_query",
          details: query.error.flatten(),
        });
        return;
      }
      const membership = await participantRow(req.params.id, me.id);
      if (!membership) {
        res.status(404).json({ error: "thread_not_found" });
        return;
      }
      const { cursor, limit } = query.data;
      // The cursor must anchor to a message of THIS thread — a garbage or
      // cross-thread id is a caller error (400), never a Prisma cursor
      // failure surfacing as a 500.
      if (cursor) {
        const anchor = await prisma.teamChatMessage.findFirst({
          where: { id: cursor, threadId: req.params.id },
          select: { id: true },
        });
        if (!anchor) {
          res.status(400).json({ error: "invalid_cursor" });
          return;
        }
      }
      // Total order (review): createdAt alone is non-unique — two messages
      // in the same millisecond could skip/duplicate across a page
      // boundary. The id tiebreak makes the sort stable for the cursor.
      // WARP-1685: the meeting relation (with RSVPs) rides along so
      // meeting_invite / meeting_reminder cards render in ONE fetch.
      const rows = await prisma.teamChatMessage.findMany({
        where: { threadId: req.params.id },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit + 1,
        include: { meeting: { include: { rsvps: true } } },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, limit);
      const names = await contactsByIds(page.map((m) => m.senderId));
      res.json({
        messages: page.map((m) =>
          toMessageDto(m, names.get(m.senderId)?.displayName),
        ),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── Messages: send ──────────────────────────────────────────────

  // WARP-1685: guardOrMcp — the send tools post through here as the acting
  // human; senderId is the RESOLVED user's id, never the principal.
  router.post("/team-chat/threads/:id/messages", guardOrMcp, async (req, res, next) => {
    try {
      const me = await resolveCaller(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const parsed = sendMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_message",
          details: parsed.error.flatten(),
        });
        return;
      }
      const membership = await participantRow(req.params.id, me.id);
      if (!membership) {
        res.status(404).json({ error: "thread_not_found" });
        return;
      }

      const body = parsed.data;
      let data: Prisma.TeamChatMessageUncheckedCreateInput;

      if (body.kind === "text") {
        data = {
          threadId: req.params.id,
          senderId: me.id,
          kind: "text",
          body: body.body,
        };
      } else if (body.kind === "file_share") {
        // The sender must be able to open the file THEMSELVES before
        // forwarding it — the same registry+space composition the Files
        // metadata routes run (routes/files.ts gateFileSpaceAccess).
        // Unregistered files (no registry row) fall back to personal-space
        // semantics: allowed, nothing to leak (the message carries only
        // sender-supplied display fields; byte access stays with /files).
        const departmentId = await resolveFileDepartment(prisma, body.ncFileId);
        if (departmentId !== null) {
          const access = await checkSpaceAccess(
            prisma,
            req,
            { id: me.id, role: me.role },
            departmentId,
            "reader",
          );
          if (!access.allowed) {
            res.status(access.status).json({ error: access.error });
            return;
          }
        }
        // WARP-1898 — record WHICH SPACE that path is relative to, so the
        // recipient's link can address it. The REGISTRY is authoritative
        // wherever it has a row: it is the same source the access check
        // above keys on, and it holds even when the client cannot know the
        // answer — a pick from the forward dialog's SEARCH tab spans every
        // space the sender can reach, so the picker's own selector says
        // nothing about where the chosen file actually lives. The sender's
        // claim is the fallback for unregistered files only, and widens
        // nothing: /files re-runs its own space gate on every read.
        const sharedFileSpace =
          departmentId !== null
            ? await departmentSpaceToken(prisma, departmentId)
            : (body.space ?? null);

        data = {
          threadId: req.params.id,
          senderId: me.id,
          kind: "file_share",
          body: body.caption && body.caption.length > 0 ? body.caption : null,
          sharedNcFileId: body.ncFileId,
          sharedFileName: body.fileName,
          sharedFilePath: body.filePath,
          sharedFileSpace,
        };
      } else {
        // ai_chat_share — ownership first, 404 on any miss (no existence
        // leak). NOTE the username comparison: routes/llm.ts (WARP-304)
        // persists `ChatSession.userId = req.user.username`, so THAT is
        // the honest ownership key for this one check.
        const session = await prisma.chatSession.findUnique({
          where: { id: body.chatSessionId },
          select: { id: true, userId: true, title: true },
        });
        if (!session || session.userId !== me.username) {
          res.status(404).json({ error: "chat_session_not_found" });
          return;
        }
        const sessionMessages = await prisma.chatMessage.findMany({
          where: { sessionId: session.id },
          orderBy: { createdAt: "asc" },
          select: {
            role: true,
            content: true,
            toolCallId: true,
            createdAt: true,
          },
        });
        // Snapshot = the human-readable turns only. Tool rows, tool-call
        // result rows (toolCallId set) and empty/stub contents are
        // internals — they never leave the owner's conversation.
        const snapshot: TranscriptSnapshot = {
          title: session.title,
          messages: sessionMessages
            .filter(
              (m) =>
                (m.role === "user" || m.role === "assistant") &&
                m.toolCallId === null &&
                m.content.trim().length > 0,
            )
            .map((m) => ({
              role: m.role,
              content: m.content,
              createdAt: m.createdAt.toISOString(),
            })),
        };
        data = {
          threadId: req.params.id,
          senderId: me.id,
          kind: "ai_chat_share",
          body: body.caption && body.caption.length > 0 ? body.caption : null,
          sharedChatSessionId: session.id,
          sharedChatSnapshot: snapshot as unknown as Prisma.InputJsonValue,
        };
      }

      // Insert + lastMessageAt bump commit together — the thread list's
      // sort key can never drift from the newest row.
      const [message] = await prisma.$transaction([
        prisma.teamChatMessage.create({ data }),
        prisma.teamChatThread.update({
          where: { id: req.params.id },
          data: { lastMessageAt: new Date() },
        }),
      ]);
      res.status(201).json({ message: toMessageDto(message) });
    } catch (err) {
      next(err);
    }
  });

  // ── Read cursor ─────────────────────────────────────────────────

  router.post("/team-chat/threads/:id/read", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      // Atomic membership-scoped update — no TOCTOU pre-check (the
      // chat-projects updateMany idiom). count 0 = not a participant → 404.
      const r = await prisma.teamChatParticipant.updateMany({
        where: { threadId: req.params.id, userId: me.id },
        data: { lastReadAt: new Date() },
      });
      if (r.count === 0) {
        res.status(404).json({ error: "thread_not_found" });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // ── Meetings (WARP-1685) ────────────────────────────────────────

  // Schedule a meeting in a thread. One transaction commits the meeting,
  // its meeting_invite card (senderId = organizer, meetingId set), the
  // inviteMessageId backlink, and the lastMessageAt bump — the invite can
  // never exist without its meeting or vice versa. The LOCAL CalendarEvent
  // mirror (the create_event tool's exact row shape) happens AFTER the
  // transaction, best-effort: a calendar hiccup logs and the meeting
  // stands, calendarEventId simply stays null.
  router.post(
    "/team-chat/threads/:id/meetings",
    guardOrMcp,
    async (req, res, next) => {
      try {
        const me = await resolveCaller(req);
        if (!me) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const parsed = createMeetingSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({
            error: "invalid_meeting",
            details: parsed.error.flatten(),
          });
          return;
        }
        const startsAt = new Date(parsed.data.startsAt);
        if (Number.isNaN(startsAt.getTime())) {
          res.status(400).json({
            error: "invalid_meeting",
            details: { startsAt: "must be an ISO-8601 timestamp" },
          });
          return;
        }
        if (startsAt.getTime() <= Date.now()) {
          res.status(400).json({ error: "starts_at_must_be_future" });
          return;
        }
        const membership = await participantRow(req.params.id, me.id);
        if (!membership) {
          res.status(404).json({ error: "thread_not_found" });
          return;
        }

        const durationMinutes = parsed.data.durationMinutes ?? null;
        const { meeting, message } = await prisma.$transaction(async (tx) => {
          const created = await tx.teamChatMeeting.create({
            data: {
              threadId: req.params.id,
              title: parsed.data.title,
              startsAt,
              durationMinutes,
              location: parsed.data.location ?? null,
              meetingUrl: parsed.data.meetingUrl ?? null,
              note: parsed.data.note ?? null,
              createdById: me.id,
              reminderMinutesBefore: parsed.data.reminderMinutesBefore ?? 15,
            },
          });
          const inviteMessage = await tx.teamChatMessage.create({
            data: {
              threadId: req.params.id,
              senderId: me.id,
              kind: "meeting_invite",
              meetingId: created.id,
            },
          });
          const linked = await tx.teamChatMeeting.update({
            where: { id: created.id },
            data: { inviteMessageId: inviteMessage.id },
          });
          await tx.teamChatThread.update({
            where: { id: req.params.id },
            data: { lastMessageAt: new Date() },
          });
          return { meeting: linked, message: inviteMessage };
        });

        // Best-effort local calendar mirror on the ORGANIZER's calendar.
        // CalendarEvent.userId holds the Nextcloud USERNAME (the
        // create_event tool's semantics) and endsAt is required — an
        // unspecified duration mirrors as the calendar's standard hour.
        let finalMeeting = meeting;
        try {
          const endsAt = new Date(
            startsAt.getTime() +
              (durationMinutes ?? DEFAULT_CALENDAR_EVENT_MINUTES) * 60_000,
          );
          const event = await prisma.calendarEvent.create({
            data: {
              userId: me.username,
              title: parsed.data.title,
              description: parsed.data.note ?? null,
              location: parsed.data.location ?? null,
              // The mirrored calendar copy keeps the link — otherwise the
              // organizer's own calendar shows a meeting they can't join.
              meetingUrl: parsed.data.meetingUrl ?? null,
              startsAt,
              endsAt,
              allDay: false,
              source: "local",
            },
          });
          finalMeeting = await prisma.teamChatMeeting.update({
            where: { id: meeting.id },
            data: { calendarEventId: event.id },
          });
        } catch (err) {
          logger.warn(
            { err, meetingId: meeting.id },
            "calendar mirror failed — meeting stands without a CalendarEvent",
          );
        }

        const dto = toMeetingDto({ ...finalMeeting, rsvps: [] });
        res.status(201).json({
          meeting: dto,
          message: { ...toMessageDto(message), meeting: dto },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Meeting detail + named RSVP list. One indistinguishable 404 for "no
  // such meeting" and "not a participant of its thread" (v1 posture).
  router.get("/team-chat/meetings/:id", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const meeting = await prisma.teamChatMeeting.findUnique({
        where: { id: req.params.id },
        include: { rsvps: true },
      });
      if (!meeting) {
        res.status(404).json({ error: "meeting_not_found" });
        return;
      }
      const membership = await participantRow(meeting.threadId, me.id);
      if (!membership) {
        res.status(404).json({ error: "meeting_not_found" });
        return;
      }
      const names = await contactsByIds(meeting.rsvps.map((r) => r.userId));
      res.json({ meeting: toMeetingDto(meeting, names) });
    } catch (err) {
      next(err);
    }
  });

  // RSVP — participant-only upsert (accept ↔ decline flips the same row).
  // The organizer's answer is implicit in organizing; they get a 400. A
  // cancelled meeting takes no new answers.
  router.post("/team-chat/meetings/:id/rsvp", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const parsed = rsvpSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "invalid_rsvp",
          details: parsed.error.flatten(),
        });
        return;
      }
      const meeting = await prisma.teamChatMeeting.findUnique({
        where: { id: req.params.id },
      });
      if (!meeting) {
        res.status(404).json({ error: "meeting_not_found" });
        return;
      }
      const membership = await participantRow(meeting.threadId, me.id);
      if (!membership) {
        res.status(404).json({ error: "meeting_not_found" });
        return;
      }
      if (meeting.createdById === me.id) {
        res.status(400).json({ error: "organizer_cannot_rsvp" });
        return;
      }
      if (meeting.status !== "scheduled") {
        res.status(400).json({ error: "meeting_cancelled" });
        return;
      }
      const rsvp = await prisma.teamChatMeetingRsvp.upsert({
        where: {
          meetingId_userId: { meetingId: meeting.id, userId: me.id },
        },
        create: {
          meetingId: meeting.id,
          userId: me.id,
          response: parsed.data.response,
        },
        update: { response: parsed.data.response, respondedAt: new Date() },
      });
      res.json({
        rsvp: {
          userId: rsvp.userId,
          response: rsvp.response,
          respondedAt: rsvp.respondedAt.toISOString(),
        },
      });
    } catch (err) {
      next(err);
    }
  });

  // Cancel — organizer only. Outsiders get the indistinguishable 404; a
  // participant who is NOT the organizer can already see the meeting, so
  // a plain 403 leaks nothing. The status flip is CLAIMED atomically
  // inside the transaction (updateMany guarded on status=scheduled), so a
  // double-cancel race can never double-post the cancellation message.
  router.post(
    "/team-chat/meetings/:id/cancel",
    guard,
    async (req, res, next) => {
      try {
        const me = callerOf(req);
        if (!me) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const meeting = await prisma.teamChatMeeting.findUnique({
          where: { id: req.params.id },
        });
        if (!meeting) {
          res.status(404).json({ error: "meeting_not_found" });
          return;
        }
        const membership = await participantRow(meeting.threadId, me.id);
        if (!membership) {
          res.status(404).json({ error: "meeting_not_found" });
          return;
        }
        if (meeting.createdById !== me.id) {
          res.status(403).json({ error: "organizer_only" });
          return;
        }
        if (meeting.status !== "scheduled") {
          res.status(409).json({ error: "meeting_already_cancelled" });
          return;
        }
        try {
          await prisma.$transaction(async (tx) => {
            const claimed = await tx.teamChatMeeting.updateMany({
              where: { id: meeting.id, status: "scheduled" },
              data: { status: "cancelled" },
            });
            if (claimed.count === 0) throw new MeetingAlreadyCancelledError();
            // Reminder terminal flips ONLY from pending (review): when the
            // reminder already went out, `sent` is the truthful history and
            // survives cancellation — overwriting it would say the reminder
            // never fired.
            await tx.teamChatMeeting.updateMany({
              where: { id: meeting.id, reminderStatus: "pending" },
              data: { reminderStatus: "not_needed" },
            });
            await tx.teamChatMessage.create({
              data: {
                threadId: meeting.threadId,
                senderId: me.id,
                kind: "text",
                body: `Meeting cancelled: ${meeting.title}`,
              },
            });
            await tx.teamChatThread.update({
              where: { id: meeting.threadId },
              data: { lastMessageAt: new Date() },
            });
          });
        } catch (err) {
          if (err instanceof MeetingAlreadyCancelledError) {
            res.status(409).json({ error: "meeting_already_cancelled" });
            return;
          }
          throw err;
        }
        // Best-effort: retract the organizer-calendar mirror. deleteMany —
        // an already-deleted event is a no-op, never a throw.
        if (meeting.calendarEventId) {
          try {
            await prisma.calendarEvent.deleteMany({
              where: { id: meeting.calendarEventId },
            });
          } catch (err) {
            logger.warn(
              { err, meetingId: meeting.id },
              "calendar mirror delete failed — meeting cancelled regardless",
            );
          }
        }
        const updated = await prisma.teamChatMeeting.findUnique({
          where: { id: meeting.id },
          include: { rsvps: true },
        });
        if (!updated) {
          res.status(404).json({ error: "meeting_not_found" });
          return;
        }
        res.json({ meeting: toMeetingDto(updated) });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Transcript ──────────────────────────────────────────────────

  router.get(
    "/team-chat/messages/:messageId/transcript",
    guard,
    async (req, res, next) => {
      try {
        const me = callerOf(req);
        if (!me) {
          res.status(401).json({ error: "auth_required" });
          return;
        }
        const message = await prisma.teamChatMessage.findUnique({
          where: { id: req.params.messageId },
        });
        // One indistinguishable 404 for: no such message / not a
        // participant / not an ai_chat_share / snapshot missing.
        if (!message || message.kind !== "ai_chat_share") {
          res.status(404).json({ error: "transcript_not_found" });
          return;
        }
        const membership = await participantRow(message.threadId, me.id);
        if (!membership) {
          res.status(404).json({ error: "transcript_not_found" });
          return;
        }
        const snapshot = message.sharedChatSnapshot as TranscriptSnapshot | null;
        if (!snapshot) {
          res.status(404).json({ error: "transcript_not_found" });
          return;
        }
        res.json({
          title: snapshot.title ?? null,
          messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── Unread total ────────────────────────────────────────────────

  router.get("/team-chat/unread-count", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
      if (!me) {
        res.status(401).json({ error: "auth_required" });
        return;
      }
      const myParts = await prisma.teamChatParticipant.findMany({
        where: { userId: me.id },
      });
      if (myParts.length === 0) {
        res.json({ total: 0 });
        return;
      }
      const total = await prisma.teamChatMessage.count({
        where: {
          senderId: { not: me.id },
          OR: myParts.map((p) => ({
            threadId: p.threadId,
            createdAt: { gt: p.lastReadAt },
          })),
        },
      });
      res.json({ total });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
