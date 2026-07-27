"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  sendChat,
  uploadBrainFile,
  fetchConversation,
  getBrainMemoryItems,
  runSceneConfirmed,
  truncateConversation,
  setMessageFeedback,
} from "../api";
import type { ScoreKind } from "../relevance";
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

/** WARP-844: the persisted user-row id for this turn. The hook re-ids the
 *  optimistic user bubble with it so edit-and-resend can truncate the
 *  server thread by a real row id, even on a live (non-reloaded) chat. */
const USER_MESSAGE_ID_HEADER = "x-user-message-id";

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
  scoreKind?: unknown;
  text?: string;
  snippet?: string;
  brainItemId?: string | null;
  brain_item_id?: string | null;
  mimeType?: string;
  mime_type?: string;
}

/**
 * WARP-1611 — accept only the two kinds the renderer understands. Anything
 * else is dropped so it falls back to `inferScoreKind`: `relevancePct` treats
 * every non-"logit" kind as already-bounded, so forwarding an unrecognised
 * tag would clamp a negative logit to 0% while looking authoritative — the
 * WARP-859/1603 bug this tag exists to prevent.
 */
function scoreKindOf(raw: unknown): ScoreKind | undefined {
  return raw === "logit" || raw === "similarity" ? raw : undefined;
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
      scoreKind: scoreKindOf(r.scoreKind),
      brainItemId: r.brainItemId ?? r.brain_item_id ?? null,
      snippet: r.snippet ?? r.text ?? undefined,
      mimeType: r.mimeType ?? r.mime_type ?? undefined,
    });
  }
  return out;
}

/**
 * WARP-1603 — rebuild an assistant turn's citation chips from its
 * PERSISTED tool calls.
 *
 * Citations are derived client-side from `search_content` results and are
 * never persisted as their own column, so `loadConversation` used to
 * rehydrate `toolCalls` while dropping `citations` entirely — the chip row
 * vanished on refresh even though the underlying `data` blob was right
 * there. Replaying the same extractor over the stored results restores the
 * exact chips the turn showed live.
 *
 * Gating mirrors the live `tool_result` path: only successful,
 * non-`confirmation_required` results contribute, and rows dedupe on
 * `citationKey` in first-seen order.
 */
function citationsFromToolCalls(
  calls: ReadonlyArray<{
    name: string;
    ok?: boolean;
    status?: string;
    data?: unknown;
  }>,
): ChatCitation[] {
  const out: ChatCitation[] = [];
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.ok !== true) continue;
    if (call.status === "confirmation_required") continue;
    for (const c of extractCitations(call.name, call.data)) {
      const k = citationKey(c);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(c);
    }
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
 *   - `model_loading` → the selected model needs a cold load (WARP-903);
 *                       show an explicit loading state until the next event
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
  /**
   * WARP-640 — one-click re-issue handle forwarded by the orchestrator when a
   * tool returns `confirmation_required` and supports completing in chat (e.g.
   * `run_scene`). The chip renders an "Approve & run" button that re-POSTs with
   * this single-use token.
   */
  confirmation?: {
    kind: string;
    sceneId?: string;
    confirmationToken: string;
  };
}

interface ReasoningStepEvent extends SSEEventBase {
  type: "reasoning_step";
  text: string;
}

/**
 * WARP-903 — the orchestrator's pre-agent-loop cold-load signal: the
 * selected model is installed in Ollama but not resident in memory, so
 * the first token is 30-60 s away. Arrives at most once, always before
 * any other event on the turn. `sizeGb` is decimal gigabytes (one
 * decimal), or null when unreported.
 */
interface ModelLoadingEvent extends SSEEventBase {
  type: "model_loading";
  model: string;
  sizeGb: number | null;
}

interface DoneEvent extends SSEEventBase {
  type: "done";
  iterations: number;
  stop_reason:
    | "model_done"
    | "iteration_limit"
    | "error"
    | "context_budget"
    | "repetition";
  error?: string;
}

type SSEEvent =
  | ContentDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ReasoningStepEvent
  | ModelLoadingEvent
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

/**
 * Map a non-OK pre-stream response from POST /api/llm/chat to friendly copy.
 *
 * The orchestrator can reject a turn with a JSON error BEFORE the SSE stream
 * starts (e.g. a role-narrowed write-tool replay → 403 `forbidden_tool_for_role`
 * in `apps/orchestrator/src/routes/llm.ts`, or a re-submitted terminal turn →
 * 409 `turn_already_completed`). Without handling these, the reader sees a
 * non-stream body and the assistant bubble renders blank. We best-effort parse
 * the `{ error }` body (it mirrors `runSceneConfirmed` in api.ts) and give the
 * well-known codes their own copy.
 *
 * The server's own `message` is deliberately NOT surfaced: these bodies are
 * written for an operator reading logs, and this is a chat bubble. Codes map
 * to copy here, the same way every other branch below does.
 */
