"use client";

// The drawer's Activity section (WARP-3519): the work item's comments and its
// history as ONE thread — newest last, the order a conversation is read in —
// with a filter and the composer under it.

import { useMemo, useRef, useState, type JSX } from "react";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { formatRelativeTime } from "@/lib/relative-time";
import { SafetyChip, Skel, usePerson } from "./bits";
import { PmIcon } from "./icons";
import {
  ACTIVITY_FILTERS,
  absoluteTime,
  describeActivity,
  emptyCopy,
  filterTimeline,
  mentionCandidatesFrom,
  type ActivityFilter,
  type MentionCandidateLike,
} from "./activity";
import { CommentCard } from "./comment";
import { RichTextEditor, type RichTextEditorHandle } from "./editor/RichTextEditor";
import { pmActions, usePeople, useTimeline } from "./usePm";
import { StagedFiles, UploadRows, pastedFiles, useAttachmentUploads, useFileDrop, useFilePicker } from "./attachments";
import type { PmActivity, PmTimelineRefs, PmAttachment } from "./types";

/** One line of history: `<Actor> <sentence> · <when>`. A person's rows carry a
 *  quiet marker rather than a face — the comments are the loud part of the
 *  thread — and the assistant's keep the "AI" mark the board already uses. */
function ActivityRow({ activity, refs }: { activity: PmActivity; refs: PmTimelineRefs }): JSX.Element {
  const person = usePerson();
  const ai = activity.actorId === null;
  const name = (id: string | null | undefined) => (id ? person(id).name : "someone");
  const sentence = describeActivity(activity, { name, refs });
  return (
    <div className="pm-tl-row">
      {ai ? <span className="pm-ai-av pm-tl-ai">AI</span> : <span className="pm-tl-dot" aria-hidden />}
      <div className="pm-tl-text">
        <span className="pm-tl-actor">{ai ? "Droplet AI" : name(activity.actorId)}</span> {sentence}
        <span className="pm-tl-when">
          {" · "}
          <time dateTime={activity.createdAt} title={absoluteTime(activity.createdAt)}>
            {formatRelativeTime(activity.createdAt)}
          </time>
        </span>
      </div>
    </div>
  );
}

function Composer({
  itemId,
  mentionCandidates,
  uploads,
  canAttach = false,
  onSent,
}: {
  itemId: string;
  uploads?: ReturnType<typeof useAttachmentUploads>;
  canAttach?: boolean;
  mentionCandidates: readonly MentionCandidateLike[] | undefined;
  /** The comment is on the server: re-read the thread and refresh the counts. */
  onSent: () => Promise<void>;
}): JSX.Element {
  const { toast } = useToast();
  const editor = useRef<RichTextEditorHandle>(null);
  // Mirrors the editor so Send can be disabled while it is empty. Reset by hand
  // after a send: `clear()` is not something to count on to report itself.
  const [empty, setEmpty] = useState(true);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [files, setFiles] = useState<File[]>([]);
  const stage = (picked: File[]) => setFiles((cur) => [...cur, ...picked]);
  const picker = useFilePicker(stage, "Choose files to attach to the comment");
  const drop = useFileDrop(stage, { nested: true });

  const submit = async () => {
    const handle = editor.current;
    // Two guards, on purpose: the button is disabled, but ⌘↵ reaches here too.
    if (!handle || sending.current || (handle.isEmpty() && files.length === 0)) return;
    sending.current = true;
    setBusy(true);
    try {
      const { comment } = await pmActions().addComment(itemId, handle.isEmpty() ? "<p></p>" : handle.getHTML());
      const staged = files;
      setFiles([]);
      if (staged.length && uploads) {
        void uploads.addFiles(staged, { commentId: comment.id }).then((failed) => {
          if (failed) toast(`Comment sent, but ${failed} ${failed === 1 ? "file" : "files"} couldn't be uploaded.`, "error");
        });
      }
    } catch (e) {
      // The draft stays in the editor; the person can simply send again.
      toast(translateError(e, "projects"), "error");
      sending.current = false;
      setBusy(false);
      return;
    }
    handle.clear();
    setEmpty(true);
    sending.current = false;
    setBusy(false);
    await onSent();
  };

  return (
    <div className={"pm-composer" + (drop.over ? " pm-drop-over" : "")}
      {...(canAttach ? drop.dropProps : {})}
      onPasteCapture={(e) => {
        if (!canAttach) return;
        const picked = pastedFiles(e);
        if (!picked.length) return;
        e.preventDefault(); e.stopPropagation(); stage(picked);
      }}>
      {canAttach && picker.input}
      <RichTextEditor
        ref={editor}
        ariaLabel="Write a comment"
        placeholder="Write a comment"
        mentionCandidates={mentionCandidates}
        onChange={({ isEmpty }) => setEmpty(isEmpty)}
        onSubmit={() => void submit()}
      />
      <StagedFiles files={files} onRemove={(i) => setFiles((cur) => cur.filter((_, j) => j !== i))} />
      {uploads && <UploadRows rows={uploads.queue.filter((r) => r.commentId)} onDismiss={uploads.dismiss} />}
      <div className="pm-row" style={{ justifyContent: "space-between", marginTop: 8 }}>
        <SafetyChip tier="write" />
        <span className="pm-row" style={{ gap: 6 }}>
        {canAttach && <button type="button" className="pm-iconbtn" aria-label="Attach files" onClick={picker.open}><PmIcon name="attach" size={16} /></button>}
        <button
          className="pm-btn primary sm"
          type="button"
          onClick={() => void submit()}
          disabled={busy || (empty && files.length === 0)}
        >
          <PmIcon name="send" size={13} />
          {busy ? "Sending…" : "Send"}
          <span className="pm-kbd" style={{ marginLeft: 2 }}>
            ⌘↵
          </span>
        </button>
        </span>
      </div>
    </div>
  );
}

