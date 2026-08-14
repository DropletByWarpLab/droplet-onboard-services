"use client";

import { useEffect, useRef, useState } from "react";
import {
  Folder,
  File,
  FileText,
  Image,
  Film,
  Music,
  Archive,
  Download,
  Trash2,
  Check,
  MoreVertical,
} from "lucide-react";
import { StarButton } from "./StarButton";
import type { FileEntryInfo } from "@/lib/types";

interface FileRowProps {
  file: FileEntryInfo;
  isSelected: boolean;
  isRenaming: boolean;
  /** Set of paths currently marked as favorites (so the row can show the star filled). */
  favoritedPaths?: Set<string>;
  onSelect: (e: React.MouseEvent) => void;
  /**
   * Additive toggle fired by the row's selection checkbox. Distinct from
   * `onSelect`, which derives its mode from the click's modifier keys — a
   * checkbox click carries none, so it must never collapse the selection to
   * this one row.
   */
  onToggleSelect: () => void;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void | Promise<void>;
  onCancelRename: () => void;
  onContextMenu: (x: number, y: number) => void;
  /** Called after a favorite toggle succeeds so the parent can refresh state. */
  onFavoriteChanged?: () => void;
  /**
   * WARP-1267 — false inside a `reader`-right department/team library. The
   * per-row Delete affordance renders visible-but-disabled with the
   * shipped reader-posture tooltip copy (design brief §2); Download stays
   * enabled — readers can always view and download. Defaults true so every
   * existing caller (My Files / Household, always writable) is unaffected.
   */
  canWrite?: boolean;
}

/** Verbatim copy (design brief §2) — ships as-is wherever a write action is
 *  disabled for a reader-right space. */
const READER_TOOLTIP =
  "You can view and download here. Ask a manager for edit access.";

function getFileIcon(file: FileEntryInfo) {
  if (file.isDirectory) return Folder;
  const mime = file.mimeType ?? "";
  if (mime.startsWith("image/")) return Image;
  if (mime.startsWith("video/")) return Film;
  if (mime.startsWith("audio/")) return Music;
  if (mime.startsWith("text/")) return FileText;
  if (mime.includes("zip") || mime.includes("tar") || mime.includes("gzip"))
    return Archive;
  return File;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) {
    size /= 1024;
    i++;
  }
  return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * A single row in the file list. Supports:
 *  - multi-select (click / ctrl-click / shift-click handled by caller)
 *  - right-click context menu (caller positions it)
 *  - in-place rename (switches to an input when `isRenaming` is true)
 *  - always-visible row actions (download, delete) — WARP-292
 */
