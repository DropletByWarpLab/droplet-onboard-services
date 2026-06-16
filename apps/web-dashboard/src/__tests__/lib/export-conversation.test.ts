/**
 * Markdown serialization for the chat-export action (history-row menu).
 * The DOM download glue is browser-API plumbing (same shape as
 * SessionHeader's zip export) — only the pure serializer is unit-tested.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  fetchConversation: vi.fn(),
}));

import { conversationToMarkdown } from "@/lib/export-conversation";
import type { PersistedConversation } from "@/lib/api";

function conv(
  overrides: Partial<PersistedConversation> = {},
): PersistedConversation {
  return {
    id: "conv-1",
    title: "Plan dinner",
    model: "llama3",
    provider: "ollama",
    createdAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:05:00.000Z",
    messages: [
      {
        id: "m1",
        role: "user",
        content: "What should we cook?",
        toolCalls: null,
        toolCallId: null,
        turnId: "t1",
        createdAt: "2026-06-01T10:00:00.000Z",
      },
      {
        id: "m2",
        role: "assistant",
        content: "How about pasta?",
        toolCalls: [{ id: "c1", name: "search_content", args: {} }],
        toolCallId: null,
        turnId: "t1",
        createdAt: "2026-06-01T10:00:30.000Z",
      },
      {
        id: "m3",
        role: "tool",
        content: "{}",
        toolCalls: null,
        toolCallId: "c1",
        turnId: "t1",
        createdAt: "2026-06-01T10:00:31.000Z",
      },
    ],
    ...overrides,
  };
}

describe("conversationToMarkdown", () => {
  it("renders title, model, and user/assistant turns in order", () => {
    const md = conversationToMarkdown(conv());
    expect(md).toContain("# Plan dinner");
    expect(md).toContain("llama3");
    const youIdx = md.indexOf("**You:**");
    const dropletIdx = md.indexOf("**Droplet:**");
    expect(youIdx).toBeGreaterThan(-1);
    expect(dropletIdx).toBeGreaterThan(youIdx);
    expect(md).toContain("What should we cook?");
    expect(md).toContain("How about pasta?");
  });

  it("drops tool/system rows and notes tools used on assistant turns", () => {
    const md = conversationToMarkdown(conv());
    // The raw tool-result JSON never lands in the export.
    expect(md).not.toContain("{}");
    expect(md).toContain("search_content");
  });

  it("falls back to a generic title and skips empty assistant placeholders", () => {
    const md = conversationToMarkdown(
      conv({
        title: null,
        messages: [
          {
            id: "m1",
            role: "user",
            content: "hi",
            toolCalls: null,
            toolCallId: null,
            turnId: "t1",
            createdAt: "2026-06-01T10:00:00.000Z",
          },
          {
            id: "m2",
            role: "assistant",
            content: "",
            toolCalls: null,
            toolCallId: null,
            turnId: "t1",
            createdAt: "2026-06-01T10:00:01.000Z",
          },
        ],
      }),
    );
    expect(md).toContain("# Chat");
    expect(md.match(/\*\*Droplet:\*\*/g)).toBeNull();
  });
});
