/**
 * WARP-1685 — `team_chat_send_meeting_invite` unit lane.
 *
 * Same two-phase contract as team_chat_send_message (share_file posture):
 * phase 1 validates fully (incl. the future-startsAt check, so the user
 * never approves a meeting the orchestrator would refuse) with reads only
 * (roster, address lookup) and ZERO writes;
 * phase 2 resolves recipients, creates/dedupes the thread, then creates
 * the meeting — everything as the forwarded acting user.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import sendMeetingInvite from "../../../src/handlers/team-chat/send-meeting-invite.js";
import type { ToolContext, ToolResult } from "../../../src/types.js";

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function res(status: number, body: unknown): FakeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// `me` is the person the orchestrator resolved from X-Droplet-User (WARP-3196).
const CONTACTS = {
  me: { id: "uuid-alice" },
  contacts: [
    { id: "uuid-alice", displayName: "Alice A", username: "alice", role: "family" },
    { id: "uuid-bob", displayName: "Bob B", username: "bob", role: "family" },
    { id: "uuid-carol", displayName: "Carol C", username: "carol", role: "guest" },
  ],
};

function ctxWith(overrides: {
  get?: Mock;
  post?: Mock;
  userId?: string | undefined;
}): { ctx: ToolContext; get: Mock; post: Mock } {
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
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
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
    if (garbage.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(garbage)}`);
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
    if (past.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(past)}`);
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
    if (longTitle.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(longTitle)}`);
    expect(longTitle.error?.code).toBe("INVALID_ARGS");
  });

  it("phase 1: confirmation_required carries title + DISPLAY NAME + readable local time — roster read only, NO writes", async () => {
    const { ctx, get, post } = ctxWith({});
    const startsAt = futureIso();
    const r = await sendMeetingInvite.handler(
      {
        recipients: ["bob"],
        title: "Budget review",
        starts_at: startsAt,
        duration_minutes: 30,
        location: "Kitchen",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.message).toContain("Budget review");
    // UX review: display name, not the login handle.
    expect(r.error?.message).toContain("Bob B");
    // UX review: readable local time in the copy — with the zone named
    // (code review: the container's TZ must be explicit) — never raw ISO.
    // Component options mirror the handler (ECMA-402 refuses
    // dateStyle/timeStyle combined with timeZoneName).
    const whenReadable = new Date(startsAt).toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
    expect(r.error?.message).toContain(whenReadable);
    expect(r.error?.message).not.toContain(startsAt);
    // ...while details keeps the machine-precise ISO for the approval chip.
    expect((r.error?.details as { startsAt: string }).startsAt).toBe(
      new Date(startsAt).toISOString(),
    );
    expect(get).toHaveBeenCalledTimes(1); // the preview's roster read
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 1 falls back to usernames when the roster read fails — still no writes", async () => {
    const get = vi.fn(async () => res(500, {}));
    const { ctx, post } = ctxWith({ get });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso() },
      ctx,
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.message).toContain("bob");
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 1 surfaces the model-composed NOTE (truncated) in message + details", async () => {
    // Code review: the note rides on the invite card — the user must see
    // it before approving, parity with send-message's body preview.
    const { ctx } = ctxWith({});
    const note = "n".repeat(300);
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso(), note },
      ctx,
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.message).toContain("Note on the invite:");
    expect(r.error?.message).not.toContain(note); // truncated, never verbatim-long
    const details = r.error?.details as { notePreview?: string };
    expect(details.notePreview).toBeDefined();
    expect(details.notePreview!.length).toBeLessThanOrEqual(120);
    expect(details.notePreview!.endsWith("…")).toBe(true);
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
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
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
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
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
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
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
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("NOT_FOUND");
  });

  it("a malformed 2xx meeting response returns the typed failure, never throws", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(200, { thread: { id: "thread-dm" } }))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: async () => {
          throw new Error("bad json");
        },
      });
    const { ctx } = ctxWith({ post });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso(), confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
  });
});

// WARP-3196 — the organizer is dropped from `recipients` by the User.id the
// roster names as `me`, on both MCP transports. ctx.userId is User.username
// on stdio and User.id over HTTP (services/mcp-server/src/context.ts
// `claims.sub`), so a recipient username compared with it only ever matched
// on stdio. The fixture's User.id differs from the username, as on a real box.
const ORGANIZER_NAMINGS = [
  { transport: "stdio", userId: "alice" },
  { transport: "HTTP", userId: "uuid-alice" },
] as const;

describe.each(ORGANIZER_NAMINGS)(
  "team_chat_send_meeting_invite — the organizer named $userId ($transport)",
  ({ userId }) => {
    const created = (threadId: string) =>
      vi
        .fn()
        .mockResolvedValueOnce(res(201, { thread: { id: threadId } }))
        .mockResolvedValueOnce(
          res(201, { meeting: { id: "meeting-s", threadId, title: "Sync" }, message: { id: "msg-s" } }),
        );

    it("[bob, me] invites Bob in a DIRECT thread", async () => {
      const post = created("thread-dm");
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMeetingInvite.handler(
        { recipients: ["bob", "alice"], title: "Sync", starts_at: futureIso(), confirmed: true },
        ctx,
      );
      if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
      expect(post).toHaveBeenNthCalledWith(
        1,
        "/api/team-chat/threads",
        { kind: "direct", participantIds: ["uuid-bob"] },
        expect.anything(),
      );
      expect(r.data).toMatchObject({ recipients: ["bob"] });
    });

    it("[bob, carol, me] invites Bob and Carol in a group", async () => {
      const post = created("thread-g");
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMeetingInvite.handler(
        { recipients: ["alice", "bob", "carol"], title: "Sync", starts_at: futureIso(), confirmed: true },
        ctx,
      );
      expect(r.ok).toBe(true);
      expect(post).toHaveBeenNthCalledWith(
        1,
        "/api/team-chat/threads",
        { kind: "group", participantIds: ["uuid-bob", "uuid-carol"] },
        expect.anything(),
      );
    });

    it("[me] alone is refused with no write — phase 2", async () => {
      const post = vi.fn();
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMeetingInvite.handler(
        { recipients: ["alice"], title: "Focus time", starts_at: futureIso(), confirmed: true },
        ctx,
      );
      if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
      expect(r.error?.code).toBe("INVALID_ARGS");
      expect(r.error?.message).toContain("someone other than yourself");
      expect(post).not.toHaveBeenCalled();
    });

    it("[me] alone is refused before the user is asked to approve — phase 1", async () => {
      const post = vi.fn();
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMeetingInvite.handler(
        { recipients: ["alice"], title: "Focus time", starts_at: futureIso() },
        ctx,
      );
      if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
      expect(r.status).not.toBe("confirmation_required");
      expect(r.error?.code).toBe("INVALID_ARGS");
      expect(post).not.toHaveBeenCalled();
    });

    it("the approval preview does not name the organizer", async () => {
      const { ctx, post } = ctxWith({ userId });
      const r = await sendMeetingInvite.handler(
        { recipients: ["bob", "alice"], title: "Sync", starts_at: futureIso() },
        ctx,
      );
      if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
      expect(r.status).toBe("confirmation_required");
      expect(r.error?.message).toContain("Bob B");
      expect(r.error?.message).not.toContain("Alice A");
      expect(r.error?.details).toMatchObject({ recipients: ["bob"] });
      expect(post).not.toHaveBeenCalled();
    });
  },
);

describe("team_chat_send_meeting_invite — a roster that does not say who is asking", () => {
  it.each([
    ["no me", { contacts: CONTACTS.contacts }],
    ["me without an id", { me: {}, contacts: CONTACTS.contacts }],
    ["an empty id", { me: { id: "" }, contacts: CONTACTS.contacts }],
  ])("%s: phase 2 fails closed with no write", async (_label, roster) => {
    const post = vi.fn();
    const { ctx } = ctxWith({ get: vi.fn(async () => res(200, roster)), post });
    const r = await sendMeetingInvite.handler(
      { recipients: ["bob"], title: "Sync", starts_at: futureIso(), confirmed: true },
      ctx,
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * WARP-3403 — "set up a meeting with dave@company.com" reaches Dave, the way
 * WARP-3349 made team_chat_send_message do: an address is looked up by the
 * orchestrator (shared `resolveTargets` in _roster.ts) and replaced by that
 * person's username, a member's or an external guest's (Romain,
 * 2026-09-30); an address that is nobody's in the Workspace is refused by
 * `precheck`, before the interceptor asks for approval. The fake answers the
 * lookup the way the route does: trim + lowercase, ACTIVE people only, one
 * row or null per address, in order.
 */
