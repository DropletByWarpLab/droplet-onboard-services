"use client";

/**
 * WARP-2981 (ADR-059 P6, §3.8) — /security/wall: the Security wall for a TV.
 *
 * A tile for each camera the signed-in person may see, above a status strip
 * — the site mode, what needs attention, and which sources are not reporting.
 * Read-only, no navigation (AuthGate renders no shell here), signed in as a
 * Member account — never an owner or admin (D6, Stefan: "Member wall, own
 * cameras"; AuthGate refuses those before this renders): every number and
 * every camera is that person's own DS-005 projection, read from the routes
 * /security and /cameras already use (useSecurityWall). Nothing here writes,
 * and nothing names a person.
 *
 * Built for twelve unattended hours: every read polls and retries on a capped
 * backoff; the strip says when it last heard from Droplet and dims under a
 * banner once that is more than 45 s ago (or the screen is offline) instead of
 * freezing; no value is drawn before its first answer (an em dash, never a 0);
 * each camera tile keeps asking and shows its picture's age once it is old;
 * and in the sign-in's last half hour a banner says the screen will be
 * signed out.
 *
 * Always dark (a TV in a room, often at night): the `.droplet-shell` root sits
 * inside a `.dark` element, so the shell's dark ramp resolves whatever the
 * dashboard's theme. Tokens only (wall.css). Only the two banners are live
 * regions, so a screen reader is not re-read the strip every 15 s. The way
 * out, "Back to Security", is always visible (a phone or an installed app has
 * no other; on a phone the strip comes above the tiles), low-key beside Full
 * screen and first in the tab order.
 */
import "@/components/shell/indigo-tokens.css";
import "@/components/shell/droplet-shell.css";
import "./wall.css";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { useSecurityWall } from "@/lib/hooks/useSecurity";
import { deviceTimeZone, formatSiteWhen } from "@/lib/security-time";
import type { SecurityMode } from "@/lib/types";
import { MODE_BADGE, displayZoneOf, fill, modeReason, staleLine } from "./ModeCard";
import { SOURCE_LABEL, STATE_BADGE } from "./SecurityFeed";
import { WallCameras } from "./WallCameras";
import {
  BEHIND_COPY,
  WALL_COPY,
  WALL_TICK_MS,
  countBehind,
  countLine,
  sessionWarning,
  sourceRows,
  sourcesHeadline,
  wallFreshness,
} from "./wall-status";

export interface SecurityWallProps {
  /** Test seam for "now" (epoch ms); defaults to a clock re-read every WALL_TICK_MS. */
  now?: number;
}

