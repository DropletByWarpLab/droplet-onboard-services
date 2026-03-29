"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Plus,
  RotateCcw,
  Trash2,
  PanelLeftClose,
  PanelLeft,
} from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";
import {
  listSessions,
  createSession,
  getSession,
  deleteSession,
  sendSessionChat,
} from "@/lib/api";
import type { SessionInfo, SessionMessageInfo } from "@/lib/types";

export default function ChatPage() {
  const { messages, isStreaming, sendMessage, clearMessages, setMessages } = useChat();
  const { models } = useModels();
  const [selectedModel, setSelectedModel] = useState("");
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [showSidebar, setShowSidebar] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-select the first available model
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      const local = models.find((m) => m.provider === "ollama");
      setSelectedModel(local?.id ?? models[0].id);
    }
  }, [models, selectedModel]);

  // Load sessions
  useEffect(() => {
    loadSessions();
  }, []);

  async function loadSessions() {
    try {
      const data = await listSessions(20, 0);
      setSessions(data.sessions || []);
    } catch {
      // Non-fatal — sessions API might not be available
    }
  }

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = useCallback(
    async (content: string) => {
      if (!selectedModel) return;

      if (activeSessionId) {
        // Send via session API for persistence
        sendMessage(content, selectedModel);
        // Also persist to session in background
        try {
          await sendSessionChat(activeSessionId, { message: content, stream: false });
        } catch {
          // Non-fatal — still sent via direct chat
        }
      } else {
        sendMessage(content, selectedModel);
      }
    },
    [selectedModel, activeSessionId, sendMessage]
  );

  const handleNewChat = useCallback(() => {
    clearMessages();
    setActiveSessionId(null);
  }, [clearMessages]);

  const handleCreateSession = useCallback(async () => {
    if (!selectedModel) return;
    try {
      const session = await createSession({ model: selectedModel });
      setSessions((prev) => [session, ...prev]);
      setActiveSessionId(session.id);
      clearMessages();
    } catch {
      // Fallback to non-session chat
      handleNewChat();
    }
  }, [selectedModel, clearMessages, handleNewChat]);

  const handleSelectSession = useCallback(
    async (session: SessionInfo) => {
      setActiveSessionId(session.id);
      setSelectedModel(session.model);
      try {
        const detail = await getSession(session.id);
        const restored = (detail.messages || []).map(
          (m: SessionMessageInfo, i: number) => ({
            id: `restored-${i}`,
            role: m.role as "user" | "assistant",
            content: m.content,
          })
        );
        setMessages(restored);
      } catch {
        clearMessages();
      }
    },
    [clearMessages, setMessages]
  );

  const handleDeleteSession = useCallback(
    async (sessionId: string) => {
      try {
        await deleteSession(sessionId);
        setSessions((prev) => prev.filter((s) => s.id !== sessionId));
        if (activeSessionId === sessionId) {
          setActiveSessionId(null);
          clearMessages();
        }
      } catch {
        // ignore
      }
    },
    [activeSessionId, clearMessages]
  );

  return (
    <div className="flex h-screen">
      {/* Session sidebar */}
      {showSidebar && (
        <div className="hidden md:flex w-64 flex-shrink-0 flex-col border-r border-separator bg-surface-secondary">
          <div className="flex items-center justify-between p-3 border-b border-separator">
            <h2 className="type-headline text-label-primary">Chats</h2>
            <button
              onClick={handleCreateSession}
              className="p-1.5 rounded-sm text-accent hover:bg-accent-subtle transition-colors"
              title="New session"
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
                    ${activeSessionId === session.id ? "bg-accent-subtle" : "hover:bg-surface-tertiary"}`}
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
                      handleDeleteSession(session.id);
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
        </header>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-3 bg-surface-primary">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-label-tertiary">
              <MessageSquare size={40} strokeWidth={1} className="mb-3 text-label-quaternary" />
              <p className="type-title-3 text-label-secondary mb-1">No messages yet</p>
              <p className="type-subheadline">
                Select a model and start chatting with your Droplet AI.
              </p>
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
