"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, HardDrive, Layers, ShieldCheck } from "lucide-react";
import {
  fetchDrives,
  updateDriveLabel,
  requestCreatePool,
  confirmPoolCommand,
} from "@/lib/api";
import type { DriveInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  calculateRaidOptions,
  type RaidLevel,
} from "@/components/setup/raid-calculator";

/**
 * Wizard step — name the drives the box detected, and (optionally) combine
 * them into a storage pool.
 *
 * The device-bridge inventory of mounted drives comes back from
 * GET /api/storage/drives (Phase L wires this on the POC; in production
 * it's the device-bridge on the host). The customer types a friendly
 * name for each ("Wedding Photos", "Camera Footage") and we upsert via
 * PATCH /api/storage/drives/:uuid (WARP-174).
 *
 * BUG-3 / ADR-019 — a RAID pool is OPTIONAL and the toggle is **default
 * OFF**. OFF leaves every drive as an independent mount (the WARP-174
 * naming step, unchanged) and the step stays skippable; setup completes
 * with NO pool. Turning it ON reveals a live capacity calculator + the
 * RAID-level chooser + the (destructive) create action, which runs through
 * #489's owner-gated two-step flow: requestCreatePool (evaluate → confirm
 * token) → confirmPoolCommand (execute). Nothing auto-creates; the AI never
 * reaches this path (the destructive ops aren't in tools-core at all).
 *
 * Auto-skip when zero drives — a single-disk box has nothing to label or
 * pool here, and the wizard shouldn't make the customer click "Skip" on a
 * no-op step.
 *
 * Visual shape mirrors the NetworkDevice cards on `/network` per
 * ADR-002 Phase 1 — icon + name + secondary metadata, edit-in-place.
 */
