"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  MessageSquare,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput, type ChatInputHandle } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { SessionHeader } from "@/components/chat/SessionHeader";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";
import { useStickyScroll } from "@/lib/hooks/useStickyScroll";

export default function ChatPage() {
  // WARP-104: chat is now a single rolling thread held in React state.
  // Multi-session UX (history sidebar, server-side persistence) was
  // dropped when /api/llm/chat became the canonical MCP-backed entry
  // point — it's stateless. Reintroducing sessions needs an
  // orchestrator-side persistence layer.
  // WARP-203: pass `chatId` so chat-attached files (brain memory) carry the
  // originating-conversation tag for the future "scope to this conversation"
  // filter (Phase 2). The id is per-mount; clearing the chat (`handleNewChat`)
  // mints a fresh one so attachments stay scoped to a single thread.
  const [chatId, setChatId] = useState(() => `chat-${Date.now()}`);
  const {
    messages,
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
  } = useChat({ chatId });
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
  useEffect(() => {
    if (!selectedModel) return;
    let pending: string | null = null;
    try {
      pending = window.sessionStorage.getItem("droplet.pendingPrompt");
    } catch {
      pending = null;
    }
    if (!pending) return;
    try {
      window.sessionStorage.removeItem("droplet.pendingPrompt");
    } catch {
      /* ignore */
    }
    sendMessage(pending, selectedModel, systemPrompt || undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedModel]);

  // WARP-295: sticky auto-scroll. The hook scrolls only when the user is
  // attached (within ~80px of the bottom). When they've scrolled up to
  // re-read a citation, new tokens land off-screen and the Jump-to-latest
  // pill below appears as the affordance to catch up.
  useEffect(() => {
    stickyScrollToBottom();
  }, [messages, stickyScrollToBottom]);

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
      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-4 h-14 border-b border-separator bg-[var(--color-toolbar-bg)] dp-material">
          <div className="flex items-center gap-2 min-w-0 flex-1">
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
    </div>
  );
}
