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
 * Access model:
 *   - Humans only (owner/admin/family/guest) — no service principals.
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
import { requireRole } from "../middleware/auth.js";
import { checkSpaceAccess } from "../middleware/space.js";
import { resolveFileDepartment } from "../services/file-registry.service.js";

type AuthedRequest = {
  user?: { id?: string; username?: string; role?: string };
};

/** The four human tiers — service principals never message. */
const HUMAN_ROLES = ["owner", "admin", "family", "guest"] as const;

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
    caption: z.string().trim().max(1000).optional(),
  }),
  z.object({
    kind: z.literal("ai_chat_share"),
    chatSessionId: z.string().uuid(),
    caption: z.string().trim().max(1000).optional(),
  }),
]);

// ── DTOs ────────────────────────────────────────────────────────────

interface ContactDto {
  id: string;
  displayName: string;
  username: string;
  role: string;
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
    sharedChatSessionId: string | null;
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
    sharedChatSessionId: m.sharedChatSessionId,
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
  router.get("/team-chat/contacts", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
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
          messages: { orderBy: { createdAt: "desc" }, take: 1 },
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

  router.post("/team-chat/threads", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
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
      const rows = await prisma.teamChatMessage.findMany({
        where: { threadId: req.params.id },
        orderBy: { createdAt: "desc" },
        take: limit + 1,
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

  router.post("/team-chat/threads/:id/messages", guard, async (req, res, next) => {
    try {
      const me = callerOf(req);
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
        data = {
          threadId: req.params.id,
          senderId: me.id,
          kind: "file_share",
          body: body.caption && body.caption.length > 0 ? body.caption : null,
          sharedNcFileId: body.ncFileId,
          sharedFileName: body.fileName,
          sharedFilePath: body.filePath,
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
