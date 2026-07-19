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
    <div
      // z-20 while the menu is open — .conv-acts' transform creates a stacking
      // context that traps the menu's z-10, so later sibling rows would
      // otherwise paint (and hit-test) above the open menu.
      className={`conv-row group relative ${menuOpen ? "z-20" : ""}`}
      data-chat-id={id}
    >
      {renaming ? (
        <div className="conv-search !m-0 !h-9">
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
          />
        </div>
      ) : (
        <button
          type="button"
          aria-label={`Open chat: ${DISPLAY_TITLE(title)}`}
          aria-current={active ? "page" : undefined}
          onClick={onSelect}
          onKeyDown={onRowKeyDown}
          className={`conv-item ${active ? "is-active" : ""}`}
        >
          <span className="conv-it-t">{DISPLAY_TITLE(title)}</span>
        </button>
      )}

      {!renaming && (
        <div className="conv-acts">
          <button
            type="button"
            aria-label={`More actions for ${DISPLAY_TITLE(title)}`}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((v) => !v);
            }}
            className="chat-iconbtn !w-7 !h-7"
          >
            <MoreHorizontal size={14} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-full mt-1 w-36 rounded-[9px] border z-10"
              style={{ background: "var(--surface)", borderColor: "var(--border)", boxShadow: "var(--lift)" }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button
                type="button"
                role="menuitem"
                onClick={openRename}
                className="msg-act w-full !justify-start !h-8"
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
                className="msg-act w-full !justify-start !h-8"
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
                className="msg-act w-full !justify-start !h-8"
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
                className="msg-act w-full !justify-start !h-8 text-system-red hover:!text-system-red"
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
