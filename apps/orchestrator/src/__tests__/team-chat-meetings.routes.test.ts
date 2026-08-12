/**
 * WARP-1685 — Team chat v1.1 meetings (mocked-Prisma lane).
 *
 * Covered here:
 *   - meeting create: zod + future-startsAt validation BEFORE any prisma
 *     write; non-participants get 404 (never 403 — v1 posture); the happy
 *     path commits meeting + meeting_invite message + lastMessageAt bump
 *     together, then mirrors a LOCAL CalendarEvent best-effort (a calendar
 *     failure never rolls back or 500s the meeting);
 *   - RSVP rules: participant-only (404), organizer refused (400), upsert
 *     semantics (accept → decline flips the same row), cancelled meetings
 *     refuse new RSVPs (400);
 *   - cancel: organizer-only (participant non-organizer → 403; outsider →
 *     404), sets status=cancelled + reminderStatus=not_needed, posts the
 *     "Meeting cancelled: <title>" text message in the same tx, deletes
 *     the linked CalendarEvent best-effort, and a second cancel 409s;
 *   - message list: meeting_invite rows carry the live meeting payload
 *     (incl. RSVPs) so the card renders in one fetch;
 *   - acting-user resolution (WARP-1685 service path): the `_service:mcp`
 *     principal acts as the X-Droplet-User USERNAME — resolved against the
 *     directory (ACTIVE humans only; unknown/service/missing → 401, fail
 *     closed), then flows through the IDENTICAL participant checks as a
 *     human call. A HUMAN session sending X-Droplet-User is IGNORED — the
 *     header can never impersonate; other service principals stay 403.
 *
 * The real-Postgres proofs (exactly-once reminder sweep, real FK/unique
 * behavior, service-path attribution against real rows) live in
 * src/__tests__/team-chat-meetings.pg.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import express, {
  type Request,
  type Response,
  type NextFunction,
} from "express";

// Functional stand-ins for BOTH guards the router imports — mimic the real
// allowed-set + pinned-principal checks so the role list and the mcp
// admission are actually pinned, without auth.ts's dependency graph.
vi.mock("../middleware/auth.js", () => {
  const roleCheck =
    (...allowed: string[]) =>
    (req: Request, res: Response, next: NextFunction) => {
      const role = (req as { user?: { role?: string } }).user?.role;
      if (typeof role !== "string" || !allowed.includes(role)) {
        res.status(403).json({ error: "Forbidden: role not permitted" });
        return;
      }
      next();
    };
  return {
    requireRole: roleCheck,
    requireRoleOrMcpService:
      (...allowed: string[]) =>
      (req: Request, res: Response, next: NextFunction) => {
        const u = (req as { user?: { id?: string; role?: string } }).user;
        if (u?.id === "_service:mcp" && u.role === "service") {
          next();
          return;
        }
        roleCheck(...allowed)(req, res, next);
      },
  };
});

vi.mock("../middleware/space.js", () => ({
  checkSpaceAccess: vi.fn(),
}));
vi.mock("../services/file-registry.service.js", () => ({
  resolveFileDepartment: vi.fn(),
}));

import { createTeamChatRouter } from "../routes/team-chat.js";

// ── In-memory prisma stub (meetings-focused) ────────────────────────

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
}
interface ThreadRow {
  id: string;
  kind: "direct" | "group";
  title: string | null;
  createdById: string;
  createdAt: Date;
  updatedAt: Date;
  lastMessageAt: Date;
}
interface ParticipantRow {
  id: string;
  threadId: string;
  userId: string;
  joinedAt: Date;
  lastReadAt: Date;
}
interface MessageRow {
  id: string;
  threadId: string;
  senderId: string;
  kind: string;
  body: string | null;
  sharedNcFileId: number | null;
  sharedFileName: string | null;
  sharedFilePath: string | null;
  /** WARP-1898 — the space `sharedFilePath` is relative to. */
  sharedFileSpace: string | null;
  sharedChatSessionId: string | null;
  sharedChatSnapshot: unknown;
  meetingId: string | null;
  createdAt: Date;
}
interface MeetingRow {
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
  status: "scheduled" | "cancelled";
  reminderMinutesBefore: number;
  reminderStatus: "pending" | "sent" | "not_needed";
  createdAt: Date;
  updatedAt: Date;
}
interface RsvpRow {
  id: string;
  meetingId: string;
  userId: string;
  response: "accepted" | "declined";
  respondedAt: Date;
}
interface CalendarEventRow {
  id: string;
  userId: string;
  title: string;
  description: string | null;
  location: string | null;
  meetingUrl: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  source: string;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${++seq}`;

function createStub(seed: {
  users?: UserRow[];
  threads?: ThreadRow[];
  participants?: ParticipantRow[];
  messages?: MessageRow[];
  meetings?: MeetingRow[];
  rsvps?: RsvpRow[];
  failCalendarCreate?: boolean;
}) {
  const users = [...(seed.users ?? [])];
  const threads = [...(seed.threads ?? [])];
  const participants = [...(seed.participants ?? [])];
  const messages = [...(seed.messages ?? [])];
  const meetings = [...(seed.meetings ?? [])];
  const rsvps = [...(seed.rsvps ?? [])];
  const calendarEvents: CalendarEventRow[] = [];

  const withRsvps = (m: MeetingRow) => ({
    ...m,
    rsvps: rsvps.filter((r) => r.meetingId === m.id),
  });

  const models = {
    users,
    threads,
    participants,
    messages,
    meetings,
    rsvps,
    calendarEvents,
    user: {
      findMany: vi.fn(
        async (args: {
          where: {
            id?: { in: string[] };
            directoryStatus?: string;
            role?: { in: string[] };
          };
          select?: Record<string, true>;
        }) => {
          const rows = users.filter((u) => {
            const w = args.where;
            if (w.id?.in !== undefined && !w.id.in.includes(u.id)) return false;
            if (
              w.directoryStatus !== undefined &&
              u.directoryStatus !== w.directoryStatus
            )
              return false;
            if (w.role?.in !== undefined && !w.role.in.includes(u.role)) return false;
            return true;
          });
          if (!args.select) return rows;
          const keys = Object.keys(args.select);
          return rows.map((r) =>
            Object.fromEntries(keys.map((k) => [k, r[k as keyof UserRow]])),
          );
        },
      ),
      findFirst: vi.fn(
        async (args: {
          where: {
            username?: string;
            directoryStatus?: string;
            role?: { in: string[] };
          };
        }) => {
          const w = args.where;
          return (
            users.find(
              (u) =>
                (w.username === undefined || u.username === w.username) &&
                (w.directoryStatus === undefined ||
                  u.directoryStatus === w.directoryStatus) &&
                (w.role?.in === undefined || w.role.in.includes(u.role)),
            ) ?? null
          );
        },
      ),
    },
    teamChatThread: {
      update: vi.fn(
        async (args: { where: { id: string }; data: { lastMessageAt: Date } }) => {
          const t = threads.find((x) => x.id === args.where.id);
          if (!t) throw new Error("thread not found");
          t.lastMessageAt = args.data.lastMessageAt;
          return t;
        },
      ),
    },
    teamChatParticipant: {
      findUnique: vi.fn(
        async (args: {
          where: { threadId_userId: { threadId: string; userId: string } };
        }) =>
          participants.find(
            (p) =>
              p.threadId === args.where.threadId_userId.threadId &&
              p.userId === args.where.threadId_userId.userId,
          ) ?? null,
      ),
      findMany: vi.fn(async (args: { where: { userId?: string; threadId?: string } }) =>
        participants.filter(
          (p) =>
            (args.where.userId === undefined || p.userId === args.where.userId) &&
            (args.where.threadId === undefined || p.threadId === args.where.threadId),
        ),
      ),
    },
    teamChatMessage: {
      create: vi.fn(
        async (args: {
          data: Partial<MessageRow> & {
            threadId: string;
            senderId: string;
            kind: string;
          };
        }) => {
          const m: MessageRow = {
            id: nextId("msg"),
            body: null,
            sharedNcFileId: null,
            sharedFileName: null,
            sharedFilePath: null,
            sharedFileSpace: null,
            sharedChatSessionId: null,
            sharedChatSnapshot: null,
            meetingId: null,
            createdAt: new Date(),
            ...args.data,
          };
          messages.push(m);
          return m;
        },
      ),
      findMany: vi.fn(
        async (args: {
          where: { threadId?: string };
          take?: number;
          include?: { meeting?: { include?: { rsvps?: boolean } } | boolean };
        }) => {
          let rows = messages.filter(
            (m) => args.where.threadId === undefined || m.threadId === args.where.threadId,
          );
          rows = [...rows].sort((a, b) => {
            const d = b.createdAt.getTime() - a.createdAt.getTime();
            return d !== 0 ? d : b.id.localeCompare(a.id);
          });
          if (args.take !== undefined) rows = rows.slice(0, args.take);
          if (!args.include?.meeting) return rows;
          return rows.map((m) => ({
            ...m,
            meeting: m.meetingId
              ? withRsvps(meetings.find((x) => x.id === m.meetingId)!)
              : null,
          }));
        },
      ),
      findFirst: vi.fn(async () => null),
    },
    teamChatMeeting: {
      create: vi.fn(
        async (args: {
          data: Partial<MeetingRow> & {
            threadId: string;
            title: string;
            startsAt: Date;
            createdById: string;
          };
        }) => {
          const m: MeetingRow = {
            id: nextId("meeting"),
            inviteMessageId: null,
            calendarEventId: null,
            durationMinutes: null,
            location: null,
            meetingUrl: null,
            note: null,
            status: "scheduled",
            reminderMinutesBefore: 15,
            reminderStatus: "pending",
            createdAt: new Date(),
            updatedAt: new Date(),
            ...args.data,
          };
          meetings.push(m);
          return m;
        },
      ),
      findUnique: vi.fn(
        async (args: {
          where: { id: string };
          include?: { rsvps?: boolean };
        }) => {
          const m = meetings.find((x) => x.id === args.where.id);
          if (!m) return null;
          return args.include?.rsvps ? withRsvps(m) : m;
        },
      ),
      update: vi.fn(
        async (args: { where: { id: string }; data: Partial<MeetingRow> }) => {
          const m = meetings.find((x) => x.id === args.where.id);
          if (!m) throw new Error("meeting not found");
          Object.assign(m, args.data, { updatedAt: new Date() });
          return m;
        },
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; status?: string; reminderStatus?: string };
          data: Partial<MeetingRow>;
        }) => {
          let count = 0;
          for (const m of meetings) {
            if (m.id !== args.where.id) continue;
            if (args.where.status !== undefined && m.status !== args.where.status)
              continue;
            if (
              args.where.reminderStatus !== undefined &&
              m.reminderStatus !== args.where.reminderStatus
            )
              continue;
            Object.assign(m, args.data, { updatedAt: new Date() });
            count++;
          }
          return { count };
        },
      ),
    },
    teamChatMeetingRsvp: {
      upsert: vi.fn(
        async (args: {
          where: { meetingId_userId: { meetingId: string; userId: string } };
          create: { meetingId: string; userId: string; response: RsvpRow["response"] };
          update: { response: RsvpRow["response"]; respondedAt: Date };
        }) => {
          const existing = rsvps.find(
            (r) =>
              r.meetingId === args.where.meetingId_userId.meetingId &&
              r.userId === args.where.meetingId_userId.userId,
          );
          if (existing) {
            existing.response = args.update.response;
            existing.respondedAt = args.update.respondedAt;
            return existing;
          }
          const row: RsvpRow = {
            id: nextId("rsvp"),
            respondedAt: new Date(),
            ...args.create,
          };
          rsvps.push(row);
          return row;
        },
      ),
    },
    calendarEvent: {
      create: vi.fn(async (args: { data: Omit<CalendarEventRow, "id"> }) => {
        if (seed.failCalendarCreate) throw new Error("calendar unavailable");
        const row: CalendarEventRow = { id: nextId("cal"), ...args.data };
        calendarEvents.push(row);
        return row;
      }),
      deleteMany: vi.fn(async (args: { where: { id: string } }) => {
        const before = calendarEvents.length;
        for (let i = calendarEvents.length - 1; i >= 0; i--) {
          if (calendarEvents[i].id === args.where.id) calendarEvents.splice(i, 1);
        }
        return { count: before - calendarEvents.length };
      }),
    },
  };
  // Interactive $transaction hands the SAME stub back as the tx client —
  // attached after construction so the object isn't self-referential in
  // its own initializer (TS7022).
  const stub = {
    ...models,
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: typeof models) => Promise<unknown>)(models);
      }
      return Promise.all(arg as Array<Promise<unknown>>);
    }),
  };
  return stub;
}

type Stub = ReturnType<typeof createStub>;

function buildApp(
  prisma: Stub,
  user: { id: string; username: string; role: string },
) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user?: typeof user }).user = user;
    next();
  });
  app.use("/api", createTeamChatRouter(prisma as never));
  return app;
}

// ── fixtures ────────────────────────────────────────────────────────

const alice: UserRow = {
  id: "uuid-alice",
  username: "alice",
  displayName: "Alice A",
  role: "family",
  directoryStatus: "ACTIVE",
};
const bob: UserRow = {
  id: "uuid-bob",
  username: "bob",
  displayName: "Bob B",
  role: "family",
  directoryStatus: "ACTIVE",
};
const mallory: UserRow = {
  id: "uuid-mallory",
  username: "mallory",
  displayName: "Mallory M",
  role: "admin",
  directoryStatus: "ACTIVE",
};
const deactivated: UserRow = {
  id: "uuid-dead",
  username: "dave",
  displayName: "Dave D",
  role: "family",
  directoryStatus: "DEACTIVATED",
};

const asAlice = { id: alice.id, username: alice.username, role: alice.role };
const asBob = { id: bob.id, username: bob.username, role: bob.role };
const asMallory = {
  id: mallory.id,
  username: mallory.username,
  role: mallory.role,
};
const asMcp = { id: "_service:mcp", username: "_service:mcp", role: "service" };
const asVoice = {
  id: "_service:voice",
  username: "_service:voice",
  role: "service",
};

const THREAD: ThreadRow = {
  id: "thread-ab",
  kind: "direct",
  title: null,
  createdById: alice.id,
  createdAt: new Date("2026-08-01T10:00:00Z"),
  updatedAt: new Date("2026-08-01T10:00:00Z"),
  lastMessageAt: new Date("2026-08-01T10:00:00Z"),
};

function part(threadId: string, userId: string): ParticipantRow {
  return {
    id: nextId("part"),
    threadId,
    userId,
    joinedAt: new Date("2026-08-01T10:00:00Z"),
    lastReadAt: new Date("2026-08-01T10:00:00Z"),
  };
}

function baseSeed(over: Parameters<typeof createStub>[0] = {}) {
  return createStub({
    users: [alice, bob, mallory, deactivated],
    threads: [THREAD],
    participants: [part(THREAD.id, alice.id), part(THREAD.id, bob.id)],
    ...over,
  });
}

function seedMeeting(over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: over.id ?? "meeting-1",
    threadId: over.threadId ?? THREAD.id,
    inviteMessageId: over.inviteMessageId ?? null,
    calendarEventId: over.calendarEventId ?? null,
    title: over.title ?? "Sprint sync",
    startsAt: over.startsAt ?? new Date(Date.now() + 60 * 60_000),
    durationMinutes: over.durationMinutes ?? 30,
    location: over.location ?? null,
    meetingUrl: over.meetingUrl ?? null,
    note: over.note ?? null,
    createdById: over.createdById ?? alice.id,
    status: over.status ?? "scheduled",
    reminderMinutesBefore: over.reminderMinutesBefore ?? 15,
    reminderStatus: over.reminderStatus ?? "pending",
    createdAt: over.createdAt ?? new Date("2026-08-01T10:00:00Z"),
    updatedAt: over.updatedAt ?? new Date("2026-08-01T10:00:00Z"),
  };
}

const futureIso = () => new Date(Date.now() + 60 * 60_000).toISOString();

// ── meeting create ──────────────────────────────────────────────────

describe("POST /team-chat/threads/:id/meetings", () => {
  it("rejects a past startsAt with 400 before any prisma write", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({
        title: "Retro",
        startsAt: new Date(Date.now() - 60_000).toISOString(),
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("starts_at_must_be_future");
    expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
    expect(prisma.teamChatMessage.create).not.toHaveBeenCalled();
  });

  it("rejects an invalid body (missing title / bad startsAt) with 400", async () => {
    const prisma = baseSeed();
    const app = buildApp(prisma, asAlice);
    const noTitle = await request(app)
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ startsAt: futureIso() });
    expect(noTitle.status).toBe(400);
    const badDate = await request(app)
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ title: "Retro", startsAt: "not-a-date" });
    expect(badDate.status).toBe(400);
    expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
  });

  it("404s (never 403) for a non-participant", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asMallory))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ title: "Retro", startsAt: futureIso() });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("thread_not_found");
    expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
  });

  it("creates meeting + invite message + bump together, then mirrors a local CalendarEvent", async () => {
    const prisma = baseSeed();
    const startsAt = futureIso();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({
        title: "Sprint sync",
        startsAt,
        durationMinutes: 45,
        location: "Kitchen",
        note: "Bring the numbers",
      });
    expect(res.status).toBe(201);

    const meeting = prisma.meetings[0];
    expect(meeting).toMatchObject({
      threadId: THREAD.id,
      title: "Sprint sync",
      durationMinutes: 45,
      location: "Kitchen",
      note: "Bring the numbers",
      createdById: alice.id,
      status: "scheduled",
      reminderMinutesBefore: 15,
      reminderStatus: "pending",
    });

    const invite = prisma.messages.find((m) => m.kind === "meeting_invite");
    expect(invite).toBeDefined();
    expect(invite?.senderId).toBe(alice.id);
    expect(invite?.meetingId).toBe(meeting.id);
    expect(meeting.inviteMessageId).toBe(invite?.id);
    // Thread sort key bumped in the same transaction.
    expect(prisma.threads[0].lastMessageAt.getTime()).toBeGreaterThan(
      new Date("2026-08-01T10:00:00Z").getTime(),
    );

    // Local calendar mirror: organizer's USERNAME (CalendarEvent.userId is
    // the Nextcloud username — the create_event tool's semantics), source
    // local, endsAt = startsAt + duration.
    expect(prisma.calendarEvents).toHaveLength(1);
    const ev = prisma.calendarEvents[0];
    expect(ev.userId).toBe(alice.username);
    expect(ev.source).toBe("local");
    expect(ev.endsAt.getTime() - ev.startsAt.getTime()).toBe(45 * 60_000);
    expect(meeting.calendarEventId).toBe(ev.id);

    expect(res.body.meeting.id).toBe(meeting.id);
    expect(res.body.meeting.status).toBe("scheduled");
    expect(res.body.message.kind).toBe("meeting_invite");
  });

  // WARP-1874 — the video-call link. An https URL authored by one member
  // becomes an href for every other member of the thread, so the scheme
  // check runs on the write path (shared-types' parseMeetingLink, pinned
  // exhaustively in packages/shared-types/src/meeting-link.test.ts).
  it("stores a video-call link beside the physical location and carries it to the calendar mirror", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({
        title: "Sprint sync",
        startsAt: futureIso(),
        location: "Living Room",
        meetingUrl: "https://warplab.zoom.us/j/98765?pwd=abc",
      });

    expect(res.status).toBe(201);
    expect(prisma.meetings[0].location).toBe("Living Room");
    expect(prisma.meetings[0].meetingUrl).toBe(
      "https://warplab.zoom.us/j/98765?pwd=abc",
    );
    // The organizer's mirrored calendar row keeps the link too — otherwise
    // the calendar copy is a meeting you can't join.
    expect(prisma.calendarEvents[0].meetingUrl).toBe(
      "https://warplab.zoom.us/j/98765?pwd=abc",
    );
    // On the wire for the invite card, in the same fetch as the meeting.
    expect(res.body.meeting.meetingUrl).toBe(
      "https://warplab.zoom.us/j/98765?pwd=abc",
    );
    expect(res.body.message.meeting.meetingUrl).toBe(
      "https://warplab.zoom.us/j/98765?pwd=abc",
    );
  });

  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "java\nscript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "http://zoom.us/j/1",
    "//evil.example/j/1",
    "the kitchen",
  ])("refuses the non-https meetingUrl %s with 400 before any write", async (hostile) => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ title: "Sprint sync", startsAt: futureIso(), meetingUrl: hostile });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_meeting");
    expect(prisma.teamChatMeeting.create).not.toHaveBeenCalled();
    expect(prisma.calendarEvents).toHaveLength(0);
  });

  it("accepts an unrecognized https link — provider detection is for the label, not admission", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({
        title: "Family call",
        startsAt: futureIso(),
        meetingUrl: "https://vc.warp-lab.ai/room/kitchen",
      });
    expect(res.status).toBe(201);
    expect(prisma.meetings[0].meetingUrl).toBe("https://vc.warp-lab.ai/room/kitchen");
  });

  it("leaves meetingUrl null when the organizer doesn't add one", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ title: "Sprint sync", startsAt: futureIso(), location: "Kitchen" });
    expect(res.status).toBe(201);
    expect(prisma.meetings[0].meetingUrl).toBeNull();
    expect(res.body.meeting.meetingUrl).toBeNull();
  });

  it("still 201s when the calendar mirror fails — the meeting stands", async () => {
    const prisma = baseSeed({ failCalendarCreate: true });
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .send({ title: "Sprint sync", startsAt: futureIso() });
    expect(res.status).toBe(201);
    expect(prisma.meetings).toHaveLength(1);
    expect(prisma.meetings[0].calendarEventId).toBeNull();
    expect(prisma.messages.some((m) => m.kind === "meeting_invite")).toBe(true);
  });
});

// ── meeting get ─────────────────────────────────────────────────────

describe("GET /team-chat/meetings/:id", () => {
  it("returns the meeting + named RSVP list to a participant; 404 to anyone else", async () => {
    const meeting = seedMeeting();
    const prisma = baseSeed({
      meetings: [meeting],
      rsvps: [
        {
          id: "rsvp-1",
          meetingId: meeting.id,
          userId: bob.id,
          response: "accepted",
          respondedAt: new Date("2026-08-02T09:00:00Z"),
        },
      ],
    });

    const ok = await request(buildApp(prisma, asBob)).get(
      `/api/team-chat/meetings/${meeting.id}`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.meeting.title).toBe("Sprint sync");
    expect(ok.body.meeting.rsvps).toEqual([
      expect.objectContaining({
        userId: bob.id,
        displayName: "Bob B",
        response: "accepted",
      }),
    ]);

    const outsider = await request(buildApp(prisma, asMallory)).get(
      `/api/team-chat/meetings/${meeting.id}`,
    );
    expect(outsider.status).toBe(404);
    expect(outsider.body.error).toBe("meeting_not_found");
  });
});

// ── RSVP ────────────────────────────────────────────────────────────

describe("POST /team-chat/meetings/:id/rsvp", () => {
  it("refuses the organizer with 400", async () => {
    const meeting = seedMeeting();
    const prisma = baseSeed({ meetings: [meeting] });
    const res = await request(buildApp(prisma, asAlice))
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "accepted" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("organizer_cannot_rsvp");
    expect(prisma.rsvps).toHaveLength(0);
  });

  it("upserts: accept then flip to declined updates the SAME row", async () => {
    const meeting = seedMeeting();
    const prisma = baseSeed({ meetings: [meeting] });
    const app = buildApp(prisma, asBob);

    const first = await request(app)
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "accepted" });
    expect(first.status).toBe(200);
    expect(first.body.rsvp).toMatchObject({ userId: bob.id, response: "accepted" });

    const second = await request(app)
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "declined" });
    expect(second.status).toBe(200);
    expect(prisma.rsvps).toHaveLength(1);
    expect(prisma.rsvps[0].response).toBe("declined");
  });

  it("404s a non-participant and 400s an invalid response value", async () => {
    const meeting = seedMeeting();
    const prisma = baseSeed({ meetings: [meeting] });
    const outsider = await request(buildApp(prisma, asMallory))
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "accepted" });
    expect(outsider.status).toBe(404);

    const invalid = await request(buildApp(prisma, asBob))
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "maybe" });
    expect(invalid.status).toBe(400);
  });

  it("refuses RSVPs on a cancelled meeting with 400", async () => {
    const meeting = seedMeeting({ status: "cancelled", reminderStatus: "not_needed" });
    const prisma = baseSeed({ meetings: [meeting] });
    const res = await request(buildApp(prisma, asBob))
      .post(`/api/team-chat/meetings/${meeting.id}/rsvp`)
      .send({ response: "accepted" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("meeting_cancelled");
  });
});

// ── cancel ──────────────────────────────────────────────────────────

describe("POST /team-chat/meetings/:id/cancel", () => {
  it("404s a non-participant, 403s a participant who is not the organizer", async () => {
    const meeting = seedMeeting();
    const prisma = baseSeed({ meetings: [meeting] });

    const outsider = await request(buildApp(prisma, asMallory)).post(
      `/api/team-chat/meetings/${meeting.id}/cancel`,
    );
    expect(outsider.status).toBe(404);

    const notOrganizer = await request(buildApp(prisma, asBob)).post(
      `/api/team-chat/meetings/${meeting.id}/cancel`,
    );
    expect(notOrganizer.status).toBe(403);
    expect(notOrganizer.body.error).toBe("organizer_only");
    expect(prisma.meetings[0].status).toBe("scheduled");
  });

  it("organizer cancel: status+reminderStatus flip, cancellation message posted, calendar event deleted", async () => {
    const meeting = seedMeeting({ calendarEventId: "cal-77" });
    const prisma = baseSeed({ meetings: [meeting] });
    // Seed the mirrored event so the delete has something to remove.
    prisma.calendarEvents.push({
      id: "cal-77",
      userId: alice.username,
      title: meeting.title,
      description: null,
      location: null,
      meetingUrl: null,
      startsAt: meeting.startsAt,
      endsAt: new Date(meeting.startsAt.getTime() + 30 * 60_000),
      allDay: false,
      source: "local",
    });

    const res = await request(buildApp(prisma, asAlice)).post(
      `/api/team-chat/meetings/${meeting.id}/cancel`,
    );
    expect(res.status).toBe(200);
    expect(res.body.meeting.status).toBe("cancelled");

    expect(prisma.meetings[0].status).toBe("cancelled");
    expect(prisma.meetings[0].reminderStatus).toBe("not_needed");
    const note = prisma.messages.find((m) => m.kind === "text");
    expect(note?.body).toBe("Meeting cancelled: Sprint sync");
    expect(note?.senderId).toBe(alice.id);
    expect(prisma.calendarEvent.deleteMany).toHaveBeenCalledWith({
      where: { id: "cal-77" },
    });
    expect(prisma.calendarEvents).toHaveLength(0);
  });

  it("cancel after the reminder went out keeps the truthful `sent` terminal", async () => {
    // Review pin: the not_needed flip is GUARDED on pending — a reminder
    // that already fired stays recorded as sent through cancellation.
    const meeting = seedMeeting({ reminderStatus: "sent" });
    const prisma = baseSeed({ meetings: [meeting] });
    const res = await request(buildApp(prisma, asAlice)).post(
      `/api/team-chat/meetings/${meeting.id}/cancel`,
    );
    expect(res.status).toBe(200);
    expect(prisma.meetings[0].status).toBe("cancelled");
    expect(prisma.meetings[0].reminderStatus).toBe("sent");
  });

  it("a second cancel 409s and does not double-post the cancellation message", async () => {
    const meeting = seedMeeting({ status: "cancelled", reminderStatus: "not_needed" });
    const prisma = baseSeed({ meetings: [meeting] });
    const res = await request(buildApp(prisma, asAlice)).post(
      `/api/team-chat/meetings/${meeting.id}/cancel`,
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("meeting_already_cancelled");
    expect(prisma.messages).toHaveLength(0);
  });
});

// ── message list carries the meeting payload ────────────────────────

describe("GET /team-chat/threads/:id/messages — meeting payload", () => {
  it("meeting_invite rows include the live meeting (incl. RSVPs) in one fetch", async () => {
    const meeting = seedMeeting({ inviteMessageId: "msg-invite" });
    const prisma = baseSeed({
      meetings: [meeting],
      messages: [
        {
          id: "msg-invite",
          threadId: THREAD.id,
          senderId: alice.id,
          kind: "meeting_invite",
          body: null,
          sharedNcFileId: null,
          sharedFileName: null,
          sharedFilePath: null,
          sharedFileSpace: null,
          sharedChatSessionId: null,
          sharedChatSnapshot: null,
          meetingId: meeting.id,
          createdAt: new Date("2026-08-02T10:00:00Z"),
        },
      ],
      rsvps: [
        {
          id: "rsvp-1",
          meetingId: meeting.id,
          userId: bob.id,
          response: "accepted",
          respondedAt: new Date("2026-08-02T11:00:00Z"),
        },
      ],
    });

    const res = await request(buildApp(prisma, asBob)).get(
      `/api/team-chat/threads/${THREAD.id}/messages`,
    );
    expect(res.status).toBe(200);
    const invite = res.body.messages.find(
      (m: { kind: string }) => m.kind === "meeting_invite",
    );
    expect(invite.meeting).toMatchObject({
      id: meeting.id,
      title: "Sprint sync",
      status: "scheduled",
      createdById: alice.id,
      durationMinutes: 30,
    });
    expect(invite.meeting.rsvps).toEqual([
      expect.objectContaining({ userId: bob.id, response: "accepted" }),
    ]);
  });
});

// ── acting-user resolution (service path) ───────────────────────────

describe("acting user — _service:mcp + X-Droplet-User", () => {
  it("attributes the message to the RESOLVED forwarded human, not the principal", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asMcp))
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .set("X-Droplet-User", alice.username)
      .send({ kind: "text", body: "sent by the assistant on Alice's behalf" });
    expect(res.status).toBe(201);
    expect(res.body.message.senderId).toBe(alice.id);
    expect(prisma.messages[0].senderId).toBe(alice.id);
  });

  it("meeting create over the service path flows through the participant check (404 for outsiders)", async () => {
    const prisma = baseSeed();
    const ok = await request(buildApp(prisma, asMcp))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .set("X-Droplet-User", alice.username)
      .send({ title: "Standup", startsAt: futureIso() });
    expect(ok.status).toBe(201);
    expect(prisma.meetings[0].createdById).toBe(alice.id);

    const outsider = await request(buildApp(prisma, asMcp))
      .post(`/api/team-chat/threads/${THREAD.id}/meetings`)
      .set("X-Droplet-User", mallory.username)
      .send({ title: "Standup", startsAt: futureIso() });
    expect(outsider.status).toBe(404);
  });

  it("401s when the header is missing, unknown, or names a deactivated user — fail closed", async () => {
    const prisma = baseSeed();
    const app = buildApp(prisma, asMcp);

    const missing = await request(app)
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .send({ kind: "text", body: "no identity" });
    expect(missing.status).toBe(401);

    const unknown = await request(app)
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .set("X-Droplet-User", "nobody")
      .send({ kind: "text", body: "ghost" });
    expect(unknown.status).toBe(401);

    const dead = await request(app)
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .set("X-Droplet-User", deactivated.username)
      .send({ kind: "text", body: "from beyond" });
    expect(dead.status).toBe(401);
    expect(prisma.messages).toHaveLength(0);
  });

  it("IGNORES the header on a human session — a human can never impersonate", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asBob))
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .set("X-Droplet-User", alice.username)
      .send({ kind: "text", body: "trying to be alice" });
    expect(res.status).toBe(201);
    expect(res.body.message.senderId).toBe(bob.id);
  });

  it("refuses OTHER service principals (403) — only _service:mcp is admitted", async () => {
    const prisma = baseSeed();
    const res = await request(buildApp(prisma, asVoice))
      .post(`/api/team-chat/threads/${THREAD.id}/messages`)
      .set("X-Droplet-User", alice.username)
      .send({ kind: "text", body: "voice tries" });
    expect(res.status).toBe(403);
  });
});