describe("WARP-3403 — a meeting invitee given by email address", () => {
  const DAVE = { id: "uuid-dave", displayName: "Dave Ortiz", username: "dave" };
  const CAROL = { id: "uuid-carol", displayName: "Carol C", username: "carol" };
  const ROSTER = { ...CONTACTS, contacts: [...CONTACTS.contacts, { ...DAVE, role: "family" }] };
  const DIRECTORY: Record<string, typeof DAVE> = {
    "dave@example.com": DAVE,
    "carol@partner.example": CAROL,
  };
  const invite = (recipients: string[], extra: Record<string, unknown> = {}) => ({
    recipients,
    title: "Planning",
    starts_at: futureIso(),
    ...extra,
  });

  function errorOf(r: ToolResult | null) {
    if (!r || r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    return r.error;
  }

  function world(roster: unknown = ROSTER) {
    const lookups: string[][] = [];
    const writes: Array<{ path: string; body: unknown }> = [];
    const get = vi.fn(async () => res(200, roster));
    const post = vi.fn(async (path: string, body: { emails?: string[] }) => {
      if (path === "/api/team-chat/contacts/lookup") {
        const emails = body.emails ?? [];
        lookups.push(emails);
        return res(200, { contacts: emails.map((e) => DIRECTORY[e.trim().toLowerCase()] ?? null) });
      }
      writes.push({ path, body });
      return path === "/api/team-chat/threads"
        ? res(201, { thread: { id: "thread-d" } })
        : res(201, { meeting: { id: "mtg-d", threadId: "thread-d" } });
    });
    const { ctx } = ctxWith({ get, post });
    return { ctx, post, lookups, writes };
  }

  it("says it takes usernames or email addresses of people in the Workspace", () => {
    expect(sendMeetingInvite.description).toContain("usernames or email addresses of people in this Workspace");
    const recipients = (sendMeetingInvite.inputSchema as { properties: { recipients: { description: string } } })
      .properties.recipients;
    expect(recipients.description).toContain(
      "Usernames or email addresses of people in this Workspace (members or external guests)",
    );
  });

  it.each([
    ["a member's", "Dave@Example.com", "uuid-dave", "dave"],
    ["an external guest's", "carol@partner.example", "uuid-carol", "carol"],
  ])("%s address resolves: the meeting is in a direct thread with them, as the acting user", async (_l, address, id, username) => {
    const w = world();
    const r = await sendMeetingInvite.handler(invite([address], { confirmed: true }), w.ctx);
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(w.post).toHaveBeenCalledWith(
      "/api/team-chat/contacts/lookup",
      { emails: [address] },
      expect.objectContaining({ headers: expect.objectContaining({ "X-Droplet-User": "alice" }) }),
    );
    expect(w.writes.map((x) => x.path)).toEqual([
      "/api/team-chat/threads",
      "/api/team-chat/threads/thread-d/meetings",
    ]);
    expect(w.writes[0]?.body).toEqual({ kind: "direct", participantIds: [id] });
    expect(r.data).toMatchObject({ recipients: [username] });
  });

  it("an address that is nobody's in the Workspace is refused by precheck, with the email suggestion and no write", async () => {
    const w = world();
    const early = await sendMeetingInvite.precheck!(invite(["stranger@example.com"]), w.ctx);
    expect(errorOf(early)).toEqual({
      code: "RECIPIENT_NOT_A_MEMBER",
      message:
        "stranger@example.com isn't in this Workspace; team chat only reaches people in it — ask the user whether to email them instead.",
    });
    expect(w.writes).toEqual([]);
  });

  it("the confirmed phase refuses the same address, with no write", async () => {
    const w = world();
    const r = await sendMeetingInvite.handler(invite(["stranger@example.com"], { confirmed: true }), w.ctx);
    expect(errorOf(r).code).toBe("RECIPIENT_NOT_A_MEMBER");
    expect(w.writes).toEqual([]);
  });

  it("an unknown username is refused before approval, with no lookup", async () => {
    const w = world();
    const early = await sendMeetingInvite.precheck!(invite(["nobody"]), w.ctx);
    expect(errorOf(early).code).toBe("UNKNOWN_RECIPIENT");
    expect(w.lookups).toEqual([]);
  });

  it("plain usernames are unchanged: no lookup", async () => {
    const w = world();
    const r = await sendMeetingInvite.handler(invite(["bob"], { confirmed: true }), w.ctx);
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual([]);
    expect(w.writes[0]?.body).toEqual({ kind: "direct", participantIds: ["uuid-bob"] });
  });

  it("a mixed list looks up only the addresses; one person named twice is invited once", async () => {
    const w = world();
    const r = await sendMeetingInvite.handler(
      invite(["bob", "dave", "DAVE@example.com"], { confirmed: true }),
      w.ctx,
    );
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual([["DAVE@example.com"]]);
    expect(w.writes[0]?.body).toEqual({ kind: "group", participantIds: ["uuid-bob", "uuid-dave"] });
  });

  it("an external guest caller is never looked up for: they get the rule instead (WARP-3263)", async () => {
    const w = world({
      contacts: [{ id: "uuid-bob", displayName: "Bob B" }],
      me: { id: "uuid-carol" },
      canStartConversation: false,
    });
    const early = await sendMeetingInvite.precheck!(invite(["bob@example.com"]), w.ctx);
    expect(errorOf(early).code).toBe("GUEST_CANNOT_START_CONVERSATION");
    expect(w.post).not.toHaveBeenCalled();
  });

  it("Messages switched off (the roster's 404) is refused before approval, with no lookup", async () => {
    const post = vi.fn();
    const { ctx } = ctxWith({ get: vi.fn(async () => res(404, {})), post });
    const early = await sendMeetingInvite.precheck!(invite(["dave@example.com"]), ctx);
    expect(errorOf(early).code).toBe("TEAM_CHAT_UNAVAILABLE");
    expect(post).not.toHaveBeenCalled();
  });

  it("a past start is refused by precheck before approval, with no HTTP", async () => {
    const w = world();
    const early = await sendMeetingInvite.precheck!(
      invite(["bob"], { starts_at: new Date(Date.now() - 60_000).toISOString() }),
      w.ctx,
    );
    expect(errorOf(early).code).toBe("INVALID_ARGS");
    expect(w.post).not.toHaveBeenCalled();
  });

  it("precheck lets a resolvable invite through to the approval and never writes, even with confirmed: true", async () => {
    const w = world();
    expect(await sendMeetingInvite.precheck!(invite(["dave@example.com"], { confirmed: true }), w.ctx)).toBeNull();
    expect(w.lookups).toEqual([["dave@example.com"]]);
    expect(w.writes).toEqual([]);
  });
});
