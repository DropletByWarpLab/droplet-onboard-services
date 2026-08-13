"use client";

import { useState, useRef, useEffect } from "react";
import {
  Download,
  FolderInput,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";

export interface ChatHistoryRowProps {
  id: string;
  title: string | null;
  active: boolean;
  /** WARP-1917 — whether this chat is pinned; flips the menu item between
   *  Pin and Unpin. */
  pinned: boolean;
  onSelect: () => void;
  onRenameSubmit: (newTitle: string) => Promise<void>;
  onDeleteRequest: () => void;
  /** Download this conversation as a Markdown transcript. */
  onExport: () => void;
  /** WARP-845 — open the move-to-project chooser for this chat. */
  onMoveRequest: () => void;
  /** WARP-1917 — toggle the pin (parent owns the optimistic state). */
  onTogglePin: () => void;
}

const DISPLAY_TITLE = (title: string | null) => title?.trim() || "Untitled chat";

export function ChatHistoryRow({
  id,
  title,
  active,
  pinned,
  onSelect,
  onRenameSubmit,
  onDeleteRequest,
  onExport,
  onMoveRequest,
  onTogglePin,
}: ChatHistoryRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(DISPLAY_TITLE(title));
  const inputRef = useRef<HTMLInputElement | null>(null);
  const actsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (renaming) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  // Outside-click / Escape close for the overflow menu — same pattern as
  // VoiceProfilesSection. The ref wraps trigger + menu so a mousedown on the
  // trigger doesn't close-then-reopen via its click toggle.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (actsRef.current && !actsRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

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
        <div className="conv-acts" ref={actsRef}>
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
              {/* WARP-1917 — pin toggle first: it's the "keep this handy"
                  action the menu exists for; label + icon flip with state. */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onTogglePin();
                }}
                className="msg-act w-full !justify-start !h-8"
              >
                {pinned ? <PinOff size={12} /> : <Pin size={12} />}{" "}
                {pinned ? "Unpin" : "Pin"}
              </button>
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
