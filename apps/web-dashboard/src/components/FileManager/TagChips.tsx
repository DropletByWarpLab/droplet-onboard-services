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
 * style of VersionHistoryPanel: hairline-topped `.sect` header, indigo tokens
 * only (ported `.chip.on` pills, no hardcoded hex). Tags are file-scoped —
 * every reader sees every tag — so anyone owner/admin/family can add or
 * remove; a guest sees a read-only empty note (the API would 403 a guest
 * anyway).
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
    <div className="pt-4" style={{ borderTop: "1px solid var(--card-bd)" }}>
      <div className="sect" style={{ margin: "0 0 12px" }}>
        <Tag size={14} style={{ color: "var(--text-muted)" }} />
        <h2>Tags</h2>
      </div>

      {isGuest ? (
        <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
          Tags aren&apos;t available for guests.
        </p>
      ) : (
        <>
          {error && (
            <p className="type-caption-1 mb-2" style={{ color: "var(--danger)" }}>
              {translateError(error, "files")}
            </p>
          )}
          {actionError && (
            <p className="type-caption-1 mb-2" style={{ color: "var(--danger)" }}>
              {actionError}
            </p>
          )}

          {isLoading && tags.length === 0 && !error && (
            <p className="type-caption-1" style={{ color: "var(--text-muted)" }}>
              Loading…
            </p>
          )}

          {!isLoading && tags.length === 0 && !error && (
            <p className="type-caption-1 mb-2" style={{ color: "var(--text-muted)" }}>
              No tags yet. Add one to organize this file.
            </p>
          )}

          {tags.length > 0 && (
            <ul className="chiprow mb-2">
              {tags.map((t) => (
                <li
                  key={t.id}
                  className="chip on"
                  style={{ height: 28, paddingRight: 6, cursor: "default" }}
                >
                  <span className="truncate max-w-[10rem]">{t.label}</span>
                  <button
                    type="button"
                    onClick={() => onRemove(t.label)}
                    className="inline-flex items-center justify-center rounded-full transition-colors"
                    style={{ padding: 2, color: "var(--brand)" }}
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
              className="flex-1 min-w-0 type-caption-1 border border-[color:var(--border)] focus:border-[color:var(--brand)] focus:outline-none transition-colors"
              style={{
                padding: "5px 10px",
                background: "var(--surface)",
                borderRadius: "var(--radius-input)",
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!draft.trim() || adding}
              className="icon-btn disabled:opacity-40"
              style={{ width: 30, height: 30 }}
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
