"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  MessageSquare,
  PanelLeftOpen,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { SessionHeader } from "@/components/chat/SessionHeader";
import { ChatHistoryPanel, type ChatHistoryPanelHandle } from "@/components/chat/ChatHistoryPanel";
import { Dialog } from "@/components/Dialog";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";
import { useStickyScroll } from "@/lib/hooks/useStickyScroll";
import { useAuth } from "@/lib/auth";

export default function ChatPage() {
  // WARP-331: history panel imperative handle + mobile drawer state.
  const router = useRouter();
  const historyHandleRef = useRef<ChatHistoryPanelHandle | null>(null);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const historyTriggerRef = useRef<HTMLButtonElement | null>(null);

  // WARP-104 dropped server-side persistence. WARP-304 restored it: every
  // turn now hits `ChatSession` / `ChatMessage` and the server hands back
  // the conversation id via the `X-Conversation-Id` response header.
  //
  // WARP-203's `chatId` (the brain-memory originating-chat tag) lives on
  // alongside; consolidating with `conversationId` is left as a follow-up.
  const [chatId, setChatId] = useState(() => `chat-${Date.now()}`);
  // DASH-04: gate the chat WS bridge on an authenticated user so it doesn't
  // open + reconnect-with-backoff against `/api/ws/events` before auth
  // resolves (or after the session expires). AuthGate only renders this
  // page when `user` is set, but passing it explicitly keeps the gate
  // correct if that ever changes and mirrors NotificationToaster.
  const { user } = useAuth();
  const {
    messages,
    isStreaming,
    sendMessage,
    stop,
    retryMessage,
    regenerate,
    approveScene,
    clearMessages,
    attachments,
    attach,
    removeAttachment,
    clearAttachments,
    conversationId,
    loadConversation,
    messagesEpoch,
  } = useChat({ chatId, historyHandleRef, authReady: Boolean(user) });

  // WARP-304 + WARP-331: keep the URL hash and the live conversationId in
  // sync, both directions. The history panel calls router.push("/chat?c=X")
  // when the user clicks a row; we react to that by loading the thread.
  // Conversely, when conversationId changes for any other reason (new chat
  // minted server-side, message sent, clearMessages), we mirror it into the
  // URL so a refresh restores the same thread.
  const searchParams = useSearchParams();
  const urlConversationId = searchParams?.get("c") ?? null;

  // URL → state: when ?c=<id> changes (sidebar click, deep link, browser
  // back/forward), rehydrate that conversation. When `c` is removed (e.g.
  // "+ New chat" pushed "/chat"), reset to a fresh empty chat. The
  // in-flight stream (if any) is NOT aborted — the orchestrator continues
  // to persist the assistant turn server-side, so the answer is saved
  // even when the user navigates away. `useChat` decouples the visible
  // `isStreaming` lock from the underlying stream by tagging each stream
  // with its conversationId, so the new chat's input unlocks immediately.
  useEffect(() => {
    if (urlConversationId) {
      if (urlConversationId === conversationId) return; // already loaded
      void loadConversation(urlConversationId).then((ok) => {
        if (!ok && typeof window !== "undefined") {
          // Stale or revoked id — strip from URL so we don't keep
          // trying to load it on every reload / re-render.
          const next = new URL(window.location.href);
          next.searchParams.delete("c");
          window.history.replaceState(null, "", next.toString());
        }
      });
    } else if (conversationId !== null) {
      // URL cleared — reset the in-memory chat so the right column
      // doesn't keep showing the messages of a now-orphaned id.
      clearMessages();
      clearAttachments();
      setChatId(`chat-${Date.now()}`);
    }
    // Intentionally only depend on urlConversationId. Including
    // conversationId / loadConversation / clearMessages would re-fire
    // this effect after every load (those callbacks are stable, the
    // conversationId comparison handles dedup via the early return).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlConversationId]);

  // state → URL: when the hook updates conversationId for any reason
  // (server response after a send, clearMessages, etc.), mirror it into
  // the URL via replaceState so the panel and a refresh both stay aligned.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const next = new URL(window.location.href);
    if (conversationId) {
      if (next.searchParams.get("c") === conversationId) return;
      next.searchParams.set("c", conversationId);
    } else {
      if (!next.searchParams.has("c")) return;
      next.searchParams.delete("c");
    }
    window.history.replaceState(null, "", next.toString());
  }, [conversationId]);
  const chatInputRef = useRef<ChatInputHandle>(null);
  const { models } = useModels();
  const [selectedModel, setSelectedModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  // WARP-295: sticky-bottom auto-scroll + Jump-to-latest pill. The hook
  // owns the detach detection so the page just wires onScroll +
  // stickyScrollToBottom through.
  const {
    scrollRef,
    isDetached,
    scrollToBottom,
    onScroll,
    stickyScrollToBottom,
  } = useStickyScroll();

  // Auto-select the first available model
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      const local = models.find((m) => m.provider === "ollama");
      setSelectedModel(local?.id ?? models[0].id);
    }
  }, [models, selectedModel]);

  // If the home-page hero handed off a prompt, send it once a model is ready.
  //
  // DASH-02: only consume the hero prompt for a genuinely fresh chat. If the
  // user landed on a deep-linked thread (`/chat?c=<id>`) — or any conversation
  // already has messages — a stale `pendingPrompt` left in sessionStorage from
  // an earlier, interrupted hero hand-off must NOT be appended to that existing
  // conversation. We still clear the stored prompt so it can't fire later, but
  // we drop it instead of sending it into a non-empty / deep-linked thread.
  useEffect(() => {
    if (!selectedModel) return;
    let pending: string | null = null;
    try {
      pending = window.sessionStorage.getItem("droplet.pendingPrompt");
    } catch {
      pending = null;
    }
    if (!pending) return;
    // One-shot: always remove it so a stale hero prompt can't resurface.
    try {
      window.sessionStorage.removeItem("droplet.pendingPrompt");
    } catch {
      /* ignore */
    }
    // Gate the auto-send on a fresh chat: no `?c=` deep link in the URL and no
    // messages already present (a loaded/hydrated thread). Otherwise discard.
    if (urlConversationId || messages.length > 0) return;
    sendMessage(pending, selectedModel, systemPrompt || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  // WARP-295: sticky auto-scroll. The hook scrolls only when the user is
  // attached (within ~80px of the bottom). When they've scrolled up to
  // re-read a citation mid-stream, fresh tokens for the SAME assistant
  // message land off-screen and the Jump-to-latest pill below appears
  // as the affordance to catch up. Length-grow and discrete refreshes
  // are handled by the two effects below — they unconditionally snap to
  // the bottom regardless of where the user is.
  useEffect(() => {
    stickyScrollToBottom();
  }, [messages, stickyScrollToBottom]);

  // WARP-331: force-scroll to the bottom on discrete refresh events —
  // conversation switched, persisted thread reloaded (manual or via the
  // MQTT turn-completed auto-refresh), or "+ New chat" cleared the list.
  useEffect(() => {
    scrollToBottom();
  }, [messagesEpoch, scrollToBottom]);

  // WARP-331: also force-scroll whenever a new message appears in the
  // array (user submits a turn, assistant placeholder is appended, a
  // second turn lands, etc.). Sticky-scroll above would skip the snap
  // if the user happened to be scrolled up at the moment the message
  // arrived — that's the wrong default the user explicitly asked us to
  // override. Per-token deltas don't grow the array, so they keep
  // following the sticky rule.
  const prevMessagesLengthRef = useRef(0);
  useEffect(() => {
    if (messages.length > prevMessagesLengthRef.current) {
      scrollToBottom();
    }
    prevMessagesLengthRef.current = messages.length;
  }, [messages, scrollToBottom]);

  const handleSend = useCallback(
    (content: string) => {
      if (!selectedModel) return;
      sendMessage(content, selectedModel, systemPrompt || undefined);
    },
    [selectedModel, sendMessage, systemPrompt]
  );

  const handleNewChat = useCallback(() => {
    clearMessages();
    clearAttachments();
    setChatId(`chat-${Date.now()}`);
  }, [clearMessages, clearAttachments]);

  // WARP-331: history panel interaction handlers.
  const handleSelectConversation = useCallback(
    (id: string) => {
      setMobileHistoryOpen(false);
      router.push(`/chat?c=${encodeURIComponent(id)}`);
    },
    [router],
  );
  const handleNewChatFromPanel = useCallback(() => {
    setMobileHistoryOpen(false);
    router.push("/chat");
  }, [router]);

  const handleRetry = useCallback(
    (messageId: string) => {
      if (!selectedModel) return;
      retryMessage(messageId, selectedModel, systemPrompt || undefined);
    },
    [retryMessage, selectedModel, systemPrompt],
  );

  // WARP-295: message-actions (Copy / Quote / Regenerate). Copy is
  // delegated to the Clipboard API; Quote feeds the composer through
  // ChatInputHandle.insertQuote; Regenerate threads through to
  // useChat.regenerate() which owns the drop-and-resend slice surgery.
  const handleCopy = useCallback(async (text: string) => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard API rejects in unfocused tabs / cross-origin frames —
      // silently no-op; the toolbar still flips its transient "Copied"
      // state so the UI doesn't get stuck.
    }
  }, []);

  const handleQuote = useCallback((text: string) => {
    chatInputRef.current?.insertQuote(text);
  }, []);

  const handleRegenerate = useCallback(
    (messageId: string) => {
      if (!selectedModel) return;
      regenerate(messageId, selectedModel, systemPrompt || undefined);
    },
    [regenerate, selectedModel, systemPrompt],
  );

  // Index of the last assistant message — the page passes
  // `isLastAssistant` to each ChatMessage so the Regenerate button
  // only surfaces on that one row.
  const lastAssistantIdx = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") return i;
    }
    return -1;
  }, [messages]);

  return (
    // Mobile: subtract the bottom-nav height (56px + safe-area) so the input
    // pins just above the tab bar with no gap. Matches AuthGate main's padding.
    // Desktop: fill dynamic viewport (lg:pb-0 on main).
    // dvh (not vh) absorbs iOS Safari's collapsing URL bar.
    // overflow-x-hidden: guard against horizontal overflow on narrow phones.
    // Underscores inside calc() are Tailwind's whitespace marker (CSS spec requires spaces around -).
    <div className="flex h-[calc(100dvh_-_56px_-_env(safe-area-inset-bottom))] lg:h-dvh overflow-x-hidden">
      {/* WARP-331: desktop chat history panel — fixed 280px left column on lg+. */}
      <aside
        className="hidden lg:flex lg:flex-col lg:w-[280px] lg:flex-shrink-0 border-r border-separator bg-surface-secondary"
        aria-label="Chat history"
      >
        <ChatHistoryPanel
          activeConversationId={conversationId}
          onSelect={handleSelectConversation}
          onNewChat={handleNewChatFromPanel}
          handleRef={historyHandleRef}
        />
      </aside>

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-4 h-14 border-b border-separator bg-[var(--color-toolbar-bg)] dp-material">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            {/* WARP-331: mobile-only history-drawer trigger. */}
            <button
              ref={historyTriggerRef}
              type="button"
              onClick={() => setMobileHistoryOpen(true)}
              aria-label="Open chat history"
              aria-haspopup="dialog"
              aria-expanded={mobileHistoryOpen}
              className="lg:hidden p-1.5 rounded-sm text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
              title="Chat history"
            >
              <PanelLeftOpen size={18} aria-hidden="true" />
            </button>
            <ModelSelector value={selectedModel} onChange={setSelectedModel} />
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSystemPrompt(!showSystemPrompt)}
              className={`p-1.5 rounded-sm transition-colors ${
                systemPrompt
                  ? "text-accent bg-accent-subtle"
                  : "text-label-tertiary hover:text-label-primary hover:bg-surface-secondary"
              }`}
              title="System prompt"
              aria-label={
                showSystemPrompt ? "Hide system prompt" : "Show system prompt"
              }
              aria-pressed={showSystemPrompt}
            >
              <Settings2 size={16} aria-hidden="true" />
            </button>
            <button
              onClick={handleNewChat}
              disabled={messages.length === 0}
              className="flex items-center gap-1.5 type-subheadline text-accent
                hover:text-accent-hover disabled:text-label-quaternary
                disabled:cursor-not-allowed transition-colors duration-200 ease-smooth"
              aria-label="Start a new chat"
            >
              <RotateCcw size={14} aria-hidden="true" />
              <span className="hidden sm:inline">New chat</span>
            </button>
          </div>
        </header>

        {/* WARP-205: per-chat brain memory export affordance.
            Hidden when no items are attached to this chat — the
            component itself returns null in that case. */}
        <SessionHeader chatId={chatId} attachments={attachments} />

        {/* System prompt */}
        {showSystemPrompt && (
          <div className="px-4 py-3 border-b border-separator bg-surface-secondary">
            <div className="flex items-center justify-between mb-1.5">
              <label className="type-caption-1 text-label-tertiary uppercase tracking-wider">
                System Prompt
              </label>
              {systemPrompt && (
                <button
                  onClick={() => setSystemPrompt("")}
                  className="type-caption-1 text-accent hover:text-accent-hover"
                >
                  Clear
                </button>
              )}
            </div>
            <textarea
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="e.g. You are a helpful cooking assistant..."
              rows={2}
              className="dp-input type-footnote resize-none"
            />
          </div>
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="chat-scroll"
          className="relative flex-1 overflow-y-auto px-5 py-6 space-y-3 bg-surface-primary"
        >
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-label-tertiary">
              <MessageSquare size={40} strokeWidth={1} className="mb-3 text-label-quaternary" />
              <p className="type-title-3 text-label-secondary mb-1">Start a conversation</p>
              <p className="type-subheadline mb-6">
                {selectedModel
                  ? "Ask anything — your Droplet AI is ready."
                  : "Select a model above to get started."}
              </p>
              {selectedModel && (
                <div className="flex flex-wrap justify-center gap-2 max-w-md">
                  {[
                    "Summarize a document for me",
                    "Help me write a script",
                    "Explain how this device works",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => handleSend(prompt)}
                      className="px-3.5 py-2 type-footnote bg-surface-tertiary text-label-secondary
                        rounded-full border border-separator hover:border-accent/40 hover:text-accent
                        transition-colors"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((msg, idx) => (
            <ChatMessage
              key={msg.id}
              message={msg}
              isStreaming={
                isStreaming && idx === messages.length - 1 && msg.role === "assistant"
              }
              isLastAssistant={idx === lastAssistantIdx}
              onRetry={handleRetry}
              onCopy={handleCopy}
              onQuote={handleQuote}
              onRegenerate={handleRegenerate}
              onApproveScene={approveScene}
            />
          ))}
        </div>
        {/* WARP-295: Jump-to-latest pill — visible only when the user
            scrolled up off the live tail. Sits absolutely above the
            ChatInput so it floats over the last message without
            stealing layout space when hidden. The container is always
            rendered (only the pill's opacity toggles) so we get a soft
            fade on both appear and disappear instead of a hard pop.
            `pointer-events-none` while hidden keeps the invisible pill
            from intercepting clicks; reduced-motion users still get a
            usable pill — the global `prefers-reduced-motion` block in
            globals.css collapses Tailwind transitions to ~0ms. */}
        {messages.length > 0 ? (
          <div className="relative" aria-hidden={!isDetached}>
            <button
              type="button"
              onClick={scrollToBottom}
              data-testid="jump-to-latest"
              tabIndex={isDetached ? 0 : -1}
              className={`
                absolute left-1/2 -translate-x-1/2 -top-12 z-10
                inline-flex items-center gap-1.5 px-4 py-2.5 rounded-full
                bg-accent text-white shadow-md
                type-caption-1 hover:bg-accent-hover
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-opacity duration-150
                ${isDetached ? "opacity-100" : "opacity-0 pointer-events-none"}
              `}
              aria-label="Jump to latest message"
            >
              <ArrowDown size={12} strokeWidth={2.5} aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        ) : null}

        {/* Input */}
        <ChatInput
          ref={chatInputRef}
          onSend={handleSend}
          disabled={isStreaming || !selectedModel}
          attachments={attachments}
          onAttach={attach}
          onRemoveAttachment={removeAttachment}
          isStreaming={isStreaming}
          onStop={stop}
        />
      </div>

      {/* WARP-331: mobile drawer — same ChatHistoryPanel, hosted in the
          Dialog placement=right primitive. No handleRef here: useChat
          only needs one consumer (the desktop panel), and both writing
          the ref would race. Rename / delete / loadMore still work
          because they don't depend on the handle. */}
      <Dialog
        open={mobileHistoryOpen}
        onClose={() => setMobileHistoryOpen(false)}
        triggerRef={historyTriggerRef}
        labelledBy="mobile-history-heading"
        placement="right"
      >
        <div className="flex flex-col h-full w-[320px] max-w-[85vw]">
          <h2 id="mobile-history-heading" className="sr-only">
            Chat history
          </h2>
          <ChatHistoryPanel
            activeConversationId={conversationId}
            onSelect={handleSelectConversation}
            onNewChat={handleNewChatFromPanel}
          />
        </div>
      </Dialog>
    </div>
  );
}
