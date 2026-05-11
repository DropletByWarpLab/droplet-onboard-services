"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { sendChat, uploadBrainFile } from "../api";
import type { ChatAttachment, ChatMessage, ChatToolCall } from "../types";

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

/**
 * Translate a raw fetch / streaming error into copy a non-engineering
 * user can act on. The original message is logged but never rendered
 * directly to avoid leaking strings like "Failed to fetch" or "503"
 * into the chat surface.
 */
function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Keep the raw cause in console for operators / debugging.
  // eslint-disable-next-line no-console
  console.error("[chat] turn failed:", raw);
  if (/network|fetch|ECONNREFUSED|ENOTFOUND/i.test(raw)) {
    return "I can't reach the Droplet right now. Check the connection and try again.";
  }
  if (/timeout|timed out/i.test(raw)) {
    return "That took too long. Try again, or simplify the request.";
  }
  if (/abort/i.test(raw)) {
    return "The request was cancelled.";
  }
  return "Something went wrong on this turn. Try again.";
}

let attachmentCounter = 0;

function createAttachmentId(): string {
  return `att-${Date.now()}-${++attachmentCounter}`;
}

export interface UseChatOptions {
  /**
   * The originating chat id sent up with each brain-memory upload so a
   * future Phase-2 "scope to this conversation" filter can do the join.
   * Stable across the lifetime of the chat session — the parent
   * component owns it.
   */
  chatId?: string;
}

