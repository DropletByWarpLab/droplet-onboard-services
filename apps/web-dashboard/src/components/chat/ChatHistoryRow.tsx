"use client";

import { useState, useRef, useEffect } from "react";
import { Download, FolderInput, MoreHorizontal, Pencil, Trash2 } from "lucide-react";

export interface ChatHistoryRowProps {
  id: string;
  title: string | null;
  active: boolean;
  onSelect: () => void;
  onRenameSubmit: (newTitle: string) => Promise<void>;
  onDeleteRequest: () => void;
  /** Download this conversation as a Markdown transcript. */
  onExport: () => void;
  /** WARP-845 — open the move-to-project chooser for this chat. */
  onMoveRequest: () => void;
}

const DISPLAY_TITLE = (title: string | null) => title?.trim() || "Untitled chat";

export function ChatHistoryRow({
  id,
  title,
  active,
  onSelect,
  onRenameSubmit,
  onDeleteRequest,
  onExport,
  onMoveRequest,
}: ChatHistoryRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(DISPLAY_TITLE(title));
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const openRename = () => {
    setMenuOpen(false);
    setDraft(DISPLAY_TITLE(title));
    setRenaming(true);
  };

  const submitRename = async () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      setRenaming(false);
      return;
    }
    setRenaming(false);
    await onRenameSubmit(trimmed);
  };

  const cancelRename = () => {
    setDraft(DISPLAY_TITLE(title));
    setRenaming(false);
  };

  // Keyboard shortcuts on the row button.
  const onRowKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F2") {
      e.preventDefault();
      openRename();
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDeleteRequest();
    }
  };

  return (
    <div className="group relative" data-chat-id={id}>
      {renaming ? (
        <div className="flex items-center gap-1 px-2 h-8 rounded-md bg-surface-secondary">
          <input
            ref={inputRef}
            aria-label="Chat title"
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelRename();
              }
            }}
            onBlur={submitRename}
            maxLength={64}
            className="flex-1 bg-transparent type-footnote text-label-primary outline-none"
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open chat: ${DISPLAY_TITLE(title)}`}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
          onKeyDown={onRowKeyDown}
          className={`
            w-full text-left px-2 h-8 rounded-md type-footnote
            flex items-center
            transition-colors duration-150
            ${
              active
                ? "bg-accent-subtle text-accent font-medium"
                : "text-label-secondary hover:bg-surface-secondary hover:text-label-primary"
            }
          `}
        >
          <span className="truncate flex-1">{DISPLAY_TITLE(title)}</span>
        </button>
      )}

      {!renaming && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
          <button
            type="button"
            aria-label={`More actions for ${DISPLAY_TITLE(title)}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="p-1 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-tertiary"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 mt-1 w-32 bg-surface-elevated dp-material rounded-md shadow-lg border border-separator z-10"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                role="menuitem"
                onClick={openRename}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-label-primary hover:bg-surface-secondary"
              >
                <Pencil size={12} /> Rename
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onMoveRequest();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-label-primary hover:bg-surface-secondary"
              >
                <FolderInput size={12} /> Move to project
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onExport();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-label-primary hover:bg-surface-secondary"
              >
                <Download size={12} /> Export
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDeleteRequest();
                }}
                className="w-full flex items-center gap-2 px-3 py-2 type-footnote text-system-red hover:bg-system-red/10"
              >
                <Trash2 size={12} /> Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
