"use client";

// One comment in the Activity timeline (WARP-3519): the card, its reaction bar,
// the inline editor and the delete confirm.

import { useEffect, useMemo, useRef, useState, type JSX, type RefObject } from "react";
import { SmilePlus } from "lucide-react";
import { PM_REACTION_EMOJI } from "@droplet/shared-types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useToast } from "@/components/Toast";
import { formatRelativeTime } from "@/lib/relative-time";
import { Avatar, usePerson } from "./bits";
import { PmIcon } from "./icons";
import {
  absoluteTime,
  applyReaction,
  isPlainEditable,
  reactionName,
  reactionTitle,
  type MentionCandidateLike,
} from "./activity";
import { RichTextEditor, type RichTextEditorHandle } from "./editor/RichTextEditor";
import { pmActions } from "./usePm";
import { canWrite, type PmComment, type PmReaction } from "./types";

/** An Escape pressed inside `ref` is dealt with there and goes no further
 *  (`onEscape`, if given, runs for it).
 *
 *  The drawer is a Dialog, and a Dialog closes on Escape from a listener on
 *  `window`. One keypress must not both dismiss the thing the person is in the
 *  middle of (the reaction row, an unsaved edit) and close the drawer under it.
 *
 *  Why two native listeners on `document`, and no handler on the element: the
 *  element's subtree may handle Escape itself — an editor that cancels on it
 *  re-renders its own form away, and one that uses React handlers only sees the
 *  key once React's root has. So "was it pressed in here?" is answered in the
 *  CAPTURE phase, before anything has had a chance to handle it, and the
 *  swallowing happens in the BUBBLE phase, after the editor and React but before
 *  the `window` listener. */
function useEscape(ref: RefObject<HTMLElement | null>, onEscape?: () => void): void {
  const latest = useRef(onEscape);
  useEffect(() => {
    latest.current = onEscape;
  });
  useEffect(() => {
    let inside = false;
    const mark = (e: KeyboardEvent) => {
      if (e.key === "Escape") inside = ref.current?.contains(e.target as Node) ?? false;
    };
    const swallow = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !inside) return;
      inside = false;
      e.stopPropagation();
      latest.current?.();
    };
    document.addEventListener("keydown", mark, true);
    document.addEventListener("keydown", swallow);
    return () => {
      document.removeEventListener("keydown", mark, true);
      // The Escape that closes an edit form is also what unmounts it. Removing
      // the swallower now would miss the very keystroke it exists for, so it
      // outlives this event.
      window.setTimeout(() => document.removeEventListener("keydown", swallow), 0);
    };
  }, [ref]);
}

// ── Reactions ───────────────────────────────────────────────────────────────

function ReactionPicker({
  isMine,
  onPick,
  onClose,
}: {
  isMine: (emoji: string) => boolean;
  onPick: (emoji: string) => void;
  onClose: () => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEscape(ref, onClose);
  return (
    <div ref={ref} className="pm-react-picker" role="group" aria-label="Pick a reaction">
      {PM_REACTION_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          className="pm-react-pick"
          aria-label={reactionName(emoji)}
          aria-pressed={isMine(emoji)}
          title={reactionName(emoji)}
          onClick={() => onPick(emoji)}
        >
          <span aria-hidden>{emoji}</span>
        </button>
      ))}
    </div>
  );
}

/** The chips under a comment, the viewer's own marked pressed, and an inline
 *  row of the allowlisted reactions behind "Add reaction" (no popover, so no
 *  portal or positioning). A click flips the chip at once and is rolled back,
 *  with a toast, if the server refuses. */
