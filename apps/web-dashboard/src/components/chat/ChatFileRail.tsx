"use client";

/**
 * WARP-2205 — the chat's file rail.
 *
 * You could always attach a file to a chat and have the model act on it, but
 * you could never LOOK at it without leaving the conversation. The chips in
 * `SessionHeader` name a file; the pins popover manages scope hints; neither
 * shows a single byte. This rail is the missing half: the conversation's files
 * in one column, and the selected one rendered in place by the same previewer
 * the Files page uses (`PreviewPane mode="docked"`, WARP-2204).
 *
 * It lists the union of two sources that address files in DIFFERENT
 * vocabularies, which is the whole reason the adapters below exist:
 *
 *   - Chat attachments are BrainMemoryItems, addressed by `itemId` and served
 *     from /api/files/brain/:itemId/download. They have NO files-tree path, so
 *     they carry an explicit `source` telling the previewer where the bytes
 *     are (WARP-2207 added the `?disposition=inline` that makes them
 *     renderable at all).
 *   - Context pins of kind "file" carry a `ref` that IS a files-tree path, so
 *     they need no override — the previewer derives its own URLs, exactly as
 *     it does on the Files page.
 *
 * The rail renders nothing at all when the conversation has no files. An empty
 * 276px column beside every new chat would be a permanent tax for a feature
 * most turns never use.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Loader2, Paperclip, Pin, X } from "lucide-react";
import { PreviewPane } from "@/components/FileManager/PreviewPane";
import { listContextPins, getDownloadUrl } from "@/lib/api";
import { authFetch } from "@/lib/auth";
import type { ChatAttachment, FileEntryInfo } from "@/lib/types";

/**
 * One row in the rail, normalized across the two source vocabularies.
 *
 * `entry` is null exactly when the file cannot be shown yet — the row still
 * renders (you attached it, you should see it) but is not selectable, and
 * `blockedReason` says why. A row that looks clickable and does nothing is the
 * failure mode this shape exists to prevent.
 */
export interface RailFile {
  key: string;
  name: string;
  bytes?: number;
  origin: "attachment" | "pin";
  entry: FileEntryInfo | null;
  /** Byte endpoints for items that live outside the files tree. */
  source?: { previewUrl: string; downloadUrl: string };
  blockedReason?: string;
  failed?: boolean;
}

/** Brain-item bytes. WARP-2207 grants inline only for its safelist. */
function brainUrls(itemId: string) {
  return {
    previewUrl: `/api/files/brain/${encodeURIComponent(itemId)}/download?disposition=inline`,
    downloadUrl: `/api/files/brain/${encodeURIComponent(itemId)}/download`,
  };
}

/**
 * A `FileEntryInfo` for something that is not a files-tree entry.
 *
 * `path` is the filename rather than a real path: the previewer keys its
 * office-thumbnail failure state on it and derives nothing else from it once
 * `source` is supplied. `modifiedAt` is empty because a `ChatAttachment`
 * carries no timestamp on the client — the previewer never reads it, and
 * inventing "now" would be a lie a future caller could render.
 */
function syntheticEntry(
  name: string,
  bytes: number,
  mimeType: string | null,
): FileEntryInfo {
  return {
    name,
    path: name,
    isDirectory: false,
    size: bytes,
    mimeType,
    modifiedAt: "",
  };
}

export function attachmentToRail(a: ChatAttachment): RailFile {
  // The bytes land on disk when the upload route returns 202 and mints the
  // itemId. "indexing" is about RAG extraction, not byte availability, so an
  // indexing item is perfectly viewable — gating on "ready" would hide a file
  // that is sitting right there.
  const hasBytes = !!a.itemId && (a.status === "ready" || a.status === "indexing");
  const failed = a.status === "failed";
  return {
    key: a.itemId ?? a.localId,
    name: a.filename,
    bytes: a.bytes,
    origin: "attachment",
    entry: hasBytes
      ? syntheticEntry(a.filename, a.bytes, a.mimeType ?? null)
      : null,
    source: hasBytes && a.itemId ? brainUrls(a.itemId) : undefined,
    failed,
    blockedReason: hasBytes
      ? undefined
      : failed
        ? (a.error ?? "Upload failed")
        : "Still uploading",
  };
}

export function pinToRail(ref: string): RailFile {
  const name = ref.split("/").filter(Boolean).pop() || ref;
  return {
    key: `pin:${ref}`,
    name,
    origin: "pin",
    // A pin's ref is already a files-tree path, so the previewer builds its own
    // URLs — no `source`. The ref is user-typed and never validated against the
    // tree, so a stale one 404s into the previewer's existing empty state
    // rather than throwing.
    entry: {
      name,
      path: ref,
      isDirectory: false,
      size: 0,
      mimeType: null,
      modifiedAt: "",
    },
  };
}

/**
 * Merge the two sources, attachments first (they are this conversation's own
 * uploads) and de-duplicated by display name — a file both attached and pinned
 * is one thing to the person looking at it.
 */
export function buildRailFiles(
  attachments: ChatAttachment[],
  pinRefs: string[],
): RailFile[] {
  const rows: RailFile[] = [];
  const seen = new Set<string>();
  for (const a of attachments ?? []) {
    const row = attachmentToRail(a);
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
  }
  for (const ref of pinRefs ?? []) {
    const row = pinToRail(ref);
    if (seen.has(row.name)) continue;
    seen.add(row.name);
    rows.push(row);
  }
  return rows;
}

