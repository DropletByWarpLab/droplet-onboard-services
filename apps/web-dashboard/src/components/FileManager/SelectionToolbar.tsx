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
    <div className="mb-4 flex items-center gap-2 p-2 pl-4 dp-card animate-slide-up">
      {count > 0 && (
        <>
          <button
            onClick={onClear}
            className="p-1.5 rounded-full text-label-tertiary hover:text-label-primary hover:bg-surface-secondary transition-colors"
            aria-label="Clear selection"
          >
            <X size={14} />
          </button>
          <span className="type-footnote text-label-primary font-medium">
            {count} selected
          </span>
          <div className="h-5 w-px bg-separator mx-1" />
        </>
      )}

      <div className="flex items-center gap-1 flex-wrap">
        {canRename && (
          <button
            onClick={onRename}
            className="dp-btn-secondary type-footnote !py-1.5 !px-3 !min-h-[32px]"
            title="Rename"
          >
            <Edit3 size={14} />
            Rename
          </button>
        )}
        {count > 0 && (
          <>
            <button
              onClick={onDownload}
              className="dp-btn-secondary type-footnote !py-1.5 !px-3 !min-h-[32px]"
              title="Download"
            >
              <Download size={14} />
              Download
            </button>
            <button
              onClick={onMove}
              className="dp-btn-secondary type-footnote !py-1.5 !px-3 !min-h-[32px]"
              title="Move to folder"
            >
              <FolderInput size={14} />
              Move
            </button>
            <button
              onClick={onCopyTo}
              className="dp-btn-secondary type-footnote !py-1.5 !px-3 !min-h-[32px]"
              title="Copy to folder"
            >
              <Copy size={14} />
              Copy
            </button>
            <button
              onClick={onCut}
              className="dp-btn-secondary type-footnote !py-1.5 !px-3 !min-h-[32px]"
              title="Cut"
            >
              <Scissors size={14} />
              Cut
            </button>
          </>
        )}
        {hasClipboard && (
          <button
            onClick={onPaste}
            className="dp-btn-primary type-footnote !py-1.5 !px-3 !min-h-[32px]"
            title="Paste here"
          >
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
            className="flex items-center gap-1.5 px-3 py-1.5 type-footnote text-system-red hover:bg-system-red/10 rounded-sm transition-colors"
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
