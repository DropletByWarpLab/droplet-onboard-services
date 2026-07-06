"use client";

import {
  X,
  Download,
  Edit3,
  FolderInput,
  Copy,
  Trash2,
  Scissors,
  ClipboardPaste,
} from "lucide-react";

interface SelectionToolbarProps {
  count: number;
  canRename: boolean;
  hasClipboard: boolean;
  onClear: () => void;
  onRename: () => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMove: () => void;
  onCopyTo: () => void;
  onDelete: () => void;
  onDownload: () => void;
}

/**
 * Floating action bar shown when one or more items are selected.
 * Slides in over the file list so primary actions stay a single click away.
 */
export function SelectionToolbar({
  count,
  canRename,
  hasClipboard,
  onClear,
  onRename,
  onCut,
  onCopy,
  onPaste,
  onMove,
  onCopyTo,
  onDelete,
  onDownload,
}: SelectionToolbarProps) {
  if (count === 0 && !hasClipboard) return null;

  return (
    <div
      className="card mb-4 flex items-center gap-2 p-2 pl-4 animate-slide-up"
      style={{
        background: "var(--glass)",
        backdropFilter: "blur(20px) saturate(150%)",
        WebkitBackdropFilter: "blur(20px) saturate(150%)",
        border: "1px solid var(--card-bd)",
        borderRadius: "var(--radius-card)",
        boxShadow: "var(--lift)",
      }}
    >
      {count > 0 && (
        <>
          <button
            onClick={onClear}
            className="p-1.5 rounded-full text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)] transition-colors"
            aria-label="Clear selection"
          >
            <X size={14} />
          </button>
          <span
            className="font-medium"
            style={{ color: "var(--text)", fontSize: "13px" }}
          >
            {count} selected
          </span>
          <div
            className="h-5 w-px mx-1"
            style={{ background: "var(--card-bd)" }}
          />
        </>
      )}

      <div className="flex items-center gap-1 flex-wrap">
        {canRename && (
          <button onClick={onRename} className="btn sm" title="Rename">
            <Edit3 size={14} />
            Rename
          </button>
        )}
        {count > 0 && (
          <>
            <button onClick={onDownload} className="btn sm" title="Download">
              <Download size={14} />
              Download
            </button>
            <button onClick={onMove} className="btn sm" title="Move to folder">
              <FolderInput size={14} />
              Move
            </button>
            <button onClick={onCopyTo} className="btn sm" title="Copy to folder">
              <Copy size={14} />
              Copy
            </button>
            <button onClick={onCut} className="btn sm" title="Cut">
              <Scissors size={14} />
              Cut
            </button>
          </>
        )}
        {hasClipboard && (
          <button onClick={onPaste} className="btn primary sm" title="Paste here">
            <ClipboardPaste size={14} />
            Paste
          </button>
        )}
      </div>

      {count > 0 && (
        <>
          <div className="flex-1" />
          <button
            onClick={onDelete}
            className="btn ghost sm"
            style={{ color: "var(--danger)" }}
            title="Move to trash"
          >
            <Trash2 size={14} />
            Trash
          </button>
        </>
      )}
    </div>
  );
}