function formatBytes(n?: number): string | null {
  if (n === undefined || n <= 0) return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

interface ChatFileRailProps {
  /** Null before the first turn mints a conversation — pins are per-session. */
  sessionId: string | null;
  attachments: ChatAttachment[];
  /**
   * "rail" renders its OWN `<aside className="file-rail hidden lg:flex">` and
   * returns null when the conversation has no files. The wrapper belongs to
   * the component rather than the page for exactly that reason: an aside the
   * page renders would still be 276px of empty glass while the component
   * inside it rendered nothing.
   *
   * "drawer" renders the bare content — the Dialog primitive supplies the
   * shell, the heading and the focus trap.
   */
  variant?: "rail" | "drawer";
  /** Rendered inside the mobile drawer, where the host supplies the close. */
  onClose?: () => void;
  /**
   * Reports how many files the rail is showing, so the page can gate its
   * mobile trigger without duplicating the pin fetch. The "rail" instance
   * mounts at every viewport (`hidden` only hides it visually), so it is a
   * reliable reporter even on a phone where it is never painted.
   */
  onCountChange?: (count: number) => void;
}

export function ChatFileRail({
  sessionId,
  attachments,
  variant = "rail",
  onClose,
  onCountChange,
}: ChatFileRailProps) {
  const [pinRefs, setPinRefs] = useState<string[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  // Pins are per-session and managed elsewhere (ContextPinsPopover). We only
  // read them, and a failure is silent on purpose: the rail's own reason for
  // existing is the attachments, and a pins outage must not blank it.
  useEffect(() => {
    if (!sessionId) {
      setPinRefs([]);
      return;
    }
    let cancelled = false;
    listContextPins(sessionId)
      .then(({ pins }) => {
        if (cancelled) return;
        setPinRefs(pins.filter((p) => p.kind === "file").map((p) => p.ref));
      })
      .catch(() => {
        if (!cancelled) setPinRefs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const files = useMemo(
    () => buildRailFiles(attachments, pinRefs),
    [attachments, pinRefs],
  );

  const selected = useMemo(
    () => files.find((f) => f.key === selectedKey) ?? null,
    [files, selectedKey],
  );

  // A selected file that leaves the list (conversation switch, attachment
  // removed) must not keep a stale pane open over the new list.
  useEffect(() => {
    if (selectedKey && !files.some((f) => f.key === selectedKey)) {
      setSelectedKey(null);
    }
  }, [files, selectedKey]);

  const handleDownload = useCallback(() => {
    if (!selected?.entry) return;
    const url = selected.source?.downloadUrl ?? getDownloadUrl(selected.entry.path);
    authFetch(url)
      .then((res) => res.blob())
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = selected.name;
        a.click();
        URL.revokeObjectURL(a.href);
      })
      .catch(() => {
        /* The pane keeps its own Download affordance; a failed save is not
           worth tearing the rail down over. */
      });
  }, [selected]);

  useEffect(() => {
    onCountChange?.(files.length);
  }, [files.length, onCountChange]);

  if (files.length === 0) return null;

  const body = (
    <div className="flex flex-col h-full w-full min-h-0">
      <div className="file-rail-head">
        <span className="file-rail-head-t">
          Files
          <span className="file-rail-count">{files.length}</span>
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="chat-iconbtn"
            aria-label="Close files"
          >
            <X size={16} aria-hidden="true" />
          </button>
        )}
      </div>

      {selected?.entry ? (
        <div className="flex-1 min-h-0">
          <PreviewPane
            file={selected.entry}
            mode="docked"
            source={selected.source}
            onClose={() => setSelectedKey(null)}
            onDownload={handleDownload}
          />
        </div>
      ) : (
        <ul className="file-rail-list">
          {files.map((f) => {
            const size = formatBytes(f.bytes);
            const blocked = !f.entry;
            return (
              <li key={f.key}>
                <button
                  type="button"
                  className="file-rail-row"
                  disabled={blocked}
                  aria-disabled={blocked}
                  onClick={() => !blocked && setSelectedKey(f.key)}
                  title={blocked ? f.blockedReason : `Open ${f.name}`}
                >
                  <span className="file-rail-ico" aria-hidden="true">
                    {f.failed ? (
                      <AlertCircle size={15} />
                    ) : blocked ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : f.origin === "pin" ? (
                      <Pin size={15} />
                    ) : (
                      <Paperclip size={15} />
                    )}
                  </span>
                  <span className="file-rail-meta">
                    <span className="file-rail-name">{f.name}</span>
                    <span className="file-rail-sub">
                      {blocked ? f.blockedReason : (size ?? "Pinned file")}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );

  if (variant === "drawer") return body;

  // `hidden lg:flex` and NOT a `display` in chat-indigo.css — see the WARP-1792
  // note on `.conv-rail`. The stylesheet rule is specificity (0,2,0) against
  // Tailwind's `.hidden` at (0,1,0), so a `display` there would beat the
  // utility and paint this rail on phones alongside its own drawer.
  return (
    <aside
      className="file-rail hidden lg:flex"
      aria-label="Files in this conversation"
    >
      {body}
    </aside>
  );
}
