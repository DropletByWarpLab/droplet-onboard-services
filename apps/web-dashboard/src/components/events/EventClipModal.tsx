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
      <div className="flex items-center justify-between px-4 py-3 border-b border-separator">
        <h2 id={headingId} className="type-headline text-label-primary capitalize truncate">
          {event.label}
          {event.subLabel && (
            <span className="text-label-tertiary font-normal normal-case ml-2">
              · {event.subLabel}
            </span>
          )}
        </h2>
        <button
          onClick={onClose}
          aria-label="Close"
          className="p-1 text-label-tertiary hover:text-label-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 rounded-sm"
        >
          <X size={18} />
        </button>
      </div>

      <div className="p-4 space-y-3">
        <div className="rounded-lg overflow-hidden bg-black">
          {event.clipUrl ? (
            <video
              key={event.id}
              src={event.clipUrl}
              controls
              autoPlay
              className="w-full max-h-[60vh] bg-black"
            />
          ) : event.snapshotUrl ? (
            <img
              src={event.snapshotUrl}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[60vh] object-contain bg-black"
            />
          ) : (
            <img
              src={event.thumbnail}
              alt={`${event.label} on ${cameraDisplay}`}
              className="w-full max-h-[60vh] object-contain bg-black"
            />
          )}
        </div>

        {/* GenAI description (Phase 7.7) — only renders when there is one. */}
        {event.description && (
          <div className="p-3 rounded-lg bg-accent-subtle flex items-start gap-2.5">
            <Sparkles size={14} className="text-accent flex-shrink-0 mt-0.5" />
            <p className="type-subheadline flex-1 italic leading-snug text-label-primary">
              &ldquo;{event.description}&rdquo;
            </p>
            <button
              onClick={handleRegenerate}
              disabled={regenerating}
              title="Generate a fresh description"
              aria-label="Regenerate description"
              className="p-1 rounded text-label-tertiary hover:text-label-primary hover:bg-surface-secondary flex-shrink-0"
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
            <p className="type-subheadline text-label-secondary">
              {cameraDisplay} · {startedAt.toLocaleString()} ·{" "}
              {Math.round(event.score * 100)}% confidence
            </p>
            {event.zones.length > 0 && (
              <p className="type-caption-1 text-label-tertiary mt-1">
                Zones: {event.zones.join(", ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            {event.label === "person" && (
              <button
                onClick={() => setTagPanelOpen((o) => !o)}
                disabled={tagging}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-secondary text-label-primary hover:bg-surface-tertiary type-subheadline transition-colors disabled:opacity-50"
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
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg type-subheadline transition-colors ${
                  retained
                    ? "bg-system-orange/15 text-system-orange hover:bg-system-orange/25"
                    : "bg-surface-secondary text-label-primary hover:bg-surface-tertiary"
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
            <Link
              href={`/cameras/${encodeURIComponent(event.camera)}`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-secondary text-label-primary hover:bg-surface-tertiary type-subheadline transition-colors"
            >
              <ExternalLink size={14} />
              <span className="hidden sm:inline">Open camera</span>
            </Link>
            {event.clipUrl && (
              <a
                href={event.clipUrl}
                download={`${event.camera}-${event.label}-${event.id}.mp4`}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-surface-secondary text-label-primary hover:bg-surface-tertiary type-subheadline transition-colors"
              >
                <Download size={14} />
                <span className="hidden sm:inline">Download</span>
              </a>
            )}
          </div>
        </div>

        {/* Inline tag-as-person panel — replaces the native prompt(). */}
        {tagPanelOpen && (
          <div className="p-3 rounded-lg bg-surface-secondary border border-separator space-y-2">
            <label
              htmlFor={`${headingId}-tag-input`}
              className="type-caption-1 text-label-tertiary block"
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
                className="dp-input flex-1"
                aria-invalid={tagError ? true : undefined}
                aria-describedby={tagError ? `${headingId}-tag-error` : undefined}
              />
              <button
                onClick={() => void handleTagSubmit()}
                disabled={tagging}
                className="dp-btn-primary type-subheadline !min-h-[36px] !py-1.5"
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
                className="type-subheadline text-accent hover:text-accent-hover px-3 py-2 transition-colors"
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
