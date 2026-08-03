/**
 * WARP-1685 — `team_chat_send_meeting_invite` unit lane.
 *
 * Same two-phase contract as team_chat_send_message (share_file posture):
 * phase 1 validates fully (incl. the future-startsAt check, so the user
 * never approves a meeting the orchestrator would refuse) with ZERO HTTP;
 * phase 2 resolves recipients, creates/dedupes the thread, then creates
 * the meeting — everything as the forwarded acting user.
 */
import { describe, it, expect, vi } from "vitest";
import sendMeetingInvite from "../../../src/handlers/team-chat/send-meeting-invite.js";
import type { ToolContext } from "../../../src/types.js";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function res(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const CONTACTS = {
  contacts: [
    { id: "uuid-alice", displayName: "Alice A", username: "alice", role: "family" },
    { id: "uuid-bob", displayName: "Bob B", username: "bob", role: "family" },
  ],
};

function ctxWith(overrides: {
  get?: ReturnType<typeof vi.fn>;
  post?: ReturnType<typeof vi.fn>;
  userId?: string | undefined;
}): { ctx: ToolContext; get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> } {
  const get = overrides.get ?? vi.fn(async () => res(200, CONTACTS));
  const post = overrides.post ?? vi.fn();
  const ctx = {
    prisma: {} as ToolContext["prisma"],
    http: { orchestrator: { get, post } } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: "userId" in overrides ? overrides.userId : "alice",
    signal: new AbortController().signal,
  } as ToolContext;
  return { ctx, get, post };
}

const futureIso = () => new Date(Date.now() + 60 * 60_000).toISOString();

describe("team_chat_send_meeting_invite", () => {
  it("is registered as a write tool that requires confirmation", () => {
    expect(sendMeetingInvite.name).toBe("team_chat_send_meeting_invite");
    expect(sendMeetingInvite.requiresWrite).toBe(true);
    expect(sendMeetingInvite.requiresConfirmation).toBe(true);
  });

  it("fails closed without an acting user", async () => {
    const { ctx, get } = ctxWith({ userId: undefined });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso() },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
  });

  it("rejects a garbage or past starts_at BEFORE asking for confirmation", async () => {
    const { ctx, get } = ctxWith({});
    const garbage = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: "whenever" },
      ctx,
    );
    expect(garbage.ok).toBe(false);
    expect(garbage.error?.code).toBe("INVALID_ARGS");

    const past = await sendMeetingInvite.handler(
      {
        recipients: ["bob"],
        title: "Sync",
        starts_at: new Date(Date.now() - 60_000).toISOString(),
      },
      ctx,
    );
    expect(past.ok).toBe(false);
    expect(past.error?.code).toBe("INVALID_ARGS");
    expect(past.status).not.toBe("confirmation_required");
    expect(get).not.toHaveBeenCalled();
  });

  it("requires recipients and a 1-200 char title", async () => {
    const { ctx } = ctxWith({});
    const none = await sendMeetingInvite.handler(
      { recipients: [], title: "Sync", starts_at: futureIso() },
      ctx,
    );
    expect(none.ok).toBe(false);

    const longTitle = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "x".repeat(201), starts_at: futureIso() },
      ctx,
    );
    expect(longTitle.ok).toBe(false);
    expect(longTitle.error?.code).toBe("INVALID_ARGS");
  });

  it("phase 1: confirmation_required carries title + recipients, ZERO HTTP", async () => {
    const { ctx, get, post } = ctxWith({});
    const r = await sendMeetingInvite.handler(
      {
        recipients: ["bob"],
        title: "Budget review",
        starts_at: futureIso(),
        duration_minutes: 30,
        location: "Kitchen",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.message).toContain("Budget review");
    expect(r.error?.message).toContain("bob");
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 2: resolves recipients, creates the thread, creates the meeting as the acting user", async () => {
    const startsAt = futureIso();
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(200, { thread: { id: "thread-dm" } })) // deduped
      .mockResolvedValueOnce(
        res(201, {
          meeting: { id: "meeting-1", threadId: "thread-dm", title: "Budget review", startsAt },
          message: { id: "msg-1" },
        }),
      );
    const { ctx } = ctxWith({ post });

    const r = await sendMeetingInvite.handler(
      {
        recipients: ["bob"],
        title: "Budget review",
        starts_at: startsAt,
        duration_minutes: 30,
        location: "Kitchen",
        note: "bring numbers",
        confirmed: true,
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({
      type: "team_chat_send_meeting_invite",
      meetingId: "meeting-1",
      threadId: "thread-dm",
      title: "Budget review",
    });
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/api/team-chat/threads",
      { kind: "direct", participantIds: ["uuid-bob"] },
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Droplet-User": "alice" }),
      }),
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/api/team-chat/threads/thread-dm/meetings",
      {
        title: "Budget review",
        startsAt,
        durationMinutes: 30,
        location: "Kitchen",
        note: "bring numbers",
      },
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Droplet-User": "alice" }),
      }),
    );
  });

  it("phase 2: unknown recipients fail loudly before any write", async () => {
    const post = vi.fn();
    const { ctx } = ctxWith({ post });
    const r = await sendMeetingInvite.handler(
      { recipients: ["ghost"], title: "Sync", starts_at: futureIso(), confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("UNKNOWN_RECIPIENT");
    expect(post).not.toHaveBeenCalled();
  });

  it("surfaces the orchestrator's 400 (e.g. startsAt slipped into the past) as INVALID_ARGS", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(200, { thread: { id: "thread-dm" } }))
      .mockResolvedValueOnce(res(400, { error: "starts_at_must_be_future" }));
    const { ctx } = ctxWith({ post });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso(), confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("INVALID_ARGS");
    expect(r.error?.message).toContain("starts_at_must_be_future");
  });

  it("surfaces the orchestrator's 404 as NOT_FOUND", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(200, { thread: { id: "thread-dm" } }))
      .mockResolvedValueOnce(res(404, { error: "thread_not_found" }));
    const { ctx } = ctxWith({ post });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso(), confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe("NOT_FOUND");
  });
});
