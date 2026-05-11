"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { translateError } from "@/lib/friendly-errors";

interface Props {
  src: string;
  onTimeUpdate?: (currentTime: number) => void;
  onError?: (message: string) => void;
  className?: string;
  autoPlay?: boolean;
  muted?: boolean;
  controls?: boolean;
}

/**
 * Imperative handle the page can use to drive the player without
 * reaching into the underlying <video> element. Currently exposes
 * `seek(seconds)` for the segment-list "jump to" behaviour.
 */
export interface HlsPlayerHandle {
  seek: (currentTime: number) => void;
  pause: () => void;
  play: () => Promise<void>;
}

/**
 * Thin HLS player wrapper.
 *
 * Strategy:
 *   - Native HLS (Safari, iOS) plays the URL directly via the
 *     underlying <video> tag — no JS library needed.
 *   - Everywhere else, dynamically import hls.js so the dashboard's
 *     non-recording surfaces don't pay for the bundle. hls.js attaches
 *     to the video element and pushes MSE buffers from the proxied
 *     m3u8.
 *
 * Re-mounts cleanly when the `src` changes (operator picks a new
 * hour), tearing down the previous Hls instance to free GPU/MSE
 * resources. Errors bubble up via `onError` so the parent can render
 * a recovery message instead of a black box.
 */
export const HlsPlayer = forwardRef<HlsPlayerHandle, Props>(function HlsPlayer(
  {
    src,
    onTimeUpdate,
    onError,
    className,
    autoPlay = true,
    muted = false,
    controls = true,
  },
  ref,
) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Keep the Hls instance ref-stable across renders so cleanup hits
  // the right object on src change.
  const hlsRef = useRef<{ destroy: () => void } | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      seek: (t: number) => {
        if (videoRef.current) videoRef.current.currentTime = t;
      },
      pause: () => {
        videoRef.current?.pause();
      },
      play: async () => {
        if (videoRef.current) await videoRef.current.play();
      },
    }),
    [],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let cancelled = false;

    // Native HLS path — Safari, mobile WebKit. The video tag plays
    // an .m3u8 source directly, no MSE shimming required.
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = src;
      return () => {
        // No Hls instance to clean up; clear src so the next mount
        // doesn't briefly hold the old one.
        video.removeAttribute("src");
        video.load();
      };
    }

    // hls.js path — dynamic import so this code is only fetched on
    // routes that actually need HLS (the recordings page).
    void (async () => {
      try {
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (!Hls.isSupported()) {
          // WARP-294: route through translateError so the recordings
          // page receives the same friendly copy idiom for every
          // failure mode (no raw enum, no engineer-speak).
          onError?.(translateError({ code: "UNSUPPORTED" }, "media"));
          return;
        }
        const hls = new Hls({
          // Keep buffers small — recording playback isn't a live edge
          // and we don't want the player chewing on 60s of decoded
          // frames just because we left the tab open.
          maxBufferLength: 30,
          // Cap the back-buffer too so a long scrub session doesn't
          // grow indefinitely.
          backBufferLength: 30,
        });
        hlsRef.current = hls;
        hls.loadSource(src);
        hls.attachMedia(video);
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) {
            // WARP-294: hls.js's `data.details` / `data.type` are
            // engineer-facing enum strings (bufferStalledError,
            // manifestLoadError, …). Translate them to plain copy via
            // the media domain before bubbling up to the parent's
            // setPlayerError.
            onError?.(
              translateError({ code: data.details ?? data.type }, "media"),
            );
          }
        });
      } catch (err) {
        if (!cancelled) {
          // WARP-294: never echo err.message — dynamic-import failures
          // and Hls instance constructor errors can surface unhelpful
          // strings like "Failed to fetch".
          onError?.(translateError(err, "media"));
        }
      }
    })();

    return () => {
      cancelled = true;
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute("src");
      video.load();
    };
  }, [src, onError]);

  return (
    <video
      ref={videoRef}
      className={className}
      controls={controls}
      autoPlay={autoPlay}
      muted={muted}
      onTimeUpdate={(e) => onTimeUpdate?.(e.currentTarget.currentTime)}
      // No native `src` here — we set it imperatively above so we
      // can switch between native HLS and hls.js.
    />
  );
});
