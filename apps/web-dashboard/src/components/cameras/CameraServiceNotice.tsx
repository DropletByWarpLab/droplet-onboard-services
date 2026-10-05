"use client";

import Link from "next/link";
import { Loader2 } from "lucide-react";

/**
 * WARP-3511 — what every camera surface shows while the camera service cannot
 * be read: a settings save restarts it for a few seconds, and it can simply be
 * down.
 *
 * Without this the grid read "Offline" on every tile for those seconds, and
 * the settings page kept a red error. Neither was true — the cameras were
 * fine; the box just could not say. So this says what is known (the service is
 * not answering, and it usually comes back on its own) and where to look if it
 * does not. It makes no claim about recording either way.
 *
 * `appearance="dark"` is for the always-dark camera detail screen; `"card"` is
 * for the indigo shell pages (light and dark themes).
 */
export function CameraServiceNotice({
  appearance = "card",
  className = "",
}: {
  appearance?: "card" | "dark";
  className?: string;
}) {
  const dark = appearance === "dark";
  return (
    <div
      role="status"
      data-testid="camera-service-notice"
      className={`flex items-start gap-2.5 ${
        dark
          ? "px-4 sm:px-6 py-2 bg-white/10 border-b border-white/15"
          : "card"
      } ${className}`}
      style={dark ? undefined : { padding: "12px 16px" }}
    >
      <Loader2
        size={14}
        aria-hidden="true"
        className={`mt-0.5 shrink-0 animate-spin ${dark ? "text-white/70" : ""}`}
        style={dark ? undefined : { color: "var(--text-muted)" }}
      />
      <p
        className={`type-caption-1 ${dark ? "text-white/80" : ""}`}
        style={dark ? undefined : { color: "var(--text-muted)" }}
      >
        <strong className={dark ? "text-white" : ""} style={dark ? undefined : { color: "var(--text)" }}>
          Camera service restarting…
        </strong>{" "}
        Status and recording details return in a few seconds. If this lasts more
        than a minute, check{" "}
        <Link href="/cameras/system" className="underline underline-offset-2">
          Camera system
        </Link>
        .
      </p>
    </div>
  );
}
