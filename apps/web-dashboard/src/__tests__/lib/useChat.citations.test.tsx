import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
}));

import { useChat } from "@/lib/hooks/useChat";
import type { PersistedConversation } from "@/lib/api";

interface ProbeValue {
  messages: ReturnType<typeof useChat>["messages"];
  sendMessage: ReturnType<typeof useChat>["sendMessage"];
  loadConversation: ReturnType<typeof useChat>["loadConversation"];
}

function Probe({ onValue }: { onValue: (v: ProbeValue) => void }) {
  const hook = useChat();
  onValue({
    messages: hook.messages,
    sendMessage: hook.sendMessage,
    loadConversation: hook.loadConversation,
  });
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
    mockFetchConversation.mockReset();
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

  /**
   * WARP-1603 — every fixture above uses a cosine-shaped score (0.71–0.93),
   * so the real production shape (BGE-reranker-base logits, mostly
   * NEGATIVE) was never exercised. The extractor must carry a negative
   * score through verbatim, and must leave a non-numeric score `undefined`
   * so the chip renders no badge instead of a fabricated "0%".
   */
  it("carries a negative reranker logit through verbatim (does not zero it)", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: tool_call\ndata: ${JSON.stringify({ id: "c1", name: "search_content", args: {} })}\n\n`,
        `event: tool_result\ndata: ${JSON.stringify({
          id: "c1",
          ok: true,
          data: {
            results: [
              {
                source: "nextcloud",
                path: "/Docs/weak-match.md",
                chunkIdx: 0,
                pageNumber: null,
                score: -1.2,
                text: "loosely related",
              },
              // `JSON.stringify(NaN)` → `null`: a score that didn't survive
              // serialization must stay `undefined`, never become 0.
              {
                source: "brain",
                path: "no-score.md",
                chunkIdx: 0,
                pageNumber: null,
                score: null,
                text: "score lost in transit",
              },
            ],
          },
        })}\n\n`,
        `event: done\ndata: ${JSON.stringify({ iterations: 1, stop_reason: "model_done" })}\n\n`,
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);
    await act(async () => {
      await value!.sendMessage("...", "llama3:8b");
    });

    await waitFor(() => {
      expect(value!.messages.at(-1)?.citations).toHaveLength(2);
    });
    const cites = value!.messages.at(-1)!.citations!;
    expect(cites[0].score).toBe(-1.2);
    expect(cites[1].score).toBeUndefined();
  });
});

/**
 * WARP-1603 — chips must survive a refresh.
 *
 * Citations are derived client-side and never persisted as their own
 * column, and `loadConversation` rehydrated `toolCalls` while silently
 * dropping `citations`. The source rows were sitting right there in each
 * tool call's `data` blob, so replaying the extractor restores them.
 */
describe("useChat.loadConversation — citation chips survive a reload", () => {
  let value: ProbeValue | null = null;

  beforeEach(() => {
    value = null;
    mockSendChat.mockReset();
    mockFetchConversation.mockReset();
  });

  function conversation(
    calls: NonNullable<PersistedConversation["messages"][number]["toolCalls"]>,
  ): PersistedConversation {
    return {
      id: "conv-1",
      title: "Reload me",
      model: "llama3:8b",
      provider: "local",
      createdAt: "2026-07-26T00:00:00Z",
      updatedAt: "2026-07-26T00:00:00Z",
      messages: [
        {
          id: "user-1",
          role: "user",
          content: "where is the VPN doc?",
          toolCalls: null,
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: "2026-07-26T00:00:00Z",
        },
        {
          id: "asst-1",
          role: "assistant",
          content: "In /Docs/vpn-setup.md.",
          toolCalls: calls,
          toolCallId: null,
          turnId: null,
          status: "completed",
          createdAt: "2026-07-26T00:00:00Z",
        },
      ],
    } as PersistedConversation;
  }

  it("rebuilds citations from the persisted search_content results", async () => {
    mockFetchConversation.mockResolvedValueOnce(
      conversation([
        {
          id: "call-1",
          name: "search_content",
          args: { query: "vpn" },
          ok: true,
          status: "ok",
          data: {
            query: "vpn",
            results: [
              {
                source: "nextcloud",
                path: "/Docs/vpn-setup.md",
                chunkIdx: 0,
                pageNumber: null,
                score: -0.4,
                text: "wg-quick up wg0",
              },
              {
                source: "brain",
                path: "wireguard-cheatsheet.md",
                chunkIdx: 2,
                pageNumber: 3,
                score: 2.1,
                text: "wg genkey",
                brainItemId: "bmi-42",
              },
            ],
          },
        },
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);
    await act(async () => {
      await value!.loadConversation("conv-1");
    });

    await waitFor(() => {
      const asst = value!.messages.find((m) => m.id === "asst-1");
      expect(asst?.citations).toHaveLength(2);
    });
    const cites = value!.messages.find((m) => m.id === "asst-1")!.citations!;
    expect(cites[0]).toMatchObject({
      source: "nextcloud",
      path: "/Docs/vpn-setup.md",
      score: -0.4,
      snippet: "wg-quick up wg0",
    });
    expect(cites[1]).toMatchObject({
      source: "brain",
      path: "wireguard-cheatsheet.md",
      pageNumber: 3,
      score: 2.1,
      brainItemId: "bmi-42",
    });
  });

  it("dedupes across tool calls and ignores failed / non-retrieval ones", async () => {
    mockFetchConversation.mockResolvedValueOnce(
      conversation([
        {
          id: "call-1",
          name: "search_content",
          args: {},
          ok: true,
          status: "ok",
          data: {
            results: [
              { source: "brain", path: "notes.md", chunkIdx: 0, pageNumber: 1, score: 0.9, text: "a" },
            ],
          },
        },
        // Same source+path+page from a second search → one chip, not two.
        {
          id: "call-2",
          name: "search_content",
          args: {},
          ok: true,
          status: "ok",
          data: {
            results: [
              { source: "brain", path: "notes.md", chunkIdx: 7, pageNumber: 1, score: 0.7, text: "b" },
            ],
          },
        },
        // A failed retrieval contributes nothing (mirrors the live path).
        {
          id: "call-3",
          name: "search_content",
          args: {},
          ok: false,
          status: "error",
          data: {
            results: [
              { source: "brain", path: "failed.md", chunkIdx: 0, pageNumber: null, score: 0.5, text: "c" },
            ],
          },
        },
        // Non-retrieval tool → no citation pollution.
        {
          id: "call-4",
          name: "list_network_devices",
          args: {},
          ok: true,
          status: "ok",
          data: { results: [{ path: "/dev/eth0", score: 1 }] },
        },
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);
    await act(async () => {
      await value!.loadConversation("conv-1");
    });

    await waitFor(() => {
      const asst = value!.messages.find((m) => m.id === "asst-1");
      expect(asst?.citations).toBeDefined();
    });
    const cites = value!.messages.find((m) => m.id === "asst-1")!.citations!;
    expect(cites).toHaveLength(1);
    expect(cites[0].path).toBe("notes.md");
  });

  it("leaves `citations` undefined on a turn with no retrieval results", async () => {
    mockFetchConversation.mockResolvedValueOnce(
      conversation([
        {
          id: "call-1",
          name: "list_network_devices",
          args: {},
          ok: true,
          status: "ok",
          data: { devices: [] },
        },
      ]),
    );

    render(<Probe onValue={(v) => (value = v)} />);
    await act(async () => {
      await value!.loadConversation("conv-1");
    });

    await waitFor(() => {
      expect(value!.messages.find((m) => m.id === "asst-1")).toBeDefined();
    });
    expect(
      value!.messages.find((m) => m.id === "asst-1")!.citations,
    ).toBeUndefined();
  });
});