export function useChat(options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  // AbortController for the in-flight stream (WARP-295). Stored in a
  // ref so `stop()` can read the current controller synchronously
  // without re-renders. `isStoppingRef` lets the SSE reader loop's
  // catch/finally distinguish a user-initiated abort (preserve partial
  // content, mark `stopped: true`) from a genuine fetch failure
  // (`friendlyErrorMessage` path).
  const abortRef = useRef<AbortController | null>(null);
  const isStoppingRef = useRef(false);
  // The chatId can change between renders; freeze the latest value in
  // a ref so `attach` (a stable callback) reads the current value.
  const chatIdRef = useRef<string | undefined>(options.chatId);
  useEffect(() => {
    chatIdRef.current = options.chatId;
  }, [options.chatId]);

  // Keep a ref-mirror of `messages` so callbacks (especially
  // `retryMessage`) can read the current snapshot synchronously without
  // relying on the setMessages updater to run before the surrounding
  // async code reads back. In test environments React batches updater
  // execution after the synchronous portion of an async function — the
  // ref dodges that.
  const messagesRef = useRef<ChatMessage[]>([]);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // ── MQTT-driven attachment status updates ──
  //
  // The orchestrator's WS bridge forwards `droplet/files/<user>/brain/indexed`
  // messages; we map `{itemId, status: "ready"|"failed", reason?}` onto
  // the local attachment list, flipping the chip in place. Mounting the
  // socket here (rather than inside ChatInput) keeps the chip state in
  // a single owner — the hook — so the Composer can render N chips
  // from the same source without duplicating the subscription.
  useEffect(() => {
    if (typeof window === "undefined") return;
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const apply = (data: { topic?: string; payload?: unknown }) => {
      if (typeof data.topic !== "string") return;
      // Match the per-user brain/indexed namespace; `<user>` is variable
      // so we end-anchor on the suffix.
      if (!data.topic.endsWith("/brain/indexed")) return;
      const payload = data.payload as
        | { itemId?: string; status?: string; reason?: string }
        | undefined;
      if (!payload?.itemId || typeof payload.status !== "string") return;
      setAttachments((prev) =>
        prev.map((a) =>
          a.itemId === payload.itemId
            ? {
                ...a,
                status:
                  payload.status === "ready"
                    ? "ready"
                    : ("failed" as ChatAttachment["status"]),
                error:
                  payload.status === "failed" ? payload.reason : undefined,
              }
            : a,
        ),
      );
    };

    const connect = () => {
      if (closed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/api/ws/events`;
      try {
        ws = new WebSocket(url);
      } catch {
        scheduleReconnect();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (event) => {
        try {
          apply(JSON.parse(typeof event.data === "string" ? event.data : ""));
        } catch {
          // Ignore malformed frames — the WS bridge always emits JSON.
        }
      };
      ws.onclose = () => {
        if (!closed) scheduleReconnect();
      };
      ws.onerror = () => {
        ws?.close();
      };
    };

    const scheduleReconnect = () => {
      if (closed) return;
      attempt += 1;
      const base = Math.min(30_000, 500 * 2 ** Math.min(attempt - 1, 6));
      const jitter = Math.random() * base * 0.25;
      reconnectTimer = setTimeout(connect, base + jitter);
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws && ws.readyState <= WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // ignore
        }
      }
    };
  }, []);

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
      // built. Don't include the empty assistant placeholder, and drop
      // any prior assistant turn that ended in an error — replaying
      // "I can't reach the Droplet…" back to the model would just
      // confuse it.
      setMessages((prev) => {
        for (const m of prev) {
          if (m.role === "assistant" && !m.content) continue;
          if (m.role === "assistant" && m.error) continue;
          replayMessages.push({ role: m.role, content: m.content });
        }
        replayMessages.push({ role: "user", content });
        return [...prev, userMessage, assistantMessage];
      });

      setIsStreaming(true);
      // Mint a fresh AbortController for this turn. Any previous one
      // is stale — sendMessage isn't called while a stream is in flight
      // because the input is disabled, but we still defensively abort
      // the old controller so dangling listeners don't leak.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      isStoppingRef.current = false;

      try {
        const response = await sendChat({
          model,
          messages: replayMessages,
          stream: true,
          signal: controller.signal,
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
            applyEvent(setMessages, assistantMessage.id, evt, content);
          }
        }

        // Flush trailing frame if the stream ended without a final \n\n.
        if (buffer.trim()) {
          const evt = parseSseFrame(buffer);
          if (evt) applyEvent(setMessages, assistantMessage.id, evt, content);
        }
      } catch (err) {
        // WARP-295: a user-initiated stop() aborts the underlying
        // fetch, which surfaces here as an AbortError. That is NOT an
        // error condition from the UX's perspective — we preserve any
        // partial content the model already streamed and mark the
        // bubble with `stopped: true` so the ChatMessage layer can
        // render the "Stopped by you" tag.
        const isAbort =
          isStoppingRef.current ||
          controller.signal.aborted ||
          (err instanceof DOMException && err.name === "AbortError");
        if (isAbort) {
          setMessages((prev) => {
            const idx = prev.findIndex((m) => m.id === assistantMessage.id);
            if (idx === -1) return prev;
            const last = prev[idx];
            if (last.role !== "assistant") return prev;
            const updated = [...prev];
            updated[idx] = { ...last, stopped: true };
            return updated;
          });
        } else {
          const friendly = friendlyErrorMessage(err);
          setMessages((prev) => {
            const updated = [...prev];
            const idx = updated.findIndex((m) => m.id === assistantMessage.id);
            if (idx !== -1) {
              const last = updated[idx];
              if (last.role === "assistant" && !last.content) {
                updated[idx] = {
                  ...last,
                  error: { message: friendly, retryPrompt: content },
                };
              }
            }
            return updated;
          });
        }
      } finally {
        setIsStreaming(false);
        isStoppingRef.current = false;
        if (abortRef.current === controller) {
          abortRef.current = null;
        }
      }
    },
    [],
  );

  /**
   * Cancel the in-flight stream (WARP-295). Aborts the underlying
   * fetch via the per-turn AbortController and signals the SSE reader
   * catch block to treat the abort as user-initiated. No-op when no
   * stream is in flight — the button may still be visible for a frame
   * after the stream ends if React hasn't re-rendered yet.
   */
  const stop = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;
    isStoppingRef.current = true;
    controller.abort();
  }, []);

  /**
   * Re-send the prompt that drove a failed assistant turn. Drops the
   * failed turn (and the user message that preceded it, since
   * `sendMessage` will re-append both) so we don't double up.
   *
   * Returns a promise so callers can `await retryMessage(...)` — the
   * test suite relies on this.
   */
  const retryMessage = useCallback(
    async (messageId: string, model: string, systemPrompt?: string) => {
      // Read the failed message from the ref-mirror — the updater
      // pattern doesn't work here because in this test/runtime
      // environment React batches the updater AFTER the surrounding
      // async code reads back closure-captured state.
      const target = messagesRef.current.find((m) => m.id === messageId);
      if (!target?.error) return;
      const retryPrompt = target.error.retryPrompt;

      // Drop the failed assistant + the user turn immediately before it
      // so the new turn replays a clean thread.
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === messageId);
        if (idx === -1) return prev;
        const userIdx = idx > 0 && prev[idx - 1].role === "user" ? idx - 1 : idx;
        return prev.filter((_, i) => i !== idx && i !== userIdx);
      });

      await sendMessage(retryPrompt, model, systemPrompt);
    },
    [sendMessage],
  );

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  /**
   * Upload a chat-attached file. Adds a pending chip immediately so
   * the user sees feedback within a frame, kicks off the upload, then
   * flips the chip to "indexing" once the orchestrator returns 202.
   * The MQTT-driven effect above flips it again to "ready" / "failed"
   * when extraction completes.
   *
   * Returns the `localId` of the chip so callers can track / remove it.
   */
  const attach = useCallback(async (file: File): Promise<string> => {
    const localId = createAttachmentId();
    const pending: ChatAttachment = {
      localId,
      filename: file.name,
      bytes: file.size,
      status: "uploading",
    };
    setAttachments((prev) => [...prev, pending]);

    try {
      const res = await uploadBrainFile(file, chatIdRef.current);
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, itemId: res.itemId, status: "indexing" }
            : a,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Upload failed";
      setAttachments((prev) =>
        prev.map((a) =>
          a.localId === localId
            ? { ...a, status: "failed", error: message }
            : a,
        ),
      );
    }
    return localId;
  }, []);

  const removeAttachment = useCallback((localId: string) => {
    setAttachments((prev) => prev.filter((a) => a.localId !== localId));
  }, []);

  const clearAttachments = useCallback(() => {
    setAttachments([]);
  }, []);

  return {
    messages,
    setMessages,
    isStreaming,
    sendMessage,
    stop,
    retryMessage,
    clearMessages,
    attachments,
    attach,
    removeAttachment,
    clearAttachments,
  };
}

/**
 * Apply a single SSE event to the streaming assistant message
 * identified by `assistantId`. Pure state mutation — extracted so
 * the reader loop reads cleanly. `retryPrompt` is the user prompt
 * that drove this turn, used to mark error states with a retry
 * affordance when a `done` event carries `stop_reason: "error"`.
 */
function applyEvent(
  setMessages: React.Dispatch<React.SetStateAction<ChatMessage[]>>,
  assistantId: string,
  evt: SSEEvent,
  retryPrompt: string,
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
        if (evt.stop_reason === "error" && !last.content) {
          // eslint-disable-next-line no-console
          console.error("[chat] agent loop ended with error:", evt.error);
          const updated = [...prev];
          updated[idx] = {
            ...last,
            error: {
              message:
                "The Droplet AI couldn't finish this turn. Try again, or ask in a different way.",
              retryPrompt,
            },
          };
          return updated;
        }
        return prev;
      }
      default:
        return prev;
    }
  });
}