function ReactionBar({
  comment,
  viewerId,
  canReact,
  onChanged,
}: {
  comment: PmComment;
  viewerId: string | undefined;
  canReact: boolean;
  onChanged: () => void | Promise<void>;
}): JSX.Element | null {
  const person = usePerson();
  const { toast } = useToast();
  // What the viewer just did, shown until the server has answered AND the
  // thread has been re-read; null = show what the server says.
  const [optimistic, setOptimistic] = useState<PmReaction[] | null>(null);
  const [picking, setPicking] = useState(false);
  const busy = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);

  const shown = optimistic ?? comment.reactions;
  const isMine = (emoji: string) =>
    viewerId !== undefined && shown.some((r) => r.emoji === emoji && r.userIds.includes(viewerId));

  const toggle = async (emoji: string) => {
    if (viewerId === undefined || busy.current) return;
    const on = !isMine(emoji);
    busy.current = true;
    setOptimistic(applyReaction(shown, emoji, viewerId, on));
    let saved = false;
    try {
      if (on) await pmActions().addReaction(comment.id, emoji);
      else await pmActions().removeReaction(comment.id, emoji);
      saved = true;
    } catch {
      toast("Couldn't add that reaction — try again.", "error");
    }
    try {
      if (saved) await onChanged();
    } finally {
      setOptimistic(null);
      busy.current = false;
    }
  };

  const closePicker = () => {
    setPicking(false);
    addButton.current?.focus();
  };

  if (!canReact && shown.length === 0) return null;
  return (
    <div className="pm-reactions">
      {shown.map((r) => {
        const title = reactionTitle(r.userIds.map((id) => person(id).name));
        if (!canReact) {
          // Read-only roles still see the tally — it is information, not a control.
          return (
            <span key={r.emoji} className="pm-react" title={title}>
              <span>{r.emoji}</span>
              <span className="n">{r.count}</span>
            </span>
          );
        }
        const mine = isMine(r.emoji);
        return (
          <button
            key={r.emoji}
            type="button"
            className={"pm-react" + (mine ? " on" : "")}
            aria-label={`${r.emoji} ${r.count}`}
            aria-pressed={mine}
            title={title}
            onClick={() => void toggle(r.emoji)}
          >
            <span aria-hidden>{r.emoji}</span>
            <span className="n" aria-hidden>
              {r.count}
            </span>
          </button>
        );
      })}
      {canReact && (
        <button
          ref={addButton}
          type="button"
          className="pm-react pm-react-add"
          aria-label="Add reaction"
          aria-expanded={picking}
          onClick={() => setPicking((v) => !v)}
        >
          <SmilePlus size={14} strokeWidth={1.6} aria-hidden />
        </button>
      )}
      {picking && (
        <ReactionPicker
          isMine={isMine}
          onPick={(emoji) => {
            closePicker();
            void toggle(emoji);
          }}
          onClose={closePicker}
        />
      )}
    </div>
  );
}

// ── Inline edit ─────────────────────────────────────────────────────────────

