"use client";

import { useState } from "react";
import {
  Trash2,
  RotateCcw,
  AlertTriangle,
  Folder,
  File,
  FileText,
  Image,
  Film,
  Music,
  Archive,
} from "lucide-react";
import type { TrashItemInfo } from "@/lib/types";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { isTrashUnsupportedError } from "@/lib/api";

interface TrashViewProps {
  items: TrashItemInfo[];
  isLoading: boolean;
  /**
   * WARP-1555 — the fetch error from `useTrash`. "Trash is empty" is the
   * most dangerous empty state in the product: shown after a failed load it
   * reads as "your deleted files are gone". A `TrashUnsupportedError` (the
   * backend 501) gets its own copy again — it is not a failure and not empty.
   */
  error?: unknown;
  /** Re-runs the trash fetch. Pass `useTrash().refresh`. */
  onRetry?: () => void;
  onRestore: (name: string) => void | Promise<void>;
  onDeleteForever: (name: string) => void | Promise<void>;
  onEmpty: () => void | Promise<void>;
}

function getIconForName(name: string, isDirectory: boolean) {
  if (isDirectory) return Folder;
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["jpg", "jpeg", "png", "gif", "webp", "svg", "bmp"].includes(ext)) return Image;
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return Film;
  if (["mp3", "wav", "ogg", "m4a", "flac"].includes(ext)) return Music;
  if (["txt", "md", "log", "csv", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "py", "sh"].includes(ext))
    return FileText;
  if (["zip", "tar", "gz", "7z", "rar"].includes(ext)) return Archive;
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
    year: "numeric",
  });
}

/**
 * Renders the trash listing with Restore / Delete-forever / Empty-trash actions.
 * Used by /files/trash/page.tsx.
 */
