"use client";

import { useState, type JSX } from "react";
import { PmIcon } from "../icons";
import { descriptionIsPlain, descriptionToText, textToDescriptionHtml } from "./description";

/**
 * The drawer's description. Readers see the sanitized HTML. Writers get an Edit
 * button that opens a plain multi-line editor: Save (or Ctrl/Cmd+Enter) stores
 * sanitized paragraphs, Cancel (or Escape) leaves the description untouched.
 *
 * `html` is server-sanitized against a strict allowlist at the write boundary
 * (orchestrator sanitizePmHtml in createWorkItem / updateWorkItem), so rendering
 * it is safe. `onSave` resolves false when the write failed (rolled back and
 * toasted by the optimistic layer); the editor then stays open to retry.
 */
export function DescriptionEditor({
  html,
  readOnly,
  onSave,
}: {
  html: string | null;
  readOnly: boolean;
  onSave: (html: string | null) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const plain = descriptionIsPlain(html);

  const start = () => {
    setDraft(descriptionToText(html));
    setEditing(true);
  };
  const save = async () => {
    const next = textToDescriptionHtml(draft);
    if (next === html) {
      setEditing(false);
      return;
    }
    if (await onSave(next)) setEditing(false);
  };

  return (
    <div>
      <div className="pm-row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <div className="pm-sect">Description</div>
        {!readOnly && !editing && (
          <button type="button" className="pm-btn ghost sm" aria-label="Edit description" onClick={start}>
            <PmIcon name="pencil" size={12} />
            Edit
          </button>
        )}
      </div>
      {editing ? (
        <div>
          <textarea
            className="pm-input"
            aria-label="Description"
            placeholder="Add a description"
            rows={6}
            maxLength={20000}
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.stopPropagation();
                setEditing(false);
              }
            }}
          />
          {!plain && (
            <div style={{ fontSize: 12, color: "var(--text-3)", marginTop: 6 }}>
              This description has formatting that can&apos;t be kept here. Saving replaces it with plain text.
            </div>
          )}
          <div className="pm-row" style={{ gap: 8, marginTop: 8 }}>
            <button type="button" className="pm-btn primary sm" onClick={() => void save()}>
              Save
            </button>
            <button type="button" className="pm-btn sm" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <span className="pm-kbd" style={{ marginLeft: "auto" }}>
              ⌘↵
            </span>
          </div>
        </div>
      ) : html ? (
        <div className="pm-prose" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <div style={{ fontSize: 13, color: "var(--text-4)" }}>No description yet.</div>
      )}
    </div>
  );
}
