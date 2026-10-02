"use client";

/**
 * WARP-2980 (ADR-059 P5 §8) — /security/patterns, titled "Patterns".
 *
 * What normal looks like for each area and camera, learned from the last four
 * weeks, and how far along Droplet is with each camera — and (WARP-2980
 * PR-B) the expected activity people have taught it, and how often each
 * kind of flag was right.
 *
 *   1. the status line — the `patterns` row of the /security health header,
 *      verbatim; plus the trial sentence while any flag is in trial (the ok
 *      row already carries it);
 *   2. Learning (`LearningList`) — every camera the viewer may see;
 *   3. What's usual (`UsualGrid`) — once the first nightly build exists;
 *   4. Expected activity (`ExpectedActivityCard`) — every state with a site
 *      zone; Add and Remove only when route 32's `canManage` says so;
 *   5. How often Droplet was right (`PrecisionCard`) — only when route 29
 *      sends `precision` (owner/admin).
 *
 * Every reader sees it (routes 29/30 are view-level for every household
 * role); the server has already applied DS-005 to every key and number, so
 * the page never filters. Lives under /security so the nav-derived route
 * guard gates it with the rest of the module.
 */
import { useMemo } from "react";
import Link from "next/link";
import { Activity, CalendarClock, Clock, Loader2, RefreshCw, Video } from "lucide-react";
import { ShellPage } from "@/components/shell/ShellPage";
import { ExpectedActivityCard } from "@/components/security/ExpectedActivityCard";
import { LearningList } from "@/components/security/LearningList";
import { PrecisionCard } from "@/components/security/PrecisionCard";
import { UsualGrid } from "@/components/security/UsualGrid";
import { COPY } from "@/components/security/patterns-copy";
import { translateError } from "@/lib/friendly-errors";
import { useSecurityCameras, useSecurityHealth, useSecurityPatterns } from "@/lib/hooks/useSecurity";

export default function SecurityPatternsPage() {
  const { overview, error, mutate } = useSecurityPatterns();
  const { sources: health } = useSecurityHealth();
  const { cameras } = useSecurityCameras();
  // translateError logs the raw cause; once per error, not per render.
  const errorCopy = useMemo(() => (error ? translateError(error, "security") : null), [error]);
  const now = new Date();

  const status = health?.find((r) => r.id === "patterns") ?? null;
  const trial = overview ? Object.values(overview.release).some((r) => r === "trial") : false;
  const showTrial = trial && status?.state !== "ok";

  let body;
  if (!overview && errorCopy) {
    body = (
      <div className="card">
        <div className="empty" role="alert">
          <span className="ei">
            <Activity size={24} />
          </span>
          <span style={{ maxWidth: "44ch" }}>{errorCopy}</span>
          <button type="button" className="btn" onClick={() => void mutate()} style={{ marginTop: 8 }}>
            <RefreshCw size={16} aria-hidden />
            {COPY.retry}
          </button>
        </div>
      </div>
    );
  } else if (!overview) {
    body = (
      <div className="card">
        <div className="empty" data-testid="patterns-loading" aria-busy="true">
          <Loader2 size={20} className="animate-spin" aria-hidden />
        </div>
      </div>
    );
  } else if (overview.state === "not_configured" && overview.reason === "no_timezone") {
    body = (
      <div className="card">
        <div className="empty">
          <span className="ei">
            <Clock size={24} />
          </span>
          <span style={{ maxWidth: "44ch" }}>{COPY.noTimezone}</span>
          <Link href="/security/settings" className="btn" style={{ marginTop: 8 }}>
            {COPY.setHours}
          </Link>
        </div>
      </div>
    );
  } else {
    const cameraList = cameras ?? [];
    const hasLearning = overview.sources.length > 0 || cameraList.length > 0;
    body = (
      <div style={{ display: "grid", gap: 14 }}>
        {(status || showTrial) && (
          <div className="card" data-testid="patterns-status">
            {status && <p style={{ margin: 0, fontSize: 13.5, color: "var(--text)", overflowWrap: "anywhere" }}>{status.detail}</p>}
            {showTrial && (
              <p style={{ margin: status ? "6px 0 0" : 0, fontSize: 12.5, color: "var(--text-muted)" }}>{COPY.trial}</p>
            )}
          </div>
        )}

        {overview.state === "not_configured" && overview.reason === "no_cameras" && (
          <div className="card">
            <div className="empty">
              <span className="ei">
                <Video size={24} />
              </span>
              <span className="eh">{COPY.noCamerasTitle}</span>
              <span style={{ maxWidth: "44ch" }}>{COPY.noCameras}</span>
            </div>
          </div>
        )}

        {hasLearning && (
          <section className="card" aria-labelledby="patterns-learning">
            <div className="card-h">
              <span className="ci">
                <CalendarClock size={16} />
              </span>
              <h2 className="ct" id="patterns-learning" style={{ margin: 0 }}>
                {COPY.learningTitle}
              </h2>
            </div>
            <p style={{ margin: "0 0 10px", fontSize: 12.5, color: "var(--text-muted)" }}>{COPY.learningHint}</p>
            <LearningList sources={overview.sources} cameras={cameraList} timezone={overview.timezone} now={now} />
          </section>
        )}

        {overview.sources.length > 0 && (
          <section className="card" aria-labelledby="patterns-usual">
            <div className="card-h">
              <span className="ci">
                <Activity size={16} />
              </span>
              <h2 className="ct" id="patterns-usual" style={{ margin: 0 }}>
                {COPY.usualTitle}
              </h2>
            </div>
            {overview.state === "ready" ? (
              <>
                <p style={{ margin: "0 0 14px", fontSize: 12.5, color: "var(--text-muted)" }}>{COPY.usualHint}</p>
                <UsualGrid keys={overview.keys} />
              </>
            ) : (
              <p className="usual-empty">{COPY.notBuilt}</p>
            )}
          </section>
        )}

        <ExpectedActivityCard overview={overview} now={now} />
        {overview.precision !== null && overview.timezone !== null && (
          <PrecisionCard precision={overview.precision} timezone={overview.timezone} now={now} />
        )}
      </div>
    );
  }

  return (
    <ShellPage icon={<Activity size={15} />} label="Security" title={COPY.title} sub={COPY.sub}>
      {body}
    </ShellPage>
  );
}
