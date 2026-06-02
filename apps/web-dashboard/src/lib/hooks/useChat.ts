"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { sendChat, uploadBrainFile, fetchConversation } from "../api";
import type {
  ChatAttachment,
  ChatCitation,
  ChatMessage,
  ChatToolCall,
} from "../types";

/** WARP-304: response header carrying the server-assigned conversation id. */
const CONVERSATION_ID_HEADER = "x-conversation-id";

/** WARP-329: response header carrying the server-side `ChatMessage.id` for
 *  this turn's assistant row. The client uses it to match incoming
 *  `turn-completed` MQTT events back to the right in-flight message. */
const ASSISTANT_MESSAGE_ID_HEADER = "x-assistant-message-id";

/**
 * WARP-329: ask for `Notification` permission lazily on the user's first
 * send, never on page load. Permission popups on load are widely disliked
 * and Safari is particularly punitive about them. Returns the current
 * permission state so callers don't need to re-read `Notification.permission`.
 */
async function ensureNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return "denied";
  }
  if (Notification.permission === "default") {
    try {
      return await Notification.requestPermission();
    } catch {
      return "denied";
    }
  }
  return Notification.permission;
}

/**
 * WARP-304: short, collision-resistant per-turn idempotency key. Native
 * `crypto.randomUUID()` is available everywhere we run (jsdom 24, modern
 * browsers, secure contexts on iOS/Android). Falls back to a v4-shaped
 * Math.random string if `randomUUID` isn't reachable so non-secure-context
 * test harnesses don't crash.
 */
