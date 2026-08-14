/**
 * WARP-458 front-end wiring — the dashboard finally consumes the
 * reasoning trace the backend has persisted all along:
 *   - every turn requests `captureReasoning: true`
 *   - `reasoning_step` SSE events accumulate onto the streaming
 *     assistant message's `reasoning` field
 *   - loadConversation carries the persisted trace through
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render } from "@testing-library/react";

const mockSendChat = vi.fn();
const mockFetchConversation = vi.fn();
const mockGetBrainMemoryItems = vi.fn();
vi.mock("@/lib/api", () => ({
  sendChat: (...args: unknown[]) => mockSendChat(...args),
  uploadBrainFile: vi.fn(),
  fetchConversation: (...args: unknown[]) => mockFetchConversation(...args),
  getBrainMemoryItems: (...args: unknown[]) => mockGetBrainMemoryItems(...args),
}));

import { useChat } from "@/lib/hooks/useChat";
import {
  REASONING_STEP_SEPARATOR,
  splitReasoningSteps,
} from "@/components/chat/reasoning-trace";

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
    start(c) {
      const enc = new TextEncoder();
      for (const f of frames) c.enqueue(enc.encode(f));
      c.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

beforeEach(() => {
  mockSendChat.mockReset();
  mockFetchConversation.mockReset();
  mockGetBrainMemoryItems.mockReset();
  mockGetBrainMemoryItems.mockResolvedValue({ items: [] });
});

describe("useChat — reasoning trace (WARP-458)", () => {
  it("requests captureReasoning on every turn", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("hello", "m1");
    });

    expect(mockSendChat.mock.calls[0]![0]).toMatchObject({
      captureReasoning: true,
    });
  });

  it("accumulates reasoning_step events onto the assistant message", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: reasoning_step\ndata: {"text":"First I check the docs."}\n\n`,
        `event: reasoning_step\ndata: {"text":"Then I compare options."}\n\n`,
        `event: content_delta\ndata: {"text":"Answer."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("why?", "m1");
    });

    const asst = probe!.messages.at(-1)!;
    expect(asst.role).toBe("assistant");
    expect(asst.content).toBe("Answer.");
    expect(asst.reasoning).toBe(
      "First I check the docs.\n\nThen I compare options.",
    );
  });

  it("carries the persisted reasoning through loadConversation", async () => {
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-r",
      title: "Why",
      model: "m1",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "m1",
          role: "user",
          content: "why?",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
        {
          id: "m2",
          role: "assistant",
          content: "Answer.",
          reasoning: "Persisted trace.",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.loadConversation("conv-r");
    });

    expect(probe!.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "Answer.",
      reasoning: "Persisted trace.",
    });
  });
});

/**
 * WARP-1605 — the live trace has to carry the SAME per-step boundaries the
 * orchestrator persists, or the reload would render a different number of
 * blocks than the stream just did.
 *
 * Wire vs. column: one agent iteration can emit SEVERAL `reasoning_step`
 * events (a provider-native block plus each inline `<reasoning>` segment) and
 * the orchestrator joins those with `\n\n` into ONE entry
 * (`reasoningSteps.push(stepParts.join("\n\n"))`) before flattening the list
 * with `REASONING_STEP_SEPARATOR`. A `tool_call` is what ends an iteration on
 * the wire (`emit(reasoning_step)` at llm-agent.service.ts precedes
 * `emit(tool_call)` for the same iteration), so it — and only it — closes a
 * step here.
 */
describe("useChat — per-step reasoning boundaries (WARP-1605)", () => {
  it("joins events within one iteration and separates them across tool calls", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        // Iteration 1: two events, one step.
        `event: reasoning_step\ndata: {"text":"We need the invoice folder."}\n\n`,
        `event: reasoning_step\ndata: {"text":"Search /Finance."}\n\n`,
        `event: tool_call\ndata: {"id":"tc-1","name":"search_files","args":{}}\n\n`,
        `event: tool_result\ndata: {"id":"tc-1","ok":true,"data":{}}\n\n`,
        // Iteration 2 (terminal): one step, then the answer.
        `event: reasoning_step\ndata: {"text":"Now summarise what came back."}\n\n`,
        `event: content_delta\ndata: {"text":"Your invoices are in /Finance."}\n\n`,
        `event: done\ndata: {"iterations":2,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("where are my invoices?", "m1");
    });

    const asst = probe!.messages.at(-1)!;
    expect(asst.content).toBe("Your invoices are in /Finance.");
    // Exactly the string the orchestrator would have written to the column.
    expect(asst.reasoning).toBe(
      "We need the invoice folder.\n\nSearch /Finance." +
        REASONING_STEP_SEPARATOR +
        "Now summarise what came back.",
    );
    expect(splitReasoningSteps(asst.reasoning)).toEqual([
      "We need the invoice folder.\n\nSearch /Finance.",
      "Now summarise what came back.",
    ]);
  });

  it("produces the SAME trace live as after a reload (render parity)", async () => {
    const frames = [
      `event: reasoning_step\ndata: {"text":"step one"}\n\n`,
      `event: tool_call\ndata: {"id":"tc-9","name":"read_file","args":{}}\n\n`,
      `event: tool_result\ndata: {"id":"tc-9","ok":true,"data":{}}\n\n`,
      `event: reasoning_step\ndata: {"text":"step two"}\n\n`,
      `event: content_delta\ndata: {"text":"Done."}\n\n`,
      `event: done\ndata: {"iterations":2,"stop_reason":"model_done"}\n\n`,
    ];
    mockSendChat.mockResolvedValueOnce(sseResponse(frames));
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("go", "m1");
    });
    const live = probe!.messages.at(-1)!.reasoning;

    // The row the orchestrator writes for that same turn.
    const persisted = `step one${REASONING_STEP_SEPARATOR}step two`;
    mockFetchConversation.mockResolvedValueOnce({
      id: "conv-parity",
      title: "Go",
      model: "m1",
      provider: "ollama",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [
        {
          id: "u1",
          role: "user",
          content: "go",
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
        {
          id: "a1",
          role: "assistant",
          content: "Done.",
          reasoning: persisted,
          toolCalls: null,
          toolCallId: null,
          turnId: "t1",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await act(async () => {
      await probe!.loadConversation("conv-parity");
    });
    const reloaded = probe!.messages.at(-1)!.reasoning;

    expect(live).toBe(persisted);
    expect(reloaded).toBe(live);
    expect(splitReasoningSteps(reloaded)).toEqual(["step one", "step two"]);
  });

  it("leaves a single-iteration turn byte-identical to the pre-1605 shape", async () => {
    mockSendChat.mockResolvedValueOnce(
      sseResponse([
        `event: reasoning_step\ndata: {"text":"First I check the docs."}\n\n`,
        `event: reasoning_step\ndata: {"text":"Then I compare options."}\n\n`,
        `event: content_delta\ndata: {"text":"Answer."}\n\n`,
        `event: done\ndata: {"iterations":1,"stop_reason":"model_done"}\n\n`,
      ]),
    );
    let probe: ProbeValue;
    render(<Probe onValue={(v) => (probe = v)} />);

    await act(async () => {
      await probe!.sendMessage("why?", "m1");
    });

    // No tool call ⇒ no step boundary ⇒ the historical `\n\n` join, and one
    // rendered block. No DB shape change for the overwhelming majority of turns.
    const asst = probe!.messages.at(-1)!;
    expect(asst.reasoning).toBe(
      "First I check the docs.\n\nThen I compare options.",
    );
    expect(splitReasoningSteps(asst.reasoning)).toHaveLength(1);
  });
});
