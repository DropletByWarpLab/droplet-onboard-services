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
 *
 * WARP-1088 — indigo shell: message/draft wells recolored onto `.card` +
 * shell tokens, buttons onto `.btn primary`/`.btn`, the "Drafted by Droplet"
 * chip onto `.badge info` (droplet-shell.css / indigo-tokens.css). The
 * off-LAN and error notices keep their semantic system-orange/system-red/
 * system-green tints unchanged — only the surrounding label text moves onto
 * the shell tokens. Pure recolor/reclass — no behavior change.
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
        <div className="h-6 w-2/3 rounded animate-pulse" style={{ background: "var(--inset)" }} />
        <div className="h-32 rounded-xl animate-pulse" style={{ background: "var(--inset)" }} />
        <div className="h-32 rounded-xl animate-pulse" style={{ background: "var(--inset)" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center" role="alert">
        <p className="type-subheadline" style={{ color: "var(--text)" }}>
          We couldn&rsquo;t open this conversation
        </p>
        <p className="type-footnote mt-1" style={{ color: "var(--text-muted)" }}>
          Try selecting it again in a moment.
        </p>
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8 text-center">
        <Sparkles size={28} className="mb-3" style={{ color: "var(--text-faint)" }} aria-hidden />
        <p className="type-subheadline" style={{ color: "var(--text)" }}>
          Select a conversation
        </p>
        <p className="type-footnote mt-1 max-w-[260px]" style={{ color: "var(--text-muted)" }}>
          Pick a message from the list to read it and see what Droplet found.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0" style={{ background: "var(--surface)" }}>
      {/* Thread header */}
      <div className="shrink-0 px-5 py-4" style={{ borderBottom: "1px solid var(--border)" }}>
        <h2 className="type-title-3" style={{ color: "var(--text)" }}>
          {thread.subject || "(no subject)"}
        </h2>
        <div className="flex items-center gap-2 mt-1 type-caption-1" style={{ color: "var(--text-muted)" }}>
          <span>{thread.lastSender ?? "Unknown sender"}</span>
          <span aria-hidden>·</span>
          <span>
            {thread.messageCount}{" "}
            {thread.messageCount === 1 ? "message" : "messages"}
          </span>
          <span
            className="ml-auto inline-flex items-center gap-1 type-caption-2"
            style={{ color: "var(--text-muted)" }}
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
    <article className="card" style={{ padding: "16px" }}>
      <header className="flex items-start gap-3">
        <span
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center type-caption-1 font-semibold"
          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
          aria-hidden
        >
          {initials(message.fromName, message.fromAddr)}
        </span>
        <div className="flex-1 min-w-0">
          <p className="type-footnote font-medium truncate" style={{ color: "var(--text)" }}>
            {name}{" "}
            {message.fromName && (
              <span className="font-normal" style={{ color: "var(--text-muted)" }}>
                &lt;{message.fromAddr}&gt;
              </span>
            )}
          </p>
          <p className="type-caption-2 mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>
            {formatMessageTime(message.receivedAt)}
          </p>
        </div>
      </header>
      <div
        className="mt-3 type-footnote whitespace-pre-wrap leading-relaxed"
        style={{ color: "var(--text)" }}
      >
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
    <article
      className="card"
      style={{
        padding: "16px",
        borderColor: "color-mix(in srgb, var(--brand) 30%, var(--card-bd))",
      }}
    >
      <header className="flex items-start gap-3">
        <span
          className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center type-caption-1 font-semibold"
          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
          aria-hidden
        >
          {initials(null, draft.toAddrs[0] ?? "you")}
        </span>
        <div className="flex-1 min-w-0">
          <p className="type-footnote font-medium" style={{ color: "var(--text)" }}>
            Draft reply{" "}
            <span className="font-normal" style={{ color: "var(--text-muted)" }}>
              to {draft.toAddrs.join(", ")}
            </span>
          </p>
          <p className="type-caption-2 mt-0.5" style={{ color: "var(--text-muted)" }}>
            {queued ? "Queued to send" : "Not sent yet"}
          </p>
        </div>
        {draft.draftedByDroplet && (
          <span className="badge info shrink-0">
            <Sparkles size={10} aria-hidden />
            Drafted by Droplet
          </span>
        )}
      </header>

      <div
        className="mt-3 type-footnote whitespace-pre-wrap leading-relaxed"
        style={{ color: "var(--text)" }}
      >
        {draft.body}
      </div>

      {/* Send control — gated by an explicit confirm step (§6). */}
      {canSend && (
        <div className="mt-4 pt-3" style={{ borderTop: "1px solid var(--border)" }}>
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
                className="btn sm"
              >
                Back
              </button>
            </div>
          ) : phase.kind === "confirming" || sending ? (
            <div className="space-y-2.5">
              <p className="type-footnote" style={{ color: "var(--text-muted)" }}>
                Sending this reply will email{" "}
                <span className="font-medium" style={{ color: "var(--text)" }}>
                  {draft.toAddrs.join(", ")}
                </span>
                . This leaves your Droplet.
              </p>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={doSend}
                  disabled={sending}
                  className="btn primary gap-1.5 type-footnote disabled:opacity-60"
                >
                  <Send size={14} aria-hidden />
                  {sending ? "Sending…" : "Confirm and send"}
                </button>
                <button
                  type="button"
                  onClick={() => setPhase({ kind: "idle" })}
                  disabled={sending}
                  className="btn sm"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setPhase({ kind: "confirming" })}
              className="btn primary gap-1.5 type-footnote"
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
      <p className="type-footnote" style={{ color: "var(--text)" }}>{message}</p>
    </div>
  );
}
