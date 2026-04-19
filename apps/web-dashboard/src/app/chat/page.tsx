"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  Settings2,
  ChevronDown,
} from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";

export default function ChatPage() {
  const {
    messages,
    isStreaming,
    sendMessage,
    clearMessages,
    sessionId,
    sessions,
    refreshSessions,
    loadSession,
    deleteSession,
  } = useChat();
  const { models } = useModels();
  const [selectedModel, setSelectedModel] = useState("");
  const [showSidebar, setShowSidebar] = useState(true);
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

  // Load sessions on mount
  useEffect(() => {
    refreshSessions();
  }, [refreshSessions]);

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
  }, [clearMessages]);

  const handleSelectSession = useCallback(
    (session: { id: string; model: string }) => {
      setSelectedModel(session.model);
      loadSession(session.id);
    },
    [loadSession]
  );

  return (
    <div className="flex h-screen">
      {/* Session sidebar */}
      {showSidebar && (
        <div className="hidden md:flex w-64 flex-shrink-0 flex-col border-r border-separator bg-surface-secondary">
          <div className="flex items-center justify-between p-3 border-b border-separator">
            <h2 className="type-headline text-label-primary">Chats</h2>
            <button
              onClick={handleNewChat}
              className="p-1.5 rounded-sm text-accent hover:bg-accent-subtle transition-colors"
              title="New chat"
            >
              <Plus size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto py-1">
            {sessions.length === 0 ? (
              <p className="type-caption-1 text-label-tertiary text-center py-8 px-3">
                No saved conversations yet. Start chatting or create a session to persist your conversations.
              </p>
            ) : (
              sessions.map((session) => (
                <div
                  key={session.id}
                  className={`group flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors
                    ${sessionId === session.id ? "bg-accent-subtle" : "hover:bg-surface-tertiary"}`}
                  onClick={() => handleSelectSession(session)}
                >
                  <MessageSquare size={14} className="text-label-tertiary flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="type-footnote text-label-primary truncate">
                      {session.title || "Untitled chat"}
                    </p>
                    <p className="type-caption-2 text-label-tertiary">
                      {session.message_count} messages
                    </p>
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteSession(session.id);
                    }}
                    className="p-1 rounded opacity-0 group-hover:opacity-100 text-label-tertiary hover:text-system-red transition-all"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Main chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <header className="flex items-center justify-between px-4 h-14 border-b border-separator bg-[var(--color-toolbar-bg)] dp-material">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowSidebar(!showSidebar)}
              className="hidden md:flex p-1.5 rounded-sm text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
            >
              {showSidebar ? <PanelLeftClose size={18} /> : <PanelLeft size={18} />}
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
            >
              <Settings2 size={16} />
            </button>
            <button
              onClick={handleNewChat}
              disabled={messages.length === 0}
              className="flex items-center gap-1.5 type-subheadline text-accent
                hover:text-accent-hover disabled:text-label-quaternary
                disabled:cursor-not-allowed transition-colors duration-200 ease-smooth"
            >
              <RotateCcw size={14} />
              New chat
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
            />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <ChatInput onSend={handleSend} disabled={isStreaming || !selectedModel} />
      </div>
    </div>
  );
}
