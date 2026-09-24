"use client";

/**
 * WARP-2978 (ADR-059 P3 §8, §6.6) — "Resolve…": done, with an optional note.
 *
 * The note is at most 280 characters (the box refuses more, and anything it
 * can't store safely, with a 400 before its transaction). Resolve is
 * aria-disabled while the write is in flight — never `disabled`, which would
 * drop focus to <body> — and the page's own ref refuses a second press.
 * Below the shell's 720 px breakpoint the dialog is a full-width sheet; above
 * it, the centered modal every other small form uses.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@/components/Dialog";
import { useMediaQuery } from "@/lib/hooks/useMediaQuery";

export const RESOLVE_COPY = {
  resolveTitle: "Resolve this incident",
  resolveSub: "It stays in the history with your note. Anything seen after this starts a new incident.",
  noteLabel: "What happened? Optional.",
  cancel: "Cancel",
  resolveConfirm: "Resolve",
} as const;

/** The box's limit on a resolve note. */
export const NOTE_MAX = 280;

export function ResolveDialog({
  open,
  busy,
  triggerRef,
  onClose,
  onConfirm,
}: {
  open: boolean;
  /** A resolve is in flight: Resolve is inert (aria-disabled). */
  busy: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onConfirm: (note: string) => void;
}) {
  const headingId = useId();
  const descId = useId();
  const noteId = useId();
  const [note, setNote] = useState("");
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const phone = useMediaQuery("(max-width: 719px)");

  // Every opening starts empty.
  useEffect(() => {
    if (open) setNote("");
  }, [open]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      initialFocusRef={noteRef}
      labelledBy={headingId}
      describedBy={descId}
      maxWidth="sm"
      placement={phone ? "right" : "center"}
      sideWidth="sheet"
    >
      <form
        style={{ display: "flex", flexDirection: "column", gap: 14 }}
        onSubmit={(e) => {
          e.preventDefault();
          // The page's in-flight ref refuses a second submit.
          onConfirm(note);
        }}
      >
        <div>
          <h2 id={headingId} className="type-headline" style={{ color: "var(--text)", margin: 0 }}>
            {RESOLVE_COPY.resolveTitle}
          </h2>
          <p id={descId} className="type-subheadline" style={{ color: "var(--text-muted)", margin: "6px 0 0" }}>
            {RESOLVE_COPY.resolveSub}
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label htmlFor={noteId} style={{ fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
            {RESOLVE_COPY.noteLabel}
          </label>
          <textarea
            ref={noteRef}
            id={noteId}
            value={note}
            maxLength={NOTE_MAX}
            rows={3}
            onChange={(e) => setNote(e.target.value)}
            style={{
              width: "100%",
              resize: "vertical",
              padding: "10px 12px",
              borderRadius: "var(--radius-input)",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--text)",
              fontSize: 16,
              lineHeight: 1.4,
            }}
          />
          <span aria-hidden style={{ alignSelf: "flex-end", fontSize: 12, color: "var(--text-muted)" }}>
            {note.length}/{NOTE_MAX}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
          <button type="button" className="btn ghost" onClick={onClose}>
            {RESOLVE_COPY.cancel}
          </button>
          {/* aria-disabled, not disabled: the pressed button keeps focus while the write is in flight. */}
          <button type="submit" className="btn primary" aria-disabled={busy || undefined}>
            {RESOLVE_COPY.resolveConfirm}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
