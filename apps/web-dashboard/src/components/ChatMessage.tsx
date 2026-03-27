import { Bot, User } from "lucide-react";
import type { ChatMessage as ChatMessageType } from "@/lib/types";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
}

export function ChatMessage({ message, isStreaming }: ChatMessageProps) {
  const isUser = message.role === "user";

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center
          ${isUser ? "bg-accent-subtle text-accent" : "bg-surface-tertiary text-label-secondary"}`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Bubble */}
      <div
        className={`max-w-[70%] px-4 py-2.5 type-body
          ${
            isUser
              ? "bg-accent text-white rounded-[20px] rounded-tr-[6px]"
              : "bg-surface-tertiary text-label-primary rounded-[20px] rounded-tl-[6px]"
          }`}
      >
        <p className="whitespace-pre-wrap">
          {message.content}
          {isStreaming && !isUser && (
            <span className="inline-block w-[2px] h-[18px] ml-0.5 -mb-[3px] bg-accent animate-pulse rounded-full" />
          )}
        </p>
      </div>
    </div>
  );
}