export function FileRow({
  file,
  isSelected,
  isRenaming,
  favoritedPaths,
  onSelect,
  onToggleSelect,
  onOpen,
  onDownload,
  onDelete,
  onRename,
  onCancelRename,
  onContextMenu,
  onFavoriteChanged,
  canWrite = true,
}: FileRowProps) {
  const isFavorited = favoritedPaths?.has(file.path) ?? false;
  const Icon = getFileIcon(file);
  // Folders take the brand indigo (design .ri.brand); other files stay muted.
  const iconColor = file.isDirectory ? "var(--brand)" : "var(--text-muted)";
  const [renameValue, setRenameValue] = useState(file.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(file.name);
      // Focus + select the name portion of the filename (without extension)
      requestAnimationFrame(() => {
        if (!inputRef.current) return;
        inputRef.current.focus();
        const dot = file.name.lastIndexOf(".");
        if (!file.isDirectory && dot > 0) {
          inputRef.current.setSelectionRange(0, dot);
        } else {
          inputRef.current.select();
        }
      });
    }
  }, [isRenaming, file.name, file.isDirectory]);

  const commitRename = () => {
    const next = renameValue.trim();
    if (!next || next === file.name) {
      onCancelRename();
      return;
    }
    void onRename(next);
  };

  // WARP-298: full keyboard support. Each row is its own focus stop
  // (role=button, tabIndex 0) and responds to:
  //   - Enter / Space  → open (mirror onClick/onDoubleClick semantics)
  //   - ArrowDown      → move focus to next row
  //   - ArrowUp        → move focus to previous row
  //   - Delete         → trigger delete (the parent passes a handler that
  //                      routes through ConfirmDialog — we never bypass it)
  //   - Shift+F10 / ContextMenu key → open context menu at the row's
  //                      bounding rect (standard kb shortcut for right-click)
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isRenaming) return; // Defer all keys to the input while renaming.
    switch (e.key) {
      case "Enter":
      case " ":
        // Space scrolls the page by default; block before opening.
        e.preventDefault();
        onOpen();
        return;
      case "ArrowDown": {
        e.preventDefault();
        const next = (e.currentTarget.nextElementSibling as HTMLElement | null);
        if (next && next.tagName === e.currentTarget.tagName) next.focus();
        return;
      }
      case "ArrowUp": {
        e.preventDefault();
        const prev = (e.currentTarget.previousElementSibling as HTMLElement | null);
        if (prev && prev.tagName === e.currentTarget.tagName) prev.focus();
        return;
      }
      case "Delete": {
        // Routes through the parent's ConfirmDialog (WARP-291); never
        // bypasses confirmation. Backspace is NOT bound here — too easy
        // to hit accidentally and the rename-input handler stops
        // propagation but other transient focus states could let a
        // stray Backspace through.
        e.preventDefault();
        if (canWrite) onDelete();
        return;
      }
      case "F10":
        if (e.shiftKey) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          onContextMenu(rect.left + 16, rect.bottom);
        }
        return;
      case "ContextMenu": {
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        onContextMenu(rect.left + 16, rect.bottom);
        return;
      }
    }
  };

  return (
    <div
      role="button"
      tabIndex={isRenaming ? -1 : 0}
      aria-label={`${file.isDirectory ? "Folder" : "File"} ${file.name}`}
      aria-selected={isSelected}
      data-filerow="1"
      onClick={(e) => {
        if (isRenaming) return;
        // WARP-309: a plain single-click on a folder navigates into it,
        // matching Finder/File Explorer breadcrumb-style browsing (the
        // double-click requirement was a Files-page quirk, not a global
        // dashboard pattern). Modifier-clicks still go to selection so
        // Cmd/Ctrl + click and Shift + range-select work on folders for
        // bulk operations (move, delete, share). For files, a plain
        // single-click selects (and opens the info sidebar — the primary
        // affordance for them); double-click "opens" — which the page wires
        // to the rich PreviewPane modal (Samantha QA #bugs).
        if (file.isDirectory && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          e.stopPropagation();
          onOpen();
          return;
        }
        onSelect(e);
      }}
      onDoubleClick={(e) => {
        if (isRenaming) return;
        e.stopPropagation();
        onOpen();
      }}
      onKeyDown={handleKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={isSelected ? { backgroundColor: "var(--brand-subtle)" } : undefined}
      className={`flex items-center justify-between px-4 py-3 min-h-[44px] group transition-colors duration-200 ease-smooth cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand)]
        ${isSelected ? "" : "hover:bg-[var(--hover)]"}`}
    >
      {/*
        Selection checkbox. The circle used to be an inert <div>, so clicking
        the one thing that looks like "tick me" bubbled to the row — which for
        a folder navigates into it (WARP-309). It is now its own control:
        toggles selection additively, swallows the click, and never opens.
        `-m-2 p-2` grows the 18 px glyph to a 34 px hit target without moving
        the layout.
      */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <button
          type="button"
          role="checkbox"
          aria-checked={isSelected}
          aria-label={`Select ${file.name}`}
          disabled={isRenaming}
          onClick={(e) => {
            e.stopPropagation();
            onToggleSelect();
          }}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            // Keep Space/Enter here — bubbling would hit the row's handler,
            // which opens the entry.
            e.stopPropagation();
            if (e.key === " " || e.key === "Enter") {
              e.preventDefault();
              onToggleSelect();
            }
          }}
          className="group/select relative flex-shrink-0 -m-2 p-2 rounded-full
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand)]"
        >
          <Icon
            size={18}
            style={{ color: iconColor }}
            className={`block transition-opacity duration-150 ${
              isSelected
                ? "opacity-0"
                : "group-hover:opacity-0 group-focus-visible/select:opacity-0"
            }`}
          />
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${
              isSelected
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-visible/select:opacity-100"
            }`}
          >
            <div
              className="w-[18px] h-[18px] rounded-full flex items-center justify-center border"
              style={
                isSelected
                  ? { background: "var(--brand)", borderColor: "var(--brand)", color: "#fff" }
                  : { borderColor: "var(--text-faint)" }
              }
            >
              {isSelected && <Check size={12} />}
            </div>
          </div>
        </button>

        {isRenaming ? (
          <input
            ref={inputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") onCancelRename();
            }}
            onBlur={commitRename}
            className="flex-1 py-1 px-2 outline-none focus:border-[var(--brand)] text-[16px] lg:text-[13.5px]"
            style={{
              background: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius-input)",
              color: "var(--text)",
              fontWeight: 500,
            }}
          />
        ) : (
          <span
            className="truncate"
            style={{ color: "var(--text)", fontSize: "13.5px", fontWeight: 500 }}
          >
            {file.name}
          </span>
        )}
      </div>

      <span
        className="w-20 text-right hidden sm:block flex-shrink-0"
        style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
      >
        {file.isDirectory ? "" : formatSize(file.size)}
      </span>

      <span
        className="w-32 text-right hidden md:block flex-shrink-0"
        style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
      >
        {formatDate(file.modifiedAt)}
      </span>

      {/* Star is visible when favorited, shown on hover otherwise */}
      <div
        className={`flex items-center gap-0.5 justify-end flex-shrink-0 transition-opacity duration-200 ${
          isFavorited ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <StarButton
          path={file.path}
          favorited={isFavorited}
          onToggle={() => onFavoriteChanged?.()}
        />
      </div>

      {/*
        WARP-292: row actions are always rendered (no opacity-gate) so
        they're discoverable on touch and reachable for keyboard users.
        WARP-298 owns the broader FileRow keyboard-nav story (Tab /
        Arrow keys to focus a row, Enter to open) — this commit just
        gets the action buttons into the DOM tab order. p-2.5 → 14 px
        icon + 20 px padding = 34 px hit-target, clearing the 32 px
        ui-ux floor. aria-labels name the file so screen-reader users
        hear which entry they're acting on.
      */}
      <div className="flex items-center gap-0.5 justify-end flex-shrink-0 transition-opacity duration-200">
        {!file.isDirectory && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
            className="p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
            aria-label={`Download ${file.name}`}
          >
            <Download size={14} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            if (canWrite) onDelete();
          }}
          disabled={!canWrite}
          title={canWrite ? undefined : READER_TOOLTIP}
          aria-disabled={canWrite ? undefined : true}
          className={`p-2.5 rounded-[var(--radius-input)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors ${
            canWrite
              ? "text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.12)]"
              : "text-[color:var(--text-faint)] cursor-not-allowed"
          }`}
          aria-label={`Delete ${file.name}`}
        >
          <Trash2 size={14} />
        </button>
        {/*
          Touch parity for the row context menu. The menu (Preview, Rename,
          Cut/Copy, Move to…, Copy to…, Share link, Delete) was reachable
          only via right-click or the keyboard's Shift+F10 / ContextMenu key
          — neither of which exists on a phone, so seven of its nine actions
          were unreachable on touch. This button opens the same menu from
          the same anchor the keyboard path uses. Desktop keeps right-click
          and is left visually unchanged (lg:hidden).
        */}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            const rect = e.currentTarget.getBoundingClientRect();
            onContextMenu(rect.left, rect.bottom);
          }}
          className="lg:hidden p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
          aria-haspopup="menu"
          aria-label={`More actions for ${file.name}`}
        >
          <MoreVertical size={14} />
        </button>
      </div>
    </div>
  );
}
