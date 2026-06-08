import { memo, useState } from "react";
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
  Copy as CopyIcon,
  Quote as QuoteIcon,
  RotateCcw,
  StopCircle,
  Ghost,
  Play,
} from "lucide-react";
import type { ChatMessage as ChatMessageType, ChatToolCall } from "@/lib/types";
import { CitationCard } from "@/components/citations/CitationCard";
import { mimeFromPath } from "@/lib/mime-icons";
import "@/components/chat/thinking.css";

/**
 * "Droplet is thinking" indicator (design handoff Option B) — the faceted
 * Droplet mark + a shimmering label, shown on the assistant turn while the
 * model is generating but hasn't emitted its first token. role=status so a
 * screen reader announces it once (no per-token spam).
 */
function ThinkingIndicator() {
  return (
    <div className="ds-thinking" role="status" aria-live="polite">
      <span className="ds-thinking-avatar" aria-hidden="true">
        <svg viewBox="0 0 52 60" xmlns="http://www.w3.org/2000/svg">
          <polygon points="26,2 44,28 36,48 16,48 8,28" fill="#818cf8" />
          <polygon className="facet-mid" points="26,2 44,28 26,36" fill="#a5b4fc" />
          <polygon points="26,2 8,28 26,36" fill="#6366f1" opacity="0.6" />
        </svg>
      </span>
      <span className="ds-thinking-label">Droplet is thinking</span>
      <span className="sr-only">Droplet is generating a response…</span>
    </div>
  );
}

interface ChatMessageProps {
  message: ChatMessageType;
  isStreaming?: boolean;
  /**
   * Called when the user clicks the retry button on a failed assistant
   * turn. The page wires this to `useChat`'s `retryMessage` so the
   * original user prompt is re-sent.
   */
  onRetry?: (messageId: string) => void;
  /**
   * WARP-295: message-actions toolbar callbacks. Wired by the page
   * from clipboard / ChatInputHandle.insertQuote / useChat.regenerate
   * respectively. `isLastAssistant` gates Regenerate so a multi-turn
   * chat doesn't surface "re-run this old answer" affordances all the
   * way back through the thread.
   */
  isLastAssistant?: boolean;
  onCopy?: (text: string) => void | Promise<void>;
  onQuote?: (text: string) => void;
  onRegenerate?: (messageId: string) => void;
  /**
   * WARP-640: complete an in-chat scene-run confirmation. Wired by the page
   * to `useChat.approveScene`. When present and the pending confirmation is a
   * `scene_run`, the approval block renders an "Approve & run" button that
   * re-issues the action with the single-use token the chip is carrying.
   */
  onApproveScene?: (messageId: string, toolCallId: string) => void;
}

