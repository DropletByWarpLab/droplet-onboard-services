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

interface TrashViewProps {
  items: TrashItemInfo[];
  isLoading: boolean;
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

  if (!isLoading && items.length === 0) {
    return (
      <div className="dp-card py-16 flex flex-col items-center justify-center text-label-tertiary">
        <Trash2 size={32} className="mb-3 text-label-quaternary" />
        <p className="type-subheadline">Trash is empty</p>
        <p className="type-caption-1 mt-1 text-label-quaternary">
          Deleted files will appear here before they&apos;re permanently removed
        </p>
      </div>
    );
  }

  return (
    <div>
      {/* Header row with Empty trash */}
      {items.length > 0 && (
        <div className="flex items-center justify-between mb-3">
          <p className="type-footnote text-label-tertiary">
            {items.length} {items.length === 1 ? "item" : "items"} in trash
          </p>
          <button
            onClick={() => setConfirmEmpty(true)}
            disabled={items.length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 type-footnote text-system-red hover:bg-system-red/10 rounded-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <AlertTriangle size={14} />
            Empty trash
          </button>
        </div>
      )}

      {/* List */}
      <div className="dp-group min-h-[200px]">
        <div className="flex items-center gap-3 px-4 py-2 type-caption-1 text-label-tertiary uppercase tracking-wider">
          <span className="flex-1">Name</span>
          <span className="w-32 hidden md:block">Original location</span>
          <span className="w-20 text-right hidden sm:block">Size</span>
          <span className="w-28 text-right hidden lg:block">Deleted</span>
          <span className="w-20" />
        </div>

        {isLoading && items.length === 0 && (
          <div className="flex items-center justify-center h-40 text-label-tertiary type-subheadline">
            Loading…
          </div>
        )}

        {items.map((item) => {
          const Icon = getIconForName(item.originalName, item.isDirectory);
          return (
            <div
              key={item.name}
              className="dp-row group hover:bg-surface-secondary/60 transition-colors"
            >
              <div className="flex items-center gap-3 flex-1 min-w-0">
                <Icon
                  size={18}
                  className={item.isDirectory ? "text-system-blue" : "text-label-secondary"}
                />
                <span className="type-callout text-label-primary truncate">
                  {item.originalName}
                </span>
              </div>

              <span className="type-caption-1 text-label-tertiary w-32 truncate hidden md:block">
                {item.originalLocation}
              </span>

              <span className="type-caption-1 text-label-tertiary w-20 text-right hidden sm:block">
                {item.isDirectory ? "" : formatSize(item.size)}
              </span>

              <span className="type-caption-1 text-label-tertiary w-28 text-right hidden lg:block">
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
                  className="p-2.5 rounded-full text-label-tertiary hover:text-accent hover:bg-accent-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors disabled:opacity-50"
                  aria-label={`Restore ${item.originalName}`}
                  title="Restore"
                >
                  <RotateCcw size={14} />
                </button>
                <button
                  onClick={() => handleDelete(item)}
                  disabled={busy === item.name}
                  className="p-2.5 rounded-full text-label-tertiary hover:text-system-red hover:bg-system-red/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-colors disabled:opacity-50"
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
