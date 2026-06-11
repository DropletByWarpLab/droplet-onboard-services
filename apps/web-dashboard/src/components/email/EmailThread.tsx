"use client";

/**
 * WARP-837 — EmailThread (column 2 of the 3-column mail client).
 *
 * Message-by-message reader (FEATURES.md §2.4). A draft Droplet authored shows
 * a "Drafted by Droplet" chip. Sending that draft is the one write path on this
 * surface and is held to the §6 contract:
 *
 *   - The send is GATED behind an explicit in-UI confirm step. Clicking "Send"
 *     reveals a confirm/cancel pair; sendDraft() only fires on confirm.
 *   - A server 451 off_lan_blocked is mapped (by api.ts) to a typed result and
 *     rendered here as a calm, actionable message pointing at Settings — never
 *     a thrown raw error, never a crash.
 *   - A genuine failure (404/409/5xx) is caught and shown as a calm line too.
 */

import { useState } from "react";
import { Lock, Send, Sparkles } from "lucide-react";
import { sendDraft } from "@/lib/api";
import type { DraftRow, EmailMessage, ThreadDetail } from "@/lib/types-email";

interface EmailThreadProps {
  thread?: ThreadDetail;
  /** The sendable Droplet draft on this thread, if any. */
  draft: DraftRow | null;
  isLoading: boolean;
  error?: Error;
  /** Whether the current user may send (owner/admin). Hides the affordance if not. */
  canSend: boolean;
  /** Called after a successful queue so the page can revalidate. */
  onSent: () => void;
}

type SendPhase =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "sending" }
  | { kind: "queued" }
  | { kind: "off_lan"; message: string }
  | { kind: "error"; message: string };

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function initials(name: string | null, addr: string): string {
  const src = name?.trim() || addr;
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  const first = parts[0]?.[0] ?? "?";
  const second = parts[1]?.[0] ?? "";
  return (first + second).toUpperCase();
}