export const ChatMessage = memo(function ChatMessage({
  message,
  isStreaming,
  onRetry,
  isLastAssistant,
  onCopy,
  onQuote,
  onRegenerate,
  onApproveScene,
}: ChatMessageProps) {
  const isUser = message.role === "user";
  const toolCalls = message.toolCalls;
  const hasToolCalls = !isUser && toolCalls && toolCalls.length > 0;
  // failureKind unifies live and loaded failure states. Live errors map
  // to "failed"; live stops map to "aborted". For loaded messages the
  // hook sets failureKind directly.
  const failureKind: ChatMessageType["failureKind"] | undefined = !isUser
    ? message.failureKind
      ?? (message.error ? "failed" : undefined)
      ?? (message.stopped ? "aborted" : undefined)
    : undefined;
  const hasFailure = Boolean(failureKind);
  const citations = !isUser ? message.citations : undefined;
  const hasCitations = Boolean(citations && citations.length > 0);
  const showToolbar =
    !isUser && !isStreaming && (Boolean(onCopy) || Boolean(onQuote) || Boolean(onRegenerate));
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  const handleCopy = async () => {
    if (!onCopy) return;
    try {
      await onCopy(message.content);
    } catch {
      // The page-level handler swallows clipboard errors; we mirror
      // the optimistic UX here either way.
    }
    setCopyState("copied");
    // Flip back after 2s — matches the share-link copy pattern used in
    // app/users/page.tsx.
    window.setTimeout(() => setCopyState("idle"), 2000);
  };

  // Surface the confirmation_required message text inline on the
  // assistant turn — even before the model continues — so the user
  // sees what they're being asked to approve without having to hover
  // a chip's title attribute.
  const confirmCall = !isUser
    ? toolCalls?.find((c) => c.status === "confirmation_required")
    : undefined;

  // Pre-first-token "thinking" window: assistant turn is streaming but has
  // no content, no tool chips, no confirmation, and no failure yet. Show the
  // Droplet thinking indicator instead of an empty bubble + blinking cursor.
  const isThinking =
    !isUser && isStreaming && !message.content && !hasToolCalls && !confirmCall && !hasFailure;
  if (isThinking) {
    return <ThinkingIndicator />;
  }

  return (
    <div className={`flex gap-2.5 ${isUser ? "flex-row-reverse" : ""}`}>
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center
          ${isUser ? "bg-accent-subtle text-accent" : "bg-surface-tertiary text-label-secondary"}`}
      >
        {isUser ? <User size={14} /> : <Bot size={14} />}
      </div>

      {/* Bubble + meta. group/message lets the action toolbar surface on
          hover OR keyboard focus (focus-within) without prop-drilling
          state up. */}
      <div className={`flex flex-col gap-1 max-w-[70%] group/message ${isUser ? "items-end" : "items-start"}`}>
      <div
        className={`px-4 py-2.5 type-body
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
                <p>
                  {confirmCall.message ??
                    "This action needs your approval in the Droplet dashboard."}
                </p>
                {/* WARP-640: scene runs can be approved right here — the chip
                    carries a single-use token, so "Approve & run" completes the
                    action without leaving chat. Other tools (no `confirmation`
                    handle) still resolve on their dedicated dashboard surface. */}
                {confirmCall.confirmation?.kind === "scene_run" && onApproveScene ? (
                  confirmCall.confirmState === "failed" ? (
                    <p
                      className="mt-1.5 type-caption-2 text-system-red"
                      data-testid="scene-approve-failed"
                    >
                      That didn’t go through — ask again to retry.
                    </p>
                  ) : (
                    <button
                      type="button"
                      disabled={confirmCall.confirmState === "running"}
                      onClick={() => onApproveScene(message.id, confirmCall.id)}
                      data-testid="scene-approve-run"
                      className="mt-1.5 inline-flex items-center gap-1 px-3 py-2 rounded-md
                        type-caption-1 font-medium
                        bg-system-orange/15 hover:bg-system-orange/25 text-system-orange
                        disabled:opacity-60 disabled:cursor-not-allowed
                        focus:outline-none focus:ring-2 focus:ring-system-orange/40
                        transition-colors"
                      aria-label="Approve and run this scene"
                    >
                      {confirmCall.confirmState === "running" ? (
                        <>
                          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
                          Running…
                        </>
                      ) : (
                        <>
                          <Play size={12} aria-hidden="true" />
                          Approve &amp; run
                        </>
                      )}
                    </button>
                  )
                ) : null}
              </div>
            )}
            {message.content && (
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  // WARP-295: wrap GFM tables in a horizontal-scroll
                  // container so a wide table doesn't blow out the
                  // bubble's max-width on narrow viewports. Audit §5.4
                  // flagged this as a should-fix.
                  table: ({ node, ...props }) => (
                    <div className="overflow-x-auto">
                      <table {...props} />
                    </div>
                  ),
                }}
              >
                {message.content}
              </ReactMarkdown>
            )}
            {message.content && (failureKind === "aborted" || failureKind === "interrupted") && (
              <span
                className="text-label-tertiary"
                aria-hidden="true"
                data-testid="partial-ellipsis"
              >
                …
              </span>
            )}
            {hasFailure && (
              <FailureChip
                kind={failureKind!}
                liveErrorMessage={message.error?.message}
                canRetry={Boolean(onRetry)}
                onRetry={() => onRetry?.(message.id)}
              />
            )}
            {isStreaming && (
              <>
                <span
                  className="inline-block w-[2px] h-[18px] ml-0.5 -mb-[3px] bg-accent animate-pulse rounded-full motion-reduce:hidden"
                  aria-hidden="true"
                />
                {/* WARP-295: text fallback for reduced-motion users.
                    The animate-pulse cursor disappears for them, so we
                    swap in a visually-equivalent ellipsis they can
                    actually see, plus an SR-only "Working…" cue so
                    screen-reader users get the streaming-state signal
                    without the live region spamming on every token. */}
                <span
                  className="hidden motion-reduce:inline ml-1 type-caption-1 text-label-tertiary"
                  aria-hidden="true"
                >
                  …
                </span>
                <span className="sr-only">Working…</span>
              </>
            )}
          </div>
        )}
      </div>
      {/* WARP-295/WARP-287: citation cards below the assistant bubble.
          Rendered through the shared <CitationCard> component for visual
          parity with /knowledge/SearchTab. The wire-shaped ChatCitation
          is projected into the canonical CitationHit DTO; chat citations
          don't carry a per-chunk `anchor` yet, so they fall through to
          <FileCitation> (the same chip the old <CitationChip> rendered). */}
      {!isUser && hasCitations ? (
        <div
          data-testid="chat-citations"
          className="flex flex-wrap gap-1.5 mt-0.5"
        >
          {citations!.map((c, i) => (
            <CitationCard
              key={`${c.source}:${c.path}:${c.pageNumber ?? ""}:${i}`}
              hit={{
                fileId: c.brainItemId ? String(c.brainItemId) : c.path,
                filename: c.path.split("/").pop() || c.path,
                mimeType: c.mimeType ?? mimeFromPath(c.path),
                chunkText: c.snippet ?? "",
                score: c.score ?? 0,
                anchor: null,
              }}
            />
          ))}
        </div>
      ) : null}
      {/* WARP-295: message-actions toolbar. focus-within keeps the
          toolbar reachable by keyboard — Tab into the bubble's button
          row surfaces it without requiring hover. When citations
          render above, add a small `mt-1` so the toolbar isn't crowded
          right under the chip row. */}
      {showToolbar ? (
        <div
          data-testid="message-actions"
          className={`
            flex items-center gap-1 flex-wrap
            opacity-0 group-hover/message:opacity-100 focus-within:opacity-100
            transition-opacity duration-150
            ${hasCitations ? "mt-1" : ""}
          `}
        >
          {onCopy ? (
            <button
              type="button"
              onClick={handleCopy}
              aria-label={copyState === "copied" ? "Copied" : "Copy message"}
              className="
                inline-flex items-center gap-1 px-3 py-2 rounded-md
                type-caption-1 text-label-tertiary
                hover:text-label-primary hover:bg-surface-secondary
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-colors
              "
            >
              {copyState === "copied" ? (
                <Check size={12} aria-hidden="true" />
              ) : (
                <CopyIcon size={12} aria-hidden="true" />
              )}
              <span>{copyState === "copied" ? "Copied" : "Copy"}</span>
            </button>
          ) : null}
          {onQuote ? (
            <button
              type="button"
              onClick={() => onQuote(message.content)}
              aria-label="Quote message"
              className="
                inline-flex items-center gap-1 px-3 py-2 rounded-md
                type-caption-1 text-label-tertiary
                hover:text-label-primary hover:bg-surface-secondary
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-colors
              "
            >
              <QuoteIcon size={12} aria-hidden="true" />
              <span>Quote</span>
            </button>
          ) : null}
          {onRegenerate && isLastAssistant ? (
            <button
              type="button"
              onClick={() => onRegenerate(message.id)}
              aria-label="Regenerate response"
              className="
                inline-flex items-center gap-1 px-3 py-2 rounded-md
                type-caption-1 text-label-tertiary
                hover:text-label-primary hover:bg-surface-secondary
                focus:outline-none focus:ring-2 focus:ring-accent/40
                transition-colors
              "
            >
              <RotateCcw size={12} aria-hidden="true" />
              <span>Regenerate</span>
            </button>
          ) : null}
        </div>
      ) : null}
      </div>
    </div>
  );
});

