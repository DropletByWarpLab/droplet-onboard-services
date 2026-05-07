"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  RotateCcw,
  Settings2,
} from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";

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
    retryMessage,
    clearMessages,
    attachments,
    attach,
    removeAttachment,
    clearAttachments,
  } = useChat({ chatId });
  const { models } = useModels();
  const [selectedModel, setSelectedModel] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showSystemPrompt, setShowSystemPrompt] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

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

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

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
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-3 bg-surface-primary">
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
              onRetry={handleRetry}
            />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <ChatInput
          onSend={handleSend}
          disabled={isStreaming || !selectedModel}
          attachments={attachments}
          onAttach={attach}
          onRemoveAttachment={removeAttachment}
        />
      </div>
    </div>
  );
}
