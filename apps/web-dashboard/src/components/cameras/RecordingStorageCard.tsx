"use client";

import { useId, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  ArrowRight,
  HardDrive,
  Loader2,
  Lock,
  LockOpen,
  Trash2,
} from "lucide-react";
import { deleteOldRecordings, updateRecordingStorage } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useRecordingStorage } from "@/lib/hooks/useRecordingStorage";
import { formatBinaryBytes } from "@/lib/format-bytes";
import {
  RECORDING_STORAGE_ANCHOR,
  SETTINGS_STORAGE_HREF,
  cameraNeedShares,
  describeWarning,
  formatRate,
  friendlyRecordingStorageError,
  recordingStatusView,
  recordingsDriveName,
  type WarningFix,
} from "@/lib/recording-storage";
import type { RecordingStorage, RecordingStorageMode } from "@/lib/types";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DestructiveConfirm } from "@/components/settings/DestructiveConfirm";
import { SafetyChip } from "@/components/email/SafetyChip";
import { Badge, Meter } from "@/components/shell/primitives";
import "./recording-storage.css";

/**
 * WARP-3515 — "Recording storage" on /cameras/system.
 *
 * ADR-070 (WARP-3512): Droplet measures what each camera writes, sizes a
 * slice of an encrypted bay drive for the retention window, and allocates it
 * itself. This card is where an owner SEES that — which drive, how much is set
 * aside, what is used, what each camera needs, any move in flight, anything
 * wrong — and makes the two choices that stay theirs: auto-sized slice vs whole
 * drive, and which eligible drive. Both are tier-2 writes (a confirm that names
 * the consequence); deleting the old recordings left on the system drive is
 * tier-3 (the owner types a phrase).
 *
 * The orchestrator side lands in WARP-3514, separately from this dashboard, so
 * the card has an honest state for an orchestrator that does not have the
 * endpoint yet ("not available on this Droplet yet" — never an error, never a
 * crash) and hides itself entirely for a role that may not read it.
 *
 * The data hook, the auth role and the API writes are the card's only inputs;
 * every number it prints is derived from the normalised `RecordingStorage`.
 */
