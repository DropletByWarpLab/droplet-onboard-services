"use client";

import { useState } from "react";
import { Tag, X, Plus } from "lucide-react";
import { useFileTags } from "@/lib/hooks/useFileTags";
import { useAuth } from "@/lib/auth";
import { translateError } from "@/lib/friendly-errors";

interface TagChipsProps {
  filePath: string;
}

const MAX_LABEL = 64;

/**
 * WARP-881 / WS-3 — file tags section for the Files detail panel. Sibling
 * style of VersionHistoryPanel: `pt-4 border-t border-separator` header,
 * `type-footnote` title, design tokens only (indigo accent-subtle chips, no
 * hardcoded hex). Tags are file-scoped — every reader sees every tag — so
 * anyone owner/admin/family can add or remove; a guest sees a read-only
 * empty note (the API would 403 a guest anyway).
 */
export function TagChips({ filePath }: TagChipsProps) {
  const { user } = useAuth();
  const isGuest = user?.role === "guest";
  const { tags, error, isLoading, add, remove } = useFileTags(
    isGuest ? null : filePath,
  );
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const submit = async () => {
    const label = draft.trim();
    if (!label || adding) return;
    setActionError(null);
    setAdding(true);
    try {
      await add(label);
      setDraft("");
    } catch (err) {
      setActionError(translateError(err, "files"));
    } finally {
      setAdding(false);
    }
  };

  const onRemove = async (label: string) => {
    setActionError(null);
    try {
      await remove(label);
    } catch (err) {
      setActionError(translateError(err, "files"));
    }
  };

  return (
    <div className="pt-4 border-t border-separator">
      <div className="flex items-center gap-2 mb-3">
        <Tag size={14} className="text-label-tertiary" />
        <h4 className="type-footnote text-label-secondary font-medium">Tags</h4>
      </div>

      {isGuest ? (
        <p className="type-caption-1 text-label-tertiary">
          Tags aren&apos;t available for guests.
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

          {isLoading && tags.length === 0 && !error && (
            <p className="type-caption-1 text-label-tertiary">Loading…</p>
          )}

          {!isLoading && tags.length === 0 && !error && (
            <p className="type-caption-1 text-label-tertiary mb-2">
              No tags yet. Add one to organize this file.
            </p>
          )}

          {tags.length > 0 && (
            <ul className="flex flex-wrap gap-1.5 mb-2">
              {tags.map((t) => (
                <li
                  key={t.id}
                  className="group inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full bg-accent-subtle text-accent type-caption-1"
                >
                  <span className="truncate max-w-[10rem]">{t.label}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(t.label)}
                    className="p-0.5 rounded-full text-accent/70 hover:text-accent hover:bg-accent-subtle transition-colors"
                    title={`Remove tag "${t.label}"`}
                    aria-label={`Remove tag ${t.label}`}
                  >
                    <X size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={draft}
              maxLength={MAX_LABEL}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="Add a tag…"
              className="flex-1 min-w-0 px-2 py-1 rounded-md bg-surface-secondary border border-separator type-caption-1 text-label-primary placeholder:text-label-tertiary focus:outline-none focus:border-accent transition-colors"
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || adding}
              className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors disabled:opacity-40 disabled:hover:text-label-tertiary disabled:hover:bg-transparent"
              title="Add tag"
              aria-label="Add tag"
            >
              <Plus size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
