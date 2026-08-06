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
  // WARP-1685 — meetings. Busy is scoped to the TARGET meeting (UX
  // review: other cards' pills must not grey out); mutations still
  // serialize globally — one in flight at a time keeps the optimistic
  // cache coherent.
  const [meetingDialogOpen, setMeetingDialogOpen] = useState(false);
  const [busyMeetingId, setBusyMeetingId] = useState<string | null>(null);
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
    if (!threadId || busyMeetingId !== null) return;
    setBusyMeetingId(meetingId);
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
      setBusyMeetingId(null);
    }
  }

  /** Organizer cancel — the two-step confirm lives in the card itself. */
  async function cancelMeeting(meetingId: string) {
    if (!threadId || busyMeetingId !== null) return;
    setBusyMeetingId(meetingId);
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
      setBusyMeetingId(null);
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
          className="mx-empty-icon"
          aria-hidden="true"
        />
        <p className="mx-empty-title">Select a conversation</p>
        <p className="mx-empty-sub">
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
      <div className="mx-head">
        <button
          type="button"
          onClick={onBack}
          className="mx-iconbtn lg:hidden -ml-1.5"
          aria-label="Back to conversations"
        >
          <ArrowLeft size={16} />
        </button>
        <div className="flex-1 min-w-0">
          <p className="mx-head-title truncate">{name}</p>
          <p className="mx-head-sub truncate">
            {thread.kind === "group" ? memberNames : "Direct message"}
          </p>
        </div>
      </div>

      {/* Messages — column-reverse renders the newest-first array bottom-up. */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col-reverse gap-2 px-4 py-3">
        {messagesError !== undefined && messages === undefined && (
          <p role="alert" className="mx-quiet">
            Couldn&apos;t load messages — retrying.
          </p>
        )}
        {messagesError === undefined && isLoading && !messages && (
          <p className="mx-quiet">Loading messages…</p>
        )}
        {messages && messages.length === 0 && (
          <p className="mx-quiet text-center py-6">
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
            busyMeetingId={busyMeetingId}
          />
        ))}
      </div>

      {/* Composer */}
      <div className="mx-composer">
        {sendError && (
          <p role="alert" className="mx-error px-1 pb-1.5">
            {sendError}
          </p>
        )}
        {meetingError && (
          <p role="alert" className="mx-error px-1 pb-1.5">
            {meetingError}
          </p>
        )}
        <div className="mx-composer-inner">
          <button
            type="button"
            onClick={() => setFilePickerOpen(true)}
            disabled={sending}
            className="mx-iconbtn"
            title="Forward a file"
            aria-label="Forward a file"
          >
            <Paperclip size={16} />
          </button>
          <button
            type="button"
            onClick={() => setMeetingDialogOpen(true)}
            disabled={sending}
            className="mx-iconbtn"
            title="Schedule a meeting"
            aria-label="Schedule a meeting"
          >
            <CalendarPlus size={16} />
          </button>
          <button
            type="button"
            onClick={() => setChatPickerOpen(true)}
            disabled={sending}
            className="mx-iconbtn"
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
            disabled={sending}
          />
          <button
            type="button"
            onClick={sendText}
            disabled={sending || draft.trim().length === 0}
            className="mx-send"
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
 *
 * WARP-1783 — the bubble pair mirrors /chat: theirs is `--surface` + the
 * `--border` hairline, mine is the soft `--user-bubble` / `--user-bubble-text`
 * pair. Mine used to be a saturated legacy-accent fill under a hardcoded
 * white literal (2.98:1 in dark — a WCAG 1.4.3 failure), which is also why
 * every nested element carried a `mine ? … : …` tone branch. With both
 * bubbles now on theme-appropriate fills, one `--inset` card tone and a
 * currentColor-derived `.mx-sub` serve both sides, so that branching is gone.
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
  busyMeetingId,
}: {
  message: TeamChatMessage;
  mine: boolean;
  showSender: boolean;
  onOpenTranscript: () => void;
  meId: string;
  participants: TeamChatThreadSummary["participants"];
  onRsvp: (meetingId: string, response: TeamChatRsvpResponse) => void;
  onCancelMeeting: (meetingId: string) => void;
  /** The one meeting with a mutation in flight — only ITS card disables. */
  busyMeetingId: string | null;
}) {
  const align = mine ? "items-end" : "items-start";

  return (
    <div className={`flex flex-col ${align}`}>
      {showSender && !mine && (
        <span className="mx-sender">
          {message.senderDisplayName ?? "Member"}
        </span>
      )}
      <div className={`mx-bubble ${mine ? "is-mine" : "is-theirs"}`}>
        {message.kind === "file_share" && (
          <Link
            href={
              message.sharedFilePath
                ? `/files?path=${encodeURIComponent(
                    message.sharedFilePath.replace(/\/[^/]*$/, "") || "/",
                  )}`
                : "/files"
            }
            className="mx-card"
          >
            <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
            <span className="min-w-0">
              <span className="mx-card-title truncate">
                {message.sharedFileName ?? "Shared file"}
              </span>
              {message.sharedFilePath && (
                <span className="mx-card-meta mx-sub truncate">
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
              meId={meId}
              participants={participants}
              onRsvp={onRsvp}
              onCancel={onCancelMeeting}
              busy={busyMeetingId === message.meeting.id}
            />
          ) : (
            // The meeting row is gone (FK SetNull) — say so honestly
            // instead of rendering a dead card.
            <p className="mx-card-meta mx-sub mb-1">Meeting no longer available</p>
          ))}

        {message.kind === "meeting_reminder" && (
          <MeetingReminderCard meeting={message.meeting} />
        )}

        {message.kind === "ai_chat_share" && (
          <button type="button" onClick={onOpenTranscript} className="mx-card">
            <Sparkles size={18} strokeWidth={1.5} aria-hidden="true" />
            <span className="min-w-0">
              <span className="mx-card-title truncate">AI conversation</span>
              <span className="mx-card-meta mx-sub truncate">
                Open the transcript
              </span>
            </span>
          </button>
        )}

        {message.body && (
          <p className="whitespace-pre-wrap break-words">{message.body}</p>
        )}

        <span className="mx-time mx-sub">
          {formatMessageTime(message.createdAt)}
        </span>
      </div>
    </div>
  );
}
