"use client";

import { useEffect, useRef, useState } from "react";
import { MessageSquare, RotateCcw } from "lucide-react";
import { ChatMessage } from "@/components/ChatMessage";
import { ChatInput } from "@/components/ChatInput";
import { ModelSelector } from "@/components/ModelSelector";
import { useChat } from "@/lib/hooks/useChat";
import { useModels } from "@/lib/hooks/useModels";

export default function ChatPage() {
  const { messages, isStreaming, sendMessage, clearMessages } = useChat();
  const { models } = useModels();
  const [selectedModel, setSelectedModel] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Auto-select the first available model
  useEffect(() => {
    if (!selectedModel && models.length > 0) {
      const local = models.find((m) => m.provider === "ollama");
      setSelectedModel(local?.id ?? models[0].id);
    }
  }, [models, selectedModel]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = (content: string) => {
    if (!selectedModel) return;
    sendMessage(content, selectedModel);
  };

  return (
    <div className="flex flex-col h-screen">
      {/* Header */}
      <header className="flex items-center justify-between px-5 h-14 border-b border-separator bg-[var(--color-toolbar-bg)] dp-material">
        <ModelSelector value={selectedModel} onChange={setSelectedModel} />
        <button
          onClick={clearMessages}
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
  );
}
