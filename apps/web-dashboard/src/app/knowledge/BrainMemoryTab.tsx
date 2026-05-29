"use client";

/**
 * "Brain memory" tab — list of BrainMemoryItem rows for the authed
 * user with per-item Delete + "Download original" + "Export all as
 * zip" affordances.
 *
 * The actual delete + export endpoints land in WARP-205. This tab
 * renders the buttons today but degrades gracefully:
 *   - When `/api/files/brain` returns 404 (WARP-203 not merged), the
 *     tab shows the same friendly empty state as Recently-indexed.
 *   - When delete / export endpoints return 404 (WARP-205 not merged),
 *     the buttons surface an inline "coming soon" state instead of
 *     blowing up.
 *
 * That way the UI shape is stable across the partial-deploy window
 * during the WARP-203 → 204 → 205 rollout.
 */

import { useState } from "react";
import {
  Download,
  FileArchive,
  Sparkles,
  Trash2,
} from "lucide-react";
import {
  type BrainMemoryItemInfo,
  transcribeNow,
  TranscribeNowUnavailable,
} from "@/lib/api";
import { authFetch } from "@/lib/auth";
import { useBrainStatus } from "@/lib/hooks/useBrainStatus";
import { iconForMime } from "@/lib/mime-icons";
import { StatusChip } from "@/components/StatusChip";
import { ConfirmDialog } from "@/components/ConfirmDialog";

