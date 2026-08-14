"use client";

import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";
import {
  readDroppedUploads,
  selectionFromFileList,
  type DroppedSelection,
} from "./FileManager/dropped-entries";

interface UploadZoneProps {
  /**
   * WARP-1876 — receives relative paths, not a raw `FileList`. A dropped
   * FOLDER expands to its real tree ("Invoices/jan.pdf"); a flat drop or a
   * multi-select is just bare file names. The caller decides how to turn
   * that into mkdir + upload calls.
   *
   * Fires for EVERY drop, including one that yielded no files — the caller
   * owns the copy, and a folder that turned out to be empty (or unreadable)
   * still needs a word (WARP-1876 review).
   */
  onUpload: (selection: DroppedSelection) => void | Promise<void>;
  children: React.ReactNode;
  /**
   * WARP-1267 — true inside a `reader`-right department/team library.
   * Drag-and-drop is a no-op (no overlay, no upload) — the reader-posture
   * disabled Upload button already carries the tooltip copy; this just
   * makes the drop target inert to match. Defaults false so every existing
   * caller (My Files / Household, always writable) is unaffected.
   */
  disabled?: boolean;
  /** Extra classes on the drop wrapper. `/files` passes `page-dropzone`,
   *  which re-emits the shell's staggered page entrance to the wrapper's
   *  children (WARP-1876 — see droplet-shell.css). */
  className?: string;
}

export function UploadZone({
  onUpload,
  children,
  disabled = false,
  className = "",
}: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      if (disabled) return;
      e.preventDefault();
      dragCounter.current++;
      setIsDragging(true);
    },
    [disabled]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent) => {
      // Symmetry with `handleDragEnter`, which bails BEFORE it increments:
      // an unguarded leave drove the counter permanently negative in a
      // reader space, and once it was negative the overlay never cleared
      // again — a page-sized dashed rectangle stuck over the whole surface
      // (WARP-1876 review). The clamp covers the other way in: a drag that
      // began outside the zone can leave it without ever entering it.
      if (disabled) return;
      e.preventDefault();
      dragCounter.current = Math.max(0, dragCounter.current - 1);
      if (dragCounter.current === 0) setIsDragging(false);
    },
    [disabled]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (disabled) return;
      // WARP-1876: the overlay is dismissed synchronously above — the gesture
      // is over the moment the pointer releases, and the tree walk below can
      // take a beat on a deep folder. Only the reporting is async.
      const { dataTransfer } = e;
      void readDroppedUploads(dataTransfer)
        // The caller's handler is async and owns the toast, so a rejected
        // run must not escape the drop path as an unhandled rejection.
        .then((selection) => onUpload(selection))
        .catch((err) => console.error("upload: drop failed", err));
    },
    [onUpload, disabled]
  );

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  return (
    <div
      className={`relative ${className}`.trim()}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      {isDragging && (
        <div
          // `sticky`-free, pointer-events-none: the overlay is pure feedback
          // — it must never eat the drop event it is describing.
          data-dropzone-overlay=""
          // z-50 clears the two stacking contexts the Files page lifts for
          // its own dropdowns (search z-40, spaces z-30, WARP-1139/1667) —
          // an overlay that paints under them reads as a broken drop target.
          className="pointer-events-none absolute inset-0 z-50 flex items-start justify-center ds-dropzone-in"
          style={{
            background: "var(--brand-subtle)",
            border: "2px dashed var(--brand)",
            borderRadius: "var(--radius-card)",
          }}
        >
          {/* Sticky inside a full-page overlay so the prompt stays in view
              on a long file list instead of centring somewhere off-screen. */}
          <div className="sticky top-1/3 text-center px-4 py-3">
            <Upload size={32} className="mx-auto mb-2" style={{ color: "var(--brand)" }} />
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              Drop files or folders to upload
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The header Upload control. WARP-1876: `multiple` was already set, but the
 * picker could not take a FOLDER — the second input carries `webkitdirectory`
 * so "an office moving its existing documents onto the Droplet" has a
 * keyboard-reachable path to the same bulk upload the dropzone offers.
 *
 * Rendered only inside ShellPage's `.phead-actions` slot on /files, so the
 * indigo `.btn` classes (scoped under `.droplet-shell`) always apply.
 */
export function UploadButton({
  onUpload,
  disabled = false,
  title,
}: {
  onUpload: (selection: DroppedSelection) => void | Promise<void>;
  /** WARP-1267 — true inside a `reader`-right space; the tooltip carries
   *  the shipped reader-posture copy (design brief §2). */
  disabled?: boolean;
  title?: string;
}) {
  const filesRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const pick = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0 && !disabled) {
      void Promise.resolve(onUpload(selectionFromFileList(e.target.files))).catch((err) =>
        console.error("upload: picker failed", err)
      );
    }
    e.target.value = "";
  };

  return (
    <>
      <button
        onClick={() => folderRef.current?.click()}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        // The label collapses to icon-only below `sm`, so the accessible
        // name has to come from the attribute, not the hidden span.
        aria-label="Upload folder"
        title={title}
        className="btn ghost"
        type="button"
      >
        <Upload size={14} />
        <span className="hidden sm:inline">Upload folder</span>
      </button>
      <button
        onClick={() => filesRef.current?.click()}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        title={title}
        className="btn primary"
        type="button"
      >
        <Upload size={14} />
        Upload
      </button>

      <input ref={filesRef} type="file" multiple className="hidden" onChange={pick} />
      <input
        ref={folderRef}
        type="file"
        multiple
        className="hidden"
        onChange={pick}
        // Non-standard but universally shipped; React needs the lowercase
        // DOM attribute names, hence the cast.
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
      />
    </>
  );
}