function EditForm({
  comment,
  mentionCandidates,
  onClose,
  onSaved,
}: {
  comment: PmComment;
  mentionCandidates: readonly MentionCandidateLike[] | undefined;
  onClose: () => void;
  /** The edit is on the server: refresh the thread, then close this form. */
  onSaved: () => Promise<void>;
}): JSX.Element {
  const { toast } = useToast();
  const editor = useRef<RichTextEditorHandle>(null);
  const box = useRef<HTMLDivElement>(null);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  // The editor's own Escape (cancel) runs first; this only keeps it from also
  // closing the drawer.
  useEscape(box);

  const save = async () => {
    const handle = editor.current;
    if (!handle || handle.isEmpty() || saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await pmActions().editComment(comment.id, handle.getHTML());
    } catch {
      // The editor stays open with the draft in it.
      toast("Couldn't edit that comment — try again.", "error");
      saving.current = false;
      setBusy(false);
      return;
    }
    await onSaved();
  };

  const cancel = () => {
    if (!saving.current) onClose();
  };

  return (
    <div ref={box} className="pm-edit">
      <RichTextEditor
        ref={editor}
        ariaLabel="Edit comment"
        initialHtml={comment.commentHtml}
        mentionCandidates={mentionCandidates}
        onChange={({ isEmpty }) => setEmpty(isEmpty)}
        onSubmit={save}
        onCancel={cancel}
        autoFocus
      />
      <div className="pm-edit-actions">
        <button type="button" className="pm-btn sm" onClick={cancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className="pm-btn primary sm" onClick={save} disabled={empty || busy}>
          Save
        </button>
      </div>
    </div>
  );
}

// ── The card ────────────────────────────────────────────────────────────────

export function CommentCard({
  comment,
  viewerId,
  role,
  mentionCandidates,
  onChanged,
}: {
  comment: PmComment;
  viewerId: string | undefined;
  role: string | undefined;
  mentionCandidates: readonly MentionCandidateLike[] | undefined;
  /** After an edit, delete or reaction landed: re-read the thread and the counts. */
  onChanged: () => void | Promise<void>;
}): JSX.Element {
  const person = usePerson();
  const { toast } = useToast();
  const { authorId } = comment;
  const writer = canWrite(role);
  const ai = authorId === null;
  const own = !ai && authorId === viewerId;
  const admin = role === "owner" || role === "admin";
  // Only the author edits (never an AI comment, never an owner/admin on
  // somebody else's words); the author or an owner/admin may delete. Write
  // affordances are hidden, not disabled, for a read-only role.
  const canDelete = writer && !comment.deleted && (own || admin);
  const canEdit = useMemo(
    () => writer && own && !comment.deleted && isPlainEditable(comment.commentHtml),
    [writer, own, comment.deleted, comment.commentHtml],
  );

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const tombstone = useRef<HTMLDivElement>(null);
  const wasEditing = useRef(false);
  const focusTombstone = useRef(false);

  // Closing the editor must not drop focus on <body>: back to Edit.
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  // The Delete button is gone once the comment is a tombstone, so its confirm
  // cannot hand focus back to it. Land on the tombstone, where the thread was.
  useEffect(() => {
    if (comment.deleted && focusTombstone.current) {
      focusTombstone.current = false;
      tombstone.current?.focus();
    }
  }, [comment.deleted]);

  const confirmDelete = async () => {
    try {
      await pmActions().deleteComment(comment.id);
    } catch (e) {
      toast("Couldn't delete that comment — try again.", "error");
      throw e; // ConfirmDialog stays open on a rejection
    }
    focusTombstone.current = true;
    await onChanged();
  };

  const closeConfirm = () => {
    setConfirming(false);
    deleteButton.current?.focus();
  };

  if (comment.deleted) {
    return (
      <div ref={tombstone} className="pm-tombstone" tabIndex={-1}>
        <span>This comment was deleted.</span>
        {comment.deletedById && (
          <span className="meta">
            {" · by "}
            {person(comment.deletedById).name}
            {" · "}
            <time dateTime={comment.deletedAt ?? comment.updatedAt}>
              {formatRelativeTime(comment.deletedAt ?? comment.updatedAt)}
            </time>
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="pm-comment">
      {ai ? <span className="pm-ai-av">AI</span> : <Avatar id={authorId} size={28} />}
      <div className="pm-comment-main">
        <div className="pm-comment-head">
          <span className="pm-comment-name">{ai ? "Droplet AI" : person(authorId).name}</span>
          <time className="pm-comment-when" dateTime={comment.createdAt} title={absoluteTime(comment.createdAt)}>
            {formatRelativeTime(comment.createdAt)}
          </time>
          {comment.editedAt && (
            <span className="pm-edited" title={absoluteTime(comment.editedAt)}>
              (edited)
            </span>
          )}
          {!editing && (canEdit || canDelete) && (
            <span className="pm-comment-actions">
              {canEdit && (
                <button
                  ref={editButton}
                  type="button"
                  className="pm-btn ghost sm"
                  onClick={() => setEditing(true)}
                >
                  <PmIcon name="pencil" size={12} />
                  Edit
                </button>
              )}
              {canDelete && (
                <button
                  ref={deleteButton}
                  type="button"
                  className="pm-btn ghost sm"
                  onClick={() => setConfirming(true)}
                >
                  <PmIcon name="trash" size={12} />
                  Delete
                </button>
              )}
            </span>
          )}
        </div>
        {editing ? (
          <EditForm
            comment={comment}
            mentionCandidates={mentionCandidates}
            onClose={() => setEditing(false)}
            onSaved={async () => {
              await onChanged();
              setEditing(false);
            }}
          />
        ) : (
          <>
            {/* Comment HTML is server-sanitized against a strict allowlist at the
                write boundary (orchestrator sanitizePmHtml in addComment and
                editComment) — every persisted value, whether from the
                dashboard, the mobile API, or an MCP tool call, is clean before
                it ever reaches this render. */}
            <div
              className={"pm-prose" + (ai ? " pm-ai-bubble" : "")}
              style={ai ? { padding: "9px 11px", borderRadius: 10 } : undefined}
              dangerouslySetInnerHTML={{ __html: comment.commentHtml }}
            />
            <ReactionBar comment={comment} viewerId={viewerId} canReact={writer} onChanged={onChanged} />
          </>
        )}
      </div>
      {canDelete && (
        // ConfirmDialog is a portal, but React still carries its key events up
        // the REACT tree — into the drawer's focus trap, which would steal Tab
        // away from the confirm. This span has no box; it only stops Tab there.
        <span hidden onKeyDown={(e) => e.key === "Tab" && e.stopPropagation()}>
          <ConfirmDialog
            open={confirming}
            onConfirm={confirmDelete}
            onCancel={closeConfirm}
            title="Delete this comment?"
            description="It will be removed from the thread. This can't be undone."
            confirmLabel="Delete"
          />
        </span>
      )}
    </div>
  );
}