function friendlyPreStreamError(status: number, code: string | undefined): string {
  if (code === "forbidden_tool_for_role") {
    return "Your account isn't allowed to run that action. Ask an owner or admin to do it.";
  }
  if (code === "off_lan_blocked") {
    // WARP-1578. T6's per-person cloud gate (451, cloud-access.service.ts)
    // refuses a turn that would reach a cloud provider. Without this the
    // refusal rendered as "Something went wrong… Try again." — untrue
    // (a sovereignty control did exactly its job) and unactionable (the
    // retry produces the identical refusal, forever).
    //
    // It names the off-box moment and both remedies, and names NEITHER limb
    // of the AND-gate: cloud access needs the box's off-LAN channel AND a
    // role that permits cloud models, the resolver returns one boolean, and
    // guessing would send half these people to the wrong settings page.
    // Same voice as the email surface's off-LAN copy (api.ts).
    return "Cloud models leave your Droplet, and they're turned off for this account. Pick a model that runs on your Droplet, or ask an admin to allow cloud models.";
  }
  if (code === "turn_already_completed") {
    return "This reply already finished. Open the conversation again to see it.";
  }
  if (code === "empty_replay") {
    // The orchestrator's backstop for the empty-thread replay bug this
    // branch fixes client-side: a request whose `messages` carry no user
    // turn is rejected before the agent loop (routes/llm.ts). Seeing this
    // copy means the dashboard serialized a user-turn-less thread again.
    return "The app sent an empty conversation, so the AI had nothing to answer. Refresh the page and try again.";
  }
  if (status === 401 || status === 403) {
    return "You're not allowed to do that right now. Try signing in again.";
  }
  if (status === 429) {
    return "The Droplet AI is busy right now. Give it a moment and try again.";
  }
  return "Something went wrong on this turn. Try again.";
}

let attachmentCounter = 0;

/**
 * Hard cap on attachments per conversation — mirrors the route schema's
 * `.max(8)` on POST /api/llm/chat. Enforced at attach time with a
 * visible failed chip; without this, the 9th+ chip rendered as attached
 * but was silently never sent to the model.
 */
