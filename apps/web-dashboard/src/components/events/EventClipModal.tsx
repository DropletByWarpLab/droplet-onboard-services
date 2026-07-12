"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  Bookmark,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import { regenerateEventDescription, tagEventAsFace } from "@/lib/api";
import type { EventDetail } from "@/lib/types";
import { useToast } from "@/components/Toast";
import { translateError } from "@/lib/friendly-errors";
import { Dialog } from "@/components/Dialog";

interface Props {
  event: EventDetail;
  onClose: () => void;
  /** Toggle the retain-indefinitely flag. When wired, the modal
   *  renders a "Save / Saved" button. The handler should call the
   *  /retain route and invalidate the events SWR cache so the badge on
   *  the underlying card flips on close. */
  onToggleRetain?: (event: EventDetail, retain: boolean) => Promise<void>;
}

/**
 * Inline player for an event. Renders the clip if Frigate saved one,
 * falls back to the high-res snapshot otherwise. Esc closes; the
 * backdrop click is also a close. The "Open camera" link routes to
 * the camera's fullscreen page so the operator can keep watching the
 * live feed without losing the events backdrop.
 *
 * `Download` is a direct link to the proxied clip URL — the browser
 * handles the save dialog. We don't add an explicit "Save" toggle
 * here yet; that's Phase 2.2 (retain_indefinitely).
 *
 * WARP-291: rebuilt on top of the shared <Dialog> primitive so ARIA
 * + focus trap + Escape + scroll-lock all come from there. The
 * "Tag as person" prompt() is replaced by an inline text-input panel
 * (the prompt was not a destructive confirm; a ConfirmDialog would be
 * the wrong primitive for capturing free-text input). All
 * `alert(err.message)` sites are replaced by toast()s carrying
 * `translateError(err, "media")` copy, never the raw err.message —
 * the audit found these were leaking orchestrator-level strings.
 */
