"use client";

import { useState } from "react";
import { Check, Loader2, Radar, RefreshCw, Video, X } from "lucide-react";
import type { CameraCandidateStatus, DiscoveredCamera } from "@/lib/types";

/**
 * "Available on your network" — what a discovery sweep actually found
 * (WARP-1847).
 *
 * This replaces the old CameraDiscoveryBanner, which could only render cameras
 * that had already been auto-added AND written to the DB as `enabled: false` — a
 * combination nothing produced, so it never appeared. The list an operator wants
 * is the one camera-discovery holds: every device it found, including the ones it
 * can see but can't stream yet, which is most real cameras on first contact.
 *
 * Three states have to be distinguishable, because the next action differs:
 *   - candidates found        → pick one and add it
 *   - swept, found nothing    → check cabling / power, sweep again
 *   - discovery not running   → nothing is looking; that's a service problem
 */

interface NetworkCameraListProps {
  cameras: DiscoveredCamera[];
  /** False when the camera-discovery service couldn't be reached at all. */
  discoveryOnline: boolean;
  scanning: boolean;
  /** Null until the operator has run a sweep this session. */
  lastScan: { at: number; found: number } | null;
  onScan: () => void;
  onAccept: (camera: DiscoveredCamera) => Promise<void> | void;
  onReject: (camera: DiscoveredCamera) => Promise<void> | void;
  /** Hand a camera we can't stream to the manual RTSP form, prefilled. */
  onEnterCredentials: (camera: DiscoveredCamera) => void;
}

const STATUS_COPY: Record<
  CameraCandidateStatus,
  { label: string; tone: string; hint: string }
> = {
  ready: {
    label: "Ready to add",
    tone: "var(--success)",
    hint: "We can reach this camera's video stream.",
  },
  needs_credentials: {
    label: "Needs sign-in",
    tone: "var(--brand)",
    hint: "This is a camera, but its video needs a username and password.",
  },
  unverified: {
    label: "Not confirmed",
    tone: "var(--text-muted)",
    hint: "Something answered on a camera port — we haven't reached video yet.",
  },
};

function statusOf(camera: DiscoveredCamera): CameraCandidateStatus {
  return camera.status ?? "unverified";
}

function subtitle(camera: DiscoveredCamera): string {
  const parts = [camera.ip, camera.manufacturer, camera.model].filter(Boolean);
  return parts.join(" · ");
}

export function NetworkCameraList({
  cameras,
  discoveryOnline,
  scanning,
  lastScan,
  onScan,
  onAccept,
  onReject,
  onEnterCredentials,
}: NetworkCameraListProps) {
  // Per-row spinner keyed by camera id: adding one camera must not lock the
  // whole list, and a slow accept (the stream is verified upstream first) needs
  // visible feedback on the row the operator clicked.
  const [busyId, setBusyId] = useState<string | null>(null);

  async function run(camera: DiscoveredCamera, action: (c: DiscoveredCamera) => Promise<void> | void) {
    setBusyId(camera.id);
    try {
      await action(camera);
    } finally {
      setBusyId(null);
    }
  }

  const scanButton = (
    <button onClick={onScan} disabled={scanning} className="btn sm" type="button">
      {scanning ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <RefreshCw size={14} />
      )}
      {scanning ? "Scanning…" : "Scan again"}
    </button>
  );

  if (cameras.length === 0) {
    // Nothing to list — say which kind of nothing it is.
    return (
      <div className="card mb-6">
        <div className="empty" style={{ padding: "34px 20px" }}>
          <span className="ei">
            <Radar size={24} className={scanning ? "animate-pulse" : ""} />
          </span>
          <span className="eh">
            {scanning
              ? "Looking for cameras…"
              : !discoveryOnline
                ? "Camera discovery isn't running"
                : lastScan
                  ? "No cameras found on your network"
                  : "Nothing found yet"}
          </span>
          <span style={{ maxWidth: "46ch" }}>
            {scanning ? (
              "Checking every address on your camera network for a video stream. This takes a few seconds."
            ) : !discoveryOnline ? (
              "The service that looks for cameras isn't responding, so nothing is being scanned. It usually starts with the rest of your Droplet — restarting the appliance is the quickest fix."
            ) : lastScan ? (
              "Make sure the camera has power and is plugged into your Droplet's network (or joined its Wi-Fi), then scan again. Cameras can take a minute to come up after powering on."
            ) : (
              "Scan your network and any cameras we can see will be listed here."
            )}
          </span>
          {!scanning && discoveryOnline && (
            <div style={{ marginTop: 8 }}>
              <button onClick={onScan} className="btn primary" type="button">
                <Radar size={16} />
                Scan network
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="card mb-6">
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <Radar size={18} style={{ color: "var(--brand)" }} className={scanning ? "animate-pulse" : ""} />
          <span className="type-subheadline font-medium" style={{ color: "var(--text)" }}>
            Available on your network
          </span>
          <span className="type-caption-1" style={{ color: "var(--text-muted)" }}>
            {cameras.length} found
          </span>
        </div>
        {scanButton}
      </div>

      <ul className="space-y-2" style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {cameras.map((cam) => {
          const status = statusOf(cam);
          const copy = STATUS_COPY[status];
          const busy = busyId === cam.id;
          const label = cam.displayName || cam.name.replace(/_/g, " ");
          return (
            <li
              key={cam.id}
              className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5 flex-wrap"
              style={{ background: "var(--surface)", border: "1px solid var(--border)" }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <span
                  className="flex items-center justify-center flex-shrink-0"
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 10,
                    background: "var(--brand-subtle)",
                    color: "var(--brand)",
                  }}
                >
                  <Video size={16} />
                </span>
                <div className="min-w-0">
                  <p className="type-footnote font-medium truncate" style={{ color: "var(--text)" }}>
                    {label}
                  </p>
                  <p className="type-caption-2 truncate" style={{ color: "var(--text-muted)" }}>
                    {subtitle(cam)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0 ml-auto">
                <span
                  className="type-caption-2 inline-flex items-center gap-1.5 px-2 py-1"
                  style={{
                    borderRadius: "var(--radius-pill)",
                    border: "1px solid var(--border)",
                    color: copy.tone,
                  }}
                  title={copy.hint}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: "50%",
                      background: copy.tone,
                      display: "inline-block",
                    }}
                  />
                  {copy.label}
                </span>

                {status === "ready" ? (
                  <button
                    onClick={() => run(cam, onAccept)}
                    disabled={busy}
                    className="btn primary sm"
                    type="button"
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                    Add
                  </button>
                ) : (
                  // Not streamable yet: camera-discovery has no accept-with-
                  // credentials API, so the honest next step is the manual form
                  // with everything we already know filled in.
                  <button
                    onClick={() => onEnterCredentials(cam)}
                    className="btn sm"
                    type="button"
                  >
                    Set up
                  </button>
                )}

                <button
                  onClick={() => run(cam, onReject)}
                  disabled={busy}
                  className="icon-btn"
                  type="button"
                  aria-label={`Ignore ${label}`}
                  title="Ignore — stop offering this device"
                >
                  <X size={16} />
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="type-caption-2 mt-3" style={{ color: "var(--text-muted)" }}>
        {cameras.some((c) => statusOf(c) === "needs_credentials")
          ? "“Needs sign-in” cameras are real cameras we can see but can't watch yet — open Set up to enter the camera's username and password."
          : "Don't recognise a device? Ignore it and it won't be offered again."}
      </p>
    </div>
  );
}
