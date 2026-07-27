"use client";

import { Thumbnail } from "./Thumbnail";
import { StarButton } from "./StarButton";
import { Download, X, AlertTriangle, type LucideIcon } from "lucide-react";
import type { FileEntryInfo } from "@/lib/types";

interface FileListSimpleProps {
  files: FileEntryInfo[];
  isLoading: boolean;
  /**
   * WARP-1555 — the fetch error from the owning hook (`useFavorites`,
   * `useRecents`, …). When set, the list renders a first-class error
   * state instead of the empty state: "we failed to load your data" and
   * "you have nothing here" are different facts and must look different.
   */
  error?: unknown;
  errorTitle?: string;
  errorDescription?: string;
  /** Re-runs the fetch. Pass the hook's `refresh` to get a retry button. */
  onRetry?: () => void;
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
  error,
  errorTitle = "We couldn't load this list",
  errorDescription = "The box didn't answer when we asked for these files. Nothing has been changed — try again in a moment.",
  onRetry,
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
  /*
    WARP-1555: the error branch is checked BEFORE `isLoading` on purpose.
    SWR flips `isLoading` back on for every backoff retry while `data` is
    still undefined, so a loading-first order would flap the user between
    "Loading…" and the failure. It is gated on an empty list so a failed
    background poll never wipes rows we already have on screen.
    role="alert" because the failure lands asynchronously, after the page
    has already rendered (same reasoning as the main Files page).
  */
  if (error && files.length === 0) {
    return (
      <div className="card" role="alert" style={{ padding: 0 }}>
        <div className="empty">
          <span className="ei">
            <AlertTriangle size={24} />
          </span>
          <p className="eh">{errorTitle}</p>
          <p style={{ maxWidth: "22rem", fontSize: "13px" }}>{errorDescription}</p>
          {onRetry && (
            <button
              type="button"
              className="btn ghost sm"
              onClick={onRetry}
              style={{ marginTop: 10 }}
            >
              Try again
            </button>
          )}
        </div>
      </div>
    );
  }

  if (isLoading && files.length === 0) {
    return (
      <div
        className="card flex items-center justify-center min-h-[240px]"
        style={{ color: "var(--text-muted)", fontSize: "13.5px" }}
      >
        Loading…
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div className="card" style={{ padding: 0 }}>
        <div className="empty">
          {EmptyIcon && (
            <span className="ei">
              <EmptyIcon size={24} />
            </span>
          )}
          <p className="eh">{emptyTitle}</p>
          {emptyDescription && (
            <p style={{ maxWidth: "22rem", fontSize: "13px" }}>{emptyDescription}</p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card overflow-hidden" style={{ padding: 0 }}>
      <div className="rows">
        {files.map((file) => {
          const parent = file.path.replace(/\/[^/]*$/, "") || "/";
          return (
            <div
              key={file.path}
              className="flex items-center gap-3 px-4 py-2.5 min-h-[52px] group cursor-pointer transition-colors duration-200 ease-smooth hover:bg-[var(--hover)]"
              onClick={() => onOpen(file)}
            >
              <Thumbnail file={file} size={36} className="flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <p
                  className="truncate"
                  style={{ color: "var(--text)", fontSize: "13.5px", fontWeight: 500 }}
                >
                  {file.name}
                </p>
                {showLocation && (
                  <p
                    className="truncate"
                    style={{ color: "var(--text-muted)", fontSize: "12px", marginTop: "1px" }}
                  >
                    {parent}
                  </p>
                )}
              </div>
              <span
                className="hidden sm:inline-block w-20 text-right flex-shrink-0"
                style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
              >
                {file.isDirectory ? "" : formatSize(file.size)}
              </span>
              <span
                className="hidden md:inline-block w-28 text-right flex-shrink-0"
                style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
              >
                {formatDate(file.modifiedAt)}
              </span>
              {/*
                WARP-300: row actions are always rendered (no opacity-0
                hover gate) so touch + keyboard users can discover them.
                p-2.5 → 34 px hit-target, clears the 32 px ui-ux floor.
                aria-labels name the file the action targets so
                screen-reader users hear which entry they're acting on
                (Favorites, Recents, and Shared-with-me all share this
                listing).
              */}
              <div className="flex items-center gap-0.5 justify-end flex-shrink-0">
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
                    className="p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
                    aria-label={`Download ${file.name}`}
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
                    className="p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors"
                    aria-label={`${removeTooltip || "Remove"} ${file.name}`}
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
    </div>
  );
}
