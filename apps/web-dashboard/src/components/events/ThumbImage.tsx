"use client";

import { useState } from "react";
import { ImageOff } from "lucide-react";

interface Props {
  src: string;
  /** Spoken label for the picture. Never painted: a failed load shows the placeholder, not this text. */
  alt: string;
  className?: string;
  /** Sizing for the placeholder (`w-full h-full`, `w-full aspect-video`…). It is centred and token-coloured already. */
  placeholderClassName?: string;
  loading?: "lazy" | "eager";
  /** Pixel size of the placeholder glyph. */
  iconSize?: number;
  /**
   * Change this to give a failed picture another chance at the SAME url. Frigate
   * writes an event's thumbnail some time after the event begins, so the first
   * request for one still in progress can 404 and a later request succeed — the
   * cards pass the item's `endTime`, which changes exactly when it ends. Left
   * out, a failure holds until `src` changes.
   */
  retryKey?: string | number | null;
}

/**
 * A thumbnail that cannot embarrass its card (WARP-3509).
 *
 * A broken `<img>` paints its `alt` as visible text in its own box. On an
 * event or review card that box is the whole 16:9 tile, beneath absolutely
 * placed badges, so "alert on warp lab office" printed straight through
 * "Alert", "New" and the duration chip. When the image fails this renders an
 * icon instead, on whatever background the tile already has (the cards set
 * `var(--inset)` on the container), so there is no text left to overlay
 * anything.
 *
 * Keyed on the failed `src` (and `retryKey`), not a boolean: a new url is a new
 * chance — the modal moving to another review, say — with no frame of
 * placeholder first. The same url and key are not retried until the component
 * remounts, so a poll that re-renders the grid does not re-request a picture
 * that is still not there.
 */
export function ThumbImage({
  src,
  alt,
  className,
  placeholderClassName = "w-full h-full",
  loading,
  iconSize = 28,
  retryKey = null,
}: Props) {
  // What failed, as a single key: the picture AND the chance it had.
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const attemptKey = `${retryKey ?? ""}\u0000${src}`;

  if (failedKey === attemptKey) {
    return (
      <div
        data-testid="thumb-fallback"
        aria-hidden="true"
        className={`flex items-center justify-center text-[color:var(--text-muted)] ${placeholderClassName}`}
      >
        <ImageOff size={iconSize} strokeWidth={1.5} />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      className={className}
      loading={loading}
      onError={() => setFailedKey(attemptKey)}
    />
  );
}
