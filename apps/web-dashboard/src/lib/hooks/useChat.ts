"use client";

import { useCallback, useState } from "react";
import { sendChat } from "../api";
import type { ChatMessage, ChatToolCall } from "../types";

/**
 * Chat hook backed by `POST /api/llm/chat` (the MCP-backed orchestrator
 * agent loop introduced in WARP-101). The route is stateless: the
 * full message thread lives in React state and is replayed on every
 * turn, so refreshing the page wipes history.
 *
 * Streaming response: parse the SSE events defined in the orchestrator's
 * `apps/orchestrator/src/types/sse-events.ts`:
 *
 *   - `content_delta` → append text to the streaming assistant message
 *   - `tool_call`     → record a pending tool dispatch as a chip
 *   - `tool_result`   → fill in the chip with `ok`/`data`/`status`/`message`
 *   - `done`          → end of stream
 *
 * The session-based UX (server-side history, sidebar of past chats)
 * went away with WARP-104. If reintroduced it would need an
 * orchestrator-side persistence layer; see the WARP-104 PR body.
 */

let messageCounter = 0;

function createId(): string {
  return `msg-${Date.now()}-${++messageCounter}`;
}

interface SSEEventBase {
  type: string;
}

interface ContentDeltaEvent extends SSEEventBase {
  type: "content_delta";
  text: string;
}

interface ToolCallEvent extends SSEEventBase {
  type: "tool_call";
  id: string;
  name: string;
  args: Record<string, unknown>;
}

interface ToolResultEvent extends SSEEventBase {
  type: "tool_result";
  id: string;
  ok: boolean;
  data?: unknown;
  status?: string;
  message?: string;
}

interface DoneEvent extends SSEEventBase {
  type: "done";
  iterations: number;
  stop_reason: "model_done" | "iteration_limit" | "error";
  error?: string;
}

type SSEEvent =
  | ContentDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | DoneEvent;

/**
 * Parses a raw SSE frame block (`event: <type>\ndata: <json>\n\n`).
 * Returns null on malformed frames so the stream can recover.
 */
function parseSseFrame(raw: string): SSEEvent | null {
  let eventType: string | null = null;
  let dataLine: string | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) eventType = line.slice(7).trim();
    else if (line.startsWith("data: ")) dataLine = line.slice(6).trim();
  }
  if (!eventType || !dataLine) return null;
  try {
    const payload = JSON.parse(dataLine) as Record<string, unknown>;
    return { type: eventType, ...payload } as SSEEvent;
  } catch {
    return null;
  }
}

export function useChat() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);

  const sendMessage = useCallback(
    async (content: string, model: string, systemPrompt?: string) => {
      const userMessage: ChatMessage = {
        id: createId(),
        role: "user",
        content,
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "",
      };

      // Snapshot the full thread up to this turn so we can hand it to
      // /api/llm/chat. The route is stateless; replay is on us.
      const replayMessages: { role: string; content: string }[] = [];
      if (systemPrompt) {
        replayMessages.push({ role: "system", content: systemPrompt });
      }
      // Existing messages already in state, plus the user turn we just
      // built. Don't include the empty assistant placeholder.
      setMessages((prev) => {
        for (const m of prev) {
          if (m.role === "assistant" && !m.content) continue;
          replayMessages.push({ role: m.role, content: m.content });
        }
        replayMessages.push({ role: "user", content });
        return [...prev, userMessage, assistantMessage];
      });

      setIsStreaming(true);

      try {
        const response = await sendChat({
          model,
          messages: replayMessages,
          stream: true,
        });

        if (!response.body) {
          throw new Error("No response body");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line (\n\n). Anything
          // after the last separator is a partial frame held over for
          // the next read.
          const sep = buffer.lastIndexOf("\n\n");
          if (sep === -1) continue;
          const completed = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          for (const frame of completed.split("\n\n")) {
            if (!frame.trim()) continue;
            const evt = parseSseFrame(frame);
            if (!evt) continue;
            applyEvent(setMessages, assistantMessage.id, evt);
          }
        }

        // Flush trailing frame if the stream ended without a final \n\n.
        if (buffer.trim()) {
          const evt = parseSseFrame(buffer);
          if (evt) applyEvent(setMessages, assistantMessage.id, evt);
        }
      } catch (err) {
        setMessages((prev) => {
          const updated = [...prev];
          const idx = updated.findIndex((m) => m.id === assistantMessage.id);
          if (idx !== -1) {
            const last = updated[idx];
            if (last.role === "assistant" && !last.content) {
              updated[idx] = {
                ...last,
                content: `Error: ${
                  err instanceof Error ? err.message : "Unknown error"
                }`,
              };
            }
          }
          return updated;
        });
      } finally {
        setIsStreaming(false);
      }
    },
    [],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  return {
    messages,
    setMessages,
    isStreaming,
    sendMessage,
    clearMessages,
  };
}

/**
 * Apply a single SSE event to the streaming assistant message
 * identified by `assistantId`. Pure state mutation — extracted so
 * the reader loop reads cleanly.
 */
function applyEvent(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  assistantId: string,
  evt: SSEEvent,
): void {
  setMessages((prev) => {
    const idx = prev.findIndex((m) => m.id === assistantId);
    if (idx === -1) return prev;
    const last = prev[idx];
    if (last.role !== "assistant") return prev;

    switch (evt.type) {
      case "content_delta": {
        const updated = [...prev];
        updated[idx] = { ...last, content: last.content + evt.text };
        return updated;
      }
      case "tool_call": {
        const chip: ChatToolCall = {
          id: evt.id,
          name: evt.name,
          args: evt.args,
        };
        const updated = [...prev];
        updated[idx] = {
          ...last,
          toolCalls: [...(last.toolCalls ?? []), chip],
        };
        return updated;
      }
      case "tool_result": {
        const calls = last.toolCalls ?? [];
        const callIdx = calls.findIndex((c) => c.id === evt.id);
        if (callIdx === -1) return prev;
        const updatedCalls = [...calls];
        updatedCalls[callIdx] = {
          ...calls[callIdx],
          ok: evt.ok,
          data: evt.data,
          status: evt.status,
          message: evt.message,
        };
        const updated = [...prev];
        updated[idx] = { ...last, toolCalls: updatedCalls };
        return updated;
      }
      case "done": {
        if (evt.stop_reason === "error" && evt.error && !last.content) {
          const updated = [...prev];
          updated[idx] = { ...last, content: `Error: ${evt.error}` };
          return updated;
        }
        return prev;
      }
      default:
        return prev;
    }
  });
}
