"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — the wall's cameras: one tile for each camera
 * the signed-in person may see, and for nothing else.
 *
 * D6 (Stefan: "Member wall, own cameras"). The wall runs on a Staff account,
 * never an owner's or admin's, so it cannot use Frigate's birdseye composite:
 * that is all-or-nothing (WARP-2982), only a viewer who sees every camera gets
 * it. Instead the tiles are exactly the list GET /api/cameras returns for this
 * person — the server narrows it to their grants (DS-005) — in the list's
 * order, each named as the household named it (`cameraLabelOf`, the feed's
 * rule). Each tile asks its own camera's latest picture every 3 s
 * (`useWallSnapshot`; the per-camera snapshot route checks the grant again).
 *
 * A tile never presents a frozen picture as a current one:
 *   · a camera turned off, or not sending pictures (`offline`/`idle` on the
 *     list: no frames reach the camera system) is not asked at all and shows
 *     no picture, only that;
 *   · a picture older than 15 s (the snapshots are failing) stays, dimmed and
 *     grey, under "Picture from {time}" — its own age;
 *   · before the first picture: "Connecting…"; if that fails, "No picture
 *     yet" while it keeps trying.
 *
 * Nothing is asked while the modules read has not said Security and Cameras
 * are open to this person (every request to a gate that refuses them would be
 * a denial row). The tiles fill the space the strip leaves on a TV (a
 * near-square grid, `--cols` × `--rows`) and stack one per row on a phone.
 */
import { useEffect, useState, type CSSProperties } from "react";
import { TriangleAlert, VideoOff } from "lucide-react";
import { cameraLabelOf, useWallSnapshot } from "@/lib/hooks/useSecurity";
import type { CameraInfo } from "@/lib/types";
import { fill } from "./ModeCard";
import { COPY as FEED_COPY } from "./SecurityFeed";
import { WALL_COPY, WALL_TILE_STALE_AFTER_MS, tileGrid } from "./wall-status";

export interface WallCamerasProps {
  /** Whether Security and Cameras are both open to this viewer; null until the wall's modules read has answered. */
  allowed: boolean | null;
  /** /security/health says no camera system is set up (`camera_ingest: not_configured`). */
  noCameraSystem: boolean;
  /** This viewer's cameras (GET /api/cameras); null until the list answers. */
  cameras: CameraInfo[] | null;
  /** The list's latest attempt failed. */
  listFailed: boolean;
  /** The wall's render clock (epoch ms): a tile's age is judged against it. */
  now: number;
  /** Formats a time for the wall (with the day when it is not today). */
  time: (ms: number) => string;
}

/** A camera that is turned off or not sending pictures: never asked, never drawn with a picture. */
function notSending(c: CameraInfo): "off" | "not_sending" | null {
  if (c.enabled === false) return "off";
  if (c.status === "offline" || c.status === "idle") return "not_sending";
  return null;
}

/** An object URL for the picture, revoked when it is replaced or the tile goes. */
function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (blob === null) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}

export type WallTileState = "connecting" | "live" | "stale" | "lost" | "off" | "not_sending";

function WallTile({ camera, now, time }: { camera: CameraInfo; now: number; time: (ms: number) => string }) {
  const quiet = notSending(camera);
  // Not asked when quiet, so no picture at all: SWR has no data for a null key.
  const { picture, failed } = useWallSnapshot(quiet === null ? camera.name : null);
  const src = useObjectUrl(picture?.value ?? null);
  const label = cameraLabelOf(camera);

  const state: WallTileState =
    quiet ?? (picture === null ? (failed ? "lost" : "connecting") : now - picture.at > WALL_TILE_STALE_AFTER_MS ? "stale" : "live");
  const line =
    state === "off"
      ? WALL_COPY.tileOff
      : state === "not_sending"
        ? WALL_COPY.tileNotSending
        : state === "lost"
          ? WALL_COPY.tileLost
          : state === "connecting"
            ? WALL_COPY.tileConnecting
            : state === "stale"
              ? fill(WALL_COPY.tileStale, { time: time(picture!.at) })
              : null;

  return (
    <figure className={state === "stale" ? "sec-wall-tile is-stale" : "sec-wall-tile"} data-state={state} data-camera={camera.name}>
      <div className="sec-wall-tile-frame" aria-busy={state === "connecting"}>
        {src !== null ? (
          <img src={src} alt={fill(WALL_COPY.tileAlt, { camera: label })} />
        ) : (
          state !== "connecting" && <VideoOff size={32} aria-hidden="true" />
        )}
      </div>
      <figcaption>
        <span className="sec-wall-tile-name">{label}</span>
        {line !== null && (
          <span className="sec-wall-tile-state">
            {state === "stale" && (
              <span className="badge warn sec-wall-badge" aria-hidden="true">
                <TriangleAlert size="1em" />
              </span>
            )}
            {line}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

export function WallCameras({ allowed, noCameraSystem, cameras, listFailed, now, time }: WallCamerasProps) {
  if (allowed === true && !noCameraSystem && cameras !== null && cameras.length > 0) {
    const { cols, rows } = tileGrid(cameras.length);
    return (
      <div className="sec-wall-cameras">
        <div className="sec-wall-tiles" style={{ "--cols": cols, "--rows": rows } as CSSProperties}>
          {cameras.map((c) => (
            <WallTile key={c.name} camera={c} now={now} time={time} />
          ))}
        </div>
      </div>
    );
  }

  // One note instead of the tiles.
  const kind =
    allowed === null
      ? "connecting"
      : noCameraSystem
        ? "no-system"
        : allowed === false || cameras?.length === 0
          ? "none"
          : listFailed
            ? "lost"
            : "connecting";
  const busy = kind === "connecting";
  return (
    <div className="sec-wall-cameras" aria-busy={busy} data-state={kind}>
      <div className="sec-wall-cameras-note">
        {!busy && <VideoOff size={40} aria-hidden="true" />}
        <p>
          {kind === "no-system"
            ? FEED_COPY.emptyNoCameras
            : kind === "none"
              ? WALL_COPY.camerasNone
              : kind === "lost"
                ? WALL_COPY.camerasLost
                : WALL_COPY.camerasConnecting}
        </p>
        {kind === "none" && <p className="sec-wall-sub">{WALL_COPY.camerasNoneBody}</p>}
        {kind === "lost" && <p className="sec-wall-sub">{WALL_COPY.camerasLostBody}</p>}
      </div>
    </div>
  );
}
