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
  // WARP-1685 — the preview message carries its meeting relation.
  if (m.kind === "meeting_invite")
    return m.meeting ? `Meeting: ${m.meeting.title}` : "Meeting invite";
  if (m.kind === "meeting_reminder")
    return m.meeting ? `Reminder: ${m.meeting.title}` : "Meeting reminder";
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
      <div className="mx-head justify-between">
        <span className="mx-head-title">Conversations</span>
        <button
          type="button"
          onClick={onCompose}
          className="mx-iconbtn"
          title="New message"
          aria-label="New message"
        >
          <SquarePen size={16} />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto py-1">
        {loadFailed && (
          <p role="alert" className="mx-quiet px-4 py-3">
            Couldn&apos;t load conversations — retrying.
          </p>
        )}

        {!loadFailed && isLoading && !threads && (
          <p className="mx-quiet px-4 py-3">Loading conversations…</p>
        )}

        {threads && threads.length === 0 && (
          <div className="mx-empty">
            <MessagesSquare
              size={28}
              strokeWidth={1.5}
              className="mx-auto mx-empty-icon"
              aria-hidden="true"
            />
            <p className="mx-empty-title">No conversations yet</p>
            <p className="mx-empty-sub">
              Message a colleague directly, or start a small group.
            </p>
            <button
              type="button"
              onClick={onCompose}
              className="btn primary mt-4"
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
              className={`mx-row ${active ? "is-active" : ""} ${
                thread.unreadCount > 0 ? "has-unread" : ""
              }`}
            >
              <span aria-hidden="true" className="mx-ava">
                {name.slice(0, 2).toUpperCase()}
              </span>
              <span className="flex-1 min-w-0">
                <span className="flex items-baseline gap-2">
                  <span className="mx-row-name truncate">{name}</span>
                  <span className="mx-row-time">
                    {formatThreadTime(thread.lastMessageAt)}
                  </span>
                </span>
                <span className="mt-0.5 flex items-center gap-2">
                  <span className="mx-row-preview truncate">
                    {previewText(thread)}
                  </span>
                  {thread.unreadCount > 0 && (
                    <>
                      {/* The numeral is decorative for SRs (aria-label on a
                          generic span is ignored); the sr-only text carries
                          the meaning. */}
                      <span aria-hidden="true" className="mx-badge">
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
