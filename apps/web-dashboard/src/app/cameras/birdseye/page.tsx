"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, LayoutGrid, Maximize2, VideoOff } from "lucide-react";
import { getBirdseyeLiveUrl, getBirdseyeStatus } from "@/lib/api";
import { ShellPage } from "@/components/shell/ShellPage";

/** A live stream reconnects this often: a clean upstream end freezes the last frame with no error. */
const RECONNECT_MS = 5 * 60_000;

/**
 * Birdseye view (Phase 6.2) — Frigate composites every active camera into
 * one frame, with motion-active cameras brought to the foreground; the
 * orchestrator turns that into a live MJPEG stream. A passive "what's
 * happening anywhere?" surface: operators reach for the per-camera detail view
 * when they want to act on what they see.
 *
 * It renders inside the normal shell (like People / Plates / System) with the
 * feed in a 16:9 card and a fullscreen button.
 *
 * A 404 from the proxied route means Frigate is not serving birdseye frames
 * (it needs `birdseye.restream`, which camera-discovery converges on at
 * startup). We show an explanation instead of a black box.
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

  const toggleFullscreen = async () => {
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
  };

  const actions = (
    <>
      <button onClick={() => router.push("/cameras")} className="btn ghost" type="button">
        <ArrowLeft size={15} />
        Cameras
      </button>
      <button
        onClick={toggleFullscreen}
        disabled={!streaming}
        className="icon-btn"
        aria-label="Fullscreen"
        title="Toggle fullscreen"
        type="button"
      >
        <Maximize2 size={16} />
      </button>
    </>
  );

  return (
    <ShellPage
      icon={<LayoutGrid size={15} />}
      label="Birdseye"
      title="Birdseye"
      sub="Every active camera in one view; cameras with motion come forward."
      actions={actions}
    >
      <div className="card" style={{ padding: 0, overflow: "hidden" }}>
        <div
          id="birdseye-feed"
          className="relative aspect-video bg-black flex items-center justify-center"
        >
          {available === false ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center max-w-md">
              <VideoOff size={48} className="text-label-quaternary" />
              <h2 className="type-title-3 text-white">Birdseye not enabled</h2>
              <p className="type-subheadline text-label-tertiary">
                Birdseye isn&apos;t set up on this Droplet yet. It needs the
                camera service&apos;s restream option, which Droplet turns on
                by itself when the camera service restarts. It will appear
                here once that finishes; check back in a minute or two.
              </p>
            </div>
          ) : imgError ? (
            <div className="flex flex-col items-center gap-3 p-6 text-center">
              <VideoOff size={48} className="text-label-quaternary" />
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
    </ShellPage>
  );
}
