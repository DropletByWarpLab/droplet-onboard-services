"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Maximize2, VideoOff } from "lucide-react";
import { getBirdseyeLiveUrl, getBirdseyeStatus } from "@/lib/api";

/** A live stream reconnects this often: a clean upstream end freezes the last frame with no error. */
const RECONNECT_MS = 5 * 60_000;

/**
 * Birdseye view (Phase 6.2) — Frigate auto-composites every active
 * camera into a single MJPEG stream, with motion-active cameras
 * brought to the foreground. Useful as a "what's happening anywhere?"
 * surface, especially in lobbies and shared spaces.
 *
 * The page is intentionally minimal: full-bleed feed + a fullscreen
 * toggle. Birdseye is a passive watch surface, not an interactive
 * one — operators reach for the per-camera detail view when they
 * want to act on what they see.
 *
 * 404 from the proxied route means Frigate doesn't have birdseye
 * enabled in its config. We show a clean message instead of a black
 * box so the operator knows what to do (turn it on in config.yml).
 *
 * The feed is an endless MJPEG stream, so the "is it enabled" check is a GET
 * whose status is read and the request aborted (`getBirdseyeStatus`, never
 * HEAD, which a live stream never answers), and a live stream reconnects
 * (`RECONNECT_MS`), since a clean upstream end fires no `error` event.
 */
export default function BirdseyePage() {
  const router = useRouter();
  const [imgError, setImgError] = useState(false);
  // The img element doesn't surface HTTP status, so we probe the
  // route once on mount to detect "not configured" (404 from orchestrator).
  const [available, setAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    getBirdseyeStatus(ctrl.signal).then(
      (status) => {
        if (!ctrl.signal.aborted) setAvailable(status >= 200 && status < 300);
      },
      () => {
        if (!ctrl.signal.aborted) setAvailable(false);
      },
    );
    return () => ctrl.abort();
  }, []);

  // A new `src` is a new stream; the browser keeps the old frame until the new one's first.
  const [reconnects, setReconnects] = useState(0);
  const streaming = available !== false && !imgError;
  useEffect(() => {
    if (!streaming) return;
    const timer = setInterval(() => setReconnects((n) => n + 1), RECONNECT_MS);
    return () => clearInterval(timer);
  }, [streaming]);

  return (
    <div className="fixed inset-0 z-40 bg-black flex flex-col">
      <header className="flex items-center justify-between px-4 sm:px-6 h-14 border-b border-white/10 bg-black/80 backdrop-blur-md">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <button
            onClick={() => router.replace("/cameras")}
            className="p-2 -ml-2 rounded-full hover:bg-white/10 transition-colors text-white"
            aria-label="Back to cameras"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="min-w-0">
            <h1 className="type-headline text-white">Birdseye</h1>
            <p className="type-caption-1 text-white/60">
              Auto-composited multi-camera live view
            </p>
          </div>
        </div>
        <button
          onClick={async () => {
            try {
              const el = document.getElementById("birdseye-feed");
              if (el && document.fullscreenElement !== el) {
                await el.requestFullscreen();
              } else if (document.fullscreenElement) {
                await document.exitFullscreen();
              }
            } catch {
              /* fullscreen API unavailable — silent no-op */
            }
          }}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-white/90 hover:bg-white/10 transition-colors"
          title="Toggle browser fullscreen"
        >
          <Maximize2 size={16} />
        </button>
      </header>

      <div
        id="birdseye-feed"
        className="relative flex-1 bg-black flex items-center justify-center min-h-0"
      >
        {available === false ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center max-w-md">
            <VideoOff size={56} className="text-label-quaternary" />
            <h2 className="type-title-3 text-white">Birdseye not enabled</h2>
            <p className="type-subheadline text-label-tertiary">
              Birdseye view isn&apos;t set up on this Droplet. Ask your admin
              to enable it in the camera service configuration.
            </p>
          </div>
        ) : imgError ? (
          <div className="flex flex-col items-center gap-3 p-6 text-center">
            <VideoOff size={56} className="text-label-quaternary" />
            <p className="type-subheadline text-label-tertiary">
              Stream lost — the camera service may have restarted. Refreshing
              the page usually picks it up.
            </p>
          </div>
        ) : (
          <img
            src={reconnects === 0 ? getBirdseyeLiveUrl() : `${getBirdseyeLiveUrl()}?w=${reconnects}`}
            alt="Birdseye live composite"
            className="max-w-full max-h-full object-contain"
            onError={() => setImgError(true)}
          />
        )}
      </div>
    </div>
  );
}
