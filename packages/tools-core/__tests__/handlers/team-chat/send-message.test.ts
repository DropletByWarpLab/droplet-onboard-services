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
import sendMessage from "../../../src/handlers/team-chat/send-message.js";
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
    { id: "uuid-carol", displayName: "Carol C", username: "carol", role: "guest" },
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
    expect(both.error?.code).toBe("INVALID_ARGS");

    const neither = await sendMessage.handler({ body: "hi" }, ctx);
    expect(neither.ok).toBe(false);
    expect(neither.error?.code).toBe("INVALID_ARGS");
  });

  it("validates the body (1-4000 chars after trim) before anything else", async () => {
    const { ctx, get } = ctxWith({});
    const empty = await sendMessage.handler({ recipients: ["bob"], body: "   " }, ctx);
    expect(empty.ok).toBe(false);
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
    expect(r.error?.code).toBe("INVALID_ARGS");
  });

  it("phase 1: confirmation_required with DISPLAY NAMES + truncated body — roster read only, NO writes", async () => {
    const { ctx, get, post } = ctxWith({});
    const body = "a".repeat(200);
    const r = await sendMessage.handler({ recipients: ["bob", "carol"], body }, ctx);
    expect(r.ok).toBe(false);
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
    expect(r.error?.code).toBe("UNKNOWN_RECIPIENT");
    expect(r.error?.message).toContain("nobody");
    expect(post).not.toHaveBeenCalled();
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
    expect(r1.error?.code).toBe("TEAM_CHAT_SEND_FAILED");

    // …and a parseable body missing the message envelope.
    const emptyBody = vi.fn().mockResolvedValueOnce(res(201, {}));
    const { ctx: ctx2 } = ctxWith({ post: emptyBody });
    const r2 = await sendMessage.handler(
      { thread_id: "t-77", body: "hi", confirmed: true },
      ctx2,
    );
    expect(r2.ok).toBe(false);
    expect(r2.error?.code).toBe("TEAM_CHAT_SEND_FAILED");
  });
});
