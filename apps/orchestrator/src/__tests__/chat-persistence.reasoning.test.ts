/**
 * WARP-458 — ChatPersistenceService coverage for the new `reasoning`
 * argument on `finalizeAssistantMessage` + the `reasoning` field on
 * `getConversationForUser`'s message rows.
 *
 * These are pure persistence-layer tests using mocked Prisma — they
 * verify the SQL contract the service exposes to the route layer
 * without spinning up a real Postgres. The integration test against
 * the live route is in `llm-agent.reasoning-flag-route.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChatPersistenceService } from "../services/chat-persistence.service.js";

interface MockTx {
  chatMessage: {
    update: ReturnType<typeof vi.fn>;
  };
  chatSession: {
    update: ReturnType<typeof vi.fn>;
  };
}

function makePrismaMock(): {
  prisma: { $transaction: ReturnType<typeof vi.fn>; chatSession: { findFirst: ReturnType<typeof vi.fn> } };
  tx: MockTx;
} {
  const tx: MockTx = {
    chatMessage: { update: vi.fn().mockResolvedValue({}) },
    chatSession: { update: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi
      .fn()
      .mockImplementation(async (cb: (t: MockTx) => Promise<unknown>) => cb(tx)),
    chatSession: { findFirst: vi.fn() },
  };
  return { prisma, tx };
}

describe("ChatPersistenceService.finalizeAssistantMessage — WARP-458 reasoning", () => {
  let prisma: ReturnType<typeof makePrismaMock>["prisma"];
  let tx: MockTx;
  let svc: ChatPersistenceService;

  beforeEach(() => {
    const m = makePrismaMock();
    prisma = m.prisma;
    tx = m.tx;
    // Cast through unknown — the service expects a full PrismaClient,
    // we're providing only the surface it actually uses.
    svc = new ChatPersistenceService(prisma as unknown as never);
  });

  it("writes the reasoning column verbatim when a string is supplied", async () => {
    await svc.finalizeAssistantMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "Paris.",
      toolCalls: [],
      status: "completed",
      reasoning: "Step 1\n\nStep 2",
    });
    expect(tx.chatMessage.update).toHaveBeenCalledTimes(1);
    const args = tx.chatMessage.update.mock.calls[0][0];
    expect(args.where).toEqual({ id: "msg-1" });
    expect(args.data.reasoning).toBe("Step 1\n\nStep 2");
    expect(args.data.content).toBe("Paris.");
    expect(args.data.status).toBe("completed");
  });

  it("clears the reasoning column when null is supplied (retried turn)", async () => {
    await svc.finalizeAssistantMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "Paris.",
      toolCalls: [],
      status: "completed",
      reasoning: null,
    });
    const args = tx.chatMessage.update.mock.calls[0][0];
    expect(args.data.reasoning).toBeNull();
  });

  it("leaves the reasoning column UNTOUCHED when undefined is supplied", async () => {
    // `undefined` is the route layer's signal that this is the
    // legacy path (pre-WARP-458 caller that doesn't know about the
    // field). The update should not include a `reasoning` key at all,
    // so Prisma leaves the existing column value alone.
    await svc.finalizeAssistantMessage({
      conversationId: "conv-1",
      messageId: "msg-1",
      content: "Paris.",
      toolCalls: [],
      status: "completed",
      // reasoning intentionally omitted
    });
    const args = tx.chatMessage.update.mock.calls[0][0];
    expect("reasoning" in args.data).toBe(false);
  });
});

describe("ChatPersistenceService.getConversationForUser — WARP-458 reasoning", () => {
  it("surfaces the reasoning column on rehydrated assistant messages", async () => {
    const { prisma } = makePrismaMock();
    prisma.chatSession.findFirst.mockResolvedValue({
      id: "conv-1",
      title: "test",
      model: "ollama/qwen3",
      provider: null,
      createdAt: new Date("2026-05-27T00:00:00Z"),
      updatedAt: new Date("2026-05-27T00:00:01Z"),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "capital of france",
          toolCalls: null,
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: new Date("2026-05-27T00:00:00.500Z"),
          reasoning: null,
        },
        {
          id: "m2",
          role: "assistant",
          content: "Paris.",
          toolCalls: null,
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: new Date("2026-05-27T00:00:01Z"),
          reasoning: "Reasoned about French geography.",
        },
      ],
    });
    const svc = new ChatPersistenceService(prisma as unknown as never);
    const detail = await svc.getConversationForUser("conv-1", "alice");
    expect(detail).not.toBeNull();
    expect(detail!.messages).toHaveLength(2);
    expect(detail!.messages[0].reasoning).toBeNull();
    expect(detail!.messages[1].reasoning).toBe(
      "Reasoned about French geography.",
    );
  });

  it("normalises missing/undefined reasoning column to null", async () => {
    // Defensive: pre-WARP-458 rows in the DB will have `reasoning =
    // null` after the ADD COLUMN migration. A row read in the rare
    // case where Prisma omits the column entirely (corrupt cache,
    // partial select) should still surface as `null` not `undefined`.
    const { prisma } = makePrismaMock();
    prisma.chatSession.findFirst.mockResolvedValue({
      id: "conv-1",
      title: null,
      model: null,
      provider: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      messages: [
        {
          id: "m1",
          role: "assistant",
          content: "ok",
          toolCalls: null,
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: new Date(),
          // reasoning omitted (simulate missing-from-result-set)
        },
      ],
    });
    const svc = new ChatPersistenceService(prisma as unknown as never);
    const detail = await svc.getConversationForUser("conv-1", "alice");
    expect(detail!.messages[0].reasoning).toBeNull();
  });
});