export function EmailThread({
  thread,
  draft,
  isLoading,
  error,
  canSend,
  onSent,
}: EmailThreadProps) {
  if (isLoading) {
    return (
      <div
        aria-label="Loading conversation"
        className="flex flex-col h-full min-h-0 p-6 space-y-4"
      >
        <div className="h-6 w-2/3 rounded bg-surface-secondary animate-pulse" />
        <div className="h-32 rounded-xl bg-surface-secondary animate-pulse" />
        <div className="h-32 rounded-xl bg-surface-secondary animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center" role="alert">
        <p className="type-subheadline text-label-primary">
          We couldn&rsquo;t open this conversation
        </p>
        <p className="type-footnote text-label-tertiary mt-1">
          Try selecting it again in a moment.
        </p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Sparkles size={28} className="text-label-quaternary mb-3" aria-hidden />
        <p className="type-subheadline text-label-primary">
          Select a conversation
        </p>
        <p className="type-footnote text-label-tertiary mt-1 max-w-[260px]">
          Pick a message from the list to read it and see what Droplet found.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 bg-surface-primary">
      {/* Thread header */}
      <div className="shrink-0 px-5 py-4 border-b border-separator">
        <h2 className="type-title-3 text-label-primary">
          {thread.subject || "(no subject)"}
        </h2>
        <div className="flex items-center gap-2 mt-1 type-caption-1 text-label-tertiary">
          <span>{thread.lastSender ?? "Unknown sender"}</span>
          <span aria-hidden>·</span>
          <span>
            {thread.messageCount}{" "}
            {thread.messageCount === 1 ? "message" : "messages"}
          </span>
          <span
            className="ml-auto inline-flex items-center gap-1 type-caption-2 text-label-secondary"
            title="This conversation is indexed on your Droplet and never leaves the LAN."
          >
            <Lock size={11} className="text-system-green" aria-hidden />
            Indexed on-prem
          </span>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-4">
        {thread.messages.map((m) => (
          <MessageBlock key={m.id} message={m} />
        ))}

        {draft && (
          <DraftBlock
            draft={draft}
            canSend={canSend}
            onSent={onSent}
          />
        )}
      </div>
    </div>
  );
}

function MessageBlock({ message }: { message: EmailMessage }) {
  const name = message.fromName ?? message.fromAddr;
  return (
    <article className="dp-card p-4">
      <header className="flex items-start gap-3">
        <span
          className="shrink-0 w-8 h-8 rounded-full bg-accent-subtle flex items-center justify-center type-caption-1 font-semibold text-accent"
          aria-hidden
        >
          {initials(message.fromName, message.fromAddr)}
        </span>
        <div className="flex-1 min-w-0">
          <p className="type-footnote text-label-primary font-medium truncate">
            {name}{" "}
            {message.fromName && (
              <span className="font-normal text-label-tertiary">
                &lt;{message.fromAddr}&gt;
              </span>
            )}
          </p>
          <p className="type-caption-2 text-label-tertiary mt-0.5 font-mono">
            {formatMessageTime(message.receivedAt)}
          </p>
        </div>
      </header>
      <div className="mt-3 type-footnote text-label-primary whitespace-pre-wrap leading-relaxed">
        {message.bodyText ?? ""}
      </div>
    </article>
  );
}

function DraftBlock({
  draft,
  canSend,
  onSent,
}: {
  draft: DraftRow;
  canSend: boolean;
  onSent: () => void;
}) {
  const [phase, setPhase] = useState<SendPhase>({ kind: "idle" });

  async function doSend() {
    setPhase({ kind: "sending" });
    try {
      const result = await sendDraft(draft.id);
      if (result.status === "off_lan_blocked") {
        setPhase({ kind: "off_lan", message: result.message });
        return;
      }
      setPhase({ kind: "queued" });
      onSent();
    } catch {
      setPhase({
        kind: "error",
        message:
          "We couldn't send this draft. It may have already been sent — refresh to check.",
      });
    }
  }

  const sending = phase.kind === "sending";
  const queued = phase.kind === "queued";

  return (
    <article className="dp-card p-4 border-accent/30">
      <header className="flex items-start gap-3">
        <span
          className="shrink-0 w-8 h-8 rounded-full bg-accent-subtle flex items-center justify-center type-caption-1 font-semibold text-accent"
          aria-hidden
        >
          {initials(null, draft.toAddrs[0] ?? "you")}
        </span>
        <div className="flex-1 min-w-0">
          <p className="type-footnote text-label-primary font-medium">
            Draft reply{" "}
            <span className="font-normal text-label-tertiary">
              to {draft.toAddrs.join(", ")}
            </span>
          </p>
          <p className="type-caption-2 text-label-tertiary mt-0.5">
            {queued ? "Queued to send" : "Not sent yet"}
          </p>
        </div>
        {draft.draftedByDroplet && (
          <span className="shrink-0 inline-flex items-center gap-1 h-5 px-1.5 rounded-full bg-accent-subtle type-caption-2 font-medium text-accent">
            <Sparkles size={10} aria-hidden />
            Drafted by Droplet
          </span>
        )}
      </header>

      <div className="mt-3 type-footnote text-label-primary whitespace-pre-wrap leading-relaxed">
        {draft.body}
      </div>

      {/* Send control — gated by an explicit confirm step (§6). */}
      {canSend && (
        <div className="mt-4 pt-3 border-t border-separator">
          {phase.kind === "queued" ? (
            <p className="type-footnote text-system-green">
              Sent — Droplet has queued this reply.
            </p>
          ) : phase.kind === "off_lan" ? (
            <OffLanNotice message={phase.message} />
          ) : phase.kind === "error" ? (
            <div role="alert" className="space-y-2">
              <p className="type-footnote text-system-red">{phase.message}</p>
              <button
                type="button"
                onClick={() => setPhase({ kind: "idle" })}
                className="dp-btn-secondary text-sm"
              >
                Back
              </button>
            </div>
          ) : phase.kind === "confirming" || sending ? (
            <div className="space-y-2.5">
              <p className="type-footnote text-label-secondary">
                Sending this reply will email{" "}
                <span className="font-medium text-label-primary">
                  {draft.toAddrs.join(", ")}
                </span>
                . This leaves your Droplet.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={doSend}
                  disabled={sending}
                  className="
                    inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg
                    bg-accent text-accent-foreground type-footnote font-medium
                    transition-colors duration-200 ease-smooth
                    hover:bg-accent-hover disabled:opacity-60
                    focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                  "
                >
                  <Send size={14} aria-hidden />
                  {sending ? "Sending…" : "Confirm and send"}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "idle" })}
                  disabled={sending}
                  className="dp-btn-secondary text-sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPhase({ kind: "confirming" })}
              className="
                inline-flex items-center gap-1.5 h-9 px-3.5 rounded-lg
                bg-accent text-accent-foreground type-footnote font-medium
                transition-colors duration-200 ease-smooth
                hover:bg-accent-hover
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
              "
            >
              <Send size={14} aria-hidden />
              Send reply
            </button>
          )}
        </div>
      )}
    </article>
  );
}

function OffLanNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex gap-2.5 p-3 rounded-lg bg-system-orange/10"
    >
      <Lock size={15} className="shrink-0 mt-0.5 text-system-orange" aria-hidden />
      <p className="type-footnote text-label-primary">{message}</p>
    </div>
  );
}