export function StorageStep({
  onComplete,
  onSkip,
}: {
  onComplete: () => void;
  onSkip: () => void;
}) {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BUG-3 / ADR-019 — RAID is OPTIONAL and OFF by default.
  const [raidOn, setRaidOn] = useState(false);
  const [chosenLevel, setChosenLevel] = useState<RaidLevel | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingToken, setPendingToken] = useState<{
    confirmationToken: string;
    service: string;
    resourceId: string;
  } | null>(null);
  // Inline pool-create error. Kept separate from the naming `error` so a
  // create refusal doesn't get clobbered by a name-validation message and
  // vice-versa.
  const [createError, setCreateError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const resp = await fetchDrives();
      const list = resp.drives ?? [];
      setDrives(list);
      // Pre-fill with existing displayName (or the FS label as a placeholder).
      const initial: Record<string, string> = {};
      for (const d of list) {
        initial[d.uuid] = d.displayName ?? "";
      }
      setNames(initial);
      // Auto-skip when there's nothing to label. Lets the wizard land
      // on the next step without a "Skip" click on an empty page.
      if (list.length === 0) {
        onSkip();
      }
    } catch (e) {
      // Bridge unreachable / dev-mode without it — treat as "no drives"
      // and skip silently. Customer can label drives later from /storage.
      onSkip();
      const _msg = e instanceof Error ? e.message : String(e);
      void _msg;
    } finally {
      setLoading(false);
    }
  }, [onSkip]);

  useEffect(() => {
    load();
  }, [load]);

  const duplicateName = useMemo(() => {
    const seen = new Set<string>();
    for (const v of Object.values(names)) {
      const trimmed = v.trim().toLowerCase();
      if (!trimmed) continue;
      if (seen.has(trimmed)) return trimmed;
      seen.add(trimmed);
    }
    return null;
  }, [names]);

  // Live capacity calculator over the REAL detected drives (sizes from the
  // bridge fetch — never a fixture). Recomputed only when the drive set
  // changes. Greys out levels the drive count can't support.
  const raidOptions = useMemo(
    () =>
      calculateRaidOptions(
        drives.map((d) => ({ device: d.device, size_bytes: d.size_bytes })),
      ),
    [drives],
  );

  // Drives that will be erased if the owner creates a pool — every detected
  // drive with a real device path. Their sizes feed the blast-radius copy.
  const poolMembers = useMemo(
    () => drives.filter((d) => /^\/dev\//.test(d.device)),
    [drives],
  );

  const chosenOption = chosenLevel
    ? raidOptions.find((o) => o.level === chosenLevel) ?? null
    : null;

  async function handleSave() {
    if (duplicateName) {
      setError(`Two drives can't share the name "${duplicateName}".`);
      return;
    }
    setError(null);
    setSaving(true);
    try {
      // Send a PATCH for each drive the customer named (skipped if blank).
      // Errors are collected — one bad PATCH doesn't kill the others; if
      // ANY succeeded the wizard advances and the customer can fix the
      // rest from /storage later.
      const results = await Promise.allSettled(
        drives
          .filter((d) => names[d.uuid]?.trim())
          .map((d) =>
            updateDriveLabel(d.uuid, { displayName: names[d.uuid].trim() }),
          ),
      );
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0 && failures.length === results.length) {
        // Every save failed → don't advance.
        setError(
          failures.length === 1
            ? "Couldn't save that name. Try again in a moment."
            : `Couldn't save any of the names yet. Try again in a moment.`,
        );
        setSaving(false);
        return;
      }
      onComplete();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed. Try again.");
      setSaving(false);
    }
  }

  // Step 1 of the gated create: evaluate the op → mint a confirm token →
  // open the blast-radius confirm. NEVER creates here. The owner must
  // confirm in the dialog for step 2 to run.
  async function handleStartCreate() {
    if (!chosenLevel || !chosenOption?.selectable) return;
    setCreateError(null);
    setCreating(true);
    const members = poolMembers.map((d) => d.device);
    try {
      const token = await requestCreatePool({
        // md device name is owner-agnostic — first pool is md0 on a fresh box
        // (the host script + bridge are authoritative; this is the request).
        device: "md0",
        level: chosenLevel,
        members,
        // The host-script's typed double-confirm gate (ADR-019 D4.3) refuses
        // to run unless the phrase NAMES every member's short device — that's
        // the "never run blind" check. The owner has already passed role +
        // confirm-token gates and acknowledged the destructive ConfirmDialog
        // (which names each drive + size); this phrase is the machine token
        // that satisfies the last-line script check by listing the members.
        confirmPhrase: buildConfirmPhrase(members),
      });
      setPendingToken({
        confirmationToken: token.confirmationToken,
        service: token.service,
        resourceId: token.resourceId,
      });
      setConfirmOpen(true);
    } catch (e) {
      setCreateError(friendlyCreateError(e));
    } finally {
      setCreating(false);
    }
  }

  // Step 2: the owner confirmed in the dialog → execute. On success advance
  // the wizard; on the host pre-flight's data-present refusal show calm,
  // honest copy (never the raw mdadm/mkfs message) and stay on the step.
  async function handleConfirmCreate() {
    if (!pendingToken) return;
    try {
      await confirmPoolCommand(pendingToken);
      setConfirmOpen(false);
      onComplete();
    } catch (e) {
      setConfirmOpen(false);
      setPendingToken(null);
      setCreateError(friendlyCreateError(e));
    }
  }

  // While loading, the auto-skip path may fire before render — show a
  // tiny placeholder so we don't briefly flash an empty page.
  if (loading && drives.length === 0) {
    return (
      <StepShell current="storage" title="Name your storage" subtitle="One moment…">
        <div className="space-y-2">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="dp-card !py-3 flex items-center gap-3 opacity-30"
            >
              <div className="w-9 h-9 rounded-lg bg-surface-secondary motion-safe:animate-pulse" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3 w-32 bg-surface-secondary rounded motion-safe:animate-pulse" />
                <div className="h-2.5 w-20 bg-surface-secondary rounded motion-safe:animate-pulse" />
              </div>
            </div>
          ))}
        </div>
      </StepShell>
    );
  }

  // When RAID is on AND the owner has picked a buildable level, the primary
  // action becomes the (destructive) create. Otherwise it stays the naming
  // step's "Save and continue". The step is ALWAYS skippable.
  const createMode = raidOn && !!chosenOption?.selectable;
  const primary = createMode
    ? {
        label: "Create pool",
        loadingLabel: "Checking drives…",
        onClick: handleStartCreate,
        isLoading: creating,
      }
    : {
        label: "Save and continue",
        loadingLabel: "Saving…",
        onClick: handleSave,
        isLoading: saving,
      };

  return (
    <StepShell current="storage"
      title="Name your storage"
      subtitle="Give each drive a name so you remember what's on it."
      primary={primary}
      skip={{ label: "Skip for now", onClick: onSkip }}
    >
      <div className="space-y-3">
        {drives.map((drive) => (
          <div key={drive.uuid} className="dp-card !p-4">
            <div className="flex items-start gap-3 mb-3">
              <div className="w-9 h-9 rounded-lg bg-accent/10 flex items-center justify-center flex-shrink-0">
                <HardDrive size={18} className="text-accent" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="type-subheadline text-label-primary">
                  {drive.label || drive.device}
                </p>
                <p className="type-caption-1 text-label-tertiary">
                  <span className="font-mono">{formatBytes(drive.size_bytes)}</span>
                  {drive.mount && ` · ${drive.mount}`}
                </p>
              </div>
            </div>
            <input
              type="text"
              value={names[drive.uuid] ?? ""}
              onChange={(e) =>
                setNames((prev) => ({
                  ...prev,
                  [drive.uuid]: e.target.value,
                }))
              }
              placeholder="e.g. Wedding Photos"
              className="dp-input"
              maxLength={64}
            />
          </div>
        ))}

        {error && (
          <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
            <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* BUG-3 / ADR-019 — optional storage-pool (RAID) setup. Default OFF. */}
      <RaidSection
        raidOn={raidOn}
        onToggle={() => {
          setRaidOn((on) => {
            const next = !on;
            // Clear any in-flight create state when switching off.
            if (!next) {
              setChosenLevel(null);
              setCreateError(null);
            }
            return next;
          });
        }}
        options={raidOptions}
        chosenLevel={chosenLevel}
        onChoose={setChosenLevel}
        members={poolMembers}
        createError={createError}
      />

      <LearnMoreCard helpAnchor="storage">
        <p>
          Each drive can hold a different kind of file. Name them however
          helps you find things later — &ldquo;Wedding Photos&rdquo;,
          &ldquo;Client Backups&rdquo;, &ldquo;Camera Footage&rdquo;.
        </p>
        <p>
          You can rename a drive anytime from Settings &rsaquo; Storage.
          Names are stored on this Droplet — nothing leaves the box.
        </p>
      </LearnMoreCard>

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={handleConfirmCreate}
        onCancel={() => {
          setConfirmOpen(false);
          setPendingToken(null);
        }}
        title="Create this storage pool?"
        description={
          chosenOption
            ? `This permanently erases everything on the drives below and combines them as ${chosenOption.label} (${chosenOption.blurb.toLowerCase()}). This can't be undone — make sure these drives are empty or backed up.`
            : "This permanently erases the selected drives and combines them into a pool. This can't be undone."
        }
        confirmLabel="Create pool"
        confirmedIdentifier={poolMembers
          .map((d) => `${driveName(d)} · ${formatBytes(d.size_bytes)}`)
          .join("\n")}
        variant="destructive"
      />
    </StepShell>
  );
}