function createTurnId(): string {
  const cryptoObj: Crypto | undefined =
    typeof crypto !== "undefined" ? crypto : undefined;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  // RFC4122 v4 fallback. Not cryptographically secure but the only
  // consumer is server-side dedup; a UUID-shaped string is sufficient.
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * WARP-295: tools whose `tool_result.data.results[]` carries
 * citation-shaped rows. Keep the set narrow — non-retrieval tools (e.g.
 * `list_network_devices`) return device data, and surfacing those as
 * citations would pollute the chip row with bogus links.
 *
 * Source-of-truth shape:
 *   packages/tools-core/src/handlers/files/search-content.ts
 *
 * If new retrieval tools land (e.g. `search_brain`, `search_calendar`),
 * add their names here and confirm the data.results[] shape matches —
 * the extractor is tolerant of missing fields but assumes `path`.
 */
const RETRIEVAL_TOOL_NAMES = new Set(["search_content"]);

/** Stable dedupe key for one citation row. */
function citationKey(c: ChatCitation): string {
  return `${c.source}|${c.path}|${c.pageNumber ?? ""}`;
}

interface RawCitationRow {
  source?: string;
  path?: string;
  pageNumber?: number | null;
  page_number?: number | null;
  score?: number;
  text?: string;
  snippet?: string;
  brainItemId?: string | null;
  brain_item_id?: string | null;
  mimeType?: string;
  mime_type?: string;
}

/** Extract `ChatCitation[]` from a tool_result event, or return [] if shape doesn't match. */
function extractCitations(toolName: string, data: unknown): ChatCitation[] {
  if (!RETRIEVAL_TOOL_NAMES.has(toolName)) return [];
  if (!data || typeof data !== "object") return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const out: ChatCitation[] = [];
  for (const r of results as RawCitationRow[]) {
    if (!r || typeof r !== "object") continue;
    if (typeof r.path !== "string") continue;
    const source: "nextcloud" | "brain" =
      r.source === "brain" ? "brain" : "nextcloud";
    out.push({
      source,
      path: r.path,
      pageNumber: r.pageNumber ?? r.page_number ?? null,
      score: typeof r.score === "number" ? r.score : undefined,
      brainItemId: r.brainItemId ?? r.brain_item_id ?? null,
      snippet: r.snippet ?? r.text ?? undefined,
      mimeType: r.mimeType ?? r.mime_type ?? undefined,
    });
  }
  return out;
}

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
 * Conversation history is rendered by ChatHistoryPanel (WARP-331),
 * which receives optimistic inserts + turn-completed refetches via
 * the `historyHandleRef` option on this hook.
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

import type { ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";

const TITLE_MAX_LEN = 64;

/** WARP-331 — derive the optimistic title from the first user message. */
function deriveOptimisticTitle(firstUserContent: string): string {
  const trimmed = firstUserContent.trim().replace(/\s+/g, " ");
  if (trimmed.length <= TITLE_MAX_LEN) return trimmed;
  // Reserve 1 char for the ellipsis so the final string is ≤ TITLE_MAX_LEN.
  const slice = trimmed.slice(0, TITLE_MAX_LEN - 1);
  const lastSpace = slice.lastIndexOf(" ");
  return (lastSpace > TITLE_MAX_LEN / 2 ? slice.slice(0, lastSpace) : slice) + "…";
}

export function notifyHistoryOfNewConversation(
  handle: ChatHistoryPanelHandle | null,
  args: { id: string; firstUserContent: string },
): void {
  if (!handle) return;
  const now = new Date().toISOString();
  handle.optimisticInsert({
    id: args.id,
    title: deriveOptimisticTitle(args.firstUserContent),
    model: null,
    provider: null,
    createdAt: now,
    updatedAt: now,
  });
}

export async function notifyHistoryOfTurnCompleted(
  handle: ChatHistoryPanelHandle | null,
  conversationId: string,
): Promise<void> {
  if (!handle) return;
  await handle.applyTurnCompleted(conversationId);
}

export interface UseChatOptions {
  /**
   * The originating chat id sent up with each brain-memory upload so a
   * future Phase-2 "scope to this conversation" filter can do the join.
   * Stable across the lifetime of the chat session — the parent
   * component owns it.
   */
  chatId?: string;
  /**
   * WARP-331: optional ref to the ChatHistoryPanel imperative handle.
   * When set, useChat will call `optimisticInsert` on the first turn of a
   * new conversation, and `applyTurnCompleted` when turn-completed fires.
   */
  historyHandleRef?: MutableRefObject<ChatHistoryPanelHandle | null>;
}

/**
 * WARP-331: key for the per-conversation attachment cache while a chat is
 * still a draft (no server-assigned conversationId yet). On the first
 * turn's `X-Conversation-Id` header we rename this bucket to the real id
 * so the chips don't visibly flicker.
 */
const DRAFT_CONV_KEY = "__draft__";

export function useChat(options: UseChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * WARP-331: the conversationId of the currently-in-flight assistant
   * stream, or `null` when nothing is streaming. The exposed `isStreaming`
   * is derived as `streamActive && streamingConversationId === conversationId`
   * — i.e. the UI lock follows the user's active chat, not the underlying
   * fetch. Switching chats mid-stream therefore unlocks the new chat's
   * input immediately; the prior chat's stream keeps running (the
   * orchestrator persists the assistant turn server-side via WARP-329).
   * Returning to the streaming chat re-locks the input until the stream
   * completes.
   */
  const [streamActive, setStreamActive] = useState(false);
  const [streamingConversationId, setStreamingConversationId] = useState<
    string | null
  >(null);
  const streamingConversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    streamingConversationIdRef.current = streamingConversationId;
  }, [streamingConversationId]);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  /**
   * WARP-331: per-conversation attachment cache. Keyed by conversationId
   * or `DRAFT_CONV_KEY` for a pre-first-turn pending state. Switching
   * conversations swaps the visible attachments via the effect below,
   * so chips uploaded in chat A don't bleed into chat B's composer.
   */
  const attachmentsByConvRef = useRef<Map<string, ChatAttachment[]>>(new Map());
  /**
   * WARP-331: track conversation ids whose stream JUST finished locally.
   * The MQTT turn-completed handler uses this to skip an auto-refresh
   * when the local stream already wrote the final content — the reload
   * would otherwise remount the message bubbles with server ids and
   * cause a visible flash. 5-second grace covers the network hop between
   * the orchestrator's finalize and the client's MQTT delivery.
   */
  const recentlyLocallyCompletedRef = useRef<Map<string, number>>(new Map());
  const LOCAL_COMPLETE_GRACE_MS = 5000;
  /**
   * WARP-304: server-assigned conversation id. Null until the first turn
   * returns the `X-Conversation-Id` header. The chat page reflects this
   * into the URL (`?c=<id>`) so a refresh restores the thread; downstream
   * turns send it back so persistence stays glued to the same row.
   */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const conversationIdRef = useRef<string | null>(null);
  useEffect(() => {
    conversationIdRef.current = conversationId;
  }, [conversationId]);
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

      // WARP-203 brain-memory chip status updates.
      if (data.topic.endsWith("/brain/indexed")) {
        const payload = data.payload as
          | { itemId?: string; status?: string; reason?: string }
          | undefined;
        if (!payload?.itemId || typeof payload.status !== "string") return;
        const itemId = payload.itemId;
        const rawStatus = payload.status;
        const reason = payload.reason;
        const flip = (a: ChatAttachment): ChatAttachment =>
          a.itemId === itemId
            ? {
                ...a,
                status:
                  rawStatus === "ready"
                    ? "ready"
                    : ("failed" as ChatAttachment["status"]),
                error: rawStatus === "failed" ? reason : undefined,
              }
            : a;
        // WARP-331: a status flip can arrive for an itemId that lives
        // in another conversation's bucket while the user is viewing a
        // different chat. Apply the updater across every bucket so the
        // chip is up to date the moment the user navigates back.
        for (const [key, list] of attachmentsByConvRef.current) {
          attachmentsByConvRef.current.set(key, list.map(flip));
        }
        setAttachments((prev) => prev.map(flip));
        return;
      }

      // WARP-329: chat turn-completed events. The orchestrator publishes
      // `droplet/chat/<user>/turn-completed` when an in-flight LLM turn
      // settles (completed / failed / aborted). When the tab is hidden,
      // surface a browser Notification so the user knows their reply
      // landed. Click → focus + deep-link to the conversation.
      if (data.topic.endsWith("/turn-completed")) {
        const payload = data.payload as
          | {
              conversationId?: string;
              messageId?: string;
              status?: "completed" | "failed" | "aborted";
              snippet?: string;
              completedAt?: string;
            }
          | undefined;
        if (!payload?.conversationId || !payload.messageId) return;
        // WARP-331: always notify the history panel (tab visibility is
        // irrelevant for sidebar refreshes).
        const historyId = payload.conversationId;
        void notifyHistoryOfTurnCompleted(
          options.historyHandleRef?.current ?? null,
          historyId,
        );
        // WARP-331: if the user is currently viewing this conversation
        // AND we didn't just stream it locally, refetch the persisted
        // state so the freshly-finalized assistant turn appears without
        // a manual page reload. Covers the "I switched away mid-stream
        // and came back" case where the local stream was abandoned but
        // the orchestrator continued to persist server-side.
        if (payload.conversationId === conversationIdRef.current) {
          const recentlyAt = recentlyLocallyCompletedRef.current.get(
            payload.conversationId,
          );
          const isStillStreamingLocally =
            streamingConversationIdRef.current === payload.conversationId;
          const justLocallyCompleted =
            recentlyAt !== undefined &&
            Date.now() - recentlyAt < LOCAL_COMPLETE_GRACE_MS;
          if (!isStillStreamingLocally && !justLocallyCompleted) {
            void loadConversation(payload.conversationId);
          }
        }
        // Only surface a notification when the tab is hidden. If the
        // user is staring at the chat surface, the streaming UI already
        // told them everything they need to know.
        const hidden =
          typeof document !== "undefined" && document.hidden === true;
        if (!hidden) return;
        if (
          typeof window === "undefined" ||
          !("Notification" in window) ||
          Notification.permission !== "granted"
        ) {
          return;
        }
        try {
          const body =
            payload.status === "failed"
              ? "The turn couldn't complete. Try again from the chat surface."
              : payload.status === "aborted"
                ? "The turn was cancelled."
                : (payload.snippet ?? "").trim() || "Your reply is ready.";
          const n = new Notification("Droplet AI replied", {
            body: body.slice(0, 140),
            // `tag: conversationId` collapses multiple notifications for
            // the same chat into one — re-firing replaces the prior.
            tag: payload.conversationId,
            data: {
              conversationId: payload.conversationId,
              messageId: payload.messageId,
            },
          });
          n.onclick = () => {
            try {
              window.focus();
              const target = `/chat?c=${encodeURIComponent(payload.conversationId!)}`;
              if (window.location.pathname + window.location.search !== target) {
                window.location.href = target;
              }
            } finally {
              n.close();
            }
          };
        } catch {
          // ignore — Notification can throw under tight tab focus rules
        }
      }
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

      // WARP-331: tag the in-flight stream with the conversationId it
      // belongs to. `null` here means "this is a draft chat that hasn't
      // received its X-Conversation-Id header yet"; we update it as soon
      // as the header arrives below. The exposed `isStreaming` is derived
      // from whether this id matches the user's active conversationId,
      // so switching chats mid-stream unlocks the new chat's input
      // immediately (the orchestrator persists the assistant turn
      // server-side via WARP-329 even if the client navigates away).
      setStreamActive(true);
      setStreamingConversationId(conversationIdRef.current);
      // Mint a fresh AbortController for this turn. Any previous one
      // is stale — sendMessage isn't called while a stream is in flight
      // because the input is disabled, but we still defensively abort
      // the old controller so dangling listeners don't leak.
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      isStoppingRef.current = false;

      const turnId = createTurnId();
      // WARP-329: lazy-ask for Notification permission on the user's first
      // send (never on page load — too aggressive, and Safari is harsh
      // about it). Awaiting here is intentional: we want the prompt to
      // appear right after the user takes a clear action. Don't block on
      // a denial — chat keeps working without notifications.
      void ensureNotificationPermission();
      try {
        const response = await sendChat({
          model,
          messages: replayMessages,
          stream: true,
          signal: controller.signal,
          conversationId: conversationIdRef.current ?? undefined,
          turnId,
        });

        // WARP-304: capture the server-assigned conversation id from the
        // very first turn. Headers are available before the streaming
        // body resolves, so we can reflect it back to the page (and the
        // URL) immediately — no waiting for the stream to end.
        const headerId = response.headers.get(CONVERSATION_ID_HEADER);
        if (headerId && conversationIdRef.current !== headerId) {
          const wasNew = conversationIdRef.current === null;
          conversationIdRef.current = headerId;
          setConversationId(headerId);
          // WARP-331: re-tag the in-flight stream with the real server id
          // so isStreaming derives correctly while the stream is still
          // running. Also migrate any draft-bucket attachments to the
          // new id so the chip row doesn't visibly reset.
          setStreamingConversationId(headerId);
          if (wasNew) {
            const drafted = attachmentsByConvRef.current.get(DRAFT_CONV_KEY);
            if (drafted && drafted.length > 0) {
              attachmentsByConvRef.current.set(headerId, drafted);
            }
            attachmentsByConvRef.current.delete(DRAFT_CONV_KEY);
            notifyHistoryOfNewConversation(
              options.historyHandleRef?.current ?? null,
              { id: headerId, firstUserContent: content },
            );
          }
        }
        // WARP-329: the server's assistant ChatMessage.id, captured from
        // the same response. Not surfaced to the page today — kept on the
        // hook so a future "regenerate this exact reply" UX has a stable
        // handle, and so the WS-driven cross-tab sync (follow-up) can
        // match incoming turn-completed events to a known message.
        const headerAssistantId = response.headers.get(
          ASSISTANT_MESSAGE_ID_HEADER,
        );
        if (headerAssistantId) {
          // No state to set today; reserved for follow-up cross-tab sync.
          // eslint-disable-next-line @typescript-eslint/no-unused-expressions
          headerAssistantId;
        }

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
        // render the aborted FailureChip.
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
        // WARP-331: stamp the just-finished conversation so the MQTT
        // turn-completed handler can skip its auto-refresh — the local
        // stream already wrote the final content, refetching would just
        // remount the bubbles. We stamp the streaming id rather than the
        // current conversationId because the user may have already
        // navigated away (background completion is the whole point).
        const justFinished = streamingConversationIdRef.current;
        if (justFinished) {
          recentlyLocallyCompletedRef.current.set(justFinished, Date.now());
        }
        // Clear both stream-state shards. The exposed `isStreaming` flips
        // false on the next render — for any chat the user is currently
        // viewing.
        setStreamActive(false);
        setStreamingConversationId(null);
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
      const snapshot = messagesRef.current;
      const idx = snapshot.findIndex((m) => m.id === messageId);
      if (idx === -1) return;
      const target = snapshot[idx];
      // Derive the prompt to re-send. Live failures carry retryPrompt on
      // the error field; history-loaded failures (failureKind) don't, so
      // fall back to the preceding user message's content.
      let retryPrompt: string | null = null;
      if (target.error) {
        retryPrompt = target.error.retryPrompt;
      } else if (target.failureKind) {
        const prev = idx > 0 ? snapshot[idx - 1] : null;
        if (prev && prev.role === "user") retryPrompt = prev.content;
      }
      if (retryPrompt == null) return;

      // Drop the failed assistant + the user turn immediately before it
      // so the new turn replays a clean thread.
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        if (i === -1) return prev;
        const userIdx = i > 0 && prev[i - 1].role === "user" ? i - 1 : i;
        return prev.filter((_, k) => k !== i && k !== userIdx);
      });

      await sendMessage(retryPrompt, model, systemPrompt);
    },
    [sendMessage],
  );

  /**
   * WARP-295: re-run an assistant turn. Drops the targeted assistant
   * message plus the immediately-preceding user prompt (the
   * sendMessage updater will re-append both), then re-sends the
   * prompt. Distinct from retryMessage: regenerate is invoked from
   * the message-actions toolbar on a successful turn, retry is the
   * affordance on a failed turn. The two paths share a common
   * "drop-and-resend" shape.
   *
   * No-op when handed a non-assistant id — the page wires this to a
   * button rendered only on the last assistant turn, but defensive
   * guards are cheap and protect against runaway calls if the wiring
   * regresses.
   */
  const regenerate = useCallback(
    async (messageId: string, model: string, systemPrompt?: string) => {
      const snapshot = messagesRef.current;
      const idx = snapshot.findIndex((m) => m.id === messageId);
      if (idx === -1) return;
      const target = snapshot[idx];
      if (target.role !== "assistant") return;
      const prevUser =
        idx > 0 && snapshot[idx - 1].role === "user" ? snapshot[idx - 1] : null;
      if (!prevUser) return;
      const prompt = prevUser.content;

      // Drop both the assistant turn and the user prompt before it;
      // sendMessage will re-append a fresh pair.
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        if (i === -1) return prev;
        const userIdx = i > 0 && prev[i - 1].role === "user" ? i - 1 : i;
        return prev.filter((_, k) => k !== i && k !== userIdx);
      });

      await sendMessage(prompt, model, systemPrompt);
    },
    [sendMessage],
  );

  /**
   * WARP-331: increments every time the messages array is replaced
   * wholesale (loadConversation, clearMessages) rather than appended/
   * mutated by a streaming chunk. The chat page watches this to force a
   * scroll-to-bottom on discrete refresh events without yanking the
   * user mid-stream-citation-read.
   */
  const [messagesEpoch, setMessagesEpoch] = useState(0);

  const clearMessages = useCallback(() => {
    setMessages([]);
    // WARP-304: starting a new chat must detach from the prior persisted
    // conversation — subsequent sends will mint a fresh one server-side.
    setConversationId(null);
    conversationIdRef.current = null;
    setMessagesEpoch((e) => e + 1);
  }, []);

  /**
   * WARP-304: rehydrate a persisted conversation by id. Used on page
   * mount when the URL carries `?c=<id>`. Replaces the in-memory thread
   * and pins `conversationId` so the next turn appends to the right
   * server-side row. Returns `false` when the conversation doesn't exist
   * (or belongs to another user) so the caller can clear the URL hash.
   */
  const loadConversation = useCallback(
    async (id: string): Promise<boolean> => {
      const persisted = await fetchConversation(id).catch(() => null);
      if (!persisted) return false;
      // Filter to user/assistant only — the chat surface doesn't render
      // system or tool messages directly; tool calls live inside the
      // assistant message's `toolCalls` chip row.
      const rebuilt: ChatMessage[] = [];
      for (const m of persisted.messages) {
        if (m.role !== "user" && m.role !== "assistant") continue;
        const failureKind: ChatMessage["failureKind"] =
          m.role === "assistant"
            ? m.status === "failed"
              ? "failed"
              : m.status === "aborted"
                ? "aborted"
                : m.status === "streaming"
                  ? "interrupted"
                  : undefined
            : undefined;
        rebuilt.push({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          ...(m.role === "assistant" && m.toolCalls?.length
            ? {
                toolCalls: m.toolCalls.map((c) => ({
                  id: c.id,
                  name: c.name,
                  args: c.args,
                  ok: c.ok,
                  status: c.status,
                  message: c.message,
                  data: c.data,
                })),
              }
            : {}),
          ...(failureKind ? { failureKind } : {}),
        });
      }
      // Tail-orphan: a user message at the END of the persisted list with no
      // assistant follow-up — usually a server crash after the user row was
      // committed but before the assistant row was created. Synthesize a
      // placeholder so the UI can offer Try-again rather than ending the chat
      // abruptly. Mid-conversation orphans are skipped on purpose (would
      // inject a duplicate turn mid-thread on retry).
      const tail = rebuilt[rebuilt.length - 1];
      if (tail && tail.role === "user") {
        rebuilt.push({
          id: `missing-after-${tail.id}`,
          role: "assistant",
          content: "",
          failureKind: "missing",
        });
      }
      setMessages(rebuilt);
      setConversationId(persisted.id);
      conversationIdRef.current = persisted.id;
      setMessagesEpoch((e) => e + 1);
      return true;
    },
    [],
  );

  /**
   * WARP-331: every attachment mutation routes through this helper so
   * the per-conversation cache stays in sync with the visible state.
   * The cache is keyed by `conversationId` (or `DRAFT_CONV_KEY` before
   * the first turn returns its server-assigned id).
   */
  const mutateAttachments = useCallback(
    (updater: (prev: ChatAttachment[]) => ChatAttachment[]) => {
      const key = conversationIdRef.current ?? DRAFT_CONV_KEY;
      setAttachments((prev) => {
        const next = updater(prev);
        attachmentsByConvRef.current.set(key, next);
        return next;
      });
    },
    [],
  );

  /**
   * Upload a chat-attached file. Adds a pending chip immediately so
   * the user sees feedback within a frame, kicks off the upload, then
   * flips the chip to "indexing" once the orchestrator returns 202.
   * The MQTT-driven effect above flips it again to "ready" / "failed"
   * when extraction completes.
   *
   * Returns the `localId` of the chip so callers can track / remove it.
   */
  const attach = useCallback(
    async (file: File): Promise<string> => {
      const localId = createAttachmentId();
      const pending: ChatAttachment = {
        localId,
        filename: file.name,
        bytes: file.size,
        status: "uploading",
      };
      mutateAttachments((prev) => [...prev, pending]);

      try {
        const res = await uploadBrainFile(file, chatIdRef.current);
        mutateAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? { ...a, itemId: res.itemId, status: "indexing" }
              : a,
          ),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Upload failed";
        mutateAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? { ...a, status: "failed", error: message }
              : a,
          ),
        );
      }
      return localId;
    },
    [mutateAttachments],
  );

  const removeAttachment = useCallback(
    (localId: string) => {
      mutateAttachments((prev) => prev.filter((a) => a.localId !== localId));
    },
    [mutateAttachments],
  );

  const clearAttachments = useCallback(() => {
    const key = conversationIdRef.current ?? DRAFT_CONV_KEY;
    attachmentsByConvRef.current.delete(key);
    setAttachments([]);
  }, []);

  // WARP-331: when the active conversationId changes, swap the visible
  // attachments to the bucket the user is now looking at. The MQTT-driven
  // "indexed" updates from chat A continue to mutate chat A's cache slot
  // even while the user is viewing chat B (via mutateAttachments), so
  // switching back doesn't lose a status flip that landed in the
  // meantime.
  useEffect(() => {
    const key = conversationId ?? DRAFT_CONV_KEY;
    const stored = attachmentsByConvRef.current.get(key) ?? [];
    setAttachments(stored);
  }, [conversationId]);

  // WARP-331: derive the visible streaming lock. The in-flight stream
  // keeps running on the conversation it started for, regardless of
  // where the user navigates; the composer only locks when the user
  // is actually viewing that conversation.
  const isStreaming =
    streamActive && streamingConversationId === conversationId;

  return {
    messages,
    setMessages,
    isStreaming,
    sendMessage,
    stop,
    retryMessage,
    regenerate,
    clearMessages,
    attachments,
    attach,
    removeAttachment,
    clearAttachments,
    // WARP-304
    conversationId,
    loadConversation,
    // WARP-331 — increments on every wholesale message-array replacement
    // (load, clear). The chat page watches this to force a scroll-to-
    // bottom on discrete refresh events without yanking the user
    // mid-stream-citation-read.
    messagesEpoch,
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
        // WARP-295: when the matching tool is a retrieval tool, fold
        // its result rows into the assistant message's citations. The
        // chip row below the bubble re-renders as each result lands so
        // sources appear alongside the streaming answer.
        const toolName = calls[callIdx].name;
        const newCitations =
          evt.ok && evt.status !== "confirmation_required"
            ? extractCitations(toolName, evt.data)
            : [];
        let mergedCitations = last.citations;
        if (newCitations.length > 0) {
          const seen = new Set((mergedCitations ?? []).map(citationKey));
          const additions: ChatCitation[] = [];
          for (const c of newCitations) {
            const k = citationKey(c);
            if (seen.has(k)) continue;
            seen.add(k);
            additions.push(c);
          }
          if (additions.length > 0) {
            mergedCitations = [...(mergedCitations ?? []), ...additions];
          }
        }
        updated[idx] = {
          ...last,
          toolCalls: updatedCalls,
          ...(mergedCitations ? { citations: mergedCitations } : {}),
        };
        return updated;
      }
      case "done": {
        if (evt.stop_reason === "error") {
          // eslint-disable-next-line no-console
          console.error("[chat] agent loop ended with error:", evt.error);
          const updated = [...prev];
          updated[idx] = {
            ...last,
            // DASH-03: do NOT set `failureKind` on a live turn. Per the
            // types.ts contract `failureKind` is populated exclusively by
            // loadConversation; setting "interrupted" here would win the
            // FailureChip precedence (`failureKind ?? (error ? "failed" : …)`)
            // and show the generic "Interrupted — the reply didn't finish."
            // copy instead of this live retry message. Setting `error` alone
            // derives "failed", whose chip renders this message + a retry,
            // and any partial content that already streamed still shows via
            // the `message.content &&` render guard.
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