export function RecordingStorageCard({ style }: { style?: CSSProperties } = {}) {
  const { state, recording, refresh } = useRecordingStorage();
  const { user } = useAuth();
  const { toast } = useToast();
  const headingId = useId();
  const pickerRef = useRef<HTMLSelectElement | null>(null);

  // The writes: PUT /storage/recordings is owner/admin; the old-footage delete
  // is owner-only. The server enforces both — this only decides what to offer.
  const canManage = user?.role === "owner" || user?.role === "admin";
  const isOwner = user?.role === "owner";

  // What the tier-2 confirm is currently asking about (null = no dialog).
  const [pending, setPending] = useState<
    | { kind: "mode"; mode: RecordingStorageMode }
    | { kind: "drive"; fsUuid: string; name: string }
    | null
  >(null);
  // The dialogs fade out after `pending` clears; if their copy were derived from
  // `pending` directly it would swap to the fallback wording mid-fade. Remember
  // the last real question and render that until the dialog is gone.
  const lastPending = useRef(pending);
  if (pending) lastPending.current = pending;
  const asked = pending ?? lastPending.current;
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const deleteTriggerRef = useRef<HTMLButtonElement | null>(null);

  // A role that may not read it sees nothing at all — not an empty frame.
  if (state === "forbidden") return null;

  const status = recording ? recordingStatusView(recording.status) : null;

  async function applyMode(mode: RecordingStorageMode) {
    try {
      await updateRecordingStorage({ mode });
      toast(
        mode === "full"
          ? "Recordings can now use the whole drive."
          : "Recordings are back to an auto-sized slice.",
        "success",
      );
      void refresh();
    } catch (err) {
      toast(friendlyRecordingStorageError(err, "mode"), "error");
      // ConfirmDialog stays open on a rejection, so the owner can retry or back out.
      throw err;
    }
  }

  async function applyDrive(fsUuid: string, name: string) {
    try {
      await updateRecordingStorage({ fsUuid });
      toast(`Moving your recordings to ${name}.`, "success");
      void refresh();
    } catch (err) {
      toast(friendlyRecordingStorageError(err, "drive"), "error");
      throw err;
    }
  }

  async function applyDelete() {
    try {
      await deleteOldRecordings();
      setDeleteOpen(false);
      setDeleteError(null);
      toast("Old recordings deleted from the system drive.", "success");
      void refresh();
    } catch (err) {
      // DestructiveConfirm shows this inline and stays open for a retry.
      setDeleteError(friendlyRecordingStorageError(err, "delete-old"));
      throw err;
    }
  }

  const driveName = recordingsDriveName(recording?.drive);

  return (
    <section
      id={RECORDING_STORAGE_ANCHOR}
      data-testid="recording-storage-card"
      aria-labelledby={headingId}
      aria-busy={state === "loading" || undefined}
      className="card rs-card"
      style={style}
    >
      <div className="rs-head">
        <span className="rs-head-ic" aria-hidden="true">
          <HardDrive size={15} />
        </span>
        <h2 id={headingId} className="rs-title">
          Recording storage
        </h2>
        {status && <Badge kind={status.kind}>{status.label}</Badge>}
      </div>

      {state === "loading" && (
        <div aria-hidden="true" className="flex flex-col gap-3 motion-safe:animate-pulse">
          <div className="rs-skel" />
          <div className="rs-skel is-tall" />
        </div>
      )}

      {state === "error" && (
        <div className="flex flex-col items-start gap-3">
          <p className="rs-note">
            Couldn&apos;t load recording storage. Your recordings aren&apos;t affected.
          </p>
          <button type="button" className="btn sm" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}

      {state === "not_supported" && (
        <p className="rs-note">
          Recording storage isn&apos;t available on this Droplet yet. Once it&apos;s
          updated, you&apos;ll see where your camera recordings are kept and how much
          space they have.
        </p>
      )}

      {state === "ready" && recording && (
        <Body
          r={recording}
          driveName={driveName}
          canManage={canManage}
          isOwner={isOwner}
          pickerRef={pickerRef}
          deleteTriggerRef={deleteTriggerRef}
          onPickMode={(mode) => setPending({ kind: "mode", mode })}
          onPickDrive={(fsUuid, name) => setPending({ kind: "drive", fsUuid, name })}
          onRequestDelete={() => {
            setDeleteError(null);
            setDeleteOpen(true);
          }}
        />
      )}

      {recording && (
        <>
          <ConfirmDialog
            open={pending?.kind === "mode"}
            variant="neutral"
            onCancel={() => setPending(null)}
            onConfirm={() =>
              pending?.kind === "mode" ? applyMode(pending.mode) : undefined
            }
            title={
              asked?.kind === "mode" && asked.mode === "auto_reserved"
                ? "Go back to auto-sized?"
                : "Use the whole drive for recordings?"
            }
            description={
              asked?.kind === "mode" && asked.mode === "auto_reserved"
                ? `Droplet will cap recordings at the space your cameras need — about ${formatBinaryBytes(recording.needBytes)} for ${Math.round(recording.retentionDays)} days, plus some headroom — and leave the rest of ${driveName} free. Recordings already using more than that are never deleted early.`
                : `Recordings will be allowed to use all ${formatBinaryBytes(recording.drive?.sizeBytes ?? recording.reservedBytes)} of ${driveName}, not just the space your cameras need. Older recordings are still deleted after ${Math.round(recording.retentionDays)} days. That can leave less room for files stored on this drive.`
            }
            confirmLabel={
              asked?.kind === "mode" && asked.mode === "auto_reserved"
                ? "Switch to auto-sized"
                : "Use whole drive"
            }
            accessory={<SafetyChip safety="Write · confirm" />}
          />

          <ConfirmDialog
            open={pending?.kind === "drive"}
            variant="neutral"
            onCancel={() => setPending(null)}
            onConfirm={() =>
              pending?.kind === "drive"
                ? applyDrive(pending.fsUuid, pending.name)
                : undefined
            }
            title={`Move recordings to ${asked?.kind === "drive" ? asked.name : "this drive"}?`}
            description={`Droplet copies your existing recordings to ${asked?.kind === "drive" ? asked.name : "the new drive"}, then switches over. Cameras keep recording while it copies, with a short pause at the very end. Your current recordings stay where they are until you choose to delete them.`}
            confirmLabel="Move recordings"
            accessory={<SafetyChip safety="Write · confirm" />}
          />

          <DestructiveConfirm
            open={deleteOpen}
            triggerRef={deleteTriggerRef}
            onCancel={() => setDeleteOpen(false)}
            onConfirm={applyDelete}
            title="Delete the old recordings?"
            consequence={`This permanently deletes ${formatBinaryBytes(recording.oldFootage.bytes)} of recordings left on the system drive from before the move. Your recordings on ${driveName} aren't touched. This can't be undone.`}
            affectedSummary={`Old recordings · ${formatBinaryBytes(recording.oldFootage.bytes)} · system drive`}
            confirmPhrase={DELETE_PHRASE}
            confirmLabel="Delete old recordings"
            progressMessage="Deleting — this can take a moment. Keep this open until it finishes."
            errorMessage={deleteError ?? undefined}
          />
        </>
      )}
    </section>
  );
}

/** What the owner types to unlock the tier-3 delete. */
const DELETE_PHRASE = "delete old recordings";

// ─── The ready body ───────────────────────────────────────────────────────

function Body({
  r,
  driveName,
  canManage,
  isOwner,
  pickerRef,
  deleteTriggerRef,
  onPickMode,
  onPickDrive,
  onRequestDelete,
}: {
  r: RecordingStorage;
  driveName: string;
  canManage: boolean;
  isOwner: boolean;
  pickerRef: React.RefObject<HTMLSelectElement | null>;
  deleteTriggerRef: React.RefObject<HTMLButtonElement | null>;
  onPickMode: (mode: RecordingStorageMode) => void;
  onPickDrive: (fsUuid: string, name: string) => void;
  onRequestDelete: () => void;
}) {
  const moving = r.status === "migrating" || r.migration.state === "running";
  const hasDrive = r.drive !== null;
  const noDrive = r.status === "no_eligible_drive";
  const missing = r.status === "missing";
  // Numbers about a drive that is not there (or not chosen) would read as
  // current; show them only when there is a live drive behind them.
  const live = hasDrive && !noDrive && !missing;
  const candidates = r.eligibleDrives.filter((d) => d.fsUuid !== r.drive?.fsUuid);

  const warnings = r.warnings.map((w) =>
    describeWarning(w, {
      mode: r.mode,
      eligibleCount: candidates.length,
      retentionDays: Math.round(r.retentionDays),
    }),
  );

  function runFix(fix: WarningFix) {
    if (fix.kind === "whole_drive") onPickMode("full");
    else if (fix.kind === "pick_drive") pickerRef.current?.focus();
  }

  return (
    <>
      {warnings.length > 0 && (
        <ul className="rs-warnings">
          {warnings.map((w) => (
            <li key={w.code} data-testid={`recording-warning-${w.code}`}>
              <div
                className={`rs-warning is-${w.severity}`}
                role={w.severity === "danger" ? "alert" : undefined}
              >
                <AlertTriangle size={16} className="rs-warning-ic" aria-hidden="true" />
                <div className="rs-warning-tx">
                  <p className="rs-warning-t">{w.title}</p>
                  <p className="rs-warning-d">{w.detail}</p>
                  {w.serverMessage && <p className="rs-warning-m">{w.serverMessage}</p>}
                </div>
                {w.fix &&
                  (w.fix.kind === "link" ? (
                    <Link className="btn sm" href={w.fix.href}>
                      {w.fix.label}
                      <ArrowRight size={14} aria-hidden="true" />
                    </Link>
                  ) : (
                    <button type="button" className="btn sm" onClick={() => runFix(w.fix!)}>
                      {w.fix.label}
                    </button>
                  ))}
              </div>
            </li>
          ))}
        </ul>
      )}

      {noDrive && (
        <div className="empty rs-empty">
          <span className="ei" aria-hidden="true">
            <HardDrive size={22} />
          </span>
          <p className="eh">No drive is ready for camera recordings</p>
          <p>
            Add a drive in Settings › Storage and prepare it. Droplet encrypts it, then
            sets aside space for recordings on its own.
            {r.needBytes > 0 &&
              ` Your cameras need about ${formatBinaryBytes(r.needBytes)} for ${Math.round(r.retentionDays)} days.`}
          </p>
          <Link className="btn primary" href={SETTINGS_STORAGE_HREF}>
            Open Storage
          </Link>
        </div>
      )}

      {hasDrive && !noDrive && (
        <DriveRow r={r} name={driveName} missing={missing} />
      )}

      {r.status === "pending" && (
        <p className="rs-note flex items-center gap-2">
          <Loader2 size={14} className="motion-safe:animate-spin" aria-hidden="true" />
          Setting up recording storage on {driveName}…
        </p>
      )}

      {(moving || r.migration.state === "failed") && (
        <Migration r={r} driveName={driveName} moving={moving} />
      )}

      {live && r.mode && (
        <ModeSwitch
          mode={r.mode}
          drive={r}
          canManage={canManage}
          locked={moving || r.status === "pending"}
          onPick={onPickMode}
        />
      )}

      {live && r.reservedBytes > 0 && <SpaceMeter r={r} />}

      {live && <Facts r={r} />}

      {canManage && !moving && candidates.length > 0 && (
        <DrivePicker
          candidates={candidates}
          selectRef={pickerRef}
          onChoose={onPickDrive}
        />
      )}

      {!noDrive && !missing && <CameraTable r={r} />}

      {r.oldFootage.present && (
        <OldFootage
          bytes={r.oldFootage.bytes}
          moving={moving}
          isOwner={isOwner}
          triggerRef={deleteTriggerRef}
          onRequestDelete={onRequestDelete}
        />
      )}
    </>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────

function DriveRow({
  r,
  name,
  missing,
}: {
  r: RecordingStorage;
  name: string;
  missing: boolean;
}) {
  const drive = r.drive!;
  return (
    <div className="rs-drive" data-testid="recording-drive">
      <span className="rs-drive-ic" aria-hidden="true">
        <HardDrive size={20} />
      </span>
      <div className="rs-drive-tx">
        <p className="rs-drive-nm">{name}</p>
        <p className="rs-drive-sub">
          Recording drive
          {drive.sizeBytes > 0 && <> · {formatBinaryBytes(drive.sizeBytes)}</>}
        </p>
      </div>
      <div className="rs-badges">
        {missing ? (
          <Badge kind="danger">Not connected</Badge>
        ) : drive.encrypted ? (
          <Badge kind="ok">
            <Lock size={11} aria-hidden="true" />
            Encrypted
          </Badge>
        ) : (
          <Badge kind="warn">
            <LockOpen size={11} aria-hidden="true" />
            Not encrypted
          </Badge>
        )}
      </div>
    </div>
  );
}

function ModeSwitch({
  mode,
  drive,
  canManage,
  locked,
  onPick,
}: {
  mode: RecordingStorageMode;
  drive: RecordingStorage;
  canManage: boolean;
  locked: boolean;
  onPick: (mode: RecordingStorageMode) => void;
}) {
  const labelId = useId();
  const name = useId();
  const disabled = !canManage || locked;
  const size = drive.drive?.sizeBytes ?? 0;
  const options: Array<{ value: RecordingStorageMode; title: string; hint: string }> = [
    {
      value: "auto_reserved",
      title: "Auto-sized",
      hint: "Droplet sets aside only what your cameras need.",
    },
    {
      value: "full",
      title: "Whole drive",
      hint:
        size > 0
          ? `Recordings can use all ${formatBinaryBytes(size)}.`
          : "Recordings can use the whole drive.",
    },
  ];
  return (
    <div>
      <span id={labelId} className="rs-field-label">
        Recording space
      </span>
      <div role="radiogroup" aria-labelledby={labelId} className="rs-seg">
        {options.map((o) => (
          <label key={o.value} className="rs-opt">
            <input
              type="radio"
              name={name}
              value={o.value}
              checked={mode === o.value}
              disabled={disabled}
              // Controlled by the SERVER's mode: picking the other one only asks
              // (tier-2 confirm); the radio flips when the orchestrator says so.
              onChange={() => onPick(o.value)}
            />
            <span className="rs-opt-t">{o.title}</span>
            <span className="rs-opt-h">{o.hint}</span>
          </label>
        ))}
      </div>
      {!canManage && (
        <p className="rs-hint">Only the owner or an admin can change this.</p>
      )}
      {canManage && locked && (
        <p className="rs-hint">Available again once recordings finish moving.</p>
      )}
    </div>
  );
}

function SpaceMeter({ r }: { r: RecordingStorage }) {
  const used = Math.min(r.usedBytes, r.reservedBytes);
  const pct = (used / r.reservedBytes) * 100;
  const kind = pct > 95 ? "danger" : pct > 85 ? "warn" : "";
  const reservedLabel =
    r.mode === "full"
      ? `${formatBinaryBytes(r.reservedBytes)} (whole drive)`
      : `${formatBinaryBytes(r.reservedBytes)} set aside`;
  return (
    <div>
      <div
        role="meter"
        aria-label="Recording space used"
        aria-valuemin={0}
        aria-valuemax={r.reservedBytes}
        aria-valuenow={used}
        aria-valuetext={`${formatBinaryBytes(r.usedBytes)} used of ${reservedLabel}`}
      >
        <Meter pct={pct} kind={kind} />
      </div>
      <p className="rs-legend" data-testid="recording-space-legend">
        <span>
          <b>{formatBinaryBytes(r.usedBytes)}</b> used
        </span>
        <span>
          <b>{formatBinaryBytes(r.freeBytes)}</b> free
        </span>
        <span>{reservedLabel}</span>
      </p>
    </div>
  );
}

function Facts({ r }: { r: RecordingStorage }) {
  const days = Math.round(r.retentionDays);
  return (
    <p className="rs-facts" data-testid="recording-facts">
      <span>
        Keeping <b>{days} days</b> of recordings
      </span>
      <span>
        <b>{formatDays(r.daysStored)}</b> stored so far
      </span>
      {r.needBytes > 0 && (
        <span>
          Needs about <b>{formatBinaryBytes(r.needBytes)}</b> for {days} days
        </span>
      )}
    </p>
  );
}

function Migration({
  r,
  driveName,
  moving,
}: {
  r: RecordingStorage;
  driveName: string;
  moving: boolean;
}) {
  const m = r.migration;
  if (!moving) {
    // A failed move: calm, and honest that nothing was lost. The raw error
    // (rsync output, paths) is deliberately never shown.
    return (
      <div className="rs-migration" data-testid="recording-migration">
        <p className="rs-migration-t">
          <AlertTriangle size={15} aria-hidden="true" />
          The move to {driveName} didn&apos;t finish
        </p>
        <p className="rs-migration-d">
          Your existing recordings were kept where they were. Check the drive in Settings
          › Storage, or choose a drive again below to try once more.
        </p>
      </div>
    );
  }
  const pct = Math.round(m.progressPct);
  return (
    <div className="rs-migration" data-testid="recording-migration">
      <p className="rs-migration-t">
        <Loader2 size={15} className="motion-safe:animate-spin" aria-hidden="true" />
        Moving your recordings to {driveName}
      </p>
      <div
        role="progressbar"
        aria-label="Moving recordings"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-valuetext={`${pct}% moved`}
      >
        <Meter pct={m.progressPct} />
      </div>
      <p className="rs-migration-n">
        <b>{pct}%</b>
        {m.bytesTotal > 0 && (
          <span>
            {formatBinaryBytes(m.bytesCopied)} of {formatBinaryBytes(m.bytesTotal)}
          </span>
        )}
      </p>
      <p className="rs-migration-d">
        Cameras keep recording while this runs, with a short pause near the end.
      </p>
    </div>
  );
}

function DrivePicker({
  candidates,
  selectRef,
  onChoose,
}: {
  candidates: RecordingStorage["eligibleDrives"];
  selectRef: React.RefObject<HTMLSelectElement | null>;
  onChoose: (fsUuid: string, name: string) => void;
}) {
  const id = useId();
  const [choice, setChoice] = useState("");
  const chosen = candidates.find((d) => d.fsUuid === choice);
  return (
    <div>
      <label htmlFor={id} className="rs-field-label">
        Move recordings to
      </label>
      <div className="rs-picker-row">
        <select
          id={id}
          ref={selectRef}
          className="rs-select"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          <option value="">Choose a drive…</option>
          {candidates.map((d) => (
            <option key={d.fsUuid} value={d.fsUuid}>
              {driveLabel(d.label)} · {formatBinaryBytes(d.sizeBytes)}
              {d.encrypted ? "" : " · not encrypted"}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn"
          disabled={!chosen}
          onClick={() => chosen && onChoose(chosen.fsUuid, driveLabel(chosen.label))}
        >
          Use this drive
        </button>
      </div>
    </div>
  );
}

function CameraTable({ r }: { r: RecordingStorage }) {
  const rows = cameraNeedShares(r.cameras);
  if (rows.length === 0) {
    // Deliberately not "No cameras are recording yet": the "Storage by camera"
    // card on the same page already says that, and two identical lines read as
    // a glitch.
    return (
      <p className="rs-note">
        Once a camera is recording, what it needs shows up here.
      </p>
    );
  }
  const needHeader = `${Math.round(r.retentionDays)}-day need`;
  return (
    // The ARIA roles are explicit on purpose: the phone layer re-lays the table
    // out as stacked cards (display: grid), which makes some screen readers
    // drop native table semantics. Explicit roles keep them.
    <table className="rs-table" role="table">
      <caption className="sr-only">Recording needs by camera</caption>
      <thead role="rowgroup">
        <tr role="row">
          <th scope="col" role="columnheader">Camera</th>
          <th scope="col" role="columnheader" className="rs-num">MB/h</th>
          <th scope="col" role="columnheader" className="rs-num">GB/day</th>
          <th scope="col" role="columnheader" className="rs-num">{needHeader}</th>
          <th scope="col" role="columnheader" className="rs-num">Share</th>
        </tr>
      </thead>
      <tbody role="rowgroup">
        {rows.map((c) => (
          <tr key={c.name} role="row" data-testid={`recording-camera-${c.name}`}>
            <td role="cell">{c.displayName}</td>
            <td role="cell" className="rs-num" data-label="MB/h">{formatRate(c.mbPerHour)}</td>
            <td role="cell" className="rs-num" data-label="GB/day">{formatRate(c.gbPerDay)}</td>
            <td role="cell" className="rs-num" data-label={needHeader}>{formatBinaryBytes(c.needBytes)}</td>
            <td role="cell" className="rs-num" data-label="Share">{formatShare(c.sharePct)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function OldFootage({
  bytes,
  moving,
  isOwner,
  triggerRef,
  onRequestDelete,
}: {
  bytes: number;
  moving: boolean;
  isOwner: boolean;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  onRequestDelete: () => void;
}) {
  return (
    <div className="rs-old" data-testid="recording-old-footage">
      <p className="rs-old-t">Old recordings are still on the system drive</p>
      <p className="rs-old-d">
        {formatBinaryBytes(bytes)} from before the move is still on the drive your Droplet
        runs on. It stays there until you delete it.
        {moving && " You can delete it once the move finishes."}
        {!moving && !isOwner && " Ask the owner to delete it."}
      </p>
      {isOwner && !moving && (
        <button
          ref={triggerRef}
          type="button"
          className="btn danger sm"
          onClick={onRequestDelete}
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete old recordings from system drive
        </button>
      )}
    </div>
  );
}

// ─── Formatting ───────────────────────────────────────────────────────────

function driveLabel(label: string): string {
  return label.trim() || "Drive";
}

/** "3.4 days", "1 day", "Under a day" — never "0.0 days". */
function formatDays(n: number): string {
  if (n < 1) return "Under a day";
  const v = Number(n.toFixed(1));
  return `${v} ${v === 1 ? "day" : "days"}`;
}

/** A camera's share of the total need. */
function formatShare(pct: number): string {
  if (pct <= 0) return "0%";
  if (pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}
