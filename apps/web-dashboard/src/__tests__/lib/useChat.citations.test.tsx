import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
}));

import { useChat } from "@/lib/hooks/useChat";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({ messages: hook.messages, sendMessage: hook.sendMessage });
  return null;
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const enc = new TextEncoder();
      for (const f of frames) controller.enqueue(enc.encode(f));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

/**
 * WARP-295: RAG citation extraction from `tool_result` events.
 *
 * Source-of-truth for `search_content`'s `data` shape:
 *   packages/tools-core/src/handlers/files/search-content.ts
 *     data: {
 *       query,
 *       results: [
 *         { source: "nextcloud"|"brain", path, chunkIdx, pageNumber, score, text }
 *       ]
 *     }
 *
 * The hook flattens these into the `ChatMessage.citations` array so the
 * <CitationChip> component renders them below the bubble.
 */

describe("useChat citation extraction (WARP-295)", () => {
  let value: ProbeValue | null = null;

  beforeEach(() => {
    value = null;
    mockSendChat.mockReset();
  });

  it("flattens search_content tool_result results into message.citations", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({
          id: "call-1",
          name: "search_content",
          args: { query: "WireGuard setup" },
        })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "call-1",
          ok: true,
          data: {
            query: "WireGuard setup",
            results: [
              {
                source: "nextcloud",
                path: "/Docs/vpn-setup.md",
                chunkIdx: 0,
                pageNumber: null,
                score: 0.93,
                text: "Run wg-quick up wg0 ...",
              },
              {
                source: "brain",
                path: "wireguard-cheatsheet.md",
                chunkIdx: 2,
                pageNumber: 3,
                score: 0.81,
                text: "Generate keys with wg genkey",
                // Brain hits sometimes carry an item id — assert it's
                // preserved end-to-end.
                brainItemId: "bmi-42",
              },
            ],
          },
        })}\n\n`,
        `event: content_delta\ndata: ${JSON.stringify({ text: "Here's the setup." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("how do I set up WireGuard?", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.role).toBe("assistant");
      expect(last?.content).toBe("Here's the setup.");
      expect(last?.citations).toBeDefined();
      expect(last?.citations).toHaveLength(2);
    });

    const cites = value!.messages.at(-1)!.citations!;
    expect(cites[0]).toMatchObject({
      source: "nextcloud",
      path: "/Docs/vpn-setup.md",
      score: 0.93,
      snippet: "Run wg-quick up wg0 ...",
    });
    expect(cites[1]).toMatchObject({
      source: "brain",
      path: "wireguard-cheatsheet.md",
      pageNumber: 3,
      score: 0.81,
      brainItemId: "bmi-42",
      snippet: "Generate keys with wg genkey",
    });
  });

  it("ignores tool_result events from non-retrieval tools (no citation pollution)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({
          id: "call-1",
          name: "list_network_devices",
          args: {},
        })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "call-1",
          ok: true,
          data: { devices: [{ mac: "AA:BB:CC:DD:EE:FF" }] },
        })}\n\n`,
        `event: content_delta\ndata: ${JSON.stringify({ text: "One device." })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("what's online?", "llama3:8b");
    });

    await waitFor(() => {
      const last = value!.messages.at(-1);
      expect(last?.content).toBe("One device.");
    });

    expect(value!.messages.at(-1)!.citations).toBeUndefined();
  });

  it("dedupes citations within a single turn (same source+path+pageNumber)", async () => {
    // Two distinct search_content calls land hits on the same path/page —
    // the chip row should show one chip, not two. The cheap dedupe is in
    // applyEvent so the downstream <CitationChip> map doesn't have to
    // worry about React keys colliding.
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({ id: "c1", name: "search_content", args: {} })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "c1",
          ok: true,
          data: {
            results: [
              { source: "brain", path: "notes.md", chunkIdx: 0, pageNumber: 1, score: 0.9, text: "a" },
            ],
          },
        })}\n\n`,
        `event: tool_call\ndata: ${JSON.stringify({ id: "c2", name: "search_content", args: {} })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "c2",
          ok: true,
          data: {
            results: [
              { source: "brain", path: "notes.md", chunkIdx: 7, pageNumber: 1, score: 0.71, text: "b" },
            ],
          },
        })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 2, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);

    await act(async () => {
      await value!.sendMessage("...", "llama3:8b");
    });

    await waitFor(() => {
      expect(value!.messages.at(-1)?.citations).toBeDefined();
    });
    expect(value!.messages.at(-1)!.citations).toHaveLength(1);
  });
});
