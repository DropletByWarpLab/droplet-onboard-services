"use client";

/**
 * WARP-1683 — left pane: the caller's conversations, newest activity first
 * (server-sorted by lastMessageAt). Each row: who, last-message preview,
 * time, unread pill. Quiet by default — the pill only renders above zero.
 */

import { MessagesSquare, SquarePen } from "lucide-react";
import type { TeamChatThreadSummary } from "@/lib/api";

/** "Now/HH:MM" today, weekday inside a week, date otherwise — the same
 *  compact scale a phone messages list uses; never a raw ISO string. */
export function formatThreadTime(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "";
  const now = new Date();
  const sameDay = then.toDateString() === now.toDateString();
  if (sameDay) {
    return then.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const days = (now.getTime() - then.getTime()) / 86_400_000;
  if (days < 7) return then.toLocaleDateString(undefined, { weekday: "short" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Display name for a thread from the CALLER's seat: the group title, or
 *  the other side's name(s). Falls back to username, then a neutral noun. */
export function threadDisplayName(
  thread: TeamChatThreadSummary,
  meId: string,
): string {
  if (thread.title) return thread.title;
  const others = thread.participants.filter((p) => p.userId !== meId);
  const names = others.map((p) => p.displayName ?? p.username ?? "Member");
  if (names.length === 0) return "Just you";
  return names.join(", ");
}

function previewText(thread: TeamChatThreadSummary): string {
  const m = thread.lastMessage;
  if (!m) return "No messages yet";
  if (m.kind === "file_share")
    return m.sharedFileName ? `Shared ${m.sharedFileName}` : "Shared a file";
  if (m.kind === "ai_chat_share") return "Shared an AI conversation";
  return m.body ?? "";
}

export function ThreadList({
  threads,
  isLoading,
  loadFailed,
  meId,
  selectedThreadId,
  onSelect,
  onCompose,
}: {
  threads: TeamChatThreadSummary[] | undefined;
  isLoading: boolean;
  /** First load failed with nothing cached — SWR keeps retrying/polling. */
  loadFailed?: boolean;
  meId: string;
  selectedThreadId: string | null;
  onSelect: (id: string) => void;
  onCompose: () => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between px-4 h-12 border-b border-separator flex-shrink-0">
        <span className="type-subheadline font-medium text-label-primary">
          Conversations
        </span>
        <button
          type="button"
          onClick={onCompose}
          className="
            p-1.5 rounded-md text-label-secondary
            hover:text-accent hover:bg-accent-subtle
            transition-colors duration-200 ease-smooth
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
          "
          title="New message"
          aria-label="New message"
        >
          <SquarePen size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {loadFailed && (
          <p role="alert" className="px-4 py-3 type-footnote text-label-tertiary">
            Couldn&apos;t load conversations — retrying.
          </p>
        )}

        {!loadFailed && isLoading && !threads && (
          <p className="px-4 py-3 type-footnote text-label-tertiary">
            Loading conversations…
          </p>
        )}

        {threads && threads.length === 0 && (
          <div className="px-6 py-10 text-center">
            <MessagesSquare
              size={28}
              strokeWidth={1.5}
              className="mx-auto text-label-quaternary"
              aria-hidden="true"
            />
            <p className="mt-3 type-subheadline text-label-secondary">
              No conversations yet
            </p>
            <p className="mt-1 type-footnote text-label-tertiary">
              Message a colleague directly, or start a small group.
            </p>
            <button
              type="button"
              onClick={onCompose}
              className="dp-btn-primary mt-4"
            >
              New message
            </button>
          </div>
        )}

        {threads?.map((thread) => {
          const active = thread.id === selectedThreadId;
          const name = threadDisplayName(thread, meId);
          return (
            <button
              key={thread.id}
              type="button"
              onClick={() => onSelect(thread.id)}
              aria-current={active ? "true" : undefined}
              className={`
                w-full text-left px-3 py-2.5 flex items-start gap-3
                transition-colors duration-200 ease-smooth
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
                ${active ? "bg-accent-subtle" : "hover:bg-surface-secondary"}
              `}
            >
              <span
                aria-hidden="true"
                className="
                  w-9 h-9 rounded-full bg-accent-subtle flex-shrink-0
                  flex items-center justify-center
                  type-footnote font-semibold text-accent
                "
              >
                {name.slice(0, 2).toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2">
                  <span
                    className={`flex-1 truncate type-subheadline ${
                      thread.unreadCount > 0
                        ? "font-semibold text-label-primary"
                        : "font-medium text-label-primary"
                    }`}
                  >
                    {name}
                  </span>
                  <span className="type-caption-2 text-label-tertiary flex-shrink-0 tabular-nums">
                    {formatThreadTime(thread.lastMessageAt)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span
                    className={`flex-1 truncate type-footnote ${
                      thread.unreadCount > 0
                        ? "text-label-secondary"
                        : "text-label-tertiary"
                    }`}
                  >
                    {previewText(thread)}
                  </span>
                  {thread.unreadCount > 0 && (
                    <>
                      {/* The numeral is decorative for SRs (aria-label on a
                          generic span is ignored); the sr-only text carries
                          the meaning. */}
                      <span
                        aria-hidden="true"
                        className="
                          flex-shrink-0 min-w-[18px] px-1.5 py-px rounded-full
                          text-center type-caption-2 font-semibold tabular-nums
                          bg-accent text-white
                        "
                      >
                        {thread.unreadCount > 99 ? "99+" : thread.unreadCount}
                      </span>
                      <span className="sr-only">{`${thread.unreadCount} unread`}</span>
                    </>
                  )}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </>
  );
}
