"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — the wall's camera composite: Frigate's
 * birdseye (WARP-1918), through the same route /cameras/birdseye plays, left
 * running for hours.
 *
 *   waiting ─(allowed)─▶ checking ─ 2xx ─▶ live ─(5 min)─▶ live, reconnected
 *      │                    │ ▲            │
 *      │                    │ └── retry ── lost ◀─ <img> error
 *      │                    ├── any other status, a timeout, no answer ─▶ lost
 *      │                    └── 404 ─▶ unavailable ─(10 min)─▶ checking
 *      └─(not allowed / no camera system)─▶ off
 *
 * The check is a GET whose status is read off the headers before the request
 * is aborted (`getBirdseyeStatus`) — never HEAD, which a continuous stream
 * never answers. A 404 is one neutral line for "not enabled" and "not yours":
 * the composite is all-or-nothing, only a viewer who may see every camera gets
 * it (WARP-2982), and the server makes the two answers identical. `lost` is
 * retried on the wall's backoff (15 s, 30 s, 60 s, then every 2 min), and a
 * live stream reconnects every 5 min: a clean upstream end freezes the last
 * frame with no error, so only a reconnect bounds a frozen picture. The new
 * stream loads hidden under the old one and replaces it on its first frame
 * (`load`), so a reconnect never blanks the screen; one that has not loaded
 * by the next reconnect is replaced in turn (never more than two streams).
 *
 * Nothing is asked while `allowed` is not true: the page's modules read says
 * whether Cameras is open to this viewer, and every request to a gate that
 * refuses them would be a denial row. Every timer is a setTimeout cleared on
 * each transition and on unmount.
 */
import { useEffect, useState } from "react";
import { VideoOff } from "lucide-react";
import { getBirdseyeLiveUrl, getBirdseyeStatus } from "@/lib/api";
import { wallRetryDelayMs } from "@/lib/hooks/useSecurity";
import { COPY as FEED_COPY } from "./SecurityFeed";
import { CAMERA_RECONNECT_MS, CAMERA_UNAVAILABLE_RECHECK_MS, WALL_COPY } from "./wall-status";

export type WallCamerasState = "waiting" | "off" | "checking" | "live" | "unavailable" | "lost";

export interface WallCamerasProps {
  /** Whether Cameras is open to this viewer; null until the wall's modules read has answered. */
  allowed: boolean | null;
  /** /security/health says no camera system is set up (`camera_ingest: not_configured`). */
  noCameraSystem: boolean;
}

export function WallCameras({ allowed, noCameraSystem }: WallCamerasProps) {
  const ask = allowed === true && !noCameraSystem;
  const [state, setState] = useState<WallCamerasState>("waiting");
  // Bumped to ask again; `lost` counts its retries for the backoff.
  const [check, setCheck] = useState(0);
  const [retries, setRetries] = useState(0);
  // The stream on screen, and the one replacing it while a reconnect loads (a new `src` is a new stream).
  const [shown, setShown] = useState(0);
  const [next, setNext] = useState<number | null>(null);
  const asked = next ?? shown;

  // Ask the route — whenever it may be asked and a (re)check is due.
  useEffect(() => {
    if (!ask) {
      setState(allowed === null ? "waiting" : "off");
      return;
    }
    const ctrl = new AbortController();
    setState("checking");
    getBirdseyeStatus(ctrl.signal).then(
      (status) => {
        if (ctrl.signal.aborted) return;
        if (status >= 200 && status < 300) {
          setRetries(0);
          setNext(null);
          setState("live");
        } else {
          setState(status === 404 ? "unavailable" : "lost");
        }
      },
      () => {
        if (!ctrl.signal.aborted) setState("lost");
      },
    );
    return () => ctrl.abort();
  }, [ask, allowed, check]);

  // The timers each state owns.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (state === "live") timer = setTimeout(() => setNext(asked + 1), CAMERA_RECONNECT_MS);
    if (state === "unavailable") timer = setTimeout(() => setCheck((c) => c + 1), CAMERA_UNAVAILABLE_RECHECK_MS);
    if (state === "lost") {
      timer = setTimeout(() => {
        setRetries((r) => r + 1);
        setCheck((c) => c + 1);
      }, wallRetryDelayMs(retries + 1));
    }
    return () => {
      if (timer !== null) clearTimeout(timer);
    };
  }, [state, asked, retries]);

  if (state === "live") {
    const stream = (g: number) => `${getBirdseyeLiveUrl()}?w=${g}`;
    return (
      <div className="sec-wall-cameras">
        <img key={shown} src={stream(shown)} alt={WALL_COPY.camerasAlt} onError={() => setState("lost")} />
        {next !== null && (
          <img
            key={next}
            src={stream(next)}
            alt=""
            aria-hidden="true"
            className="is-pending"
            onLoad={() => {
              setShown(next);
              setNext(null);
            }}
            onError={() => setState("lost")}
          />
        )}
      </div>
    );
  }
  const busy = state === "waiting" || state === "checking";
  const line =
    state === "off" && noCameraSystem
      ? FEED_COPY.emptyNoCameras
      : state === "off" || state === "unavailable"
        ? WALL_COPY.camerasUnavailable
        : state === "lost"
          ? WALL_COPY.camerasLost
          : WALL_COPY.camerasConnecting;
  return (
    <div className="sec-wall-cameras" aria-busy={busy} data-state={state}>
      <div className="sec-wall-cameras-note">
        {!busy && <VideoOff size={40} aria-hidden="true" />}
        <p>{line}</p>
        {state === "lost" && <p className="sec-wall-sub">{WALL_COPY.camerasLostBody}</p>}
      </div>
    </div>
  );
}