/**
 * The optional RAID block: a default-OFF switch, and — when ON — the live
 * capacity calculator + level chooser. Pure presentation; all create wiring
 * lives in the parent so the destructive flow stays in one place.
 */
function RaidSection({
  raidOn,
  onToggle,
  options,
  chosenLevel,
  onChoose,
  members,
  createError,
}: {
  raidOn: boolean;
  onToggle: () => void;
  options: ReturnType<typeof calculateRaidOptions>;
  chosenLevel: RaidLevel | null;
  onChoose: (level: RaidLevel) => void;
  members: DriveInfo[];
  createError: string | null;
}) {
  // RAID only makes sense with 2+ drives; with a single drive the toggle is
  // shown but every redundant level is greyed — still honest, and the owner
  // sees why. We always render the toggle so the option is discoverable.
  return (
    <div className="dp-card !p-4 mt-6">
      <div className="flex items-start gap-3">
        <span className="flex-none h-9 w-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
          <Layers size={18} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-3">
            <p className="type-subheadline text-label-primary">
              Combine drives into a pool
            </p>
            <button
              type="button"
              role="switch"
              aria-checked={raidOn}
              aria-label="Set up a storage pool (RAID)"
              onClick={onToggle}
              className={`relative inline-flex h-6 w-11 flex-none items-center rounded-full motion-safe:transition-colors ${
                raidOn ? "bg-accent" : "bg-separator"
              }`}
            >
              <span
                className={`inline-block h-5 w-5 transform rounded-full bg-surface-primary shadow-sm motion-safe:transition-transform ${
                  raidOn ? "translate-x-[22px]" : "translate-x-0.5"
                }`}
              />
            </button>
          </div>
          <p className="type-caption-1 text-label-tertiary mt-0.5">
            Optional. A pool joins your drives for more space or to survive a
            drive failing. Leave this off to keep each drive on its own.
          </p>
        </div>
      </div>

      {raidOn && (
        <div className="mt-4 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200">
          <div
            role="radiogroup"
            aria-label="RAID level"
            className="grid grid-cols-1 gap-2"
          >
            {options.map((opt) => {
              const selected = chosenLevel === opt.level;
              return (
                <button
                  key={opt.level}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={!opt.selectable}
                  aria-label={`${opt.label} — ${
                    opt.selectable ? opt.blurb : opt.unavailableReason
                  }`}
                  onClick={() => opt.selectable && onChoose(opt.level)}
                  className={`flex items-center justify-between gap-3 rounded-[10px] border px-3 py-2.5 text-left motion-safe:transition-colors ${
                    !opt.selectable
                      ? "border-separator opacity-50 cursor-not-allowed"
                      : selected
                        ? "border-accent bg-accent/5"
                        : "border-separator hover:border-accent/40"
                  }`}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="type-subheadline font-mono text-label-primary">
                        {opt.label}
                      </span>
                      {selected && (
                        <ShieldCheck
                          size={14}
                          className="text-accent flex-none"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                    <span className="block type-caption-1 text-label-tertiary">
                      {opt.selectable ? opt.blurb : opt.unavailableReason}
                    </span>
                  </span>
                  <span className="flex-none text-right">
                    {opt.selectable ? (
                      <span className="type-subheadline font-mono text-label-primary">
                        {formatBytes(opt.usableBytes)}
                      </span>
                    ) : (
                      <span className="type-caption-1 text-label-quaternary">
                        &mdash;
                      </span>
                    )}
                    <span className="block type-caption-2 text-label-quaternary">
                      usable
                    </span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* Honest blast-radius reminder, shown the moment RAID is on. */}
          <p className="type-caption-1 text-label-secondary mt-3">
            Creating a pool erases{" "}
            {members.length === 1 ? "this drive" : `these ${members.length} drives`}
            . Move anything you want to keep off them first.
          </p>

          {createError && (
            <div
              role="alert"
              className="mt-3 flex items-start gap-2 type-footnote text-label-primary bg-system-orange/10 rounded-sm px-3 py-2"
            >
              <AlertCircle
                size={14}
                className="mt-0.5 flex-shrink-0 text-system-orange"
              />
              <span>{createError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Map a pool-create failure to calm, honest, home-user copy. The host
 * pre-flight (ADR-019 D4.3) refuses a populated / mounted / OS-backing disk;
 * the orchestrator forwards that as a 422 whose raw message can name mdadm /
 * mkfs / filesystem internals. We NEVER show that raw string. The common case
 * — drives in use — gets a reassuring, actionable message; anything else gets
 * a calm generic fallback.
 */
function friendlyCreateError(err: unknown): string {
  const raw = err instanceof Error ? err.message.toLowerCase() : "";
  // Operator breadcrumb — full cause in DevTools, never on screen.
  // eslint-disable-next-line no-console
  console.error("[storage-step:create]", err);
  if (
    /in use|mounted|filesystem|contains|has data|partition|busy|not empty/.test(
      raw,
    )
  ) {
    return "These drives have data on them — back them up first. Droplet won't erase a drive that's in use.";
  }
  return "We couldn't create that pool right now. Try again in a moment.";
}

/**
 * Build the host-script confirm phrase (ADR-019 D4.3). The script's "never
 * run blind" gate requires the phrase to contain every member's SHORT device
 * basename (case-sensitive substring), e.g. for ["/dev/sda1","/dev/sda2"] →
 * "ERASE sda1 sda2". The owner-facing confirmation (role + token +
 * destructive ConfirmDialog naming each drive) is the human gate; this is the
 * machine token that satisfies the last-line script check.
 */
export function buildConfirmPhrase(members: string[]): string {
  const shorts = members
    .map((m) => m.split("/").filter(Boolean).pop() ?? "")
    .filter(Boolean);
  return `ERASE ${shorts.join(" ")}`.trim();
}

/** Customer-facing drive name: friendly displayName, then FS label, then the
 *  device tail — never a bare device path on its own. Mirrors DrivesPanel. */
function driveName(d: DriveInfo): string {
  const tail = d.device.split("/").filter(Boolean).pop() ?? "";
  const raw = (d.displayName || d.label || tail).replace(/[-_]+/g, " ").trim();
  if (!raw) return "Drive";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 GB";
  const tb = bytes / 1_000_000_000_000;
  if (tb >= 1) return `${tb.toFixed(tb >= 10 ? 0 : 1)} TB`;
  const gb = bytes / 1_000_000_000;
  // 1 decimal for sub-10 GB (small USB sticks read "7.3 GB" instead
  // of "7 GB"), 0 decimals at 10 GB and up. Mirrors the TB branch
  // above. Prior version had `gb >= 100 ? 0 : 0` — both branches
  // returned 0, so a 1.5 GB drive rendered as "1 GB" (truncated).
  return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
}
