"use client";

import { Loader2, FileText, AlertTriangle, Check, X } from "lucide-react";
import type { ChatAttachment } from "@/lib/types";
import { translateError } from "@/lib/friendly-errors";

interface AttachmentChipProps {
  attachment: ChatAttachment;
  /** Remove from the local list — used both for "user clicked X" and
   *  "user clicked retry on a failed item, re-add later". */
  onRemove?: (localId: string) => void;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Renders one chat attachment as a status chip — pending spinner /
 * ready check / failed warning. Sits inline above the chat input,
 * mirroring the iMessage attachment-row pattern. The MQTT-driven status
 * flip (driven by the WebSocket bridge) re-renders the chip in place.
 */
export function AttachmentChip({ attachment, onRemove }: AttachmentChipProps) {
  const { localId, filename, bytes, status, error } = attachment;

  // Tone-of-voice for the screen-reader-only status string. The dot
  // before each phrase is a non-breaking space + middot for the
  // visual layout — separated here so the ARIA text reads cleanly.
  const statusText =
    status === "pending" || status === "uploading"
      ? "Uploading"
      : status === "indexing"
        ? "Indexing"
        : status === "ready"
          ? "Ready"
          : "Failed";

  const isWorking = status === "pending" || status === "uploading" || status === "indexing";
  const isFailed = status === "failed";
  const isReady = status === "ready";

  return (
    <div
      data-testid="attachment-chip"
      data-attachment-id={localId}
      data-status={status}
      role="status"
      aria-label={`${filename} — ${statusText}`}
      className={`inline-flex items-center gap-2 rounded-full px-3 py-1.5 type-caption-1
        max-w-full bg-surface-secondary border
        ${isFailed ? "border-system-orange/60" : "border-separator"}
      `}
    >
      <FileText
        size={14}
        className="flex-shrink-0 text-label-secondary"
        strokeWidth={2}
      />
      <span className="truncate text-label-primary" title={filename}>
        {filename}
      </span>
      <span className="text-label-tertiary">·</span>
      <span className="text-label-tertiary tabular-nums flex-shrink-0">
        {formatBytes(bytes)}
      </span>
      <span className="text-label-tertiary">·</span>
      {isWorking ? (
        <Loader2
          size={12}
          className="animate-spin text-accent flex-shrink-0"
          aria-hidden
        />
      ) : isReady ? (
        <Check
          size={14}
          className="text-system-green flex-shrink-0"
          aria-hidden
        />
      ) : (
        <AlertTriangle
          size={14}
          className="text-system-orange flex-shrink-0"
          aria-hidden
        />
      )}
      <span className="text-label-tertiary flex-shrink-0">{statusText}</span>
      {isFailed && error ? (
        // WARP-294: never surface the raw `error` payload anywhere in
        // the DOM (text or title) — the backend may emit terse strings
        // (HTTP codes, indexer enums, ECONNREFUSED). The full raw cause
        // goes via the helper's console.error for QA / operator triage.
        <span className="text-label-tertiary truncate">
          — {translateError({ message: error }, "chat")}
        </span>
      ) : null}
      {onRemove ? (
        <button
          type="button"
          onClick={() => onRemove(localId)}
          aria-label={`Remove ${filename}`}
          className="flex-shrink-0 ml-1 -mr-1 size-5 rounded-full
            flex items-center justify-center
            text-label-tertiary hover:text-label-primary
            hover:bg-label-quaternary/40
            transition-colors duration-150"
        >
          <X size={12} strokeWidth={2.5} />
        </button>
      ) : null}
    </div>
  );
}
