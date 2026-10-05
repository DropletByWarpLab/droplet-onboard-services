"use client";
/**
 * WARP-3691 — pieces shared by the inline media cards.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, Loader2 } from "lucide-react";
import { isSafeMediaUrl } from "@droplet/shared-types";
import { authFetch } from "@/lib/auth";

export const UNAVAILABLE_COPY = "Camera unavailable or you don't have access";

/**
 * Defence in depth: the parser already drops bad URLs, but a card must never
 * put anything but a same-origin `/api/` path into an element, whoever called
 * it. Same rule as SafeImage in safe-markdown.tsx.
 */
export function safeSrc(url: string | undefined): string | undefined {
  return isSafeMediaUrl(url) ? url : undefined;
}

/** `url` with a cache-buster, preserving any existing query. */
export function withBust(url: string, stamp: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}t=${stamp}`;
}

/**
 * HTTP status of a GET to `url` (0 on network failure), body never read. An
 * `<img>`/`<video>` `onError` carries no status, so this is how a card tells
 * "you can't see this camera" (404) from "the box is unreachable". Only ever
 * called with a snapshot/thumbnail URL — never a live stream.
 */
export async function probeStatus(url: string): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await authFetch(url, { signal: ctrl.signal });
    void res.body?.cancel().catch(() => undefined);
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

/** Plain-language copy for a failed media load. */
export function errorCopy(status: number, camera: boolean): string {
  if (status === 404 || status === 403) {
    return camera ? UNAVAILABLE_COPY : "File not found or you don't have access";
  }
  if (status === 401) return "Your session expired. Sign in again to see this.";
  return camera ? "Couldn't load the camera image. Try again." : "Couldn't load this file. Try again.";
}

/** Observe whether `ref` is on screen. SSR / no-IntersectionObserver => true. */
export function useInView<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setInView(e.isIntersecting);
      },
      { threshold: 0.1 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, inView];
}

export function MediaFrame({
  children,
  testId,
  label,
}: {
  children: ReactNode;
  testId: string;
  label: string;
}) {
  return (
    <figure
      className="card overflow-hidden max-w-md w-full"
      data-testid={testId}
      aria-label={label}
      style={{ padding: 0 }}
    >
      {children}
    </figure>
  );
}

export function MediaCaption({ children }: { children: ReactNode }) {
  return (
    <figcaption className="flex items-center gap-2 px-3 py-2 type-footnote text-[var(--text-muted)]">
      {children}
    </figcaption>
  );
}

export function MediaError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center justify-center gap-2 aspect-video bg-[var(--card-inner)] text-[var(--text-muted)] px-4 text-center"
      data-testid="media-error"
    >
      <Camera size={20} aria-hidden="true" className="opacity-60" />
      <span className="type-footnote">{message}</span>
      {onRetry ? (
        <button type="button" className="btn sm" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function MediaSpinner() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
      <Loader2 size={18} className="animate-spin text-[var(--text-faint)]" aria-hidden="true" />
    </div>
  );
}

/**
 * An MJPEG `<img>` that CLOSES its connection on unmount.
 *
 * Removing an `<img>` from the DOM does not reliably abort an in-flight
 * multipart stream, so the cleanup clears `src` first. Browsers cap sockets per
 * origin (6 on HTTP/1.1): a feed left connected after it scrolls away or after
 * the message unmounts would starve every other request on the page.
 */
export function LiveImage({
  src,
  alt,
  onError,
  onLoad,
}: {
  src: string;
  alt: string;
  onError: () => void;
  onLoad?: () => void;
}) {
  const ref = useRef<HTMLImageElement | null>(null);
  useEffect(() => {
    const img = ref.current;
    return () => {
      if (img) {
        img.removeAttribute("src");
        img.src = "";
      }
    };
  }, []);
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      ref={ref}
      src={src}
      alt={alt}
      className="absolute inset-0 w-full h-full object-cover"
      onError={onError}
      onLoad={onLoad}
    />
  );
}
