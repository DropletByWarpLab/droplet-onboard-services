"use client";

/**
 * WARP-1683 — right pane: one conversation. Header (back on mobile, name,
 * members caption), the message scroll (column-reverse so the newest-first
 * API order renders bottom-anchored with no scroll management), and the
 * composer with the two forward actions.
 *
 * Read cursor: opening a thread — and any NEW newest message while it is
 * open — POSTs /read and refreshes the unread badge. Guarded by the newest
 * message id so the 5s poll doesn't spam identical writes.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft,
  ArrowUp,
  CalendarPlus,
  FileText,
  MessagesSquare,
  Paperclip,
  Sparkles,
} from "lucide-react";
import {
  cancelTeamChatMeeting,
  markTeamChatThreadRead,
  rsvpTeamChatMeeting,
  sendTeamChatMessage,
  type TeamChatMessage,
  type TeamChatRsvpResponse,
  type TeamChatSendBody,
  type TeamChatThreadSummary,
} from "@/lib/api";
import { useTeamChatMessages } from "@/lib/hooks/useTeamChat";
import { threadDisplayName } from "./ThreadList";
import { ForwardFileDialog, ForwardChatDialog } from "./ForwardDialogs";
import { TranscriptModal } from "./TranscriptModal";
import { MeetingCard, MeetingReminderCard } from "./MeetingCard";
import { MeetingDialog } from "./MeetingDialog";

function formatMessageTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function ConversationPane({
  thread,
  meId,
  onBack,
  onActivity,
}: {
  thread: TeamChatThreadSummary | null;
  meId: string;
  onBack: () => void;
  onActivity: (threadId: string) => void;
}) {
  const threadId = thread?.id ?? null;
  const { messages, isLoading, mutate, error: messagesError } =
    useTeamChatMessages(threadId);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [chatPickerOpen, setChatPickerOpen] = useState(false);
  const [transcriptFor, setTranscriptFor] = useState<TeamChatMessage | null>(null);
  // WARP-1685 — meetings.
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false);
  const [meetingBusy, setMeetingBusy] = useState(false);
  const [meetingError, setMeetingError] = useState<string | null>(null);

  // Mark read on open + whenever a new newest message lands while open.
  const lastMarkedRef = useRef<string | null>(null);
  const newestId = messages?.[0]?.id ?? null;
  useEffect(() => {
    if (!threadId || newestId === null) return;
    const marker = `${threadId}:${newestId}`;
    if (lastMarkedRef.current === marker) return;
    lastMarkedRef.current = marker;
    void markTeamChatThreadRead(threadId)
      .then(() => onActivity(threadId))
      .catch(() => {
        // Non-fatal — the next poll retries via a changed marker.
        lastMarkedRef.current = null;
      });
  }, [threadId, newestId, onActivity]);

  // Reset composer state when switching threads.
  useEffect(() => {
    setDraft("");
    setSendError(null);
    setMeetingError(null);
  }, [threadId]);

  async function send(body: TeamChatSendBody) {
    if (!threadId || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await sendTeamChatMessage(threadId, body);
      setDraft("");
      await mutate();
      onActivity(threadId);
    } catch (err) {
      // api.ts throws plain user copy (detail already console-logged there).
      setSendError(err instanceof Error ? err.message : "Couldn't send. Try again.");
    } finally {
      setSending(false);
    }
  }

  function sendText() {
    const body = draft.trim();
    if (body.length === 0) return;
    void send({ kind: "text", body });
  }

  /**
   * WARP-1685 — RSVP with an optimistic chip flip: the local cache is
   * updated immediately (no revalidate), then the POST runs, and the
   * awaited revalidate in `finally` re-reads server truth — which is also
   * the rollback path when the POST failed (plus honest error copy).
   */
  async function rsvp(meetingId: string, response: TeamChatRsvpResponse) {
    if (!threadId || meetingBusy) return;
    setMeetingBusy(true);
    setMeetingError(null);
    await mutate(
      (current) =>
        current && {
          ...current,
          messages: current.messages.map((m) => {
            if (!m.meeting || m.meeting.id !== meetingId) return m;
            return {
              ...m,
              meeting: {
                ...m.meeting,
                rsvps: [
                  ...m.meeting.rsvps.filter((r) => r.userId !== meId),
                  { userId: meId, response, respondedAt: new Date().toISOString() },
                ],
              },
            };
          }),
        },
      { revalidate: false },
    );
    try {
      await rsvpTeamChatMeeting(meetingId, response);
    } catch (err) {
      setMeetingError(
        err instanceof Error ? err.message : "Couldn't send your answer. Try again.",
      );
    } finally {
      await mutate();
      setMeetingBusy(false);
    }
  }

  /** Organizer cancel — the two-step confirm lives in the card itself. */
  async function cancelMeeting(meetingId: string) {
    if (!threadId || meetingBusy) return;
    setMeetingBusy(true);
    setMeetingError(null);
    try {
      await cancelTeamChatMeeting(meetingId);
      onActivity(threadId);
    } catch (err) {
      setMeetingError(
        err instanceof Error ? err.message : "Couldn't cancel the meeting. Try again.",
      );
    } finally {
      await mutate();
      setMeetingBusy(false);
    }
  }

  /** The composer text rides along as the forward's caption. */
  function captionOrUndefined(): string | undefined {
    const c = draft.trim();
    return c.length > 0 ? c : undefined;
  }

  if (!thread) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
        <MessagesSquare
          size={30}
          strokeWidth={1.5}
          className="text-label-quaternary"
          aria-hidden="true"
        />
        <p className="mt-3 type-subheadline text-label-secondary">
          Select a conversation
        </p>
        <p className="mt-1 type-footnote text-label-tertiary">
          Pick one on the left, or start a new message.
        </p>
      </div>
    );
  }

  const name = threadDisplayName(thread, meId);
  const memberNames = thread.participants
    .map((p) => p.displayName ?? p.username ?? "Member")
    .join(", ");

  return (
    <>
      {/* Header */}
      <div className="flex items-center gap-3 px-4 h-12 border-b border-separator flex-shrink-0">
        <button
          type="button"
          onClick={onBack}
          className="
            lg:hidden p-1.5 -ml-1.5 rounded-md text-label-secondary
            hover:text-label-primary hover:bg-surface-secondary
            transition-colors duration-200 ease-smooth
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
          "
          aria-label="Back to conversations"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="type-subheadline font-medium text-label-primary truncate">
            {name}
          </p>
          <p className="type-caption-2 text-label-tertiary truncate">
            {thread.kind === "group" ? memberNames : "Direct message"}
          </p>
        </div>
      </div>

      {/* Messages — column-reverse renders the newest-first array bottom-up. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse gap-2 px-4 py-3">
        {messagesError !== undefined && messages === undefined && (
          <p role="alert" className="type-footnote text-label-tertiary">
            Couldn&apos;t load messages — retrying.
          </p>
        )}
        {messagesError === undefined && isLoading && !messages && (
          <p className="type-footnote text-label-tertiary">Loading messages…</p>
        )}
        {messages && messages.length === 0 && (
          <p className="type-footnote text-label-tertiary text-center py-6">
            No messages yet — say hello.
          </p>
        )}
        {messages?.map((m) => (
          <MessageBubble
            key={m.id}
            message={m}
            mine={m.senderId === meId}
            showSender={thread.kind === "group"}
            onOpenTranscript={() => setTranscriptFor(m)}
            meId={meId}
            participants={thread.participants}
            onRsvp={(meetingId, response) => void rsvp(meetingId, response)}
            onCancelMeeting={(meetingId) => void cancelMeeting(meetingId)}
            meetingBusy={meetingBusy}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="border-t border-separator px-3 py-2.5 flex-shrink-0">
        {sendError && (
          <p role="alert" className="type-caption-1 text-system-red px-1 pb-1.5">
            {sendError}
          </p>
        )}
        {meetingError && (
          <p role="alert" className="type-caption-1 text-system-red px-1 pb-1.5">
            {meetingError}
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <button
            type="button"
            onClick={() => setFilePickerOpen(true)}
            disabled={sending}
            className="
              p-2 rounded-md text-label-secondary
              hover:text-accent hover:bg-accent-subtle
              transition-colors duration-200 ease-smooth disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            "
            title="Forward a file"
            aria-label="Forward a file"
          >
            <Paperclip size={16} />
          </button>
          <button
            type="button"
            onClick={() => setMeetingDialogOpen(true)}
            disabled={sending}
            className="
              p-2 rounded-md text-label-secondary
              hover:text-accent hover:bg-accent-subtle
              transition-colors duration-200 ease-smooth disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            "
            title="Schedule a meeting"
            aria-label="Schedule a meeting"
          >
            <CalendarPlus size={16} />
          </button>
          <button
            type="button"
            onClick={() => setChatPickerOpen(true)}
            disabled={sending}
            className="
              p-2 rounded-md text-label-secondary
              hover:text-accent hover:bg-accent-subtle
              transition-colors duration-200 ease-smooth disabled:opacity-50
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            "
            title="Forward an AI chat"
            aria-label="Forward an AI chat"
          >
            <Sparkles size={16} />
          </button>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendText();
              }
            }}
            rows={1}
            placeholder={`Message ${name}`}
            aria-label={`Message ${name}`}
            className="dp-input flex-1 resize-none max-h-28 min-h-[38px]"
            disabled={sending}
          />
          <button
            type="button"
            onClick={sendText}
            disabled={sending || draft.trim().length === 0}
            className="
              p-2 rounded-full bg-accent text-white
              hover:bg-accent-hover transition-colors duration-200 ease-smooth
              disabled:opacity-40 disabled:hover:bg-accent
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            "
            title="Send"
            aria-label="Send message"
          >
            <ArrowUp size={16} />
          </button>
        </div>
      </div>

      <ForwardFileDialog
        open={filePickerOpen}
        onClose={() => setFilePickerOpen(false)}
        note={draft.trim()}
        onPick={(file) => {
          setFilePickerOpen(false);
          void send({
            kind: "file_share",
            ncFileId: file.ncFileId,
            fileName: file.name,
            filePath: file.path,
            caption: captionOrUndefined(),
          });
        }}
      />
      <ForwardChatDialog
        open={chatPickerOpen}
        onClose={() => setChatPickerOpen(false)}
        note={draft.trim()}
        onPick={(conversation) => {
          setChatPickerOpen(false);
          void send({
            kind: "ai_chat_share",
            chatSessionId: conversation.id,
            caption: captionOrUndefined(),
          });
        }}
      />
      <TranscriptModal
        message={transcriptFor}
        onClose={() => setTranscriptFor(null)}
      />
      <MeetingDialog
        open={meetingDialogOpen}
        onClose={() => setMeetingDialogOpen(false)}
        threadId={thread.id}
        onCreated={() => {
          setMeetingDialogOpen(false);
          void mutate().then(() => onActivity(thread.id));
        }}
      />
    </>
  );
}

/**
 * One message. Text renders as a plain bubble; the two forward kinds render
 * a card INSIDE the bubble — file cards deep-link into /files, AI-chat
 * cards open the read-only transcript modal. No entrance motion by design:
 * the 5s poll re-renders the list, and replayed animations would turn
 * ambient refresh into noise (design-motion restraint).
 */
function MessageBubble({
  message,
  mine,
  showSender,
  onOpenTranscript,
  meId,
  participants,
  onRsvp,
  onCancelMeeting,
  meetingBusy,
}: {
  message: TeamChatMessage;
  mine: boolean;
  showSender: boolean;
  onOpenTranscript: () => void;
  meId: string;
  participants: TeamChatThreadSummary["participants"];
  onRsvp: (meetingId: string, response: TeamChatRsvpResponse) => void;
  onCancelMeeting: (meetingId: string) => void;
  meetingBusy: boolean;
}) {
  const align = mine ? "items-end" : "items-start";
  const bubble = mine
    ? "bg-accent text-white"
    : "bg-surface-secondary text-label-primary";
  // Card surfaces stay readable inside both bubble colors.
  const cardTone = mine
    ? "bg-white/10 border-white/20"
    : "bg-surface-primary border-separator";
  // UX review: /70 on the accent bubble fell under 4.5:1 for the caption
  // text — /80 clears it while still reading as secondary.
  const subtle = mine ? "text-white/80" : "text-label-tertiary";

  return (
    <div className={`flex flex-col ${align}`}>
      {showSender && !mine && (
        <span className="type-caption-2 text-label-tertiary px-1 pb-0.5">
          {message.senderDisplayName ?? "Member"}
        </span>
      )}
      <div
        className={`max-w-[85%] sm:max-w-[70%] rounded-2xl px-3.5 py-2 ${bubble}`}
      >
        {message.kind === "file_share" && (
          <Link
            href={
              message.sharedFilePath
                ? `/files?path=${encodeURIComponent(
                    message.sharedFilePath.replace(/\/[^/]*$/, "") || "/",
                  )}`
                : "/files"
            }
            className={`
              flex items-center gap-2.5 rounded-lg border px-3 py-2 mb-1 ${cardTone}
              transition-opacity duration-200 ease-smooth hover:opacity-80
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            `}
          >
            <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block type-footnote font-medium truncate">
                {message.sharedFileName ?? "Shared file"}
              </span>
              {message.sharedFilePath && (
                <span className={`block type-caption-2 truncate ${subtle}`}>
                  {message.sharedFilePath}
                </span>
              )}
            </span>
          </Link>
        )}

        {message.kind === "meeting_invite" &&
          (message.meeting ? (
            <MeetingCard
              meeting={message.meeting}
              mine={mine}
              meId={meId}
              participants={participants}
              onRsvp={onRsvp}
              onCancel={onCancelMeeting}
              busy={meetingBusy}
            />
          ) : (
            // The meeting row is gone (FK SetNull) — say so honestly
            // instead of rendering a dead card.
            <p className={`type-caption-2 mb-1 ${subtle}`}>
              Meeting no longer available
            </p>
          ))}

        {message.kind === "meeting_reminder" && (
          <MeetingReminderCard meeting={message.meeting} mine={mine} />
        )}

        {message.kind === "ai_chat_share" && (
          <button
            type="button"
            onClick={onOpenTranscript}
            className={`
              w-full text-left flex items-center gap-2.5 rounded-lg border px-3 py-2 mb-1 ${cardTone}
              transition-opacity duration-200 ease-smooth hover:opacity-80
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
            `}
          >
            <Sparkles size={18} strokeWidth={1.5} aria-hidden="true" />
            <span className="min-w-0">
              <span className="block type-footnote font-medium truncate">
                AI conversation
              </span>
              <span className={`block type-caption-2 truncate ${subtle}`}>
                Open the transcript
              </span>
            </span>
          </button>
        )}

        {message.body && (
          <p className="type-subheadline whitespace-pre-wrap break-words">
            {message.body}
          </p>
        )}

        <p className={`type-caption-2 mt-0.5 text-right tabular-nums ${subtle}`}>
          {formatMessageTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}
