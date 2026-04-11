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
import type { FileEntryInfo } from "@/lib/types";

interface FileRowProps {
  file: FileEntryInfo;
  isSelected: boolean;
  isRenaming: boolean;
  onSelect: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onDownload: () => void;
  onDelete: () => void;
  onRename: (newName: string) => void | Promise<void>;
  onCancelRename: () => void;
  onContextMenu: (x: number, y: number) => void;
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
  onSelect,
  onOpen,
  onDownload,
  onDelete,
  onRename,
  onCancelRename,
  onContextMenu,
}: FileRowProps) {
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

  return (
    <div
      onClick={(e) => {
        if (isRenaming) return;
        onSelect(e);
      }}
      onDoubleClick={(e) => {
        if (isRenaming) return;
        e.stopPropagation();
        onOpen();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      className={`dp-row group transition-colors duration-200 ease-smooth cursor-pointer
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
