import { Bot, User } from "lucide-react";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-3 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center
          ${isUser ? "bg-droplet-500/20 text-droplet-400" : "bg-slate-800 text-slate-400"}`}
      >
        {isUser ? <User size={16} /> : <Bot size={16} />}
      </div>

      {/* Content */}
      <div
        className={`max-w-[75%] px-4 py-3 rounded-2xl text-sm leading-relaxed
          ${
            isUser
              ? "bg-droplet-600 text-white rounded-tr-md"
              : "bg-slate-800 text-slate-200 rounded-tl-md"
          }`}
      >
        <p className="whitespace-pre-wrap">
          {message.content}
          {isStreaming && !isUser && (
            <span className="inline-block w-1.5 h-4 ml-0.5 bg-droplet-400 animate-pulse" />
          )}
        </p>
      </div>
    </div>
  );
}
