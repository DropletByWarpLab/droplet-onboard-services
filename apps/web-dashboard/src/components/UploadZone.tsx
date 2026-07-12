"use client";

import { useCallback, useRef, useState } from "react";
import { Upload } from "lucide-react";

interface UploadZoneProps {
  onUpload: (files: FileList) => void;
  children: React.ReactNode;
  /**
   * WARP-1267 — true inside a `reader`-right department/team library.
   * Drag-and-drop is a no-op (no overlay, no upload) — the reader-posture
   * disabled Upload button already carries the tooltip copy; this just
   * makes the drop target inert to match. Defaults false so every existing
   * caller (My Files / Household, always writable) is unaffected.
   */
  disabled?: boolean;
}

export function UploadZone({ onUpload, children, disabled = false }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
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

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounter.current--;
    if (dragCounter.current === 0) setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounter.current = 0;
      setIsDragging(false);
      if (disabled) return;
      if (e.dataTransfer.files.length > 0) {
        onUpload(e.dataTransfer.files);
      }
    },
    [onUpload, disabled]
  );

  const handleDragOver = (e: React.DragEvent) => e.preventDefault();

  return (
    <div
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {children}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files && e.target.files.length > 0) {
            onUpload(e.target.files);
            e.target.value = "";
          }
        }}
      />

      {isDragging && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center transition-opacity duration-200"
          style={{
            background: "var(--brand-subtle)",
            border: "2px dashed var(--brand)",
            borderRadius: "var(--radius-card)",
          }}
        >
          <div className="text-center">
            <Upload
              size={32}
              className="mx-auto mb-2"
              style={{ color: "var(--brand)" }}
            />
            <p className="type-subheadline" style={{ color: "var(--text)" }}>
              Drop files to upload
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// Rendered only inside ShellPage's `.phead-actions` slot on /files, so the
// indigo `.btn` classes (scoped under `.droplet-shell`) always apply.
export function UploadButton({
  onClick,
  disabled = false,
  title,
}: {
  onClick: () => void;
  /** WARP-1267 — true inside a `reader`-right space; the tooltip carries
   *  the shipped reader-posture copy (design brief §2). */
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-disabled={disabled || undefined}
      title={title}
      className="btn primary"
      type="button"
    >
      <Upload size={14} />
      Upload
    </button>
  );
}
