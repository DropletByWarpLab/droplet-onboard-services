"use client";

import Link from "next/link";
import { AlertTriangle, ArrowRight, HardDrive } from "lucide-react";
import { useRecordingStorage } from "@/lib/hooks/useRecordingStorage";
import { formatBinaryBytes } from "@/lib/format-bytes";
import {
  RECORDING_STORAGE_HREF,
  formatRate,
  recordingsDriveName,
} from "@/lib/recording-storage";
import type { CameraOverAllocation, RecordingStorage } from "@/lib/types";
import "./recording-storage.css";

/**
 * WARP-3515 — where THIS camera records, on /cameras/[name]/settings.
 *
 * The retention sliders and the storage budget on that page decide how long
 * footage is KEPT; which drive it lands on, and how much of it is set aside, is
 * Droplet's to allocate (ADR-070, docs/ADR-070-camera-recording-storage.md).
 * This note sits in the budget card and puts the two side by side: the
 * recording drive and its mode, this camera's rate and its need for the
 * retention window, and a link to the Recording storage card where the owner's
 * choices live.
 *
 * It is silent, not apologetic, when there is nothing to say: while loading, on
 * a fetch error, on an orchestrator that does not have the endpoint yet, and
 * for a role that may not read it, it renders nothing at all — a settings page
 * must not grow a placeholder or an error because an unrelated surface is
 * missing.
 */
export function CameraRecordingNote({ camera }: { camera: string }) {
  const { state, recording, stale } = useRecordingStorage();
  if (state !== "ready" || stale || !recording) return null;

  const drive = recordingsDriveName(recording.drive);
  const row = recording.cameras.find((c) => c.name === camera);

  return (
    <div
      className="rs-camera-note"
      role="group"
      aria-label="Where this camera records"
    >
      <DriveLine r={recording} drive={drive} />

      {hasLiveDrive(recording) &&
        (row && row.gbPerDay > 0 ? (
          <p className="rs-camera-note-d">
            About <b>{formatRate(row.gbPerDay)} GB</b> a day
            {recording.retentionKnown === false ? (
              <> &middot; Recording space estimate unavailable while waiting for recording retention settings.</>
            ) : (
              <> &middot; needs about <b>{formatBinaryBytes(row.needBytes)}</b> for its retention window</>
            )}
          </p>
        ) : (
          <p className="rs-camera-note-d">
            {recording.retentionKnown === false
              ? "Recording space estimate unavailable while waiting for recording retention settings."
              : "This camera hasn't been measured yet. Droplet sizes its space once it has recorded for a while."}
          </p>
        ))}

      <Link className="rs-camera-note-link" href={RECORDING_STORAGE_HREF}>
        See Recording storage
        <ArrowRight size={13} aria-hidden="true" />
      </Link>
    </div>
  );
}

/** A drive that is actually there to record to (named, connected, chosen). */
function hasLiveDrive(r: RecordingStorage): boolean {
  return (
    r.drive !== null &&
    r.status !== "missing" &&
    r.status !== "no_eligible_drive" &&
    r.status !== "on_system_disk"
  );
}

function DriveLine({ r, drive }: { r: RecordingStorage; drive: string }) {
  if (r.status === "no_eligible_drive") {
    return (
      <p className="rs-camera-note-t">
        <HardDrive size={14} aria-hidden="true" />
        No recording drive is set up yet.
      </p>
    );
  }
  if (r.status === "on_system_disk") {
    return (
      <p className="rs-camera-note-t">
        <HardDrive size={14} aria-hidden="true" />
        Recordings are on the system drive right now.
      </p>
    );
  }
  if (r.status === "missing") {
    return (
      <p className="rs-camera-note-t">
        <HardDrive size={14} aria-hidden="true" />
        The recording drive isn&apos;t connected.
      </p>
    );
  }
  return (
    <>
      <p className="rs-camera-note-t">
        <HardDrive size={14} aria-hidden="true" />
        <span>
          Recording drive: <b>{drive}</b>
          {r.mode ? <> &middot; {r.mode === "full" ? "Whole drive" : "Auto-sized"}</> : null}
        </span>
      </p>
      {r.status === "migrating" && (
        <p className="rs-camera-note-d">Recordings are being moved to this drive now.</p>
      )}
    </>
  );
}

/**
 * The budgets, summed, against the volume that has to hold them.
 *
 * `GET /cameras/:name/budget` has always returned `overAllocation` — an advisory,
 * because budgets are targets and the oldest footage is evicted first — but the
 * dashboard type never carried it, so an owner who had promised 3 TB across a
 * 2 TB drive was never told. Silent unless the sum really exceeds a real
 * capacity: `null` (unknown) and `overAllocated: false` render nothing, and a
 * malformed advisory is dropped rather than printed as NaN.
 */
export function OverAllocationNote({
  overAllocation,
}: {
  overAllocation?: CameraOverAllocation | null;
}) {
  if (!overAllocation?.overAllocated) return null;
  const { allocatedBytes, capacityBytes } = overAllocation;
  const usable = (n: number) => Number.isFinite(n) && n > 0;
  if (!usable(allocatedBytes) || !usable(capacityBytes)) return null;
  return (
    <p className="rs-over" data-testid="over-allocation-warning">
      <AlertTriangle size={15} className="rs-over-ic" aria-hidden="true" />
      <span>
        Camera budgets add up to <b>{formatBinaryBytes(allocatedBytes)}</b>, but the
        drive holds <b>{formatBinaryBytes(capacityBytes)}</b>. When it fills, the oldest
        footage is deleted first, so a camera may keep fewer days than its budget
        suggests.
      </span>
    </p>
  );
}
