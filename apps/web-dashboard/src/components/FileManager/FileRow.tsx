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
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void | Promise<void>;
  onCancelRename: () => void;
  onContextMenu: (x: number, y: number) => void;
  /** Called after a favorite toggle succeeds so the parent can refresh state. */
  onFavoriteChanged?: () => void;
}

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
 *  - hover row actions (download, delete)
 */
export function FileRow({
  file,
  isSelected,
  isRenaming,
  favoritedPaths,
  onSelect,
  onOpen,
  onDownload,
  onDelete,
  onRename,
  onCancelRename,
  onContextMenu,
  onFavoriteChanged,
}: FileRowProps) {
  const isFavorited = favoritedPaths?.has(file.path) ?? false;
  const Icon = getFileIcon(file);
  const iconColor = file.isDirectory ? "text-system-blue" : "text-label-secondary";
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
        onDelete();
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
      className={`dp-row group transition-colors duration-200 ease-smooth cursor-pointer
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40
        ${isSelected ? "bg-accent-subtle" : "hover:bg-surface-secondary/60"}`}
    >
      {/* Selection indicator */}
      <div className="flex items-center gap-3 flex-1 min-w-0">
        <div className="relative flex-shrink-0">
          <Icon
            size={18}
            className={`${iconColor} transition-opacity duration-150 ${
              isSelected ? "opacity-0" : "group-hover:opacity-0"
            }`}
          />
          <div
            className={`absolute inset-0 flex items-center justify-center transition-opacity duration-150 ${
              isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"
            }`}
          >
            <div
              className={`w-[18px] h-[18px] rounded-full flex items-center justify-center border ${
                isSelected
                  ? "bg-accent border-accent text-white"
                  : "border-label-tertiary"
              }`}
            >
              {isSelected && <Check size={12} />}
            </div>
          </div>
        </div>

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
            className="dp-input type-callout flex-1 !py-1 !px-2 !min-h-0"
          />
        ) : (
          <span className="type-callout text-label-primary truncate">
            {file.name}
          </span>
        )}
      </div>

      <span className="type-caption-1 text-label-tertiary w-20 text-right hidden sm:block flex-shrink-0">
        {file.isDirectory ? "" : formatSize(file.size)}
      </span>

      <span className="type-caption-1 text-label-tertiary w-32 text-right hidden md:block flex-shrink-0">
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

      <div className="flex items-center gap-0.5 w-16 justify-end flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
        {!file.isDirectory && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
            className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
            aria-label="Download"
          >
            <Download size={14} />
          </button>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          className="p-1.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
          aria-label="Delete"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
