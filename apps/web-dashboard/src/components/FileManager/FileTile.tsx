"use client";

import { useEffect, useRef, useState } from "react";
import { Check, MoreVertical } from "lucide-react";
import { Thumbnail } from "./Thumbnail";
import { FolderIcon } from "./FolderIcon";
import { useDropTarget } from "./internal-drag";
import type { FileEntryInfo, FolderColor } from "@/lib/types";

interface FileTileProps {
  file: FileEntryInfo;
  isSelected: boolean;
  isRenaming: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onToggleSelect: () => void;
  onOpen: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void | Promise<void>;
  onCancelRename: () => void;
  onContextMenu: (x: number, y: number) => void;
  /** false in a reader space / for a guest — Delete key becomes a no-op. */
  canWrite?: boolean;
  folderColor?: FolderColor;
  onDragStartRow?: (e: React.DragEvent) => void;
  onDragEndRow?: () => void;
  canDropOn?: () => boolean;
  onDropItems?: (paths: string[]) => void;
}

/**
 * One tile of the Icons (grid) view — the Finder/Explorer counterpart of
 * `FileRow`, with the same selection, open, rename, context-menu and
 * drag/drop contract so the page wires both from the same handlers.
 */
export function FileTile({
  file,
  isSelected,
  isRenaming,
  onSelect,
  onToggleSelect,
  onOpen,
  onDelete,
  onRename,
  onCancelRename,
  onContextMenu,
  canWrite = true,
  folderColor,
  onDragStartRow,
  onDragEndRow,
  canDropOn,
  onDropItems,
}: FileTileProps) {
  const [renameValue, setRenameValue] = useState(file.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isOver, handlers: dropHandlers } = useDropTarget({
    enabled: file.isDirectory && !!onDropItems,
    canDrop: () => canDropOn?.() ?? true,
    onDrop: (paths) => onDropItems?.(paths),
  });

  useEffect(() => {
    if (!isRenaming) return;
    setRenameValue(file.name);
    requestAnimationFrame(() => {
      if (!inputRef.current) return;
      inputRef.current.focus();
      const dot = file.name.lastIndexOf(".");
      if (!file.isDirectory && dot > 0) inputRef.current.setSelectionRange(0, dot);
      else inputRef.current.select();
    });
  }, [isRenaming, file.name, file.isDirectory]);

  const commitRename = () => {
    const next = renameValue.trim();
    if (!next || next === file.name) {
      onCancelRename();
      return;
    }
    void onRename(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (isRenaming) return;
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        onOpen();
        return;
      case "ArrowRight":
      case "ArrowDown": {
        e.preventDefault();
        (e.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
        return;
      }
      case "ArrowLeft":
      case "ArrowUp": {
        e.preventDefault();
        (e.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
        return;
      }
      case "Delete":
        e.preventDefault();
        if (canWrite) onDelete();
        return;
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
      data-filetile="1"
      draggable={!!onDragStartRow && !isRenaming}
      onDragStart={onDragStartRow}
      onDragEnd={onDragEndRow}
      {...dropHandlers}
      data-drop-over={isOver ? "1" : undefined}
      onClick={(e) => {
        if (isRenaming) return;
        // Same rule as FileRow: a plain click on a folder navigates in;
        // modifier clicks select; a file click selects.
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
      style={
        isOver
          ? {
              backgroundColor: "var(--brand-subtle)",
              boxShadow: "inset 0 0 0 2px var(--brand)",
            }
          : isSelected
          ? { backgroundColor: "var(--brand-subtle)" }
          : undefined
      }
      className={`group relative flex flex-col items-center gap-2 p-3 rounded-[var(--radius-input)] cursor-pointer transition-colors duration-200 ease-smooth
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand)]
        ${isSelected || isOver ? "" : "hover:bg-[var(--hover)]"}`}
    >
      <button
        type="button"
        role="checkbox"
        aria-checked={isSelected}
        aria-label={`Select ${file.name}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === " " || e.key === "Enter") {
            e.preventDefault();
            onToggleSelect();
          }
        }}
        className={`absolute top-2 left-2 w-[18px] h-[18px] rounded-full flex items-center justify-center border transition-opacity duration-150
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--brand)]
          ${isSelected ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
        style={
          isSelected
            ? { background: "var(--brand)", borderColor: "var(--brand)", color: "#fff" }
            : { borderColor: "var(--text-faint)", background: "var(--surface)" }
        }
      >
        {isSelected && <Check size={12} />}
      </button>

      {/* Touch parity for the right-click menu (same as FileRow's ⋮). */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          onContextMenu(rect.left, rect.bottom);
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        className="lg:hidden absolute top-1 right-1 p-2 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
        aria-haspopup="menu"
        aria-label={`More actions for ${file.name}`}
      >
        <MoreVertical size={14} />
      </button>

      <div className="flex items-center justify-center h-[72px] w-full">
        {file.isDirectory ? (
          <FolderIcon size={64} color={folderColor} />
        ) : (
          <Thumbnail file={file} size={72} />
        )}
      </div>

      {isRenaming ? (
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") onCancelRename();
          }}
          onBlur={commitRename}
          className="w-full py-1 px-2 outline-none focus:border-[var(--brand)] text-center text-[16px] lg:text-[13.5px]"
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
          className="w-full text-center break-words"
          title={file.name}
          style={{
            color: "var(--text)",
            fontSize: "13.5px",
            fontWeight: file.isDirectory ? 600 : 500,
            display: "-webkit-box",
            WebkitLineClamp: 2,
            WebkitBoxOrient: "vertical",
            overflow: "hidden",
          }}
        >
          {file.name}
        </span>
      )}
    </div>
  );
}