/** `navigator.onLine`, kept current by the browser's online/offline events. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine !== false));
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  return online;
}

function ModeBadge({ mode }: { mode: SecurityMode }) {
  const { cls, text, icon: Icon } = MODE_BADGE[mode];
  return (
    <span className={`${cls} sec-wall-badge`}>
      <Icon size="1em" aria-hidden="true" />
      {text}
    </span>
  );
}

export function SecurityWall({ now: nowProp }: SecurityWallProps) {
  const wall = useSecurityWall();
  const online = useOnline();
  const rootRef = useRef<HTMLElement>(null);

  // The render clock (a UI tick, not a scheduler): staleness, "Updated" and the sign-out warning are re-judged on it.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setClock(Date.now()), WALL_TICK_MS);
    return () => clearInterval(id);
  }, []);
  const now = nowProp ?? clock;

  // Full screen, where the browser offers it.
  const [canFullScreen, setCanFullScreen] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);
  useEffect(() => {
    setCanFullScreen(Boolean(document.fullscreenEnabled));
    const update = () => setIsFullScreen(document.fullscreenElement !== null && document.fullscreenElement !== undefined);
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullScreen = () => {
    const done = document.fullscreenElement ? document.exitFullscreen() : rootRef.current?.requestFullscreen();
    void Promise.resolve(done).catch(() => {
      /* refused (no user gesture, or a kiosk browser without it): the page still works */
    });
  };

  const freshness = wallFreshness(wall.lastOkAt, wall.failed, online, now);
  const dimmed = freshness.state === "stale" || freshness.state === "offline";
  const zone = (wall.mode ? displayZoneOf(wall.mode) : deviceTimeZone()) ?? undefined;
  // With the day when it is not today: an outage can cross midnight.
  const time = (ms: number) => formatSiteWhen(new Date(ms), zone as string, new Date(now));

  const sources = wall.sources;
  const cameraIngest = sources?.find((r) => r.id === "camera_ingest") ?? null;
  const siteModeRow = sources?.find((r) => r.id === "site_mode") ?? null;
  const behind = sources ? countBehind(sources) : null;
  const notReporting = sources ? sourceRows(sources).filter((r) => r.state !== "ok") : [];

  return (
    <div className="dark">
      <main id="main" tabIndex={-1} ref={rootRef} className="droplet-shell sec-wall" aria-labelledby="sec-wall-h">
        <h1 id="sec-wall-h" className="sr-only">
          {WALL_COPY.heading}
        </h1>

        <div className="sec-wall-banners">
          {dimmed && (
            <div className="sec-wall-banner" role="status" aria-live="polite" data-banner={freshness.state}>
              {/* The warning mark /security's ModeCard puts on its stale line: this is not the neutral sign-out notice. */}
              <span className="badge warn sec-wall-badge" aria-hidden="true">
                <TriangleAlert size="1em" />
              </span>
              <span className="sec-wall-banner-text">
                <strong>{freshness.state === "offline" ? WALL_COPY.offlineTitle : WALL_COPY.staleTitle}</strong>
                <span>
                  {freshness.updatedAt === null
                    ? WALL_COPY.staleNeverBody
                    : fill(freshness.state === "offline" ? WALL_COPY.offlineBody : WALL_COPY.staleBody, { time: time(freshness.updatedAt) })}
                </span>
              </span>
            </div>
          )}
          {wall.signInEndsAt !== null && sessionWarning(wall.signInEndsAt, now) && (
            <div className="sec-wall-banner" role="status" aria-live="polite" data-banner="sign-out">
              <span>{fill(WALL_COPY.signOutSoon, { time: time(Date.parse(wall.signInEndsAt)) })}</span>
            </div>
          )}
        </div>

        <section aria-label={WALL_COPY.stripLabel} className={dimmed ? "sec-wall-strip is-stale" : "sec-wall-strip"}>
          <dl>
            <div className="sec-wall-cell" data-cell="mode">
              <dt>{WALL_COPY.modeLabel}</dt>
              <dd>
                {wall.mode ? (
                  <>
                    <ModeBadge mode={wall.mode.mode} />
                    {/* setBy: null — a person's name never goes on a room-facing screen. */}
                    <span className="sec-wall-sub">{modeReason({ ...wall.mode, setBy: null }, new Date(now))}</span>
                    {wall.mode.stale && <span className="sec-wall-sub">{staleLine(siteModeRow, wall.mode, new Date(now))}</span>}
                  </>
                ) : (
                  <span className="sec-wall-value">{wall.failed.mode ? WALL_COPY.modeUnknown : WALL_COPY.unknownValue}</span>
                )}
              </dd>
            </div>

            <div className="sec-wall-cell" data-cell="attention">
              <dt>{WALL_COPY.attentionLabel}</dt>
              <dd>
                {wall.counts ? (
                  <>
                    <span className="sec-wall-value">{wall.counts.openAlerts + wall.counts.openNotices}</span>
                    {wall.counts.openAlerts > 0 && (
                      <span className="badge danger sec-wall-badge">
                        {countLine(wall.counts.openAlerts, WALL_COPY.alertsOne, WALL_COPY.alertsMany)}
                      </span>
                    )}
                    {behind && <span className="sec-wall-sub">{BEHIND_COPY[behind]}</span>}
                  </>
                ) : (
                  <span className="sec-wall-value">{WALL_COPY.unknownValue}</span>
                )}
              </dd>
            </div>

            <div className="sec-wall-cell" data-cell="sources">
              <dt>{WALL_COPY.sourcesLabel}</dt>
              <dd>
                {sources ? (
                  <>
                    <span className="sec-wall-value sm">{sourcesHeadline(sources)}</span>
                    {notReporting.length > 0 && (
                      <ul className="sec-wall-sources">
                        {notReporting.map((r) => (
                          <li key={r.id}>
                            <span>{SOURCE_LABEL[r.id] ?? WALL_COPY.otherSource}</span>
                            <span className={`${STATE_BADGE[r.state]?.cls ?? "badge muted"} sec-wall-badge`}>
                              {STATE_BADGE[r.state]?.text ?? WALL_COPY.unknownValue}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                ) : (
                  <span className="sec-wall-value">{WALL_COPY.unknownValue}</span>
                )}
              </dd>
            </div>

            <div className="sec-wall-cell" data-cell="updated">
              <dt>{WALL_COPY.updatedLabel}</dt>
              <dd>
                <span className="sec-wall-value sm">{freshness.updatedAt === null ? WALL_COPY.waiting : time(freshness.updatedAt)}</span>
                <Link href="/security" className="btn sm ghost sec-wall-leave">
                  {WALL_COPY.leave}
                </Link>
                {canFullScreen && (
                  <button type="button" className="btn sm sec-wall-full" onClick={toggleFullScreen}>
                    {isFullScreen ? WALL_COPY.exitFullScreen : WALL_COPY.fullScreen}
                  </button>
                )}
              </dd>
            </div>
          </dl>
        </section>

        {/* After the banners and the strip in the page, so a screen reader reaches them and the way out before every camera's
            name; a TV draws the tiles above them (wall.css), a phone shows this order. */}
        <WallCameras
          allowed={wall.access === null ? null : wall.access.security && wall.access.cameras}
          noCameraSystem={cameraIngest?.state === "not_configured"}
          cameras={wall.cameras.list}
          listFailed={wall.cameras.failed}
          now={now}
          time={time}
        />
      </main>
    </div>
  );
}
