"use client";

import { useEffect, useRef, useState, type JSX } from "react";

const TITLE_STYLE = {
  margin: 0,
  fontSize: 22,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: 1.25,
  color: "var(--text)",
} as const;

/**
 * The drawer's title (design brief §4.2). Writers get the title as a button:
 * click or Enter/Space turns it into a field, Enter or blur saves, Escape puts
 * the old name back. An empty name is refused inline and the field stays open.
 * Readers get the plain heading.
 *
 * `onSave` resolves false when the write failed (the optimistic layer has
 * already rolled the name back and toasted); the field then stays open with what
 * was typed, so a retry is one keystroke away.
 */
export function TitleEditor({
  name,
  readOnly,
  onSave,
}: {
  name: string;
  readOnly: boolean;
  onSave: (name: string) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  // Enter commits, and the blur that follows the field unmounting must not commit again.
  const settled = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(name);
  }, [name, editing]);

  if (readOnly) return <h2 style={TITLE_STYLE}>{name}</h2>;

  const commit = async () => {
    if (settled.current) return;
    const next = draft.trim();
    if (next === "") {
      setError("Name can't be empty.");
      return;
    }
    settled.current = true;
    if (next === name) {
      setEditing(false);
      return;
    }
    setError(null);
    const ok = await onSave(next);
    if (ok) setEditing(false);
    else settled.current = false;
  };

  const cancel = () => {
    settled.current = true;
    setDraft(name);
    setError(null);
    setEditing(false);
  };

  if (!editing) {
    return (
      <h2 style={TITLE_STYLE}>
        <button
          type="button"
          className="pm-valbtn pm-title-btn"
          style={{ font: "inherit", letterSpacing: "inherit", fontWeight: "inherit" }}
          aria-label={`Edit title: ${name}`}
          onClick={() => {
            settled.current = false;
            setEditing(true);
          }}
        >
          {name}
        </button>
      </h2>
    );
  }

  return (
    <div>
      <input
        className={"pm-input pm-title-input" + (error ? " invalid" : "")}
        aria-label="Title"
        aria-invalid={error ? true : undefined}
        value={draft}
        maxLength={500}
        autoFocus
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void commit();
          } else if (e.key === "Escape") {
            // The drawer closes on a window-level Escape; this one belongs to the field.
            e.stopPropagation();
            cancel();
          }
        }}
      />
      {error && (
        <div className="pm-field-error" role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
