/**
 * WARP-1685 — `team_chat_send_message` unit lane.
 *
 * Two-phase contract (the share_file posture, NOT email_send's weaker
 * route-side gate): phase 1 (no `confirmed`) validates fully, makes ZERO
 * HTTP calls, and returns confirmation_required with a preview the chat
 * surface relays for approval; phase 2 (`confirmed: true`) resolves
 * recipients through the roster, creates/dedupes the thread, and posts —
 * every call carrying X-Droplet-User = ctx.userId so the orchestrator
 * attributes the message to the acting human, never `_service:mcp`.
 */
import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import sendMessage from "../../../src/handlers/team-chat/send-message.js";
import emailSend from "../../../src/handlers/email/send.js";
import emailDraftReply from "../../../src/handlers/email/draft-reply.js";
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

describe("team_chat_send_message", () => {
  it("is registered as a write tool that requires confirmation", () => {
    expect(sendMessage.name).toBe("team_chat_send_message");
    expect(sendMessage.requiresWrite).toBe(true);
    expect(sendMessage.requiresConfirmation).toBe(true);
  });

  it("fails closed without an acting user — zero HTTP", async () => {
    const { ctx, get, post } = ctxWith({ userId: undefined });
    const r = await sendMessage.handler({ recipients: ["bob"], body: "hi" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("AUTH_REQUIRED");
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("requires exactly ONE of recipients / thread_id", async () => {
    const { ctx } = ctxWith({});
    const both = await sendMessage.handler(
      { recipients: ["bob"], thread_id: "t1", body: "hi" },
      ctx,
    );
    expect(both.ok).toBe(false);
    if (both.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(both)}`);
    expect(both.error?.code).toBe("INVALID_ARGS");

    const neither = await sendMessage.handler({ body: "hi" }, ctx);
    expect(neither.ok).toBe(false);
    if (neither.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(neither)}`);
    expect(neither.error?.code).toBe("INVALID_ARGS");
  });

  it("validates the body (1-4000 chars after trim) before anything else", async () => {
    const { ctx, get } = ctxWith({});
    const empty = await sendMessage.handler({ recipients: ["bob"], body: "   " }, ctx);
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(empty)}`);
    expect(empty.error?.code).toBe("INVALID_ARGS");

    const long = await sendMessage.handler(
      { recipients: ["bob"], body: "x".repeat(4001) },
      ctx,
    );
    expect(long.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });

  it("refuses a recipients list that names only the sender", async () => {
    const { ctx } = ctxWith({});
    const r = await sendMessage.handler({ recipients: ["alice"], body: "hi me" }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("INVALID_ARGS");
  });

  it("phase 1: confirmation_required with DISPLAY NAMES + truncated body — roster read only, NO writes", async () => {
    const { ctx, get, post } = ctxWith({});
    const body = "a".repeat(200);
    const r = await sendMessage.handler({ recipients: ["bob", "carol"], body }, ctx);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    // UX review: the approval copy names people, not login handles.
    expect(r.error?.message).toContain("Bob B");
    expect(r.error?.message).toContain("Carol C");
    expect(r.error?.message).not.toContain(body); // truncated, never verbatim-long
    expect(get).toHaveBeenCalledTimes(1); // the preview's roster read
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 1 falls back to usernames when the roster read fails — still no writes", async () => {
    const get = vi.fn(async () => res(500, {}));
    const { ctx, post } = ctxWith({ get });
    const r = await sendMessage.handler({ recipients: ["bob"], body: "hi" }, ctx);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.status).toBe("confirmation_required");
    expect(r.error?.message).toContain("bob");
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 2 (recipients): resolves the roster, creates a direct thread, posts as the acting user", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(201, { thread: { id: "thread-9" } }))
      .mockResolvedValueOnce(
        res(201, { message: { id: "msg-1", threadId: "thread-9" } }),
      );
    const { ctx, get } = ctxWith({ post });

    const r = await sendMessage.handler(
      { recipients: ["bob"], body: "lunch?", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(r.data).toMatchObject({
      type: "team_chat_send_message",
      threadId: "thread-9",
      messageId: "msg-1",
    });

    // Roster read + both writes carry the acting-user header.
    expect(get).toHaveBeenCalledWith(
      "/api/team-chat/contacts",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Droplet-User": "alice" }),
      }),
    );
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
      "/api/team-chat/threads/thread-9/messages",
      { kind: "text", body: "lunch?" },
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Droplet-User": "alice" }),
      }),
    );
  });

  it("phase 2: two or more recipients create a group thread", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(201, { thread: { id: "thread-g" } }))
      .mockResolvedValueOnce(res(201, { message: { id: "msg-2", threadId: "thread-g" } }));
    const { ctx } = ctxWith({ post });

    const r = await sendMessage.handler(
      { recipients: ["bob", "carol"], body: "standup?", confirmed: true },
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

  it("phase 2: an unknown recipient fails loudly BEFORE any thread is created", async () => {
    const post = vi.fn();
    const { ctx } = ctxWith({ post });
    const r = await sendMessage.handler(
      { recipients: ["nobody"], body: "hi", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("UNKNOWN_RECIPIENT");
    expect(r.error?.message).toContain("nobody");
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 2: an external guest's names-only roster returns the real rule, not UNKNOWN_RECIPIENT (WARP-3263)", async () => {
    const get = vi.fn(async () =>
      res(200, {
        contacts: [{ id: "uuid-bob", displayName: "Bob B" }],
        me: { id: "uuid-carol" },
        canStartConversation: false,
      }),
    );
    const post = vi.fn();
    const { ctx } = ctxWith({ get, post, userId: "carol" });
    const r = await sendMessage.handler(
      { recipients: ["bob"], body: "hi", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("GUEST_CANNOT_START_CONVERSATION");
    expect(post).not.toHaveBeenCalled();
  });

  it("phase 2: the thread route's guest 403 maps to the typed error, not TEAM_CHAT_SEND_FAILED", async () => {
    const post = vi.fn(async () => res(403, { error: "guest_cannot_start_conversation" }));
    const { ctx } = ctxWith({ post });
    const r = await sendMessage.handler(
      { recipients: ["bob"], body: "hi", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("GUEST_CANNOT_START_CONVERSATION");
  });

  it("phase 2 (thread_id): posts straight to the thread — no roster read", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce(res(201, { message: { id: "msg-3", threadId: "t-77" } }));
    const { ctx, get } = ctxWith({ post });

    const r = await sendMessage.handler(
      { thread_id: "t-77", body: "on my way", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/api/team-chat/threads/t-77/messages",
      { kind: "text", body: "on my way" },
      expect.anything(),
    );
  });

  it("surfaces the orchestrator's 404 (foreign thread / module off) as NOT_FOUND", async () => {
    const post = vi.fn().mockResolvedValueOnce(res(404, { error: "thread_not_found" }));
    const { ctx } = ctxWith({ post });
    const r = await sendMessage.handler(
      { thread_id: "not-mine", body: "hi", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("NOT_FOUND");
  });

  it("surfaces other HTTP failures with the status", async () => {
    const post = vi.fn().mockResolvedValueOnce(res(500, {}));
    const { ctx } = ctxWith({ post });
    const r = await sendMessage.handler(
      { thread_id: "t-77", body: "hi", confirmed: true },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
    expect(r.error?.message).toContain("500");
  });

  it("a malformed 2xx (unparseable or message-less body) returns the typed failure, never throws", async () => {
    // Body that fails to parse at all…
    const badJson = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const { ctx: ctx1 } = ctxWith({ post: badJson });
    const r1 = await sendMessage.handler(
      { thread_id: "t-77", body: "hi", confirmed: true },
      ctx1,
    );
    expect(r1.ok).toBe(false);
    if (r1.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r1)}`);
    expect(r1.error?.code).toBe("TEAM_CHAT_SEND_FAILED");

    // …and a parseable body missing the message envelope.
    const emptyBody = vi.fn().mockResolvedValueOnce(res(201, {}));
    const { ctx: ctx2 } = ctxWith({ post: emptyBody });
    const r2 = await sendMessage.handler(
      { thread_id: "t-77", body: "hi", confirmed: true },
      ctx2,
    );
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r2)}`);
    expect(r2.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
  });
});

// WARP-3196 — the sender is dropped from `recipients` by the User.id the
// roster names as `me`, on both MCP transports. ctx.userId is User.username
// on stdio and User.id over HTTP (services/mcp-server/src/context.ts
// `claims.sub`), so a recipient username compared with it only ever matched
// on stdio. Over HTTP "[bob, me]" went out as a two-person group (the
// orchestrator drops me.id → 400 group_requires_two_participants) and "[me]"
// skipped the self-only guard. The fixture's User.id differs from the
// username, as on a real box.
const SENDER_NAMINGS = [
  { transport: "stdio", userId: "alice" },
  { transport: "HTTP", userId: "uuid-alice" },
] as const;

describe.each(SENDER_NAMINGS)(
  "team_chat_send_message — the sender named $userId ($transport)",
  ({ userId }) => {
    const created = (threadId: string) =>
      vi
        .fn()
        .mockResolvedValueOnce(res(201, { thread: { id: threadId } }))
        .mockResolvedValueOnce(res(201, { message: { id: "msg-s", threadId } }));

    it("[bob, me] is a DIRECT message to Bob", async () => {
      const post = created("thread-dm");
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMessage.handler(
        { recipients: ["bob", "alice"], body: "lunch?", confirmed: true },
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

    it("[bob, carol, me] is a group of Bob and Carol", async () => {
      const post = created("thread-g");
      const { ctx } = ctxWith({ post, userId });
      const r = await sendMessage.handler(
        { recipients: ["alice", "bob", "carol"], body: "standup?", confirmed: true },
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
      const r = await sendMessage.handler(
        { recipients: ["alice"], body: "note to self", confirmed: true },
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
      const r = await sendMessage.handler({ recipients: ["alice"], body: "note to self" }, ctx);
      if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
      expect(r.status).not.toBe("confirmation_required");
      expect(r.error?.code).toBe("INVALID_ARGS");
      expect(post).not.toHaveBeenCalled();
    });

    it("the approval preview does not name the sender", async () => {
      const { ctx, post } = ctxWith({ userId });
      const r = await sendMessage.handler({ recipients: ["bob", "alice"], body: "lunch?" }, ctx);
      if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
      expect(r.status).toBe("confirmation_required");
      expect(r.error?.message).toContain("Bob B");
      expect(r.error?.message).not.toContain("Alice A");
      expect(r.error?.details).toMatchObject({ recipients: ["bob"] });
      expect(post).not.toHaveBeenCalled();
    });
  },
);

describe("team_chat_send_message — a roster that does not say who is asking", () => {
  it.each([
    ["no me", { contacts: CONTACTS.contacts }],
    ["me without an id", { me: {}, contacts: CONTACTS.contacts }],
    ["an empty id", { me: { id: "" }, contacts: CONTACTS.contacts }],
  ])("%s: phase 2 fails closed with no write", async (_label, roster) => {
    const post = vi.fn();
    const { ctx } = ctxWith({ get: vi.fn(async () => res(200, roster)), post });
    const r = await sendMessage.handler(
      { recipients: ["bob"], body: "hi", confirmed: true },
      ctx,
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
    expect(post).not.toHaveBeenCalled();
  });
});

/**
 * WARP-3340 — Romain, 2026-09-29: "team chat default unless specified by the
 * user". The descriptions are what the model reads when both channels are
 * advertised (agent-loop eval seed-028 drafted and sent an email instead), so
 * each side of the choice says it. Key phrases only, so a rewording keeps
 * these green. MUTATION: drop any one clause and its assertion goes red.
 */
describe("WARP-3340 — team chat is the default channel, email only when asked", () => {
  it("team_chat_send_message is the default and takes usernames or work addresses (WARP-3349)", () => {
    expect(sendMessage.description).toContain("use email only when the user asks for email");
    expect(sendMessage.description).toContain("member usernames or their work email addresses");
    expect(sendMessage.description).toContain("never guess one from a job title");
    const recipients = (sendMessage.inputSchema as { properties: { recipients: { description: string } } })
      .properties.recipients;
    expect(recipients.description).toContain("usernames or their work email addresses");
  });

  it.each([emailSend, emailDraftReply])("$name is for a request for email, which a thread reply is", (tool) => {
    expect(tool.description).toContain("Only when the user asks for email");
    expect(tool.description).toContain("replying to an email thread counts as asking for email");
    expect(tool.description).toContain("team chat is the default");
  });
});

/**
 * WARP-3349 — "message dave@company.com" reaches Dave over team chat. The
 * roster carries no email (User.email is encrypted at rest), so an address
 * is looked up by the orchestrator and replaced by the member's username;
 * an address that is no member's is refused BEFORE the person is asked to
 * approve (`precheck`, which the mcp-server runs ahead of the interceptor's
 * challenge), with the email suggestion. The fake answers the lookup the way
 * the route does: trim + lowercase, members only, one row or null per
 * address, in order.
 */
describe("WARP-3349 — a recipient given by work email address", () => {
  const DAVE = { id: "uuid-dave", displayName: "Dave Ortiz", username: "dave" };
  const ROSTER = { ...CONTACTS, contacts: [...CONTACTS.contacts, { ...DAVE, role: "family" }] };
  const DIRECTORY: Record<string, typeof DAVE> = { "dave@example.com": DAVE };
  const GUEST_ADDRESS = "carol@partner.example";

  function errorOf(r: ToolResult | null) {
    if (!r || r.ok) throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
    return r.error;
  }

  function world(roster: unknown = ROSTER, lookup?: (emails: string[]) => FakeResponse) {
    const lookups: string[][] = [];
    const writes: Array<{ path: string; body: unknown }> = [];
    const get = vi.fn(async () => res(200, roster));
    const post = vi.fn(async (path: string, body: { emails?: string[] }) => {
      if (path === "/api/team-chat/contacts/lookup") {
        const emails = body.emails ?? [];
        lookups.push(emails);
        return lookup
          ? lookup(emails)
          : res(200, {
              contacts: emails.map((e) => {
                const key = e.trim().toLowerCase();
                return DIRECTORY[key] ?? (key === GUEST_ADDRESS ? { guest: true } : null);
              }),
            });
      }
      writes.push({ path, body });
      return path === "/api/team-chat/threads"
        ? res(201, { thread: { id: "thread-d" } })
        : res(201, { message: { id: "msg-d", threadId: "thread-d" } });
    });
    const { ctx } = ctxWith({ get, post });
    return { ctx, post, lookups, writes };
  }

  it("an address resolves to its member: a direct thread with them, sent as the acting user", async () => {
    const w = world();
    const r = await sendMessage.handler(
      { recipients: ["dave@example.com"], body: "Server maintenance tonight at 10pm", confirmed: true },
      w.ctx,
    );
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(w.post).toHaveBeenCalledWith(
      "/api/team-chat/contacts/lookup",
      { emails: ["dave@example.com"] },
      expect.objectContaining({ headers: expect.objectContaining({ "X-Droplet-User": "alice" }) }),
    );
    expect(w.writes[0]).toEqual({
      path: "/api/team-chat/threads",
      body: { kind: "direct", participantIds: ["uuid-dave"] },
    });
    expect(r.data).toMatchObject({ recipients: ["dave"] });
  });

  // The person approves the interceptor's card (argument shapes only), not
  // this handler's text, so what matters before approval is only whether
  // precheck lets the call through.
  it("precheck resolves a member's address and lets the call through to the approval, writing nothing", async () => {
    const w = world();
    expect(await sendMessage.precheck!({ recipients: ["dave@example.com"], body: "hi" }, w.ctx)).toBeNull();
    expect(w.lookups).toEqual([["dave@example.com"]]);
    expect(w.writes).toEqual([]);
  });

  it("an address that is no member's is refused before approval, with the email suggestion", async () => {
    const w = world();
    const early = await sendMessage.precheck!({ recipients: ["stranger@example.com"], body: "hi" }, w.ctx);
    expect(early).toEqual({
      ok: false,
      status: "error",
      error: {
        code: "RECIPIENT_NOT_A_MEMBER",
        message:
          "stranger@example.com isn't a member of this Workspace; team chat only reaches members — ask the user whether to email them instead.",
      },
    });
    expect(w.writes).toEqual([]);
  });

  it("a guest's address is refused truthfully: guests are reached by username only", async () => {
    const w = world();
    const early = await sendMessage.precheck!({ recipients: [GUEST_ADDRESS], body: "hi" }, w.ctx);
    expect(errorOf(early)).toEqual({
      code: "RECIPIENT_IS_GUEST",
      message:
        "carol@partner.example is an external guest in this Workspace; team chat reaches guests by username only — ask the user for the username, or whether to email them instead.",
    });
    expect(w.writes).toEqual([]);
  });

  it.each([
    ["no local part", "@bob"],
    ["no domain dot", "bob@localhost"],
    ["over the 320-character limit", `${"a".repeat(310)}@example.com`],
  ])("a value not shaped like an address (%s) is not looked up: UNKNOWN_RECIPIENT", async (_label, value) => {
    const w = world();
    const early = await sendMessage.precheck!({ recipients: [value], body: "hi" }, w.ctx);
    expect(errorOf(early).code).toBe("UNKNOWN_RECIPIENT");
    expect(w.lookups).toEqual([]);
  });

  it("Messages switched off (the roster's 404) is refused before approval, with no lookup", async () => {
    const post = vi.fn();
    const { ctx } = ctxWith({ get: vi.fn(async () => res(404, {})), post });
    const early = await sendMessage.precheck!({ recipients: ["dave@example.com"], body: "hi" }, ctx);
    expect(errorOf(early).code).toBe("TEAM_CHAT_UNAVAILABLE");
    expect(post).not.toHaveBeenCalled();
  });

  it("any other roster failure still lets the call through to the approval (phase 2 reads again)", async () => {
    const { ctx } = ctxWith({ get: vi.fn(async () => res(500, {})) });
    expect(await sendMessage.precheck!({ recipients: ["bob"], body: "hi" }, ctx)).toBeNull();
  });

  it("phase 2 refuses the same address, with no write", async () => {
    const w = world();
    const r = await sendMessage.handler(
      { recipients: ["stranger@example.com"], body: "hi", confirmed: true },
      w.ctx,
    );
    if (r.ok) throw new Error(`expected a failed ToolResult, got ${JSON.stringify(r)}`);
    expect(r.error?.code).toBe("RECIPIENT_NOT_A_MEMBER");
    expect(w.writes).toEqual([]);
  });

  it("an unknown username is refused before approval too", async () => {
    const w = world();
    const early = await sendMessage.precheck!({ recipients: ["nobody"], body: "hi" }, w.ctx);
    expect(errorOf(early).code).toBe("UNKNOWN_RECIPIENT");
    expect(w.lookups).toEqual([]);
  });

  it("usernames are unchanged: no lookup", async () => {
    const w = world();
    const r = await sendMessage.handler({ recipients: ["bob"], body: "hi", confirmed: true }, w.ctx);
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual([]);
    expect(w.writes[0]?.body).toEqual({ kind: "direct", participantIds: ["uuid-bob"] });
  });

  it("a roster username wins over the address reading, even one containing @", async () => {
    const w = world({
      ...ROSTER,
      contacts: [...ROSTER.contacts, { id: "uuid-legacy", displayName: "Old Account", username: "ops@legacy" }],
    });
    const r = await sendMessage.handler({ recipients: ["ops@legacy"], body: "hi", confirmed: true }, w.ctx);
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual([]);
    expect(w.writes[0]?.body).toEqual({ kind: "direct", participantIds: ["uuid-legacy"] });
  });

  it("a mixed list: usernames stay, only the addresses are looked up, one group", async () => {
    const w = world();
    const r = await sendMessage.handler(
      { recipients: ["bob", "dave@example.com"], body: "standup?", confirmed: true },
      w.ctx,
    );
    expect(r.ok).toBe(true);
    expect(w.lookups).toEqual([["dave@example.com"]]);
    expect(w.writes[0]?.body).toEqual({ kind: "group", participantIds: ["uuid-bob", "uuid-dave"] });
  });

  it("one person named by username and by address (any case) is messaged once, directly", async () => {
    const w = world();
    const r = await sendMessage.handler(
      { recipients: ["dave", "Dave@Example.COM"], body: "hi", confirmed: true },
      w.ctx,
    );
    if (!r.ok) throw new Error(`expected a successful ToolResult, got ${JSON.stringify(r)}`);
    expect(w.lookups).toEqual([["Dave@Example.COM"]]);
    expect(w.writes[0]?.body).toEqual({ kind: "direct", participantIds: ["uuid-dave"] });
    expect(r.data).toMatchObject({ recipients: ["dave"] });
  });

  it("a mixed list with one outsider is refused whole, naming only the outsider", async () => {
    const w = world();
    const early = await sendMessage.precheck!(
      { recipients: ["bob", "dave@example.com", "x@other.org"], body: "hi" },
      w.ctx,
    );
    expect(errorOf(early).code).toBe("RECIPIENT_NOT_A_MEMBER");
    expect(errorOf(early).message).toMatch(/^x@other\.org isn't a member/);
    expect(errorOf(early).message).not.toContain("dave@example.com");
  });

  it("an external guest is never looked up for: they get the rule instead (WARP-3263)", async () => {
    const w = world({
      contacts: [{ id: "uuid-bob", displayName: "Bob B" }],
      me: { id: "uuid-carol" },
      canStartConversation: false,
    });
    const early = await sendMessage.precheck!({ recipients: ["bob@example.com"], body: "hi" }, w.ctx);
    expect(errorOf(early).code).toBe("GUEST_CANNOT_START_CONVERSATION");
    expect(w.post).not.toHaveBeenCalled();
  });

  it.each([
    ["the module is off", () => res(404, {}), "TEAM_CHAT_UNAVAILABLE"],
    ["a server error", () => res(500, {}), "TEAM_CHAT_SEND_FAILED"],
    ["a row count that does not match", () => res(200, { contacts: [] }), "TEAM_CHAT_SEND_FAILED"],
  ])("a lookup that fails (%s) is refused before approval", async (_label, answer, code) => {
    const w = world(ROSTER, answer);
    const early = await sendMessage.precheck!({ recipients: ["dave@example.com"], body: "hi" }, w.ctx);
    expect(errorOf(early).code).toBe(code);
  });

  it("precheck never writes, even when the model already set confirmed: true", async () => {
    const w = world();
    const early = await sendMessage.precheck!(
      { recipients: ["dave@example.com"], body: "hi", confirmed: true },
      w.ctx,
    );
    expect(early).toBeNull();
    expect(w.writes).toEqual([]);
  });

  it("precheck lets a thread_id send through to the approval, with no HTTP", async () => {
    const w = world();
    expect(await sendMessage.precheck!({ thread_id: "t-1", body: "hi" }, w.ctx)).toBeNull();
    expect(w.post).not.toHaveBeenCalled();
  });
});