export function TrashView({
  items,
  isLoading,
  error,
  onRetry,
  onRestore,
  onDeleteForever,
  onEmpty,
}: TrashViewProps) {
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TrashItemInfo | null>(null);

  const handleRestore = async (item: TrashItemInfo) => {
    setBusy(item.name);
    try {
      await onRestore(item.name);
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = (item: TrashItemInfo) => {
    setPendingDelete(item);
  };

  const performDelete = async () => {
    const item = pendingDelete;
    if (!item) return;
    setBusy(item.name);
    try {
      await onDeleteForever(item.name);
      setPendingDelete(null);
    } catch (err) {
      throw err;
    } finally {
      setBusy(null);
    }
  };

  const performEmpty = async () => {
    await onEmpty();
  };

  /*
    WARP-1555: the trash has no trash bin behind it (backend 501). Not a
    failure and emphatically not "empty" — say plainly that deletes here are
    immediate so nobody goes looking for a file that was never kept. No retry
    button: retrying cannot make a backend grow a trashbin.
  */
  if (isTrashUnsupportedError(error) && items.length === 0) {
    return (
      <div className="card" role="alert" style={{ padding: 0 }}>
        <div className="empty">
          <span className="ei">
            <Trash2 size={24} />
          </span>
          <p className="eh">Trash isn&apos;t available on this Droplet</p>
          <p style={{ maxWidth: "42ch", fontSize: "13px" }}>
            This box&apos;s storage doesn&apos;t keep a trash bin, so deleting a
            file removes it straight away. Nothing is being hidden here — check
            a backup if you need a deleted file back.
          </p>
        </div>
      </div>
    );
  }

  /*
    WARP-1555: a failed fetch, checked before `isLoading` (SWR turns loading
    back on for each backoff retry) and before the empty state. Gated on an
    empty list so a failed background poll never hides items already shown.
  */
  if (error && items.length === 0) {
    return (
      <div className="card" role="alert" style={{ padding: 0 }}>
        <div className="empty">
          <span className="ei">
            <AlertTriangle size={24} />
          </span>
          <p className="eh">We couldn&apos;t load your trash</p>
          <p style={{ maxWidth: "42ch", fontSize: "13px" }}>
            The box didn&apos;t answer when we asked what&apos;s in the trash.
            Nothing has been deleted for good — try again in a moment.
          </p>
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

  if (!isLoading && items.length === 0) {
    return (
      <div className="card" style={{ padding: 0 }}>
        <div className="empty">
          <span className="ei">
            <Trash2 size={24} />
          </span>
          <p className="eh">Trash is empty</p>
          <p style={{ fontSize: "13px" }}>
            Deleted files will appear here before they&apos;re permanently removed
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      {/* Header row with Empty trash */}
      {items.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <p style={{ color: "var(--text-muted)", fontSize: "12.5px" }}>
            {items.length} {items.length === 1 ? "item" : "items"} in trash
          </p>
          <button
            onClick={() => setConfirmEmpty(true)}
            disabled={items.length === 0}
            className="btn ghost sm disabled:opacity-50 disabled:cursor-not-allowed"
            style={{ color: "var(--danger)" }}
          >
            <AlertTriangle size={14} />
            Empty trash
          </button>
        </div>
      )}

      {/* List */}
      <div className="card overflow-hidden min-h-[200px]" style={{ padding: 0 }}>
        <div
          className="flex items-center gap-3 px-4 py-2 uppercase tracking-wider"
          style={{ color: "var(--text-faint)", fontSize: "11px", borderBottom: "1px solid var(--card-bd)" }}
        >
          <span className="flex-1">Name</span>
          <span className="w-32 hidden md:block">Original location</span>
          <span className="w-20 text-right hidden sm:block">Size</span>
          <span className="w-28 text-right hidden lg:block">Deleted</span>
          <span className="w-20" />
        </div>

        {isLoading && items.length === 0 && (
          <div
            className="flex items-center justify-center h-40"
            style={{ color: "var(--text-muted)", fontSize: "13.5px" }}
          >
            Loading…
          </div>
        )}

        <div className="rows">
          {items.map((item) => {
            const Icon = getIconForName(item.originalName, item.isDirectory);
            return (
              <div
                key={item.name}
                className="flex items-center gap-3 px-4 py-3 min-h-[44px] group transition-colors duration-200 ease-smooth hover:bg-[var(--hover)]"
              >
                <div className="flex items-center gap-3 flex-1 min-w-0">
                  <Icon
                    size={18}
                    style={{ color: item.isDirectory ? "var(--brand)" : "var(--text-muted)" }}
                  />
                  <span
                    className="truncate"
                    style={{ color: "var(--text)", fontSize: "13.5px", fontWeight: 500 }}
                  >
                    {item.originalName}
                  </span>
                </div>

                <span
                  className="w-32 truncate hidden md:block"
                  style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
                >
                  {item.originalLocation}
                </span>

                <span
                  className="w-20 text-right hidden sm:block"
                  style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
                >
                  {item.isDirectory ? "" : formatSize(item.size)}
                </span>

                <span
                  className="w-28 text-right hidden lg:block"
                  style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: "11.5px" }}
                >
                  {formatDate(item.deletedAt)}
                </span>

                {/*
                  WARP-300: row actions are always rendered (no opacity-0
                  hover gate) so touch + keyboard users can discover the
                  actions. p-2.5 → 34 px hit-target, clears the 32 px
                  ui-ux floor. aria-labels name the file so screen-reader
                  users hear which entry they're about to restore or
                  permanently delete.
                */}
                <div className="flex items-center gap-0.5 justify-end flex-shrink-0">
                  <button
                    onClick={() => handleRestore(item)}
                    disabled={busy === item.name}
                    className="p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[color:var(--brand)] hover:bg-[var(--hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors disabled:opacity-50"
                    aria-label={`Restore ${item.originalName}`}
                    title="Restore"
                  >
                    <RotateCcw size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(item)}
                    disabled={busy === item.name}
                    className="p-2.5 rounded-[var(--radius-input)] text-[color:var(--text-muted)] hover:text-[#ef4444] hover:bg-[rgba(239,68,68,0.12)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)] transition-colors disabled:opacity-50"
                    aria-label={`Delete forever ${item.originalName}`}
                    title="Delete forever"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <ConfirmDialog
        open={pendingDelete !== null}
        onConfirm={performDelete}
        onCancel={() => setPendingDelete(null)}
        title={
          pendingDelete
            ? `Permanently delete "${pendingDelete.originalName}"?`
            : "Permanently delete?"
        }
        description="This bypasses Trash. The file cannot be restored after this."
        confirmLabel="Delete forever"
        variant="destructive"
      />

      <ConfirmDialog
        open={confirmEmpty}
        onConfirm={performEmpty}
        onCancel={() => setConfirmEmpty(false)}
        title={
          items.length > 0
            ? `Permanently delete ${items.length} ${items.length === 1 ? "item" : "items"} in trash?`
            : "Empty trash?"
        }
        description="Every file in Trash is gone for good. This cannot be undone."
        confirmLabel="Empty trash"
        variant="destructive"
      />
    </div>
  );
}
