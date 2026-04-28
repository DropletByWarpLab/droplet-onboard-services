import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Bot, User, Wrench, Loader2, Check, AlertTriangle, ShieldAlert } from "lucide-react";
import type { ChatMessage as ChatMessageType, ChatToolCall } from "@/lib/types";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const toolCalls = message.toolCalls;
  const hasToolCalls = !isUser && toolCalls && toolCalls.length > 0;

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
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="chat-markdown">
            {hasToolCalls && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {toolCalls!.map((call) => (
                  <ToolCallChip key={call.id} call={call} />
                ))}
              </div>
            )}
            {message.content && (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            )}
            {isStreaming && (
              <span className="inline-block w-[2px] h-[18px] ml-0.5 -mb-[3px] bg-accent animate-pulse rounded-full" />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Inline chip surfaced on the assistant message for each MCP tool the
 * model dispatched. The chip transitions through three visual states:
 *
 *   - pending (no `ok` yet)         → spinner
 *   - ok=true                        → green check
 *   - ok=false + status="confirmation_required"
 *                                    → amber shield (the existing Tier-2
 *                                      modal flow watches for this)
 *   - ok=false (other error)         → red triangle
 */
function ToolCallChip({ call }: { call: ChatToolCall }) {
  const pending = call.ok === undefined;
  const needsConfirm = call.ok === false && call.status === "confirmation_required";
  const failed = call.ok === false && !needsConfirm;

  const Icon = pending
    ? Loader2
    : needsConfirm
    ? ShieldAlert
    : failed
    ? AlertTriangle
    : Check;

  const tone = pending
    ? "bg-surface-secondary text-label-tertiary"
    : needsConfirm
    ? "bg-system-amber-subtle text-system-amber"
    : failed
    ? "bg-system-red-subtle text-system-red"
    : "bg-system-green-subtle text-system-green";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full type-caption-1 ${tone}`}
      data-tool-call-id={call.id}
      data-tool-name={call.name}
      data-tool-status={call.status ?? (pending ? "pending" : call.ok ? "ok" : "error")}
      title={call.message ?? call.name}
    >
      <Wrench size={12} className="opacity-70" />
      <Icon size={12} className={pending ? "animate-spin" : ""} />
      <span className="font-mono">{call.name}</span>
    </span>
  );
}
