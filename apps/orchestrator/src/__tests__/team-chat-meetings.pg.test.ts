/**
 * WARP-1685 — Team chat v1.1 meetings: the invariants only a REAL Postgres
 * can prove, driven end-to-end through the real router + real sweep
 * (team-chat.pg.test.ts lane and rules).
 *
 * WHY THESE CASES RUN HERE
 *
 *   lifecycle    — create → the invite card + meeting + REAL CalendarEvent
 *                  mirror all exist and link up; RSVP upsert flips ONE real
 *                  row under the real unique index; cancel flips
 *                  status/reminderStatus, posts the cancellation message,
 *                  and removes the mirrored CalendarEvent;
 *   sweep        — run TWICE against real rows: exactly ONE
 *                  meeting_reminder message (the pending→sent claim is a
 *                  real UPDATE ... WHERE reminderStatus='pending'), and
 *                  the invitee (never the organizer) gets a REAL
 *                  NotificationLog row; a stale meeting gets the explicit
 *                  not_needed terminal with no message;
 *   acting user  — the `_service:mcp` principal + X-Droplet-User resolves
 *                  against the REAL directory: messages attribute to the
 *                  forwarded human's User.id; a human session's header is
 *                  IGNORED; a deactivated forwarded identity 401s; a
 *                  forwarded non-participant gets the same 404 a human
 *                  outsider gets (the tool path can never widen access).
 *
 * Gated on RUN_PG_INTEGRATION=1 + DATABASE_URL, exactly like
 * team-chat.pg.test.ts. Local: scripts/test-orchestrator-pg.sh. CI: the
 * `pg-integration` job in .github/workflows/orchestrator-tests.yml.
 *
 * FIXTURE SCOPING — this DB is shared by the pg suites running in
 * parallel. Every row this file mints is namespaced `warp1685-`
 * (usernames; CalendarEvent/NotificationLog rows are keyed by those
 * usernames) and every cleanup is scoped to that prefix — never an
 * unscoped deleteMany, never a TRUNCATE (the access-role.pg.test.ts rule).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";

// The DB-less lane's global setup mocks @prisma/client; this file needs the
// real driver (team-chat.pg.test.ts precedent).
vi.unmock("@prisma/client");

vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Leaf EFFECTS are mocked; every DECISION is real. MQTT is the sweep's one
// off-DB side effect — the NotificationLog write it accompanies stays real.
vi.mock("../services/mqtt.service.js", () => ({
  publish: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../services/session.service.js", () => ({
  createSession: vi.fn(async () => ({ sid: "sid-test", evictedSids: [] })),
  checkSession: vi.fn(async () => ({ kind: "ok", record: {} })),
  deleteSession: vi.fn(async () => undefined),
  revokeAllSessions: vi.fn(async () => 1),
}));
vi.mock("../services/nextcloud-session.service.js", () => ({
  storeNcToken: vi.fn().mockResolvedValue(undefined),
  getNcToken: vi.fn().mockResolvedValue(null),
  deleteNcToken: vi.fn().mockResolvedValue(undefined),
  touchNcToken: vi.fn().mockResolvedValue(undefined),
  resolveNcToken: vi.fn().mockResolvedValue("test-nc-token"),
}));
vi.mock("../services/auth-denylist.service.js", () => ({
  denylistUser: vi.fn().mockResolvedValue(undefined),
  isUserDenied: vi.fn().mockResolvedValue(false),
}));

import { createTeamChatRouter } from "../routes/team-chat.js";
import { runTeamChatMeetingReminderSweep } from "../services/team-chat-reminders.service.js";

const RUN =
  process.env.RUN_PG_INTEGRATION === "1" &&
  typeof process.env.DATABASE_URL === "string" &&
  process.env.DATABASE_URL.length > 0;

describe.skipIf(!RUN)("team chat meetings — real Postgres (WARP-1685)", () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    const { PrismaClient: RealPrismaClient } =
      await vi.importActual<typeof import("@prisma/client")>("@prisma/client");
    prisma = new RealPrismaClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const PREFIX = "warp1685-";
  const OURS = { startsWith: PREFIX } as const;

  beforeEach(async () => {
    vi.clearAllMocks();
    // FK-ordered, prefix-scoped cleanup. Threads cascade participants,
    // messages, meetings, and (via meetings) RSVPs. CalendarEvent and
    // NotificationLog rows are keyed by our prefixed usernames.
    const ourUsers = await prisma.user.findMany({
      where: { username: OURS },
      select: { id: true },
    });
    const ourIds = ourUsers.map((u) => u.id);
    if (ourIds.length > 0) {
      await prisma.teamChatThread.deleteMany({
        where: { participants: { some: { userId: { in: ourIds } } } },
      });
    }
    await prisma.calendarEvent.deleteMany({ where: { userId: OURS } });
    await prisma.notificationLog.deleteMany({ where: { userId: OURS } });
    await prisma.user.deleteMany({ where: { username: OURS } });
  });

  // ── fixtures ─────────────────────────────────────────────────────

  async function mkUser(
    suffix: string,
    role: "owner" | "admin" | "family" | "guest",
    directoryStatus: "ACTIVE" | "DEACTIVATED" = "ACTIVE",
  ) {
    const username = `${PREFIX}${suffix}`;
    return prisma.user.create({
      data: {
        username,
        displayName: username,
        nextcloudUsername: username,
        role,
        directoryStatus,
      },
    });
  }

  function buildApp(actor: { id: string; username: string; role: string }) {
    const app = express();
    app.use(express.json());
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as unknown as { user: typeof actor & { displayName: string } }).user = {
        ...actor,
        displayName: actor.username,
      };
      next();
    });
    app.use("/api", createTeamChatRouter(prisma));
    return app;
  }

  const asActor = (u: { id: string; username: string; role: string }) => ({
    id: u.id,
    username: u.username,
    role: u.role,
  });
  const MCP = { id: "_service:mcp", username: "_service:mcp", role: "service" };

  async function mkDirectThread(
    a: { id: string; username: string; role: string },
    b: { id: string },
  ): Promise<string> {
    const res = await request(buildApp(asActor(a)))
      .post("/api/team-chat/threads")
      .send({ kind: "direct", participantIds: [b.id] });
    expect(res.status).toBe(201);
    return res.body.thread.id as string;
  }

  // ── lifecycle ────────────────────────────────────────────────────

  it("create → invite card + calendar mirror; RSVP upserts one row; cancel flips state and retracts the mirror", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const threadId = await mkDirectThread(alice, bob);

    const startsAt = new Date(Date.now() + 60 * 60_000);
    const created = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/meetings`)
      .send({
        title: `${PREFIX}kickoff`,
        startsAt: startsAt.toISOString(),
        durationMinutes: 30,
        location: "Kitchen",
      });
    expect(created.status).toBe(201);
    const meetingId = created.body.meeting.id as string;

    // Invite card + backlink are REAL rows committed together.
    const invite = await prisma.teamChatMessage.findFirst({
      where: { threadId, kind: "meeting_invite" },
    });
    expect(invite?.meetingId).toBe(meetingId);
    expect(invite?.senderId).toBe(alice.id);
    const meetingRow = await prisma.teamChatMeeting.findUnique({
      where: { id: meetingId },
    });
    expect(meetingRow?.inviteMessageId).toBe(invite?.id);

    // Organizer-calendar mirror: a real CalendarEvent, linked back.
    expect(meetingRow?.calendarEventId).not.toBeNull();
    const event = await prisma.calendarEvent.findUnique({
      where: { id: meetingRow!.calendarEventId! },
    });
    expect(event).toMatchObject({
      userId: alice.username,
      title: `${PREFIX}kickoff`,
      source: "local",
    });

    // The message list serves the card in ONE fetch (meeting + rsvps).
    const bobApp = buildApp(asActor(bob));
    const rsvp1 = await request(bobApp)
      .post(`/api/team-chat/meetings/${meetingId}/rsvp`)
      .send({ response: "accepted" });
    expect(rsvp1.status).toBe(200);
    const rsvp2 = await request(bobApp)
      .post(`/api/team-chat/meetings/${meetingId}/rsvp`)
      .send({ response: "declined" });
    expect(rsvp2.status).toBe(200);
    const rsvpRows = await prisma.teamChatMeetingRsvp.findMany({
      where: { meetingId },
    });
    expect(rsvpRows).toHaveLength(1); // upsert flipped the SAME row
    expect(rsvpRows[0].response).toBe("declined");

    const list = await request(bobApp).get(
      `/api/team-chat/threads/${threadId}/messages`,
    );
    expect(list.status).toBe(200);
    const inviteDto = list.body.messages.find(
      (m: { kind: string }) => m.kind === "meeting_invite",
    );
    expect(inviteDto.meeting).toMatchObject({
      id: meetingId,
      title: `${PREFIX}kickoff`,
      status: "scheduled",
    });
    expect(inviteDto.meeting.rsvps).toEqual([
      expect.objectContaining({ userId: bob.id, response: "declined" }),
    ]);

    // Organizer refused on their own meeting; non-organizer refused cancel.
    const own = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/meetings/${meetingId}/rsvp`)
      .send({ response: "accepted" });
    expect(own.status).toBe(400);
    const notOrganizer = await request(bobApp).post(
      `/api/team-chat/meetings/${meetingId}/cancel`,
    );
    expect(notOrganizer.status).toBe(403);

    // Organizer cancel: state flip + cancellation message + mirror gone.
    const cancelled = await request(buildApp(asActor(alice))).post(
      `/api/team-chat/meetings/${meetingId}/cancel`,
    );
    expect(cancelled.status).toBe(200);
    const after = await prisma.teamChatMeeting.findUnique({
      where: { id: meetingId },
    });
    expect(after?.status).toBe("cancelled");
    expect(after?.reminderStatus).toBe("not_needed");
    const note = await prisma.teamChatMessage.findFirst({
      where: { threadId, kind: "text" },
    });
    expect(note?.body).toBe(`Meeting cancelled: ${PREFIX}kickoff`);
    const eventAfter = await prisma.calendarEvent.findUnique({
      where: { id: meetingRow!.calendarEventId! },
    });
    expect(eventAfter).toBeNull();

    // Cancelled meetings take no further RSVPs; a second cancel 409s.
    const lateRsvp = await request(bobApp)
      .post(`/api/team-chat/meetings/${meetingId}/rsvp`)
      .send({ response: "accepted" });
    expect(lateRsvp.status).toBe(400);
    const again = await request(buildApp(asActor(alice))).post(
      `/api/team-chat/meetings/${meetingId}/cancel`,
    );
    expect(again.status).toBe(409);
  });

  // ── reminder sweep ───────────────────────────────────────────────

  it("sweep is exactly-once against real rows, and notifies the invitee (never the organizer)", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const threadId = await mkDirectThread(alice, bob);

    // Due NOW: starts in 10 min, 15-min window → dueAt was 5 min ago.
    const created = await request(buildApp(asActor(alice)))
      .post(`/api/team-chat/threads/${threadId}/meetings`)
      .send({
        title: `${PREFIX}standup`,
        startsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        reminderMinutesBefore: 15,
      });
    expect(created.status).toBe(201);
    const meetingId = created.body.meeting.id as string;

    const first = await runTeamChatMeetingReminderSweep(prisma);
    expect(first.remindersSent).toBe(1);
    const second = await runTeamChatMeetingReminderSweep(prisma);
    expect(second.remindersSent).toBe(0);

    const reminders = await prisma.teamChatMessage.findMany({
      where: { threadId, kind: "meeting_reminder" },
    });
    expect(reminders).toHaveLength(1); // run twice, ONE card
    expect(reminders[0].senderId).toBe(alice.id);
    expect(reminders[0].meetingId).toBe(meetingId);
    const meeting = await prisma.teamChatMeeting.findUnique({
      where: { id: meetingId },
    });
    expect(meeting?.reminderStatus).toBe("sent");

    // REAL NotificationLog rows: invitee yes, organizer no.
    const bobLogs = await prisma.notificationLog.findMany({
      where: { userId: bob.username },
    });
    expect(bobLogs).toHaveLength(1);
    expect(bobLogs[0].title).toBe("Meeting reminder");
    const aliceLogs = await prisma.notificationLog.count({
      where: { userId: alice.username },
    });
    expect(aliceLogs).toBe(0);
  });

  it("sweep grace path: a meeting already started past 5 min gets not_needed, no message", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const threadId = await mkDirectThread(alice, bob);

    // The route refuses past startsAt — mint the stale row directly, the
    // way a crashed box would find one on restart.
    const stale = await prisma.teamChatMeeting.create({
      data: {
        threadId,
        title: `${PREFIX}missed`,
        startsAt: new Date(Date.now() - 10 * 60_000),
        createdById: alice.id,
      },
    });

    const result = await runTeamChatMeetingReminderSweep(prisma);
    expect(result.markedNotNeeded).toBe(1);
    const after = await prisma.teamChatMeeting.findUnique({
      where: { id: stale.id },
    });
    expect(after?.reminderStatus).toBe("not_needed");
    const reminders = await prisma.teamChatMessage.count({
      where: { threadId, kind: "meeting_reminder" },
    });
    expect(reminders).toBe(0);
  });

  // ── acting user (service path) ───────────────────────────────────

  it("service path attributes to the forwarded human; human headers are ignored; outsiders stay 404", async () => {
    const alice = await mkUser("alice", "family");
    const bob = await mkUser("bob", "family");
    const mallory = await mkUser("mallory", "admin"); // not a participant
    const ghost = await mkUser("ghost", "family", "DEACTIVATED");
    const threadId = await mkDirectThread(alice, bob);

    const mcpApp = buildApp(MCP);

    // Attribution: the message belongs to the RESOLVED user, not the
    // principal — proven against the real directory row.
    const sent = await request(mcpApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .set("X-Droplet-User", alice.username)
      .send({ kind: "text", body: "assistant, on Alice's behalf" });
    expect(sent.status).toBe(201);
    expect(sent.body.message.senderId).toBe(alice.id);

    // Meeting create over the service path: same attribution.
    const meeting = await request(mcpApp)
      .post(`/api/team-chat/threads/${threadId}/meetings`)
      .set("X-Droplet-User", bob.username)
      .send({
        title: `${PREFIX}via-tool`,
        startsAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      });
    expect(meeting.status).toBe(201);
    expect(meeting.body.meeting.createdById).toBe(bob.id);

    // The tool path can never WIDEN access: a forwarded non-participant
    // gets the same indistinguishable 404 a human outsider gets.
    const outsider = await request(mcpApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .set("X-Droplet-User", mallory.username)
      .send({ kind: "text", body: "let me in" });
    expect(outsider.status).toBe(404);

    // Fail closed: missing header and deactivated identity both 401.
    const missing = await request(mcpApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .send({ kind: "text", body: "anonymous" });
    expect(missing.status).toBe(401);
    const dead = await request(mcpApp)
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .set("X-Droplet-User", ghost.username)
      .send({ kind: "text", body: "from beyond" });
    expect(dead.status).toBe(401);

    // A HUMAN session sending the header is IGNORED — no impersonation.
    const spoof = await request(buildApp(asActor(bob)))
      .post(`/api/team-chat/threads/${threadId}/messages`)
      .set("X-Droplet-User", alice.username)
      .send({ kind: "text", body: "trying to be alice" });
    expect(spoof.status).toBe(201);
    expect(spoof.body.message.senderId).toBe(bob.id);
  });
});
