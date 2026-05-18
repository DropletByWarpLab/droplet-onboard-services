import { describe, it, expect, vi } from "vitest";
import type { ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";

// We deliberately test the wiring logic as a small pure helper so we
// don't have to stand up the entire useChat hook (which depends on
// WebSocket + fetch + AbortController). Extract the helper out of
// useChat.ts as `notifyHistoryOfTurnCompleted(handle, id)`.

import { notifyHistoryOfTurnCompleted, notifyHistoryOfNewConversation } from "./useChat";

describe("useChat → ChatHistoryPanel wiring", () => {
  it("notifyHistoryOfNewConversation calls optimisticInsert with a derived title", () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    notifyHistoryOfNewConversation(handle, {
      id: "new-id",
      firstUserContent: "  Why doesn't the chat history show?  ",
    });
    expect(handle.optimisticInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "new-id",
        title: "Why doesn't the chat history show?",
      }),
    );
  });

  it("notifyHistoryOfNewConversation clamps the optimistic title to 64 chars", () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    notifyHistoryOfNewConversation(handle, {
      id: "new-id",
      firstUserContent: "x".repeat(200),
    });
    const call = (handle.optimisticInsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.title.length).toBeLessThanOrEqual(64);
  });

  it("notifyHistoryOfTurnCompleted calls applyTurnCompleted", async () => {
    const handle: ChatHistoryPanelHandle = {
      optimisticInsert: vi.fn(),
      applyTurnCompleted: vi.fn().mockResolvedValue(undefined),
    };
    await notifyHistoryOfTurnCompleted(handle, "abc");
    expect(handle.applyTurnCompleted).toHaveBeenCalledWith("abc");
  });

  it("both helpers no-op when handle is null", async () => {
    expect(() =>
      notifyHistoryOfNewConversation(null, { id: "x", firstUserContent: "y" }),
    ).not.toThrow();
    await expect(notifyHistoryOfTurnCompleted(null, "x")).resolves.toBeUndefined();
  });
});
