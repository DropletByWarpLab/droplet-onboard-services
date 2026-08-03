/**
 * WARP-1685 — meeting reminder sweep (mocked lane).
 *
 * Exactly-once is the whole point: the reminderStatus pending→sent claim
 * commits in the SAME transaction as the meeting_reminder message insert,
 * so a second sweep run (restart, overlapping replica after an advisory-
 * lock handoff) can never double-post. Stale meetings (already started
 * past the 5-min grace) get the EXPLICIT not_needed terminal — no silent
 * skip that would leave rows perpetually pending.
 *
 * The real-Postgres run-twice proof lives in
 * __tests__/team-chat-meetings.pg.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { sendNotificationMock } = vi.hoisted(() => ({
  sendNotificationMock: vi.fn(async () => ({
    id: "log-1",
    channels: ["toast"],
    delivered: true,
  })),
}));

vi.mock("./notifications.service.js", () => ({
  sendNotification: sendNotificationMock,
}));

import { runTeamChatMeetingReminderSweep } from "./team-chat-reminders.service.js";

// ── stub ────────────────────────────────────────────────────────────

interface MeetingRow {
  id: string;
  threadId: string;
  title: string;
  startsAt: Date;
  createdById: string;
  status: "scheduled" | "cancelled";
  reminderMinutesBefore: number;
  reminderStatus: "pending" | "sent" | "not_needed";
}
interface MessageRow {
  id: string;
  threadId: string;
  senderId: string;
  kind: string;
  meetingId: string | null;
}

let seq = 0;

function createStub(seed: {
  meetings: MeetingRow[];
  participants?: Array<{ threadId: string; userId: string }>;
  users?: Array<{ id: string; username: string }>;
}) {
  const meetings = [...seed.meetings];
  const participants = [...(seed.participants ?? [])];
  const users = [...(seed.users ?? [])];
  const messages: MessageRow[] = [];
  const threadBumps: string[] = [];

  const models = {
    meetings,
    messages,
    threadBumps,
    teamChatMeeting: {
      findMany: vi.fn(
        async (args: {
          where: {
            status: string;
            reminderStatus: string;
            startsAt: { lte: Date };
          };
        }) =>
          meetings.filter(
            (m) =>
              m.status === args.where.status &&
              m.reminderStatus === args.where.reminderStatus &&
              m.startsAt.getTime() <= args.where.startsAt.lte.getTime(),
          ),
      ),
      updateMany: vi.fn(
        async (args: {
          where: { id: string; reminderStatus?: string; status?: string };
          data: Partial<MeetingRow>;
        }) => {
          let count = 0;
          for (const m of meetings) {
            if (m.id !== args.where.id) continue;
            if (
              args.where.reminderStatus !== undefined &&
              m.reminderStatus !== args.where.reminderStatus
            )
              continue;
            if (args.where.status !== undefined && m.status !== args.where.status)
              continue;
            Object.assign(m, args.data);
            count++;
          }
          return { count };
        },
      ),
    },
    teamChatMessage: {
      create: vi.fn(
        async (args: {
          data: { threadId: string; senderId: string; kind: string; meetingId: string };
        }) => {
          const row: MessageRow = { id: `msg-${++seq}`, ...args.data };
          messages.push(row);
          return row;
        },
      ),
    },
    teamChatThread: {
      update: vi.fn(async (args: { where: { id: string } }) => {
        threadBumps.push(args.where.id);
        return { id: args.where.id };
      }),
    },
    teamChatParticipant: {
      findMany: vi.fn(async (args: { where: { threadId: string } }) =>
        participants.filter((p) => p.threadId === args.where.threadId),
      ),
    },
    user: {
      findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) =>
        users.filter((u) => args.where.id.in.includes(u.id)),
      ),
    },
  };
  // Attached after construction so the object isn't self-referential in
  // its own initializer (TS7022).
  const stub = {
    ...models,
    $transaction: vi.fn(
      async (fn: (tx: typeof models) => Promise<unknown>) => fn(models),
    ),
  };
  return stub;
}

const ORGANIZER = { id: "uuid-alice", username: "alice" };
const INVITEE = { id: "uuid-bob", username: "bob" };

function meeting(over: Partial<MeetingRow> = {}): MeetingRow {
  return {
    id: over.id ?? `meeting-${++seq}`,
    threadId: over.threadId ?? "thread-1",
    title: over.title ?? "Sprint sync",
    // Due by default: starts in 10 min with a 15-min reminder window.
    startsAt: over.startsAt ?? new Date(Date.now() + 10 * 60_000),
    createdById: over.createdById ?? ORGANIZER.id,
    status: over.status ?? "scheduled",
    reminderMinutesBefore: over.reminderMinutesBefore ?? 15,
    reminderStatus: over.reminderStatus ?? "pending",
  };
}

function baseStub(m: MeetingRow[]) {
  return createStub({
    meetings: m,
    participants: [
      { threadId: "thread-1", userId: ORGANIZER.id },
      { threadId: "thread-1", userId: INVITEE.id },
    ],
    users: [ORGANIZER, INVITEE],
  });
}

beforeEach(() => {
  sendNotificationMock.mockClear();
});

describe("runTeamChatMeetingReminderSweep", () => {
  it("posts ONE meeting_reminder card (organizer-sent), flips pending→sent, bumps the thread", async () => {
    const m = meeting();
    const prisma = baseStub([m]);
    const result = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(result).toEqual({ remindersSent: 1, markedNotNeeded: 0 });
    expect(prisma.messages).toHaveLength(1);
    expect(prisma.messages[0]).toMatchObject({
      threadId: "thread-1",
      senderId: ORGANIZER.id,
      kind: "meeting_reminder",
      meetingId: m.id,
    });
    expect(prisma.meetings[0].reminderStatus).toBe("sent");
    expect(prisma.threadBumps).toEqual(["thread-1"]);
  });

  it("notifies every participant EXCEPT the organizer, keyed by USERNAME", async () => {
    const prisma = baseStub([meeting()]);
    await runTeamChatMeetingReminderSweep(prisma as never);

    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    expect(sendNotificationMock).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        userId: INVITEE.username,
        kind: "event",
        title: "Meeting reminder",
        body: expect.stringContaining("Sprint sync"),
      }),
    );
  });

  it("is exactly-once: a second sweep run posts nothing more", async () => {
    const prisma = baseStub([meeting()]);
    await runTeamChatMeetingReminderSweep(prisma as never);
    const second = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(second).toEqual({ remindersSent: 0, markedNotNeeded: 0 });
    expect(prisma.messages).toHaveLength(1);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("leaves not-yet-due meetings untouched", async () => {
    // Starts in 2h with a 15-min window — due at T-15min, far away.
    const prisma = baseStub([
      meeting({ startsAt: new Date(Date.now() + 2 * 60 * 60_000) }),
    ]);
    const result = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(result).toEqual({ remindersSent: 0, markedNotNeeded: 0 });
    expect(prisma.messages).toHaveLength(0);
    expect(prisma.meetings[0].reminderStatus).toBe("pending");
  });

  it("marks meetings already started past the grace window not_needed — explicitly, no message", async () => {
    const prisma = baseStub([
      meeting({ startsAt: new Date(Date.now() - 10 * 60_000) }),
    ]);
    const result = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(result).toEqual({ remindersSent: 0, markedNotNeeded: 1 });
    expect(prisma.messages).toHaveLength(0);
    expect(prisma.meetings[0].reminderStatus).toBe("not_needed");
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("still reminds a meeting that started moments ago (inside the grace window)", async () => {
    const prisma = baseStub([
      meeting({ startsAt: new Date(Date.now() - 2 * 60_000) }),
    ]);
    const result = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(result.remindersSent).toBe(1);
    expect(prisma.messages).toHaveLength(1);
  });

  it("a notification failure is contained — the reminder still counts and nothing throws", async () => {
    sendNotificationMock.mockRejectedValueOnce(new Error("mqtt down"));
    const prisma = baseStub([meeting()]);
    const result = await runTeamChatMeetingReminderSweep(prisma as never);

    expect(result.remindersSent).toBe(1);
    expect(prisma.meetings[0].reminderStatus).toBe("sent");
  });
});
