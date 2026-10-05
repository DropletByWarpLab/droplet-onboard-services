"use client";

import { useMemo, type ReactNode } from "react";
import { Shield } from "lucide-react";
import { useRecordingsSummary } from "@/lib/hooks/useRecordings";
import {
  MODE_CHIP_LABEL,
  MODE_SENTENCE,
  describeLastSaved,
  describeRetention,
  formatBytesPerDay,
  formatDays,
  formatSavedAgo,
  formatStorageBytes,
  formatStoredDays,
  isRecordingDegraded,
  summarizeStoredFootage,
} from "@/lib/camera-recording";
import type { CameraInfo } from "@/lib/types";
import { CameraRelatedLinks, type CameraRelatedPage } from "./CameraRelatedLinks";
import { CameraServiceNotice } from "./CameraServiceNotice";
import { RetentionFixButton } from "./RetentionFixButton";

/**
 * WARP-3511 — the answer to "is this camera keeping footage, and how much?",
 * in one block.
 *
 * It shows the mode, what each open window keeps, when something last landed
 * on disk, how much there is and how fast it grows, and how far back it goes.
 * Every figure comes from the camera's own reading — no day count is written
 * into the copy — and one the box could not give is a dash, never a zero.
 *
 * Two surfaces, one component: the always-dark detail rail
 * (`appearance="rail"`) and a card at the top of the settings page
 * (`appearance="card"`).
 *
 * It does not claim anything it cannot back. While the camera service is
 * unreadable it says so instead of describing a camera it knows nothing about,
 * and a box that does not report a recording block gets a plain sentence.
 */
export function CameraRecordingSummary({
  camera,
  appearance,
  current,
  canManage,
  cameras,
  title = "Recording",
  onRepaired,
}: {
  camera: CameraInfo;
  appearance: "rail" | "card";
  current: CameraRelatedPage;
  /** Owner / admin: may open Settings and repair a camera that is not saving. */
  canManage: boolean;
  /** For household names in the repair dialog. */
  cameras?: ReadonlyArray<Pick<CameraInfo, "name" | "displayName">>;
  title?: string;
  /** Called after the retention repair was applied. */
  onRepaired?: () => void;
}) {
  const rec = camera.recording;
  const degraded = isRecordingDegraded(camera);

  // How far back there is real footage. The Recordings page reads the same
  // summary under the same SWR key, so opening it from here is instant. Not
  // asked for while the service cannot be read.
  const summary = useRecordingsSummary(degraded || !rec ? null : camera.name);
  const stored = useMemo(() => summarizeStoredFootage(summary.days), [summary.days]);

  const rail = appearance === "rail";
  const cls = rail
    ? {
        root: "space-y-2",
        heading: "type-caption-1 text-white/60 uppercase tracking-wide",
        label: "type-caption-2 text-white/60",
        value: "type-footnote text-white",
        muted: "type-footnote text-white/60",
      }
    : {
        root: "card space-y-3 lg:col-span-2",
        heading: "type-headline text-[var(--text)]",
        label: "type-caption-1 text-[var(--text-muted)]",
        value: "type-subheadline text-[var(--text)]",
        muted: "type-subheadline text-[var(--text-muted)]",
      };

  // Orange text is only legible on the page's own tint (the shell darkens it
  // there), so a warning is always a pill, never bare orange on a card.
  const warnPill = "text-system-orange bg-system-orange/10 px-1.5 py-0.5 rounded-full";
  const chipStyle = rail ? "bg-white/10 text-white px-1.5 py-0.5 rounded" : "px-1.5 py-0.5 rounded";

  const rows: Array<{ label: string; value: ReactNode }> = [];
  if (rec && !degraded && rec.mode) {
    const saved = describeLastSaved(camera);
    const off = rec.mode === "off";
    const retention = describeRetention(rec);

    rows.push({
      label: "Mode",
      value: (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span
            data-testid="recording-mode"
            className={off ? warnPill : chipStyle}
            style={off || rail ? undefined : { background: "var(--inset)", color: "var(--text)" }}
          >
            {MODE_CHIP_LABEL[rec.mode]}
          </span>
          <span>{MODE_SENTENCE[rec.mode]}</span>
        </span>
      ),
    });
    rows.push({
      label: "Keeps",
      value: off ? (
        <span>Nothing</span>
      ) : (
        <ul data-testid="recording-retention">
          {retention.map((w) => (
            <li key={w.key}>
              {w.label}: {formatDays(w.days)}
            </li>
          ))}
        </ul>
      ),
    });
    rows.push({
      label: "Last saved",
      value: !saved ? (
        <span>—</span>
      ) : (
        <span className={saved.tone === "warn" ? warnPill : ""}>
          {rec.lastSegmentAt ? formatSavedAgo(rec.lastSegmentAt) : saved.text}
        </span>
      ),
    });
    rows.push({
      label: "Used",
      value: <span>{rec.usedBytes === null ? "—" : formatStorageBytes(rec.usedBytes)}</span>,
    });
    rows.push({
      label: "Writing",
      value: <span>{rec.bytesPerDay === null ? "—" : formatBytesPerDay(rec.bytesPerDay)}</span>,
    });
    rows.push({
      label: "Stored",
      value: (
        <span>
          {stored
            ? `${formatStoredDays(stored.days)} · since ${stored.since.toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}`
            : summary.isLoading
              ? "…"
              : "—"}
        </span>
      ),
    });
  }

  const notSaving = !degraded && rec?.mode === "off";

  return (
    <section aria-label="Recording" data-testid="camera-recording-summary" className={cls.root}>
      {rail ? (
        <h2 className={cls.heading}>{title}</h2>
      ) : (
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-[var(--brand)]" aria-hidden="true" />
          <h2 className={cls.heading}>{title}</h2>
        </div>
      )}

      {degraded ? (
        <CameraServiceNotice appearance={rail ? "dark" : "card"} />
      ) : !rec ? (
        <p className={cls.muted}>This box doesn&apos;t report recording details yet.</p>
      ) : (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 items-baseline">
          {rows.map((r) => (
            <div key={r.label} className="contents">
              <dt className={cls.label}>{r.label}</dt>
              <dd className={cls.value}>{r.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {notSaving && (
        <div className="flex flex-wrap items-center gap-2" data-testid="recording-not-saving">
          <span className={rail ? "type-caption-1 text-white/80" : "type-caption-1 text-[var(--text-muted)]"}>
            {canManage
              ? "Nothing is being saved, so there will be nothing to look back at."
              : "Nothing is being saved. Ask an owner or admin to turn recording on."}
          </span>
          {canManage && (
            <RetentionFixButton
              cameraName={camera.name}
              cameras={cameras}
              onDone={onRepaired}
              appearance={rail ? "dark" : "card"}
            />
          )}
        </div>
      )}

      <CameraRelatedLinks
        camera={camera.name}
        current={current}
        canManage={canManage}
        appearance={rail ? "rail" : "card"}
      />
    </section>
  );
}
