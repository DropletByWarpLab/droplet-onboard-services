import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Bot,
  User,
  Wrench,
  Loader2,
  Check,
  AlertTriangle,
  ShieldAlert,
  RefreshCcw,
} from "lucide-react";
import type { ChatMessage as ChatMessageType, ChatToolCall } from "@/lib/types";

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  /**
   * Called when the user clicks the retry button on a failed assistant
   * turn. The page wires this to `useChat`'s `retryMessage` so the
   * original user prompt is re-sent.
   */
  onRetry?: (messageId: string) => void;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
  onRetry,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const toolCalls = message.toolCalls;
  const hasToolCalls = !isUser && toolCalls && toolCalls.length > 0;
  const hasError = !isUser && Boolean(message.error);

  // Surface the confirmation_required message text inline on the
  // assistant turn — even before the model continues — so the user
  // sees what they're being asked to approve without having to hover
  // a chip's title attribute.
  const confirmCall = !isUser
    ? toolCalls?.find((c) => c.status === "confirmation_required")
    : undefined;

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
        // role="status" + aria-live="polite" on the streaming assistant
        // bubble so screen readers announce content as it lands without
        // alert-spamming. WARP-44 precedent.
        role={!isUser && isStreaming ? "status" : undefined}
        aria-live={!isUser && isStreaming ? "polite" : undefined}
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
            {confirmCall && (
              <div
                className="mb-2 p-2 rounded-lg bg-system-orange/10 text-system-orange type-caption-1"
                role="alert"
                data-confirm-message-for={confirmCall.id}
              >
                {confirmCall.message ??
                  "This action needs your approval in the Droplet dashboard."}
              </div>
            )}
            {message.content && (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {message.content}
              </ReactMarkdown>
            )}
            {hasError && (
              <div
                className="flex items-start gap-2 p-2 rounded-lg bg-system-red/10 text-system-red type-caption-1"
                role="alert"
              >
                <AlertTriangle size={14} className="flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <p>{message.error!.message}</p>
                  {onRetry && (
                    <button
                      type="button"
                      onClick={() => onRetry(message.id)}
                      className="mt-1.5 inline-flex items-center gap-1 type-caption-1 font-medium
                        text-system-red hover:underline focus:outline-none focus:ring-2
                        focus:ring-system-red/40 rounded-sm"
                      aria-label="Try sending this message again"
                    >
                      <RefreshCcw size={12} />
                      Try again
                    </button>
                  )}
                </div>
              </div>
            )}
            {isStreaming && (
              <span
                className="inline-block w-[2px] h-[18px] ml-0.5 -mb-[3px] bg-accent animate-pulse rounded-full"
                aria-hidden="true"
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * Inline chip surfaced on the assistant message for each MCP tool the
 * model dispatched. The chip transitions through four visual states:
 *
 *   - pending (no `ok` yet)               → spinner (neutral surface)
 *   - status === "confirmation_required"   → amber shield + alert
 *     (per spec §7.1 + §8.2 this arrives with `ok: true` because MCP
 *     marks it `isError: false` — checking `status` directly is the
 *     correct discriminator, NOT `ok`)
 *   - ok === true (everything else)        → green check
 *   - ok === false (genuine error)         → red triangle
 *
 * Color tones use the design-system `system-*` tokens with /opacity
 * modifiers (matches the established pattern in ModelSelector + EventForm).
 */
function ToolCallChip({ call }: { call: ChatToolCall }) {
  const pending = call.ok === undefined;
  // status is the source of truth for confirmation — see header comment.
  const needsConfirm = call.status === "confirmation_required";
  const failed = !pending && !needsConfirm && call.ok === false;
  const ok = !pending && !needsConfirm && !failed;

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
      ? "bg-system-orange/15 text-system-orange"
      : failed
        ? "bg-system-red/15 text-system-red"
        : "bg-system-green/15 text-system-green";

  const ariaState = pending
    ? "running"
    : needsConfirm
      ? "needs your approval"
      : failed
        ? "failed"
        : "completed";

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-full type-caption-1 ${tone}`}
      data-tool-call-id={call.id}
      data-tool-name={call.name}
      data-tool-status={call.status ?? (pending ? "pending" : ok ? "ok" : "error")}
      title={call.message ?? call.name}
      aria-label={`Tool ${call.name}, ${ariaState}${call.message ? ": " + call.message : ""}`}
    >
      <Wrench size={12} className="opacity-70" aria-hidden="true" />
      <Icon
        size={12}
        className={pending ? "animate-spin" : ""}
        aria-hidden="true"
      />
      <span className="font-mono">{call.name}</span>
    </span>
  );
}
