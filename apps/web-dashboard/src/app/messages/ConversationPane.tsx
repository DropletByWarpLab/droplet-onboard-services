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

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import useSWR from "swr";
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
  fetchSpaces,
  markTeamChatThreadRead,
  rsvpTeamChatMeeting,
  sendTeamChatMessage,
  type TeamChatMessage,
  type TeamChatRsvpResponse,
  type TeamChatSendBody,
  type TeamChatThreadSummary,
} from "@/lib/api";
import type { FileSpace, FileSpacesResponse } from "@/lib/types";
import { buildFilesUrl, spaceRelativePath } from "@/lib/space-attribution";
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

  // WARP-1898 — the spaces THIS viewer can open. A forwarded-file card needs
  // them twice: to tell "follow this link" apart from "you can't reach this"
  // (instead of linking into /files' silent personal-space fallback), and for
  // the matched space's `root`, which converts the stored home-relative path
  // into the space-relative `?path=` /files expects. Fetched only once a
  // thread actually contains a file share (SWR dedupes it with the forward
  // picker's identical key), and deliberately NOT gated on `thread`: hooks
  // run before the no-thread early return below.
  const hasFileShare = messages?.some((m) => m.kind === "file_share") ?? false;
  const { data: spacesResp } = useSWR<FileSpacesResponse>(
    hasFileShare ? "/api/files/spaces" : null,
    fetchSpaces,
    { shouldRetryOnError: false },
  );
  // `null` = not known yet (loading, or the probe failed). Distinct from an
  // empty list, which would mean "reaches nothing" — cards stay neutral while
  // it is null rather than accusing a reachable space of being unreachable.
  const spaces = useMemo(() => spacesResp?.spaces ?? null, [spacesResp]);

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
            spaces={spaces}
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
            // WARP-1898 — `filePath` is space-relative, so the space has to
            // travel with it or the recipient's link resolves in THEIRS.
            space: file.space,
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
 * WARP-1898 — the /files deep link for a forwarded file.
 *
 * Two path vocabularies meet here, and mixing them is the WARP-1140
 * double-prefix bug (a silently EMPTY folder, no error):
 *
 *   - `sharedFilePath` is HOME-relative, because the picker stores a
 *     listing row's own `path` and library rows carry their mount
 *     ("/Finance/Q1/x.pdf" — see `toActiveSpaceRelative` in files/page.tsx).
 *   - `?path=` is SPACE-relative: the orchestrator re-prefixes the mount
 *     server-side (`rootForSpace`), so passing the mounted form again
 *     resolves "/Finance/Finance/Q1".
 *
 * So `path` is converted with the space's own root, exactly as
 * `resolveFileSpace` does for the space-aware sub-views, while `preview`
 * stays HOME-relative — it is matched against the loaded listing's entries,
 * which carry that form (files/page.tsx). `buildFilesUrl` drops `space` for
 * personal and `path` for the root, keeping those URLs byte-identical to
 * every other Files link.
 */
function filesHrefFor(
  spaceId: string,
  spaceRoot: string,
  homeRelativePath: string,
): string {
  const parent = homeRelativePath.replace(/\/[^/]*$/, "") || "/";
  const base = buildFilesUrl(spaceId, spaceRelativePath(parent, spaceRoot));
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}preview=${encodeURIComponent(homeRelativePath)}`;
}

type FileShareState =
  | { kind: "open"; href: string }
  /** Known to be unopenable by THIS viewer, with a reason worth showing. */
  | { kind: "blocked"; reason: string }
  /** Reachability not known yet — render neutral, never guess. */
  | { kind: "pending" };

/**
 * Decide what a forwarded-file card can honestly offer this viewer.
 *
 * Forwarding grants NOTHING — `routes/team-chat.ts` checks only that the
 * SENDER could read the file and then stores a pointer; /files re-runs its
 * own access control when the link is followed. So a card that cannot work
 * must say so, rather than render a link that silently goes elsewhere:
 * /files resolves an absent-or-inaccessible `space` to the viewer's
 * personal space on purpose (a no-existence-leak fallback, files/page.tsx),
 * which is exactly how the sender's path came to be resolved inside the
 * recipient's own namespace.
 */
function fileShareState(
  message: TeamChatMessage,
  mine: boolean,
  spaces: FileSpace[] | null,
): FileShareState {
  const path = message.sharedFilePath;
  const space = message.sharedFileSpace;

  // Sent before the space was recorded. A path with no space is not
  // addressable, and resolving it against a guess IS the defect.
  if (!path || !space) {
    return {
      kind: "blocked",
      reason: "Droplet can't tell where this file is kept — ask for it again.",
    };
  }

  // Personal space is nobody's but its owner's: there is no grant and no
  // cross-user personal space to browse, so this can never resolve for
  // anyone else however well-formed the link is. Its root is always "/",
  // so my own file links without waiting on the space list.
  if (space === "personal") {
    if (mine) return { kind: "open", href: filesHrefFor(space, "/", path) };
    const who = message.senderDisplayName ?? "the sender";
    return {
      kind: "blocked",
      reason: `Only ${who} can open this — it's in their personal files.`,
    };
  }

  // Household / department library: openable only if the viewer has that
  // space — and its `root` is also what converts the stored home-relative
  // path into the space-relative `?path=`, so the lookup is load-bearing
  // twice over, not just an access check.
  if (spaces === null) return { kind: "pending" };
  const target = spaces.find((s) => s.id === space);
  if (!target) {
    return {
      kind: "blocked",
      reason: "You don't have access to where this file is kept.",
    };
  }
  return { kind: "open", href: filesHrefFor(target.id, target.root, path) };
}

function FileShareCard({
  message,
  mine,
  spaces,
}: {
  message: TeamChatMessage;
  mine: boolean;
  spaces: FileSpace[] | null;
}) {
  const name = message.sharedFileName ?? "Shared file";
  const state = fileShareState(message, mine, spaces);

  if (state.kind === "open") {
    return (
      <Link href={state.href} className="mx-card" data-testid="file-share-link">
        <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0">
          <span className="mx-card-title truncate">{name}</span>
          {message.sharedFilePath && (
            <span className="mx-card-meta mx-sub truncate">
              {message.sharedFilePath}
            </span>
          )}
        </span>
      </Link>
    );
  }

  // Not a link: there is nowhere correct to send them. The filename still
  // shows (the sender already disclosed it), and the path rides along as a
  // title so they can ask for it by name.
  return (
    <div
      className="mx-card is-unavailable"
      data-testid={
        state.kind === "blocked" ? "file-share-unavailable" : "file-share-pending"
      }
      title={message.sharedFilePath ?? undefined}
    >
      <FileText size={18} strokeWidth={1.5} aria-hidden="true" />
      <span className="min-w-0">
        <span className="mx-card-title truncate">{name}</span>
        {state.kind === "blocked" && (
          <span className="mx-card-meta mx-sub">{state.reason}</span>
        )}
      </span>
    </div>
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
  spaces,
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
  /** WARP-1898 — spaces this viewer can open; null until known. */
  spaces: FileSpace[] | null;
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
          <FileShareCard
            message={message}
            mine={mine}
            spaces={spaces}
          />
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