export function EventClipModal({ event, onClose, onToggleRetain }: Props) {
  const headingId = useId();
  const { toast } = useToast();

  // Local optimistic state for the Save toggle so the button flips
  // immediately on click. Reset whenever the modal switches to a new
  // event (operator clicked through to a different one).
  const [retained, setRetained] = useState(event.retainIndefinitely);
  const [retainBusy, setRetainBusy] = useState(false);
  useEffect(() => {
    setRetained(event.retainIndefinitely);
  }, [event.id, event.retainIndefinitely]);

  const handleToggleRetain = async () => {
    if (!onToggleRetain || retainBusy) return;
    const next = !retained;
    setRetainBusy(true);
    setRetained(next); // optimistic
    try {
      await onToggleRetain(event, next);
    } catch (e) {
      // Roll back on failure — leave the operator with an accurate state.
      setRetained(!next);
      toast(translateError(e, "media"), "error");
    } finally {
      setRetainBusy(false);
    }
  };

  // "Tag as person" — feeds Frigate's face recogniser. Only meaningful
  // for person-labeled events; we render the button conditionally
  // below to avoid suggesting "tag this car as Alice."
  const [tagging, setTagging] = useState(false);
  const [tagPanelOpen, setTagPanelOpen] = useState(false);
  const [tagName, setTagName] = useState("");
  const [tagError, setTagError] = useState<string | null>(null);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  const handleTagSubmit = async () => {
    const name = tagName.trim();
    if (!name) {
      setTagError("Enter a name.");
      return;
    }
    if (!/^[a-zA-Z0-9_ -]{1,40}$/.test(name)) {
      setTagError("Letters, numbers, spaces, hyphens, underscores; up to 40 chars.");
      return;
    }
    setTagError(null);
    setTagging(true);
    try {
      await tagEventAsFace(event.id, name);
      toast(`Tagged as ${name}. This snapshot will help recognise them next time.`, "success");
      setTagPanelOpen(false);
      setTagName("");
    } catch (e) {
      toast(translateError(e, "media"), "error");
    } finally {
      setTagging(false);
    }
  };

  useEffect(() => {
    if (tagPanelOpen) {
      // Defer one tick so the input is mounted before focus.
      const id = window.setTimeout(() => tagInputRef.current?.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [tagPanelOpen]);

  // GenAI regenerate-description — explicit "I want a fresh one"
  // affordance for events whose description is missing or stale.
  const [regenerating, setRegenerating] = useState(false);
  const handleRegenerate = async () => {
    setRegenerating(true);
    try {
      await regenerateEventDescription(event.id);
      toast(
        "A fresh description is being generated. Refresh the events list in a few seconds to see it.",
        "info",
      );
    } catch (e) {
      toast(translateError(e, "media"), "error");
    } finally {
      setRegenerating(false);
    }
  };

  const cameraDisplay = event.camera.replace(/_/g, " ");
  const startedAt = new Date(event.startTime * 1000);

  return (
    // `flush`: sectioned layout — the full-width header divider + sections
    // own their padding (WARP-1153).
    <Dialog open onClose={onClose} labelledBy={headingId} maxWidth="xl" flush>
      <div
        className="flex items-center justify-between px-4 py-3"
        style={{ borderBottom: "1px solid var(--card-bd)" }}
      >
        <h2
          id={headingId}
          className="type-headline capitalize truncate"
          style={{ color: "var(--text)" }}
        >
          {event.label}
          {event.subLabel && (
            <span className="font-normal normal-case ml-2" style={{ color: "var(--text-muted)" }}>
              · {event.subLabel}
            </span>
          )}
        </h2>
        <button onClick={onClose} aria-label="Close" className="icon-btn" style={{ width: 32, height: 32 }}>
          <X size={18} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div className="rounded-lg overflow-hidden" style={{ background: "var(--inset)" }}>
          {event.clipUrl ? (
            <video
              key={event.id}
              src={event.clipUrl}
              controls
              autoPlay
              className="w-full max-h-[60vh]"
              style={{ background: "var(--inset)" }}
            />
          ) : event.snapshotUrl ? (
            <img
              src={event.snapshotUrl}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[60vh] object-contain"
              style={{ background: "var(--inset)" }}
            />
          ) : (
            <img
              src={event.thumbnail}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[60vh] object-contain"
              style={{ background: "var(--inset)" }}
            />
          )}
        </div>

        {/* GenAI description (Phase 7.7) — only renders when there is one. */}
        {event.description && (
          <div
            className="p-3 rounded-lg flex items-start gap-2.5"
            style={{
              background: "var(--brand-subtle)",
              border: "1px solid color-mix(in srgb, var(--brand) 25%, transparent)",
            }}
          >
            <Sparkles size={14} className="flex-shrink-0 mt-0.5" style={{ color: "var(--brand)" }} />
            <p className="type-subheadline flex-1 italic leading-snug" style={{ color: "var(--text)" }}>
              &ldquo;{event.description}&rdquo;
            </p>
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              title="Generate a fresh description"
              aria-label="Regenerate description"
              className="p-1 rounded flex-shrink-0 text-[color:var(--text-muted)] hover:text-[color:var(--text)] hover:bg-[var(--hover)]"
            >
              {regenerating ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <RefreshCw size={12} />
              )}
            </button>
          </div>
        )}

        {/* Metadata + actions */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <p className="type-subheadline" style={{ color: "var(--text-muted)" }}>
              {cameraDisplay} · {startedAt.toLocaleString()} ·{" "}
              {Math.round(event.score * 100)}% confidence
            </p>
            {event.zones.length > 0 && (
              <p className="type-caption-1 mt-1" style={{ color: "var(--text-muted)" }}>
                Zones: {event.zones.join(", ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            {event.label === "person" && (
              <button
                onClick={() => setTagPanelOpen((o) => !o)}
                disabled={tagging}
                className="btn"
                title="Tag this person for face recognition"
              >
                {tagging ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Tag size={14} />
                )}
                <span className="hidden sm:inline">Tag person</span>
              </button>
            )}
            {onToggleRetain && (
              <button
                onClick={handleToggleRetain}
                disabled={retainBusy}
                aria-pressed={retained}
                className={`btn ${
                  retained
                    ? "!bg-system-orange/15 !text-system-orange !border-transparent hover:!bg-system-orange/25"
                    : ""
                } ${retainBusy ? "opacity-60 cursor-wait" : ""}`}
                title={retained ? "Unsave (allow normal retention)" : "Save (retain indefinitely)"}
              >
                {retainBusy ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Bookmark
                    size={14}
                    className={retained ? "fill-current" : ""}
                  />
                )}
                <span className="hidden sm:inline">
                  {retained ? "Saved" : "Save"}
                </span>
              </button>
            )}
            <Link href={`/cameras/${encodeURIComponent(event.camera)}`} className="btn">
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Open camera</span>
            </Link>
            {event.clipUrl && (
              <a
                href={event.clipUrl}
                download={`${event.camera}-${event.label}-${event.id}.mp4`}
                className="btn"
              >
                <Download size={14} />
                <span className="hidden sm:inline">Download</span>
              </a>
            )}
          </div>
        </div>

        {/* Inline tag-as-person panel — replaces the native prompt(). */}
        {tagPanelOpen && (
          <div className="card space-y-2" style={{ padding: 12 }}>
            <label
              htmlFor={`${headingId}-tag-input`}
              className="type-caption-1 block"
              style={{ color: "var(--text-muted)" }}
            >
              Tag this person — letters, numbers, spaces, hyphens, underscores
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`${headingId}-tag-input`}
                ref={tagInputRef}
                value={tagName}
                onChange={(e) => {
                  setTagName(e.target.value);
                  setTagError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleTagSubmit();
                }}
                placeholder="Alice"
                maxLength={40}
                className="flex-1 px-3 py-2 outline-none focus:border-[var(--brand)] placeholder:text-[color:var(--text-muted)]"
                style={{
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: "var(--radius-input)",
                  color: "var(--text)",
                }}
                aria-invalid={tagError ? true : undefined}
                aria-describedby={tagError ? `${headingId}-tag-error` : undefined}
              />
              <button
                onClick={() => void handleTagSubmit()}
                disabled={tagging}
                className="btn primary sm"
              >
                {tagging ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  "Save"
                )}
              </button>
              <button
                onClick={() => {
                  setTagPanelOpen(false);
                  setTagName("");
                  setTagError(null);
                }}
                className="type-subheadline px-3 py-2 transition-colors text-[color:var(--brand)] hover:text-[color:var(--brand-hover)]"
              >
                Cancel
              </button>
            </div>
            {tagError && (
              <p
                id={`${headingId}-tag-error`}
                role="alert"
                className="type-caption-1 text-system-red"
              >
                {tagError}
              </p>
            )}
          </div>
        )}
      </div>
    </Dialog>
  );
}
