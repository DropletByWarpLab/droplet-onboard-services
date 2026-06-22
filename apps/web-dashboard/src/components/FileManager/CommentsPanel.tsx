"use client";

import { useState } from "react";
import { MessageSquare, Trash2 } from "lucide-react";
import { useFileComments } from "@/lib/hooks/useFileComments";
import { useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";
import type { FileCommentInfo } from "@/lib/types";

interface CommentsPanelProps {
  filePath: string;
}

const MAX_BODY = 4000;

function formatWhen(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diffMs = Date.now() - then;
  const min = Math.round(diffMs / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

/**
 * WARP-881 / WS-3 — file comments section for the Files detail panel.
 *
 * Sibling style of VersionHistoryPanel: `pt-4 border-t border-separator`
 * header, `type-footnote` title, design tokens only. Reads are user-scoped
 * server-side (family sees only its own; owner/admin see all). The delete
 * affordance is shown only when the comment is the viewer's own OR the
 * viewer is owner/admin — mirroring the server's author-or-privileged guard
 * so a family user never sees a control that would 403.
 */
export function CommentsPanel({ filePath }: CommentsPanelProps) {
  const { user } = useAuth();
  const isGuest = user?.role === "guest";
  const isPrivileged = user?.role === "owner" || user?.role === "admin";
  const { comments, error, isLoading, add, remove } = useFileComments(
    isGuest ? null : filePath,
  );
  const [draft, setDraft] = useState("");
  const [posting, setPosting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const canDelete = (c: FileCommentInfo): boolean =>
    isPrivileged || c.authorUserId === user?.id;

  const submit = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setActionError(null);
    setPosting(true);
    try {
      await add(body);
      setDraft("");
    } catch (err) {
      setActionError(translateError(err, "files"));
    } finally {
      setPosting(false);
    }
  };

  const onRemove = async (id: string) => {
    setActionError(null);
    try {
      await remove(id);
    } catch (err) {
      setActionError(translateError(err, "files"));
    }
  };

  return (
    <div className="pt-4 border-t border-separator">
      <div className="flex items-center gap-2 mb-3">
        <MessageSquare size={14} className="text-label-tertiary" />
        <h4 className="type-footnote text-label-secondary font-medium">
          Comments
        </h4>
      </div>

      {isGuest ? (
        <p className="type-caption-1 text-label-tertiary">
          Comments aren&apos;t available for guests.
        </p>
      ) : (
        <>
          {error && (
            <p className="type-caption-1 text-system-red mb-2">
              {translateError(error, "files")}
            </p>
          )}
          {actionError && (
            <p className="type-caption-1 text-system-red mb-2">{actionError}</p>
          )}

          {isLoading && comments.length === 0 && !error && (
            <p className="type-caption-1 text-label-tertiary">Loading…</p>
          )}

          {!isLoading && comments.length === 0 && !error && (
            <p className="type-caption-1 text-label-tertiary mb-3">
              No comments yet. Start the conversation about this file.
            </p>
          )}

          {comments.length > 0 && (
            <ul className="space-y-2 mb-3">
              {comments.map((c) => (
                <li
                  key={c.id}
                  className="group rounded-md bg-surface-secondary px-2.5 py-2"
                >
                  <div className="flex items-start gap-2">
                    <p className="flex-1 min-w-0 type-caption-1 text-label-primary whitespace-pre-wrap break-words">
                      {c.body}
                    </p>
                    {canDelete(c) && (
                      <button
                        type="button"
                        onClick={() => onRemove(c.id)}
                        className="shrink-0 p-1 rounded-full text-label-tertiary opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-system-red transition-all"
                        title="Delete comment"
                        aria-label="Delete comment"
                      >
                        <Trash2 size={12} />
                      </button>
                    )}
                  </div>
                  <p className="type-caption-2 text-label-tertiary mt-1">
                    {formatWhen(c.createdAt)}
                  </p>
                </li>
              ))}
            </ul>
          )}

          <textarea
            value={draft}
            maxLength={MAX_BODY}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Cmd/Ctrl+Enter posts — Enter alone keeps newlines.
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void submit();
              }
            }}
            rows={2}
            placeholder="Add a comment…"
            className="w-full resize-none px-2.5 py-2 rounded-md bg-surface-secondary border border-separator type-caption-1 text-label-primary placeholder:text-label-tertiary focus:outline-none focus:border-accent transition-colors"
          />
          <div className="flex justify-end mt-2">
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || posting}
              className="btn ghost sm disabled:opacity-40"
            >
              {posting ? "Posting…" : "Post"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
