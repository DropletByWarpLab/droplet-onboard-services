"use client";

/**
 * Per-chat SessionHeader (WARP-205).
 *
 * Renders a contextual "Export brain memory for this chat" affordance
 * when the current chat has at least one attached BrainMemoryItem.
 * Hits `GET /api/files/brain/export?chatId=<id>` which streams a zip
 * (manifest.json + per-item original bytes) — see WARP-205 spec §6.3.
 *
 * The chat page in `app/chat/page.tsx` mints a fresh `chatId` per
 * thread and tracks `attachments`; this header is rendered conditional
 * on `attachments.length > 0` AND at least one attachment having
 * advanced to `ready` (so we don't offer to export bytes that aren't
 * persisted yet). Pre-export, attachments in the local UI are still
 * pending uploads; the orchestrator-side row is what the export
 * actually reads, so we gate on the WS-driven status flip.
 *
 * The component intentionally does NOT poll. Status updates flow into
 * `useChat` via MQTT-backed websocket; the parent re-renders us with
 * the new prop when an item flips to ready.
 */

import { useState } from "react";
import { FileArchive } from "lucide-react";
import { authFetch } from "@/lib/auth";
import type { ChatAttachment } from "@/lib/types";

interface Props {
  chatId: string;
  attachments: ChatAttachment[];
}

export function SessionHeader({ chatId, attachments }: Props) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  // Surface the affordance only when there's at least one attachment
  // that the orchestrator will actually find. Pre-ready attachments
  // (still uploading, queued for indexing) won't have a row yet, but
  // are reasonable to include since the export route reads the row,
  // not the indexer state. Anything past `pending` qualifies.
  const exportable = attachments.filter(
    (a) => a.status === "ready" || a.status === "indexing",
  );
  if (exportable.length === 0) {
    return null;
  }

  async function handleExport() {
    setPending(true);
    setMessage(null);
    try {
      const res = await authFetch(
        `/api/files/brain/export?chatId=${encodeURIComponent(chatId)}`,
      );
      if (res.status === 404) {
        setMessage("Export will be online once the brain memory service is fully set up.");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Export failed: ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `brain-memory-${chatId}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setMessage(`Export failed: ${(err as Error).message}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <div
      className="px-4 py-2 border-b border-separator bg-surface-secondary/40
        flex items-center justify-between gap-2"
      data-testid="session-header"
    >
      <span className="type-caption-1 text-label-tertiary">
        {exportable.length} file
        {exportable.length === 1 ? "" : "s"} attached to this chat
      </span>
      <div className="flex items-center gap-2">
        {message && (
          <span className="type-caption-1 text-label-secondary" role="status">
            {message}
          </span>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={pending}
          className="
            inline-flex items-center gap-1.5 type-caption-1 text-label-secondary
            px-2.5 py-1 rounded-md bg-surface-tertiary
            hover:bg-surface-secondary hover:text-label-primary
            transition-colors disabled:opacity-50
          "
          data-testid="session-export"
          aria-label="Export brain memory for this chat"
        >
          <FileArchive size={12} />
          {pending ? "Preparing…" : "Export brain memory for this chat"}
        </button>
      </div>
    </div>
  );
}
