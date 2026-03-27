"use client";

import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
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
      // Prefer local models first
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
      <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/50">
        <ModelSelector value={selectedModel} onChange={setSelectedModel} />
        <button
          onClick={clearMessages}
          disabled={messages.length === 0}
          className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-slate-400 hover:text-slate-200
            disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RotateCcw size={14} />
          New chat
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-6 space-y-4">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-slate-500">
            <p className="text-lg mb-2">No messages yet</p>
            <p className="text-sm">
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