export function ActivitySection({
  itemId,
  viewerId,
  role,
  onChanged,
  attachments = [],
  uploads,
  canAttach = false,
}: {
  attachments?: PmAttachment[];
  uploads?: ReturnType<typeof useAttachmentUploads>;
  canAttach?: boolean;
  itemId: string;
  viewerId: string | undefined;
  role: string | undefined;
  /** An edit, delete, reaction or new comment landed: refresh what counts it. */
  onChanged: () => void;
}): JSX.Element {
  const { entries, refs, total, truncated, isLoading, error, mutate } = useTimeline(itemId);
  const { people } = usePeople();
  const mentionCandidates = useMemo(
    () => mentionCandidatesFrom(people?.map((person) => ({ userId: person.id, displayName: person.displayName }))),
    [people],
  );
  const [filter, setFilter] = useState<ActivityFilter>("all");

  const refresh = async () => {
    await mutate();
    onChanged();
  };

  const loading = entries === undefined && !error && isLoading;
  const failed = entries === undefined && error !== undefined;
  const shown = entries ? filterTimeline(entries, filter) : [];

  return (
    <div>
      <div className="pm-tl-head">
        <h3 className="pm-sect" style={{ margin: 0 }}>
          Activity {total !== undefined && <span className="sx">{total}</span>}
        </h3>
        <div className="pm-pills" role="group" aria-label="Show">
          {ACTIVITY_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? "on" : ""}
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-busy="true">
          <Skel h={34} />
          <Skel h={34} />
          <Skel h={34} w="70%" />
        </div>
      )}

      {failed && (
        <div className="pm-tl-error">
          <span>Couldn&apos;t load activity. Check the appliance connection and try again.</span>
          <button type="button" className="pm-btn ghost sm" onClick={() => void mutate()}>
            Try again
          </button>
        </div>
      )}

      {entries && shown.length === 0 && <div className="pm-tl-empty">{emptyCopy(filter)}</div>}

      {shown.length > 0 && (
        <ul className="pm-tl">
          {shown.map((entry) => (
            <li key={entry.id} className={entry.type === "comment" ? "pm-tl-item" : "pm-tl-item is-history"}>
              {entry.type === "comment" ? (
                <CommentCard
                  comment={entry.comment}
                  attachments={attachments.filter((file) => file.commentId === entry.comment.id)}
                  viewerId={viewerId}
                  role={role}
                  mentionCandidates={mentionCandidates}
                  onChanged={refresh}
                />
              ) : (
                <ActivityRow activity={entry.activity} refs={refs} />
              )}
            </li>
          ))}
        </ul>
      )}

      {truncated && entries && total !== undefined && (
        <p className="pm-tl-note">
          Showing the first {entries.length} of {total} entries.
        </p>
      )}

      <Composer itemId={itemId} mentionCandidates={mentionCandidates} uploads={uploads} canAttach={canAttach} onSent={refresh} />
    </div>
  );
}