export function BrainMemoryTab() {
  // WARP-214: useBrainStatus replaces the manual GET + state — it seeds from
  // GET /api/files/brain and merges status flips from the WS bridge so the
  // StatusChip flips in place when the file-indexer publishes a new status.
  const { items: itemMap, loading, error } = useBrainStatus();
  const items = Array.from(itemMap.values()).sort(
    (a, b) =>
      new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
  );
  const unavailable = !loading && !error && itemMap.size === 0;

  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [exportPending, setExportPending] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  // WARP-218 not yet merged: feature-detect transcribeNow availability so the
  // overflow menu hides itself once we observe the route returning 404.
  const [transcribeNowAvailable, setTranscribeNowAvailable] = useState(true);
  // ConfirmDialog target — null when no delete is pending. Holds the
  // BrainMemoryItemInfo so the dialog can render the filename.
  const [confirmTarget, setConfirmTarget] = useState<BrainMemoryItemInfo | null>(
    null,
  );

  // The hook drives loading/error state; we keep `actionMessage` for inline
  // delete/export feedback and clear it whenever the items list refreshes.
  // (No-op effect — the WS bridge is the source of truth for re-render.)

  function handleDelete(item: BrainMemoryItemInfo) {
    setConfirmTarget(item);
  }

  async function performDelete() {
    const item = confirmTarget;
    if (!item) return;
    setPendingDelete(item.id);
    setActionMessage(null);
    try {
      const res = await authFetch(
        `/api/files/brain/${encodeURIComponent(item.id)}`,
        { method: "DELETE" }
      );
      if (res.status === 404) {
        setActionMessage(
          "Delete will be online once the brain memory service is fully set up."
        );
        setConfirmTarget(null);
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Delete failed: ${res.status}`);
      }
      setConfirmTarget(null);
      // WS bridge will eventually reconcile, but optimistically the list
      // re-fetches on next /api/files/brain refresh. No local mutation.
    } catch (err) {
      setActionMessage(`Delete failed: ${(err as Error).message}`);
      throw err;
    } finally {
      setPendingDelete(null);
    }
  }

  async function handleTranscribeNow(itemId: string) {
    setActionMessage(null);
    try {
      await transcribeNow(itemId);
      // Status flip arrives via the WS bridge.
    } catch (e) {
      if (e instanceof TranscribeNowUnavailable) {
        // WARP-218 hasn't merged yet — hide the menu in subsequent renders.
        setTranscribeNowAvailable(false);
        setActionMessage(
          "Manual transcription is not available yet. Items run on the nightly schedule.",
        );
      } else {
        setActionMessage(`Transcribe failed: ${(e as Error).message}`);
      }
    }
  }

  async function handleExportAll() {
    setExportPending(true);
    setActionMessage(null);
    try {
      const res = await authFetch(`/api/files/brain/export?all=1`);
      if (res.status === 404) {
        setActionMessage(
          "Export will be online once the brain memory service is fully set up."
        );
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
      a.download = "brain-memory.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setActionMessage(`Export failed: ${(err as Error).message}`);
    } finally {
      setExportPending(false);
    }
  }

  if (loading) {
    return (
      <div className="dp-card p-6 type-footnote text-label-tertiary">
        Loading…
      </div>
    );
  }

  if (error) {
    return (
      <div role="alert" className="dp-card p-4 type-footnote text-system-red">
        Couldn&apos;t load brain memory: {error}
      </div>
    );
  }

  if (unavailable) {
    return (
      <div className="dp-card p-8 text-center" data-testid="brain-memory-empty">
        <Sparkles size={28} className="text-label-quaternary mx-auto mb-3" />
        <p className="type-subheadline text-label-primary">
          No files indexed yet.
        </p>
        <p className="type-footnote text-label-tertiary mt-1">
          Drop a file in chat or upload to your Droplet&apos;s Nextcloud at{" "}
          <a href="/files" className="text-accent hover:underline">
            /files
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="type-footnote text-label-tertiary px-1">
          {items.length} item{items.length === 1 ? "" : "s"}
        </p>
        <button
          type="button"
          onClick={handleExportAll}
          disabled={exportPending}
          className="
            inline-flex items-center gap-1.5 type-footnote text-label-secondary
            px-3 py-1.5 rounded-md bg-surface-secondary
            hover:bg-surface-tertiary hover:text-label-primary
            transition-colors disabled:opacity-50
          "
          data-testid="brain-export-all"
        >
          <FileArchive size={14} />
          {exportPending ? "Preparing…" : "Export all as zip"}
        </button>
      </div>

      {actionMessage && (
        <div className="dp-card p-3 type-footnote text-label-secondary" role="status">
          {actionMessage}
        </div>
      )}

      <ul className="space-y-2" data-testid="brain-memory-list">
        {items.map((item) => {
          // WARP-214: object-icon set keyed off MIME — Headphones for audio,
          // Film for video, Mail for email, FileArchive for archives, etc.
          const Icon = iconForMime(item.mimeType);
          return (
          <li
            key={item.id}
            className="dp-card p-3 flex items-start gap-3"
            data-testid="brain-memory-item"
          >
            <div className="w-8 h-8 rounded-md bg-accent-subtle flex items-center justify-center flex-shrink-0">
              <Icon size={14} className="text-accent" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="type-subheadline text-label-primary truncate">
                  {item.filename}
                </p>
                <StatusChip
                  itemId={item.id}
                  status={item.status ?? "ready"}
                  failureReason={item.failureReason}
                  onTranscribeNow={
                    transcribeNowAvailable ? handleTranscribeNow : undefined
                  }
                />
              </div>
              <p className="type-caption-1 text-label-tertiary">
                {item.mimeType} · {(item.sizeBytes / 1024).toFixed(1)} KB ·{" "}
                {new Date(item.uploadedAt).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <a
                href={`/api/files/brain/${encodeURIComponent(item.id)}/download`}
                className="
                  p-1.5 rounded-md text-label-tertiary
                  hover:bg-surface-secondary hover:text-label-primary
                  transition-colors
                "
                title="Download original"
                aria-label="Download original"
                data-testid="brain-download"
              >
                <Download size={14} />
              </a>
              <button
                type="button"
                onClick={() => handleDelete(item)}
                disabled={pendingDelete === item.id}
                className="
                  p-1.5 rounded-md text-label-tertiary
                  hover:bg-system-red/10 hover:text-system-red
                  transition-colors disabled:opacity-50
                "
                title="Delete"
                aria-label="Delete"
                data-testid="brain-delete"
              >
                <Trash2 size={14} />
              </button>
            </div>
          </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={confirmTarget !== null}
        onConfirm={performDelete}
        onCancel={() => setConfirmTarget(null)}
        title={
          confirmTarget
            ? `Delete "${confirmTarget.filename}" from brain memory?`
            : "Delete from brain memory?"
        }
        description="Your assistant will no longer recall this file's contents. The original on disk is unaffected."
        confirmLabel="Delete"
        variant="destructive"
      />
    </div>
  );
}