/**
 * Failure-state chip for an assistant turn. Four variants:
 *
 *   - failed       — server-side error (live or loaded)
 *   - aborted      — user-cancelled (live or loaded). The bubble keeps
 *                    its partial content; this chip sits below it.
 *   - interrupted  — server died mid-stream. Loaded-only. Partial
 *                    content kept.
 *   - missing      — synthetic placeholder for an orphan user turn.
 *                    No bubble; just the chip.
 *
 * The Try-again link is rendered when `canRetry` is true and routes to
 * the parent's `onRetry`. The page wires that to useChat.retryMessage.
 */
function FailureChip({
  kind,
  liveErrorMessage,
  canRetry,
  onRetry,
}: {
  kind: NonNullable<ChatMessageType["failureKind"]>;
  liveErrorMessage?: string;
  canRetry: boolean;
  onRetry: () => void;
}) {
  const variant = ({
    failed: {
      Icon: AlertTriangle,
      copy: liveErrorMessage ?? "Something went wrong on this turn.",
      tone: "bg-system-red/10 text-system-red",
      role: "alert" as const,
    },
    aborted: {
      Icon: StopCircle,
      copy: "Stopped",
      tone: "bg-surface-tertiary text-label-secondary",
      role: "status" as const,
    },
    interrupted: {
      Icon: RotateCcw,
      copy: "Interrupted — the reply didn't finish.",
      tone: "bg-system-orange/15 text-system-orange",
      role: "alert" as const,
    },
    missing: {
      Icon: Ghost,
      copy: "No reply was saved for this turn.",
      tone: "bg-surface-tertiary/40 text-label-tertiary border border-dashed border-separator",
      role: "status" as const,
    },
  } satisfies Record<NonNullable<ChatMessageType["failureKind"]>, {
    Icon: typeof AlertTriangle;
    copy: string;
    tone: string;
    role: "alert" | "status";
  }>)[kind];

  return (
    <div
      className={`flex items-start gap-2 p-2 rounded-lg type-caption-1 ${variant.tone}`}
      role={variant.role}
      data-failure-kind={kind}
    >
      <variant.Icon size={14} className="flex-shrink-0 mt-0.5" aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <p>{variant.copy}</p>
        {canRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="mt-1.5 inline-flex items-center gap-1 type-caption-1 font-medium
              hover:underline focus:outline-none focus:ring-2
              focus:ring-current/40 rounded-sm"
            aria-label="Try sending this message again"
          >
            <RefreshCcw size={12} aria-hidden="true" />
            Try again
          </button>
        )}
      </div>
    </div>
  );
}

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
