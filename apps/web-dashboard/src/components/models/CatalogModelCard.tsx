"use client";

/**
 * WARP-1827 — one INSTALLABLE model from the eligible catalog (rendered under
 * the local models as "Available to install").
 *
 * The catalog is decided appliance-side (the inference-manager filters its
 * list to what this box's VRAM can actually run), so everything shown here is
 * already known to fit. The card is honest the same way LocalModelCard is:
 * the download size renders only when the catalog knows it ("~9 GB download"),
 * never fabricated; capability/role chips come straight from the catalog.
 *
 * Read/write split mirrors the rest of /models: owners/admins get a Download
 * button; members see the metadata read-only with NO disabled-button noise.
 * One download at a time — while any pull runs, other cards' buttons disable;
 * the pulling card swaps its button for a live progress meter driven by the
 * NDJSON stream (determinate only when the stream reports completed/total —
 * an invented percentage would be a fabricated number).
 */

import { Cpu, Download, HardDrive, Loader2 } from "lucide-react";
import type { CatalogModelEntry } from "@/lib/types";

export function CatalogModelCard({
  entry,
  canManage = false,
  pulling = false,
  pullBusy = false,
  progressPct = null,
  progressStatus = null,
  error = null,
  onDownload,
}: {
  entry: CatalogModelEntry;
  /** Owner/admin — only they can download. */
  canManage?: boolean;
  /** True while THIS model is downloading. */
  pulling?: boolean;
  /** True while ANY download runs — disables this card's button. */
  pullBusy?: boolean;
  /** 0–100 from the stream's completed/total; null → indeterminate. */
  progressPct?: number | null;
  /** The stream's own status line ("pulling manifest", …). */
  progressStatus?: string | null;
  /** Terminal error for THIS model (e.g. the disk-preflight detail). */
  error?: string | null;
  onDownload: () => void;
}) {
  const title = entry.display_name ?? entry.name;
  // Chips: capabilities + roles, deduped — "chat" appearing in both lists
  // must not render twice.
  const chips = Array.from(new Set([...entry.capabilities, ...entry.roles]));
  const caption = [entry.maker, entry.class].filter(Boolean).join(" · ");

  return (
    <div className="card flex flex-col gap-3.5" style={{ padding: "16px" }}>
      {/* Header: glyph · display name + maker · (no status chip — nothing is
          running yet; the one state this card can be in is "downloading"). */}
      <div className="flex items-start gap-2.5">
        <span
          className="w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0"
          style={{ background: "var(--brand-subtle)", color: "var(--brand)" }}
          aria-hidden
        >
          <Cpu size={18} strokeWidth={2} />
        </span>
        <div className="flex-1 min-w-0">
          <h3
            className="type-subheadline font-medium truncate"
            style={{ color: "var(--text)" }}
          >
            {title}
          </h3>
          {caption && (
            <p
              className="type-caption-1 truncate"
              style={{ color: "var(--text-muted)" }}
            >
              {caption}
            </p>
          )}
        </div>
      </div>

      {/* Catalog description — straight from the sidecar; absent stays absent. */}
      {entry.description && (
        <p className="type-caption-1" style={{ color: "var(--text-muted)", margin: 0 }}>
          {entry.description}
        </p>
      )}

      {/* Capability / role chips. */}
      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip}
              className="inline-flex items-center h-6 px-2 rounded-full type-caption-2"
              style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}
            >
              {chip}
            </span>
          ))}
        </div>
      )}

      {pulling ? (
        /* Live download progress, driven by the box's own NDJSON stream.
           Determinate only when the stream reports totals; between phases
           ("verifying sha256 digest") the bar is honestly indeterminate. */
        <div className="flex flex-col gap-1.5">
          <div
            className="h-1.5 rounded-full overflow-hidden bg-[var(--inset)]"
            role="progressbar"
            aria-label={`Downloading ${title}`}
            aria-valuenow={progressPct ?? undefined}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div
              className={`h-full rounded-full bg-[var(--brand)] ${
                progressPct == null ? "animate-pulse" : ""
              }`}
              style={{
                width:
                  progressPct == null
                    ? "100%"
                    : `${Math.min(100, Math.max(0, progressPct))}%`,
                opacity: progressPct == null ? 0.45 : 1,
                // Ease between stream updates instead of jumping — the NDJSON
                // lines arrive in bursts and a hard snap reads as glitchy.
                transition: "width 300ms ease",
              }}
            />
          </div>
          <p
            className="inline-flex items-center gap-1.5 type-caption-1 tabular-nums"
            role="status"
            style={{ color: "var(--text-muted)", margin: 0 }}
          >
            <Loader2 size={12} className="animate-spin" aria-hidden />
            {progressStatus ?? "Downloading…"}
            {progressPct != null ? ` — ${progressPct}%` : ""}
          </p>
        </div>
      ) : (
        /* Foot: honest size + the one action. Members get no button at all —
           read-only without disabled-button noise. */
        <div
          className="flex items-center gap-2 type-caption-1"
          style={{ color: "var(--text-muted)" }}
        >
          {entry.disk_gb != null && (
            <span
              className="inline-flex items-center gap-1"
              title="Approximate download size"
            >
              <HardDrive size={12} strokeWidth={2} aria-hidden />
              <span className="tabular-nums">~{entry.disk_gb} GB download</span>
            </span>
          )}
          {canManage && (
            <button
              type="button"
              className="btn ml-auto"
              onClick={onDownload}
              disabled={pullBusy}
              title={
                pullBusy
                  ? "Your Droplet downloads one model at a time"
                  : undefined
              }
            >
              <Download size={14} strokeWidth={2} aria-hidden />
              Download
            </button>
          )}
        </div>
      )}

      {error && (
        <p
          className="type-caption-2"
          role="alert"
          style={{ color: "var(--system-red, #ff3b30)", margin: 0 }}
        >
          {error}
        </p>
      )}
    </div>
  );
}
