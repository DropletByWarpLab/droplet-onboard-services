"use client";

import { Thumbnail } from "./Thumbnail";
import { StarButton } from "./StarButton";
import { Download, X, type LucideIcon } from "lucide-react";
import type { FileEntryInfo } from "@/lib/types";

interface FileListSimpleProps {
  files: FileEntryInfo[];
  isLoading: boolean;
  emptyIcon?: LucideIcon;
  emptyTitle?: string;
  emptyDescription?: string;
  showLocation?: boolean;
  showStar?: boolean;
  onOpen: (file: FileEntryInfo) => void;
  onDownload?: (file: FileEntryInfo) => void;
  onRemove?: (file: FileEntryInfo) => void;
  removeTooltip?: string;
  onStarChanged?: () => void;
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
 * Shared read-only listing used by Favorites / Recents / Shared-with-me sub-routes.
 * Shows a thumbnail + name + optional parent location + quick actions.
 */
export function FileListSimple({
  files,
  isLoading,
  emptyIcon: EmptyIcon,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  showLocation = true,
  showStar = false,
  onOpen,
  onDownload,
  onRemove,
  removeTooltip,
  onStarChanged,
}: FileListSimpleProps) {
  if (isLoading && files.length === 0) {
    return (
      <div className="dp-group min-h-[240px] flex items-center justify-center text-label-tertiary type-subheadline">
        Loading…
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="dp-card py-16 flex flex-col items-center justify-center text-label-tertiary">
        {EmptyIcon && <EmptyIcon size={32} className="mb-3 text-label-quaternary" />}
        <p className="type-subheadline">{emptyTitle}</p>
        {emptyDescription && (
          <p className="type-caption-1 mt-1 text-label-quaternary text-center max-w-xs">
            {emptyDescription}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="dp-group">
      {files.map((file) => {
        const parent = file.path.replace(/\/[^/]*$/, "") || "/";
        return (
          <div
            key={file.path}
            className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] group hover:bg-surface-secondary/60 cursor-pointer transition-colors"
            onClick={() => onOpen(file)}
          >
            <Thumbnail file={file} size={36} className="flex-shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="type-callout text-label-primary truncate">
                {file.name}
              </p>
              {showLocation && (
                <p className="type-caption-2 text-label-tertiary truncate">
                  {parent}
                </p>
              )}
            </div>
            <span className="type-caption-1 text-label-tertiary hidden sm:inline-block w-20 text-right flex-shrink-0">
              {file.isDirectory ? "" : formatSize(file.size)}
            </span>
            <span className="type-caption-1 text-label-tertiary hidden md:inline-block w-28 text-right flex-shrink-0">
              {formatDate(file.modifiedAt)}
            </span>
            <div className="flex items-center gap-0.5 w-16 justify-end flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
              {showStar && (
                <div onClick={(e) => e.stopPropagation()}>
                  <StarButton
                    path={file.path}
                    favorited={true}
                    onToggle={(next) => {
                      if (!next) onStarChanged?.();
                    }}
                  />
                </div>
              )}
              {onDownload && !file.isDirectory && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onDownload(file);
                  }}
                  className="p-1.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle transition-colors"
                  aria-label="Download"
                >
                  <Download size={14} />
                </button>
              )}
              {onRemove && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(file);
                  }}
                  className="p-1.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 transition-colors"
                  aria-label={removeTooltip || "Remove"}
                  title={removeTooltip}
                >
                  <X size={14} />
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