export const MAX_ATTACHMENTS_PER_CONVERSATION = 8;

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
  args: { id: string; firstUserContent: string; projectId?: string | null },
): void {
  if (!handle) return;
  const now = new Date().toISOString();
  handle.optimisticInsert({
    id: args.id,
    title: deriveOptimisticTitle(args.firstUserContent),
    model: null,
    provider: null,
    // WARP-845 — mirror the server-side project stamp so the new chat
    // lands under its folder in the sidebar, not in the date groups.
    projectId: args.projectId ?? null,
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
  /**
   * DASH-04: whether an authenticated user is present. The chat WS bridge
   * (`/api/ws/events`) is only opened when this is true, so we don't
   * connect — and then reconnect-with-backoff forever — on an
   * unauthenticated or expired session before auth resolves. Mirrors the
   * `if (!user) return` gate `NotificationToaster` already applies to the
   * same endpoint. Defaults to `true` so callers that don't pass it (and
   * unit tests) keep the prior always-connect behavior.
   */
  authReady?: boolean;
  /**
   * Fires after `loadConversation` successfully rehydrates a persisted
   * thread, with the conversation's persisted metadata. The chat page
   * uses it to restore the model the conversation was held in (the
   * picker otherwise keeps whatever model happened to be selected).
   */
  onConversationLoaded?: (meta: {
    id: string;
    model: string | null;
    systemPrompt: string | null;
  }) => void;
  /** WARP-845 — project the NEXT new conversation should be filed under
   *  (set when the user starts a chat from a project's "+"). Sent on the
   *  first turn only; the server validates ownership. */
  projectId?: string | null;
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
   * WARP-859 — conversation-scoped attachment list: everything ever
   * attached to this chat. Distinct from the composer staging
   * `attachments` above, which now CLEARS on send (the file rides onto
   * the sent message and leaves the input). This list feeds SessionHeader
   * and the per-turn content re-injection (turnAttachments), and survives
   * reload (rehydrated from the server's brain items). Same per-conv
   * bucketing as the composer cache.
   */
  const [sessionAttachments, setSessionAttachments] = useState<ChatAttachment[]>([]);
  const sessionByConvRef = useRef<Map<string, ChatAttachment[]>>(new Map());
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

  // Staleness guard for loadConversation's post-await writes. Each load
  // (and clearMessages) bumps the epoch; a load that awakes from an await
  // to find the epoch moved on MUST NOT write — otherwise switching
  // conversations mid-load lets the slow loser clobber the winner's
  // attachments/model/prompt (and a late chip restore would then leak
  // conversation A's itemIds into B's next turn via attachmentsRef).
  const loadEpochRef = useRef(0);

  // Same ref treatment for the pending project id (WARP-845).
  const projectIdRef = useRef(options.projectId);
  useEffect(() => {
    projectIdRef.current = options.projectId;
  }, [options.projectId]);

  // Same ref treatment for the loaded-conversation callback so the
  // stable `loadConversation` sees the caller's latest prop.
  const onConversationLoadedRef = useRef(options.onConversationLoaded);
  useEffect(() => {
    onConversationLoadedRef.current = options.onConversationLoaded;
  }, [options.onConversationLoaded]);

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

  // Ref-mirror of the visible attachment chips so `sendMessage` (a
  // stable callback) can read the current conversation's attachments
  // when building the request. The visible list always tracks the
  // active conversation (see the bucket-swap effect below), which is
  // exactly the conversation a send targets.
  const attachmentsRef = useRef<ChatAttachment[]>([]);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  // WARP-859 — ref-mirror of the conversation-scoped list so the send
  // path can read+merge it synchronously when building the turn.
  const sessionAttachmentsRef = useRef<ChatAttachment[]>([]);
  useEffect(() => {
    sessionAttachmentsRef.current = sessionAttachments;
  }, [sessionAttachments]);

  // ── MQTT-driven attachment status updates ──
  //
  // The orchestrator's WS bridge forwards `droplet/files/<user>/brain/indexed`
  // messages; we map `{itemId, status: "ready"|"failed", reason?}` onto
  // the local attachment list, flipping the chip in place. Mounting the
  // socket here (rather than inside ChatInput) keeps the chip state in
  // a single owner — the hook — so the Composer can render N chips
  // from the same source without duplicating the subscription.
  //
  // DASH-04: only open the socket once an authenticated user is present.
  // Without this gate the effect connected on mount (deps `[]`) even on an
  // unauthenticated / expired session and then reconnected with backoff
  // indefinitely against a `/api/ws/events` endpoint that just closes the
  // upgrade. Gating on `authReady` (and listing it in the deps) means the
  // socket opens exactly once auth resolves — same `if (!user) return`
  // treatment NotificationToaster applies to the same endpoint.
  const authReady = options.authReady ?? true;
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!authReady) return;
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
        // WARP-859 — keep the conversation-scoped list (SessionHeader +
        // re-injection) in lockstep so a file attached and sent while
        // still "indexing" flips to "ready" there too.
        for (const [key, list] of sessionByConvRef.current) {
          sessionByConvRef.current.set(key, list.map(flip));
        }
        setSessionAttachments((prev) => prev.map(flip));
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
  }, [authReady]);

  const sendMessage = useCallback(
    async (
      content: string,
      model: string,
      systemPrompt?: string,
      // WARP-904 — the provider of the currently-selected model, looked
      // up by the caller from `/api/llm/models`. Forwarded verbatim so
      // the orchestrator persists an explicit provider on this turn
      // instead of inferring one from the model name.
      provider?: string,
    ) => {
      // WARP-859 — files staged in the composer ride onto THIS message
      // and then leave the input. Snapshot the staged chips for display
      // on the user bubble, and fold them into the conversation-scoped
      // session list (deduped by itemId) so they stay attached to the
      // chat (SessionHeader, per-turn re-injection) after the composer
      // clears.
      const stagedSnapshot = attachmentsRef.current.slice();
      const sessionKey = conversationIdRef.current ?? DRAFT_CONV_KEY;
      const mergedSession = (() => {
        const byKey = new Map(
          sessionAttachmentsRef.current.map((a) => [a.itemId ?? a.localId, a]),
        );
        for (const a of stagedSnapshot) byKey.set(a.itemId ?? a.localId, a);
        return [...byKey.values()];
      })();

      const userMessage: ChatMessage = {
        id: createId(),
        role: "user",
        content,
        ...(stagedSnapshot.length > 0
          ? { attachments: stagedSnapshot }
          : {}),
      };
      const assistantMessage: ChatMessage = {
        id: createId(),
        role: "assistant",
        content: "",
      };

      // Snapshot the full thread up to this turn so we can hand it to
      // /api/llm/chat. The route is stateless; replay is on us. Build the
      // snapshot synchronously from the ref-mirror, NEVER inside the
      // setMessages updater: React defers the updater whenever another
      // update is already pending — which is every drop-then-send caller
      // (retryMessage, regenerate, editMessage) — so sendChat would
      // serialize the request body while replayMessages was still empty,
      // and the model, seeing a blank thread, answered every retry with
      // a generic greeting. Skip assistant turns with no content and
      // ones that ended in an error — replaying "I can't reach the
      // Droplet…" back to the model would just confuse it.
      const replayMessages: { role: string; content: string }[] = [];
      if (systemPrompt) {
        replayMessages.push({ role: "system", content: systemPrompt });
      }
      for (const m of messagesRef.current) {
        if (m.role === "assistant" && !m.content) continue;
        if (m.role === "assistant" && m.error) continue;
        replayMessages.push({ role: m.role, content: m.content });
      }
      replayMessages.push({ role: "user", content });
      setMessages((prev) => [...prev, userMessage, assistantMessage]);
      // Keep the ref-mirror in lockstep for any synchronous reader that
      // runs before the commit (e.g. a second retry click this tick).
      messagesRef.current = [
        ...messagesRef.current,
        userMessage,
        assistantMessage,
      ];

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
      // WARP-844: persisted assistant row id, captured from the response
      // headers inside the try block; consumed in finally (re-id).
      let headerAssistantId: string | null = null;
      let preStreamError = false;
      // WARP-329: lazy-ask for Notification permission on the user's first
      // send (never on page load — too aggressive, and Safari is harsh
      // about it). Awaiting here is intentional: we want the prompt to
      // appear right after the user takes a clear action. Don't block on
      // a denial — chat keeps working without notifications.
      void ensureNotificationPermission();
      // Reference every uploaded attachment chip on this turn (chips
      // persist for the conversation's lifetime, mirroring how an
      // attached file stays in context for the whole conversation).
      // Chips still uploading have no itemId yet and are skipped — the
      // orchestrator resolves the live status (ready / indexing /
      // failed) per item, so a stale client status can't mislead it.
      // Cap matches the route schema's `.max(8)`. WARP-859: source from
      // the merged conversation-scoped list (not just the composer) so an
      // attached doc stays injected for follow-up turns even though the
      // composer cleared after the turn that attached it.
      const turnAttachments = mergedSession
        .filter((a): a is ChatAttachment & { itemId: string } =>
          Boolean(a.itemId),
        )
        .slice(0, MAX_ATTACHMENTS_PER_CONVERSATION)
        .map((a) => ({ itemId: a.itemId }));

      // Commit the merged session list + clear the composer staging area.
      // Keyed by the same conv slot the chips live in (DRAFT on a first
      // turn); the draft→real migration below moves both buckets.
      if (mergedSession.length > 0) {
        sessionByConvRef.current.set(sessionKey, mergedSession);
        setSessionAttachments(mergedSession);
      }
      if (stagedSnapshot.length > 0) {
        attachmentsByConvRef.current.set(sessionKey, []);
        setAttachments([]);
      }

      try {
        const response = await sendChat({
          model,
          // WARP-904 — explicit provider for this turn's audit trail
          // (omitted entirely when the caller doesn't know it, so the
          // server falls back to its existing name-based routing).
          ...(provider ? { provider } : {}),
          messages: replayMessages,
          stream: true,
          signal: controller.signal,
          conversationId: conversationIdRef.current ?? undefined,
          turnId,
          // First turn of a draft chat: hand the server the client-minted
          // chatId so it adopts any draft-phase uploads (even ones whose
          // upload finishes after this send) into the new conversation.
          ...(conversationIdRef.current === null && chatIdRef.current
            ? { draftChatId: chatIdRef.current }
            : {}),
          // WARP-845 — file the new conversation under the active project.
          ...(conversationIdRef.current === null && projectIdRef.current
            ? { projectId: projectIdRef.current }
            : {}),
          // WARP-458 — surface the model's reasoning trace live; the
          // disclosure stays collapsed unless the user opens it.
          captureReasoning: true,
          ...(turnAttachments.length > 0
            ? { attachments: turnAttachments }
            : {}),
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
            // WARP-859 — move the conversation-scoped session bucket from
            // the draft slot to the real id too, so SessionHeader + the
            // per-turn re-injection keep finding the chat's attachments.
            const draftSession = sessionByConvRef.current.get(DRAFT_CONV_KEY);
            if (draftSession && draftSession.length > 0) {
              sessionByConvRef.current.set(headerId, draftSession);
            }
            sessionByConvRef.current.delete(DRAFT_CONV_KEY);
            notifyHistoryOfNewConversation(
              options.historyHandleRef?.current ?? null,
              {
                id: headerId,
                firstUserContent: content,
                projectId: projectIdRef.current ?? null,
              },
            );
          }
        }
        // WARP-329: the server's assistant ChatMessage.id, captured from
        // the same response. Not surfaced to the page today — kept on the
        // hook so a future "regenerate this exact reply" UX has a stable
        // handle, and so the WS-driven cross-tab sync (follow-up) can
        // match incoming turn-completed events to a known message.
        headerAssistantId = response.headers.get(ASSISTANT_MESSAGE_ID_HEADER);
        // WARP-844: swap the optimistic user bubble's local id for the
        // persisted row id so a later edit can truncate server-side.
        const headerUserId = response.headers.get(USER_MESSAGE_ID_HEADER);
        if (headerUserId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === userMessage.id ? { ...m, id: headerUserId } : m,
            ),
          );
          userMessage.id = headerUserId;
        }

        // Pre-stream error guard. The orchestrator can reply with a JSON
        // error (400/401/403/409/429) BEFORE the SSE stream begins — e.g. a
        // role-narrowed write-tool replay (403 forbidden_tool_for_role) or a
        // re-submitted terminal turn (409 turn_already_completed). Reading
        // that JSON body as an SSE stream yields no frames, leaving a silent
        // blank assistant bubble. Best-effort parse the `{ error }` body
        // (mirrors runSceneConfirmed in api.ts) and surface it on the
        // placeholder exactly like the catch block below, so the FailureChip
        // + Try-again render.
        if (!response.ok) {
          const data = (await response.json().catch(() => ({}))) as {
            error?: string;
            message?: string;
            code?: string;
          };
          const code = data.code ?? data.error;
          const friendly = friendlyPreStreamError(response.status, code);
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
          preStreamError = true;
          return;
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
        if (justFinished && !preStreamError) {
          recentlyLocallyCompletedRef.current.set(justFinished, Date.now());
        }
        // WARP-844: swap the assistant placeholder's local id for the
        // persisted row id AFTER the stream settles (doing it mid-stream
        // would orphan applyEvent's delta routing, which captures the
        // local id). Live turns become ratable / addressable server-side.
        if (headerAssistantId) {
          const persistedId = headerAssistantId;
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMessage.id ? { ...m, id: persistedId } : m,
            ),
          );
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
    async (
      messageId: string,
      model: string,
      systemPrompt?: string,
      provider?: string,
    ) => {
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
      if (!retryPrompt) return;

      // Drop the failed assistant + the user turn immediately before it
      // so the new turn replays a clean thread.
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        if (i === -1) return prev;
        const userIdx = i > 0 && prev[i - 1].role === "user" ? i - 1 : i;
        return prev.filter((_, k) => k !== i && k !== userIdx);
      });
      // Mirror the drop into messagesRef synchronously — sendMessage
      // builds the replay thread from the ref, and the updater above
      // won't have run yet (same idiom as editMessage).
      const dropUserIdx =
        idx > 0 && snapshot[idx - 1].role === "user" ? idx - 1 : idx;
      messagesRef.current = snapshot.filter(
        (_, k) => k !== idx && k !== dropUserIdx,
      );

      await sendMessage(retryPrompt, model, systemPrompt, provider);
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
    async (
      messageId: string,
      model: string,
      systemPrompt?: string,
      provider?: string,
    ) => {
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
      // Mirror the drop into messagesRef synchronously — sendMessage
      // builds the replay thread from the ref (see retryMessage).
      const dropUserIdx =
        idx > 0 && snapshot[idx - 1].role === "user" ? idx - 1 : idx;
      messagesRef.current = snapshot.filter(
        (_, k) => k !== idx && k !== dropUserIdx,
      );

      await sendMessage(prompt, model, systemPrompt, provider);
    },
    [sendMessage],
  );

  /**
   * WARP-844: thumbs rating. Optimistic local flip + server PATCH;
   * reverts on failure. Clicking the active thumb again clears (null).
   */
  const rateMessage = useCallback(
    async (messageId: string, feedback: "up" | "down" | null) => {
      const convId = conversationIdRef.current;
      const prevValue = messagesRef.current.find((m) => m.id === messageId)
        ?.feedback ?? null;
      const apply = (value: "up" | "down" | null) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id === messageId ? { ...m, feedback: value } : m,
          ),
        );
      apply(feedback);
      if (!convId) return;
      try {
        await setMessageFeedback(convId, messageId, feedback);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[chat] feedback save failed:", err);
        apply(prevValue);
      }
    },
    [],
  );

  /**
   * WARP-844: edit & resend a user turn. Slices the local thread to just
   * BEFORE the edited message, truncates the persisted thread from that
   * row onward (so a reload matches), then re-sends the edited prompt
   * through the normal sendMessage path. Truncation failures degrade to
   * a local-only edit — the chat keeps working; only a reload would show
   * the superseded turns.
   */
  const editMessage = useCallback(
    async (
      messageId: string,
      newContent: string,
      model: string,
      systemPrompt?: string,
      provider?: string,
    ) => {
      const trimmed = newContent.trim();
      if (!trimmed) return;
      const snapshot = messagesRef.current;
      const idx = snapshot.findIndex((m) => m.id === messageId);
      if (idx === -1) return;
      if (snapshot[idx].role !== "user") return;

      const convId = conversationIdRef.current;
      if (convId) {
        try {
          await truncateConversation(convId, messageId);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn("[chat] truncate before edit failed:", err);
        }
        // The truncate is a real network round-trip and nothing locks the
        // UI during it — if the user switched conversations (or hit
        // "+ New chat", nulling the ref) mid-await, sending now would
        // append the edited prompt to the WRONG thread while the original
        // one is already truncated server-side. Bail; the user can redo
        // the edit on the (still-truncated) original conversation.
        if (conversationIdRef.current !== convId) return;
      }

      // Drop the edited message and everything after it; sendMessage
      // re-appends the edited prompt + a fresh assistant placeholder.
      // Re-derive the slice point from the CURRENT thread (it may have
      // changed during the await) instead of the stale pre-await snapshot.
      const current = messagesRef.current;
      const currentIdx = current.findIndex((m) => m.id === messageId);
      if (currentIdx === -1) return;
      setMessages((prev) => {
        const i = prev.findIndex((m) => m.id === messageId);
        return i === -1 ? prev : prev.slice(0, i);
      });
      messagesRef.current = current.slice(0, currentIdx);

      await sendMessage(trimmed, model, systemPrompt, provider);
    },
    [sendMessage],
  );

  /**
   * WARP-640: complete an in-chat `run_scene` confirmation. The chip's
   * "Approve & run" button calls this with the assistant message id + the
   * tool-call id; we read the single-use `confirmationToken` the tool_result
   * stamped onto that call and echo it back to `POST /api/scenes/:id/run`.
   *
   * The chip walks idle → running → ran/failed. On success the approval block
   * dismisses and the chip flips green (all actions ran) or red (partial). On
   * failure the block stays but flips to a failed note: the token is single-use
   * and already spent server-side, so there's no dead "retry same token"
   * affordance — the copy tells the user to ask again, which mints a fresh one.
   *
   * Guards against double-submit (ignores a call already running/ran) and
   * against a malformed/absent confirmation handle.
   */
  const approveScene = useCallback(
    async (messageId: string, toolCallId: string) => {
      const snapshot = messagesRef.current;
      const msg = snapshot.find((m) => m.id === messageId);
      const call = msg?.toolCalls?.find((c) => c.id === toolCallId);
      const confirmation = call?.confirmation;
      if (
        !call ||
        !confirmation ||
        confirmation.kind !== "scene_run" ||
        !confirmation.sceneId
      ) {
        return;
      }
      if (call.confirmState === "running" || call.confirmState === "ran") return;

      const patchCall = (patch: Partial<ChatToolCall>) =>
        setMessages((prev) =>
          prev.map((m) =>
            m.id !== messageId
              ? m
              : {
                  ...m,
                  toolCalls: m.toolCalls?.map((c) =>
                    c.id === toolCallId ? { ...c, ...patch } : c,
                  ),
                },
          ),
        );

      patchCall({ confirmState: "running" });
      try {
        const outcome = await runSceneConfirmed(
          confirmation.sceneId,
          confirmation.confirmationToken,
        );
        const allSucceeded = outcome.successCount === outcome.actionCount;
        patchCall({
          confirmState: "ran",
          // Clearing confirmation_required dismisses the amber approval block;
          // `ok` flips the chip green (all ran) / red (partial).
          status: allSucceeded ? "ok" : "error",
          ok: allSucceeded,
          message: allSucceeded
            ? `Ran all ${outcome.actionCount} action(s).`
            : `Ran ${outcome.successCount} of ${outcome.actionCount} action(s) — ${outcome.actionCount - outcome.successCount} failed.`,
        });
      } catch (e) {
        patchCall({
          confirmState: "failed",
          message:
            e instanceof Error ? e.message : "Couldn't run the scene.",
        });
      }
    },
    [],
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
    // Invalidate any in-flight loadConversation (see loadEpochRef).
    loadEpochRef.current += 1;
    setMessages([]);
    // Keep the ref-mirror in lockstep so a send in the same tick can't
    // replay the cleared thread into the new conversation.
    messagesRef.current = [];
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
      const epoch = ++loadEpochRef.current;
      const persisted = await fetchConversation(id).catch(() => null);
      if (!persisted) return false;
      // A newer load (or "+ New chat") superseded this one mid-fetch —
      // drop the result instead of clobbering the winner's state.
      if (loadEpochRef.current !== epoch) return false;
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
                  : // WARP-854 — ghost turns: rows persisted as `completed`
                    // with no visible output and no tool activity (the
                    // pre-fix empty-completion bug, e.g. context-window
                    // overflow). Without this they render as nothing at
                    // all; mapping to "failed" surfaces the retry chip.
                    m.content.trim().length === 0 &&
                      (!m.toolCalls || m.toolCalls.length === 0)
                    ? "failed"
                    : undefined
            : undefined;
        const restoredToolCalls =
          m.role === "assistant" && m.toolCalls?.length
            ? m.toolCalls.map((c) => ({
                id: c.id,
                name: c.name,
                args: c.args,
                ok: c.ok,
                status: c.status,
                message: c.message,
                data: c.data,
                // WARP-640 — restore the confirmation handle so a chip
                // reloaded in `confirmation_required` still renders the
                // "Approve & run" button (mirrors the live tool_result
                // path above). The amber block guards re-clicks via the
                // server's 403 on a consumed/expired token. (review #497)
                ...(c.confirmation ? { confirmation: c.confirmation } : {}),
              }))
            : undefined;
        // WARP-1603 — citations aren't persisted as their own column; they
        // are re-derived from the retrieval tool results stored on the
        // turn. Without this the chip row disappeared on every refresh.
        const restoredCitations = restoredToolCalls
          ? citationsFromToolCalls(restoredToolCalls)
          : [];
        rebuilt.push({
          id: m.id,
          role: m.role as "user" | "assistant",
          content: m.content,
          // WARP-458 — re-render the persisted trace without re-running
          // inference.
          ...(m.role === "assistant" && m.reasoning
            ? { reasoning: m.reasoning }
            : {}),
          ...(m.role === "assistant" && m.feedback
            ? { feedback: m.feedback }
            : {}),
          // WARP-904 — per-message audit trail (persisted on both user
          // and assistant rows going forward; absent on older history).
          ...(m.model ? { model: m.model } : {}),
          ...(m.provider ? { provider: m.provider } : {}),
          ...(restoredToolCalls ? { toolCalls: restoredToolCalls } : {}),
          ...(restoredCitations.length > 0
            ? { citations: restoredCitations }
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
      // Keep the ref-mirror in lockstep so a send issued before the commit
      // (e.g. a pending-prompt auto-send) replays the loaded thread, not
      // the previous conversation's.
      messagesRef.current = rebuilt;
      setConversationId(persisted.id);
      conversationIdRef.current = persisted.id;
      setMessagesEpoch((e) => e + 1);
      // Surface the persisted metadata so the page can restore the model
      // this conversation was held in. Read through a ref so the stable
      // callback sees the caller's latest prop.
      onConversationLoadedRef.current?.({
        id: persisted.id,
        model: persisted.model ?? null,
        systemPrompt: persisted.systemPrompt ?? null,
      });
      // Rehydrate the attachment chip row. Uploads are tagged with the
      // conversationId (directly post-first-turn; via the orchestrator's
      // re-stamp for draft-phase uploads), so the brain-items list filtered
      // by originatingChatId is exactly this conversation's attachments.
      // Best-effort: a failed fetch leaves the chips empty, same as before
      // this rehydration existed.
      try {
        const { items } = await getBrainMemoryItems({
          originatingChatId: persisted.id,
        });
        // Superseded while fetching chips: the conversation itself loaded
        // fine (return true below), but the chip write belongs to a view
        // the user already left.
        if (loadEpochRef.current !== epoch) return true;
        // Deterministic chip set: oldest-first, capped to the same limit
        // attach() enforces — so a reload selects the SAME 8 the live
        // session referenced, not a different newest-first subset.
        const ordered = [...items].sort((a, b) =>
          String((a as { uploadedAt?: string }).uploadedAt ?? "").localeCompare(
            String((b as { uploadedAt?: string }).uploadedAt ?? ""),
          ),
        );
        const chips: ChatAttachment[] = ordered
          .slice(0, MAX_ATTACHMENTS_PER_CONVERSATION)
          .map((i) => ({
          localId: `att-rehydrated-${i.id}`,
          itemId: i.id,
          filename: i.filename,
          bytes: Number((i as { bytes?: number }).bytes ?? 0),
          mimeType: (i as { mimeType?: string }).mimeType ?? undefined,
          status:
            i.status === "ready"
              ? "ready"
              : i.status === "failed"
                ? "failed"
                : // indexing | queued_for_transcription both render as
                  // the in-progress chip; the WS bridge flips them live.
                  "indexing",
          ...(i.failureReason ? { error: i.failureReason } : {}),
        }));
        // WARP-859 — on reload the chat's attachments are conversation
        // history, not staged input: populate the session-scoped list
        // (SessionHeader + re-injection) and leave the composer empty.
        sessionByConvRef.current.set(persisted.id, chips);
        setSessionAttachments(chips);
        attachmentsByConvRef.current.set(persisted.id, []);
        setAttachments([]);
      } catch {
        // non-fatal — chat renders without chips
      }
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
      // Enforce the per-conversation cap (failed chips don't count —
      // they hold no itemId and are never sent).
      const active = attachmentsRef.current.filter(
        (a) => a.status !== "failed",
      ).length;
      if (active >= MAX_ATTACHMENTS_PER_CONVERSATION) {
        mutateAttachments((prev) => [
          ...prev,
          {
            localId,
            filename: file.name,
            bytes: file.size,
            mimeType: file.type || undefined,
            status: "failed",
            error: `Attachment limit reached (${MAX_ATTACHMENTS_PER_CONVERSATION} per conversation).`,
          },
        ]);
        return localId;
      }
      const pending: ChatAttachment = {
        localId,
        filename: file.name,
        bytes: file.size,
        mimeType: file.type || undefined,
        // Retained in-memory so the composer chip can show a thumbnail; the
        // send path only ever transmits { itemId }, never the File.
        file,
        status: "uploading",
      };
      mutateAttachments((prev) => [...prev, pending]);

      try {
        // Prefer the durable server conversationId as the brain tag once
        // one exists — the orchestrator also re-stamps draft uploads to
        // it on the next turn, so every item in a persisted conversation
        // ends up queryable by `originatingChatId = conversationId`
        // (which is what loadConversation's chip rehydration reads).
        // Pre-first-turn drafts fall back to the client-minted chatId.
        const res = await uploadBrainFile(
          file,
          conversationIdRef.current ?? chatIdRef.current,
        );
        // Drive the chip from the server's reported status, not a hard-coded
        // "indexing". A WARP-864 dedup hit against an already-processed file
        // returns its CURRENT status (e.g. "ready"), and since no re-ingest
        // runs there is no later WS `/brain/indexed` flip to rescue it — so
        // the chip must reflect res.status now or it would spin forever.
        // "queued_for_transcription" has no chip variant; it renders as the
        // working spinner like "indexing".
        const chipStatus: ChatAttachment["status"] =
          res.status === "ready"
            ? "ready"
            : res.status === "failed"
              ? "failed"
              : "indexing";
        mutateAttachments((prev) =>
          prev.map((a) =>
            a.localId === localId
              ? { ...a, itemId: res.itemId, status: chipStatus }
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
    // WARP-859 — a fresh chat (handleNewChat / URL-clear reset) drops the
    // conversation-scoped list too, so a new thread starts with no
    // inherited attachments.
    sessionByConvRef.current.delete(key);
    setSessionAttachments([]);
  }, []);

  // WARP-331: when the active conversationId changes, swap the visible
  // attachments to the bucket the user is now looking at. The MQTT-driven
  // "indexed" updates from chat A continue to mutate chat A's cache slot
  // even while the user is viewing chat B (via mutateAttachments), so
  // switching back doesn't lose a status flip that landed in the
  // meantime.
  useEffect(() => {
    const key = conversationId ?? DRAFT_CONV_KEY;
    setAttachments(attachmentsByConvRef.current.get(key) ?? []);
    // WARP-859 — swap the conversation-scoped list in lockstep.
    setSessionAttachments(sessionByConvRef.current.get(key) ?? []);
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
    editMessage,
    rateMessage,
    approveScene,
    clearMessages,
    attachments,
    /** WARP-859 — every attachment on this conversation (for SessionHeader);
     *  the composer `attachments` above clears on send. */
    sessionAttachments,
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
    if (prev[idx].role !== "assistant") return prev;

    // WARP-903 — the cold-load window. A `model_loading` event stamps the
    // loading payload onto the placeholder; ANY other event first clears
    // it (first token, reasoning step, tool call, and done all mean the
    // model is resident, so the loading copy must go — including on paths
    // below that otherwise return the array unchanged).
    if (evt.type === "model_loading") {
      const updated = [...prev];
      updated[idx] = {
        ...updated[idx],
        modelLoading: { model: evt.model, sizeGb: evt.sizeGb },
      };
      return updated;
    }
    let base = prev;
    if (prev[idx].modelLoading) {
      base = [...prev];
      base[idx] = { ...base[idx], modelLoading: undefined };
    }
    const last = base[idx];

    switch (evt.type) {
      case "content_delta": {
        const updated = [...base];
        updated[idx] = { ...last, content: last.content + evt.text };
        return updated;
      }
      case "reasoning_step": {
        // WARP-458 — steps arrive before the answer's content_delta;
        // concatenate with blank lines, mirroring how the orchestrator
        // persists the trace to ChatMessage.reasoning.
        const updated = [...base];
        updated[idx] = {
          ...last,
          reasoning: last.reasoning
            ? `${last.reasoning}\n\n${evt.text}`
            : evt.text,
        };
        return updated;
      }
      case "tool_call": {
        const chip: ChatToolCall = {
          id: evt.id,
          name: evt.name,
          args: evt.args,
        };
        const updated = [...base];
        updated[idx] = {
          ...last,
          toolCalls: [...(last.toolCalls ?? []), chip],
        };
        return updated;
      }
      case "tool_result": {
        const calls = last.toolCalls ?? [];
        const callIdx = calls.findIndex((c) => c.id === evt.id);
        if (callIdx === -1) return base;
        const updatedCalls = [...calls];
        updatedCalls[callIdx] = {
          ...calls[callIdx],
          ok: evt.ok,
          data: evt.data,
          status: evt.status,
          message: evt.message,
          // WARP-640: carry the re-issue token onto the chip so the
          // "Approve & run" button can complete the action in-chat.
          ...(evt.confirmation ? { confirmation: evt.confirmation } : {}),
        };
        const updated = [...base];
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
          const updated = [...base];
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
        // WARP-854 (live path) — a turn that finishes `model_done`,
        // `iteration_limit`, `context_budget`, or `repetition` but produced
        // no visible content and no reasoning is the live-stream twin of the
        // persisted ghost-turn the loadConversation path maps to
        // `failureKind: "failed"`. Without this guard the bubble renders as
        // nothing at all. Set `error` (not `failureKind` — that field is
        // loadConversation-only) so the FailureChip + Try-again render,
        // matching the `stop_reason: "error"` branch above.
        //
        // WARP-1479 — tool activity does NOT make a blank answer honest, so
        // no stop reason requires an empty `toolCalls` any more: the common
        // live shape is tools that RUN, SUCCEED, and are followed by no
        // answer at all (chips, then nothing). The server rewrites those
        // turns to `stop_reason: "error"` now, so this guard is the
        // defense-in-depth twin for any turn that reaches us un-rewritten.
        if (
          last.content.trim().length === 0 &&
          (!last.reasoning || !last.reasoning.trim()) &&
          (evt.stop_reason === "model_done" ||
            evt.stop_reason === "iteration_limit" ||
            evt.stop_reason === "context_budget" ||
            evt.stop_reason === "repetition")
        ) {
          const updated = [...base];
          updated[idx] = {
            ...last,
            error: {
              message:
                "The Droplet AI finished without a reply. Try again, or ask in a different way.",
              retryPrompt,
            },
          };
          return updated;
        }
        return base;
      }
      default:
        return base;
    }
  });
}
