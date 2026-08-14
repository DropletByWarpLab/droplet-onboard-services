"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, HardDrive, Layers, ShieldCheck } from "lucide-react";
import {
  fetchDrives,
  fetchPools,
  updateDriveLabel,
  requestCreatePool,
  confirmPoolCommand,
  requestAdoptDrive,
  reclaimDrive,
} from "@/lib/api";
import type { DiskInfo, DiskState, DriveInfo, PoolInfo } from "@/lib/types";
import { StepShell } from "@/components/setup/StepShell";
import { LearnMoreCard } from "@/components/setup/LearnMoreCard";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  calculateRaidOptions,
  type RaidLevel,
} from "@/components/setup/raid-calculator";
// WARP-1337: sanitizer for the post-wipe FS label (^[A-Za-z0-9_-]{1,16}$),
// its shadow-mount collision guard, and the ONE shared display-name chain.
import {
  driveDisplayName,
  sanitizeFsLabel,
  takenVolumeNames,
  uniqueFsLabel,
} from "@/components/FileManager/drive-display";

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
 * #5 ADDENDUM (owner-directed reversal of ADR-019's default-OFF): with **2+
 * poolable drives** the pool toggle now defaults **ON** with a sensible level
 * pre-selected, and the step is **non-skippable** — the customer either creates
 * a pool or toggles it off and names the drives. The data-safety that motivated
 * ADR-019 is preserved: pooling still NEVER auto-creates (the primary "Create
 * pool" requires the owner-gated confirm dialog + the host-script typed
 * double-confirm, which refuses any drive with data).
 *
 * "Poolable" means a FREE physical disk — the box's installed storage (a disk
 * the Droplet is already using, bridge `removable: false`) is excluded from
 * both pooling and reclaim here, because combining/wiping it would tear down
 * live storage; the owner manages those from Settings › Storage. On the common
 * single-box (whose drives are all in use) there's nothing poolable, so the
 * step keeps the default-OFF, skippable behaviour and never drops the customer
 * onto a create flow the host will (correctly) refuse.
 *
 * Whole-disk grouping (setup honesty): the bridge returns one entry per mounted
 * FILESYSTEM, so a single physical disk split into two partitions (e.g. an
 * `nvr` + a `data` filesystem on `sda`) comes back as two entries. The reclaim
 * + pool flows act on the WHOLE disk, so we group those entries by their
 * backing disk: that disk is ONE reclaim/pool target, shown once, and wiping it
 * erases EVERY filesystem on it (named in the confirm). The naming step stays
 * per-filesystem — you still name each one.
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
  /** WARP-933 — deprecated/no-op: the step no longer auto-skips when no drives
   *  are found (it renders an explicit state instead). Kept in the prop type so
   *  the page's existing pass stays valid; ignored at runtime. */
  onAutoSkip?: () => void;
}) {
  const [drives, setDrives] = useState<DriveInfo[]>([]);
  // WARP-936 — the orchestrator's whole-disk inventory (present-but-unmounted
  // disks included). `null` = older stack without the field; the reclaim list
  // then falls back to grouping the mounted drives (the WARP-662 behaviour).
  const [bridgeDisks, setBridgeDisks] = useState<DiskInfo[] | null>(null);
  // WARP-936 — an existing md array must be SURFACED during setup, not
  // silently ignored (the live box already had md127 and the step said
  // "No extra drives to set up").
  const [pools, setPools] = useState<PoolInfo[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // BUG-3 / ADR-019 — RAID is OPTIONAL and OFF by default.
  const [raidOn, setRaidOn] = useState(false);
  // Tracks whether the user has explicitly toggled the RAID switch; load() only
  // auto-enables RAID before the first interaction so a post-adopt refresh
  // doesn't silently override an explicit "off" choice.
  const userToggledRaid = useRef(false);
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

  // WARP-662 — "reclaim existing drives" (wipe + reformat + mount). OFF by
  // default + opt-in, mirroring the RAID toggle. Per-disk wipe method. Same
  // owner-gated two-step flow (requestAdoptDrive → confirm). The OS disk is
  // refused server-side by the host script; the box's installed storage is
  // disabled client-side too (it's in use, not a foreign drive).
  const [adoptOn, setAdoptOn] = useState(false);
  // Keyed by whole-disk kernel name (e.g. "sda"), not a per-partition uuid —
  // reclaim acts on the whole disk.
  const [adoptWipe, setAdoptWipe] = useState<Record<string, "quick" | "secure">>({});
  const [adoptPending, setAdoptPending] = useState<{
    token: { confirmationToken: string; service: string; resourceId: string };
    disk: PhysicalDisk;
  } | null>(null);
  const [adoptConfirmOpen, setAdoptConfirmOpen] = useState(false);
  const [adoptError, setAdoptError] = useState<string | null>(null);
  // Whole-disk name currently mid-adopt (button spinner), or null.
  const [adoptBusy, setAdoptBusy] = useState<string | null>(null);

  // WARP-1048 — reclaim a pool-MEMBER disk: break it out of its md array, then
  // adopt it. Distinct confirm dialog + copy from the plain adopt (it removes a
  // drive from a pool first), but the same owner-gated two-step flow
  // (reclaimDrive → confirm). Shares adoptBusy/adoptError for the row spinner
  // and the inline error line.
  const [reclaimPending, setReclaimPending] = useState<{
    token: { confirmationToken: string; service: string; resourceId: string };
    disk: PhysicalDisk;
  } | null>(null);
  const [reclaimConfirmOpen, setReclaimConfirmOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const resp = await fetchDrives();
      const list = resp.drives ?? [];
      setDrives(list);
      setBridgeDisks(resp.disks ?? null);
      // Pre-fill with existing displayName (or the FS label as a placeholder).
      const initial: Record<string, string> = {};
      for (const d of list) {
        initial[d.uuid] = d.displayName ?? "";
      }
      setNames(initial);
      // WARP-936 — surface an existing array. Best-effort: a pools fetch
      // failure never blocks the step (we just can't show the card).
      let existingPools: PoolInfo[] = [];
      try {
        const poolsResp = await fetchPools();
        existingPools = poolsResp?.pools ?? [];
      } catch {
        existingPools = [];
      }
      setPools(existingPools);
      // #5: with 2+ drives we can ACTUALLY pool — i.e. free physical disks —
      // default to pooling ON (a sensible level is pre-selected by the effect
      // below). A box whose drives are all in use by the Droplet has nothing
      // poolable, so we leave the destructive pool toggle OFF rather than
      // landing the customer on a create flow the host will refuse.
      // WARP-936: never default it ON when an array ALREADY exists — piling a
      // second pool onto a box mid-setup is a Settings decision, not a default.
      if (
        !userToggledRaid.current &&
        existingPools.length === 0 &&
        groupPhysicalDisks(list).filter((p) => !p.inUse).length >= 2
      ) {
        setRaidOn(true);
      }
      // WARP-933 — do NOT auto-skip on an empty drive list. The step renders an
      // explicit "no drives to set up" state with Continue, so the page is
      // visible rather than silently jumped past.
    } catch (e) {
      // Bridge unreachable — surface it with a retry rather than silently
      // skipping, which read to customers as "the page doesn't work". They can
      // still continue or skip deliberately.
      setError("Couldn't load your drives. Check the connection and try again.");
      const _msg = e instanceof Error ? e.message : String(e);
      void _msg;
    } finally {
      setLoading(false);
    }
  }, []);

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

  // Group the per-filesystem drive list by backing physical disk. The reclaim
  // + pool flows act on whole disks, so two partitions of one disk (e.g. an
  // `nvr` + a `data` filesystem on `sda`) are ONE target — shown once, and
  // wiping it erases both. (WARP-662 / setup honesty.)
  //
  // WARP-857: a pool is created on the WHOLE disk, so when the orchestrator
  // provides the whole-disk inventory, size each disk from THAT (the true disk
  // capacity, including unpartitioned space) instead of summing its filesystem
  // sizes — which under-counts and mis-priced the RAID calculator (and
  // disagreed with the reclaim list, which already uses the whole-disk size).
  const physicalDisks = useMemo(() => {
    const grouped = groupPhysicalDisks(drives);
    if (bridgeDisks === null) return grouped;
    const wholeDiskSize = new Map(bridgeDisks.map((d) => [d.name, d.size_bytes]));
    return grouped.map((p) => {
      const whole = wholeDiskSize.get(p.disk);
      return whole && whole > 0 ? { ...p, sizeBytes: whole } : p;
    });
  }, [drives, bridgeDisks]);

  // WARP-936 — reclaim candidates. When the orchestrator provides the
  // whole-disk inventory we build the list from it (so a present-but-
  // UNMOUNTED disk is finally offered — the exact gap that hid the live
  // box's two RAID-member drives); an older stack without the field falls
  // back to grouping the mounted list (the original WARP-662 behaviour).
  const reclaimDisks = useMemo<PhysicalDisk[]>(() => {
    if (bridgeDisks === null) return physicalDisks;
    return bridgeDisks.map((d) => ({
      disk: d.name,
      members: drives.filter(
        (dr) => (dr.parent_disk || wholeDiskName(dr.device)) === d.name,
      ),
      sizeBytes: d.size_bytes,
      inUse: d.state === "in_use",
      state: d.state,
      md: d.md,
    }));
  }, [bridgeDisks, drives, physicalDisks]);

  // Disks we can actually pool/reclaim here: the box's installed storage
  // (`removable: false`) is excluded — it's in use by the Droplet, not a
  // previously-used foreign drive — so we never default the customer into a
  // create/wipe the host will (correctly) refuse.
  const poolableDisks = useMemo(
    () => physicalDisks.filter((p) => !p.inUse),
    [physicalDisks],
  );

  // Live capacity calculator over the REAL poolable disks — ONE entry per
  // physical disk, sized to the whole disk (never per-partition, which would
  // double-count a multi-partition disk and offer a meaningless same-disk
  // "mirror"). Sizes come from the bridge fetch, never a fixture.
  const raidOptions = useMemo(
    () =>
      calculateRaidOptions(
        poolableDisks.map((p) => ({
          // WARP-857: mirror handleStartCreate's guard — `p.disk` is normally a
          // short kernel name ("sda"), but the groupPhysicalDisks fallback can
          // carry a full /dev/ path for an unrecognized shape; only prefix when
          // it's missing so we never build "/dev//dev/…".
          device: p.disk.startsWith("/dev/") ? p.disk : `/dev/${p.disk}`,
          size_bytes: p.sizeBytes,
        })),
      ),
    [poolableDisks],
  );

  // #5: when pooling auto-enables (2+ poolable disks) pre-select the first
  // buildable RAID level so the customer lands on a ready-to-create pool. Only
  // fills when nothing is chosen yet, so it never overrides an explicit pick or
  // re-selects after the owner clears it.
  useEffect(() => {
    // Only when there are 2+ FREE disks to actually combine. JBOD is
    // "selectable" at a single disk, but a one-disk "pool" isn't a meaningful
    // combine here — and pre-selecting it would light up "Create pool" while
    // the chooser stays hidden (canPool gate), contradicting the can't-pool
    // note. Gate the auto-pick on the same 2-disk floor the chooser uses.
    if (raidOn && poolableDisks.length >= 2 && !chosenLevel) {
      const best = raidOptions.find((o) => o.selectable);
      if (best) setChosenLevel(best.level);
    }
  }, [raidOn, chosenLevel, raidOptions, poolableDisks.length]);

  // Every mounted filesystem a pool-create would erase — across every POOLABLE
  // disk — so the confirm dialog names them all. (The member DEVICE list sent
  // to the host is deduped to one per disk; see handleStartCreate.)
  const poolMembers = useMemo(
    () =>
      poolableDisks
        .flatMap((p) => p.members)
        .filter((d) => /^\/dev\//.test(d.device)),
    [poolableDisks],
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
    // One member per POOLABLE physical disk — the WHOLE DISK NODE, never a
    // partition of it (and never two partitions of the SAME disk). WARP-848
    // QA must-fix: this used to send each disk's FIRST partition
    // (members[0].device, e.g. /dev/sda1), so the host script's managed
    // teardown released only that partition's mounts and wipefs/mdadm ran on
    // the partition — while the ConfirmDialog promised, and the capacity
    // options priced, the whole disk. A sibling partition (the live box's
    // sda2 `data` next to sda1 `nvr`) survived mounted and un-erased,
    // re-automounting every boot, and the pool came up partition-sized.
    // Tearing down a DISK node covers every child partition (kernel PKNAME
    // topology), so the whole-disk member delivers exactly what the dialog
    // names. `p.disk` is normally a short kernel name ("sda"); the
    // groupPhysicalDisks fallback can carry a full device path for an
    // unrecognized shape, so only prefix /dev/ when it's missing.
    const members = poolableDisks.map((p) =>
      p.disk.startsWith("/dev/") ? p.disk : `/dev/${p.disk}`,
    );
    try {
      // WARP-1337 AC3 note (code review): requestCreatePool ACCEPTS an
      // optional displayName (the confirmed create seeds the StoragePool row
      // with it), but the wizard deliberately does not pass one yet — AC5
      // forbids restructuring this step's UI, and the pool-name input ships
      // with the follow-up naming tickets. When that lands, OMIT the field
      // entirely for empty input (displayName: "" is a zod 400), mirroring
      // the label-omission pattern in fsLabelFor above.
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

  // WARP-1337 — seed the post-wipe filesystem label from the best customer
  // name we have for the disk: the name typed in THIS step's field, else the
  // member's saved displayName, else its existing FS label (preserved across
  // the wipe). The label becomes the mount tail, so an adopted drive never
  // lands back on a GUID mount. Returns undefined (caller OMITS the label)
  // when nothing usable survives sanitizing.
  //
  // Code review: the label is uniquified against the OTHER mounted volumes'
  // labels/tails — the host script's raw mount at /mnt/droplet/<LABEL> would
  // stack a duplicate over the existing mount (shadow mount). This disk's own
  // filesystems are excluded from the check: the wipe erases them, so
  // re-adopting a drive under its own current name is not a collision.
  function fsLabelFor(disk: PhysicalDisk): string | undefined {
    const own = new Set<DriveInfo>(disk.members);
    const taken = takenVolumeNames(drives.filter((d) => !own.has(d)));
    for (const m of disk.members) {
      const label = sanitizeFsLabel(
        names[m.uuid]?.trim() || m.displayName || m.label,
      );
      if (label) return uniqueFsLabel(label, taken, disk.disk);
    }
    return undefined;
  }

  // WARP-662 step 1 — adopt a previously-used DISK: request a confirm token
  // (does NOT wipe yet) and open the per-disk blast-radius dialog. The device
  // sent is the WHOLE disk; the host script refuses the OS disk regardless, and
  // we never offer reclaim on the box's installed storage (disk.inUse).
  async function handleStartAdopt(disk: PhysicalDisk) {
    if (disk.inUse) return; // installed box storage — managed from Settings
    // WARP-936/1048: a plain adopt is never offered for an md member — wipefs on
    // an md-held member fails EBUSY. The member's own path is RECLAIM
    // (handleStartReclaim), which detaches it from the array first; this adopt
    // handler bails so the two never cross.
    if (disk.state === "pool_member") return;
    const name = disk.disk;
    if (!name) return;
    setAdoptError(null);
    setAdoptBusy(name);
    try {
      const label = fsLabelFor(disk);
      const token = await requestAdoptDrive({
        device: name,
        wipeMethod: adoptWipe[name] ?? "quick",
        ...(label ? { label } : {}),
        confirmPhrase: buildConfirmPhrase([`/dev/${name}`]),
      });
      setAdoptPending({
        token: {
          confirmationToken: token.confirmationToken,
          service: token.service,
          resourceId: token.resourceId,
        },
        disk,
      });
      setAdoptConfirmOpen(true);
    } catch (e) {
      setAdoptError(friendlyAdoptError(e));
    } finally {
      setAdoptBusy(null);
    }
  }

  // Step 2 — owner confirmed in the dialog → execute. On success refresh the
  // drive list (the adopted disk re-appears, freshly formatted + mounted); on
  // the host pre-flight's refusal show calm copy and stay on the step.
  async function handleConfirmAdopt() {
    if (!adoptPending) return;
    try {
      await confirmPoolCommand(adoptPending.token);
      setAdoptConfirmOpen(false);
      setAdoptPending(null);
      await load();
    } catch (e) {
      setAdoptConfirmOpen(false);
      setAdoptPending(null);
      setAdoptError(friendlyAdoptError(e));
    }
  }

  // WARP-1048 step 1 — reclaim a pool-MEMBER disk: request a confirm token
  // (does NOT touch the array yet) and open the reclaim blast-radius dialog.
  // The request carries the owning md so the host script detaches the member
  // (mdadm --fail/--remove + --zero-superblock) before the adopt flow. A member
  // is never plain-adopted — wipefs on an md-held member EBUSYs.
  async function handleStartReclaim(disk: PhysicalDisk) {
    if (disk.state !== "pool_member" || !disk.md) return;
    const name = disk.disk;
    if (!name) return;
    setAdoptError(null);
    setAdoptBusy(name);
    try {
      const label = fsLabelFor(disk);
      const token = await reclaimDrive({
        device: name,
        md: disk.md,
        wipeMethod: adoptWipe[name] ?? "quick",
        ...(label ? { label } : {}),
        confirmPhrase: buildConfirmPhrase([`/dev/${name}`]),
      });
      setReclaimPending({
        token: {
          confirmationToken: token.confirmationToken,
          service: token.service,
          resourceId: token.resourceId,
        },
        disk,
      });
      setReclaimConfirmOpen(true);
    } catch (e) {
      setAdoptError(friendlyAdoptError(e));
    } finally {
      setAdoptBusy(null);
    }
  }

  // Step 2 — owner confirmed → execute. On success refresh so the reclaimed
  // disk re-appears as standalone storage (and the pool shows one fewer member).
  async function handleConfirmReclaim() {
    if (!reclaimPending) return;
    try {
      await confirmPoolCommand(reclaimPending.token);
      setReclaimConfirmOpen(false);
      setReclaimPending(null);
      await load();
    } catch (e) {
      setReclaimConfirmOpen(false);
      setReclaimPending(null);
      setAdoptError(friendlyAdoptError(e));
    }
  }

  // Initial load — show a skeleton. WARP-933 review: also offer "Skip for now"
  // so a hung storage bridge (load never resolves) isn't a dead-end with only
  // Back as an escape.
  if (loading && drives.length === 0) {
    return (
      <StepShell
        current="storage"
        title="Name your storage"
        subtitle="One moment…"
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
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

  // WARP-933 — no drives came back (empty list, or the storage bridge couldn't
  // be reached). Render an explicit, VISIBLE state with Continue/retry instead
  // of silently auto-skipping the step (which read as "the page doesn't work").
  // WARP-936: only when there is truly nothing to act on — an unmounted disk
  // in the inventory or an existing pool means the body must render.
  if (
    drives.length === 0 &&
    (error !== null || (reclaimDisks.length === 0 && pools.length === 0))
  ) {
    return (
      <StepShell
        current="storage"
        title="Name your storage"
        subtitle={
          error
            ? "We couldn't read your drives just now."
            : "Your Droplet's built-in storage is already set up."
        }
        primary={{ label: "Continue", onClick: onComplete }}
        skip={{ label: "Skip for now", onClick: onSkip }}
      >
        <div className="dp-card !py-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-accent/10">
            <HardDrive size={20} className="text-accent" />
          </div>
          {error ? (
            <>
              <p className="type-subheadline text-label-primary">
                Couldn&rsquo;t load your drives
              </p>
              <p className="type-caption-1 text-label-tertiary max-w-xs">
                {error}
              </p>
              <button
                type="button"
                onClick={load}
                className="dp-btn-secondary mt-1"
              >
                Try again
              </button>
            </>
          ) : (
            <>
              <p className="type-subheadline text-label-primary">
                No extra drives to set up
              </p>
              <p className="type-caption-1 text-label-tertiary max-w-xs">
                Your Droplet&rsquo;s built-in storage is already configured. Plug
                in an extra drive to add space — you can manage storage anytime
                from the Storage page.
              </p>
            </>
          )}
        </div>
      </StepShell>
    );
  }

  // When RAID is on AND the owner has picked a buildable level, the primary
  // action becomes the (destructive) create. Otherwise it stays the naming
  // step's "Save and continue". #5: the step is skippable when there aren't 2+
  // poolable disks (a single disk, or a box whose drives are all in use — both
  // can't be pooled); with 2+ poolable disks it's non-skippable.
  // Create is reachable only with 2+ free disks to combine (mirrors the
  // RaidSection's canPool gate) AND a buildable level chosen; otherwise the
  // primary stays the naming step's "Save and continue".
  const createMode =
    raidOn && poolableDisks.length >= 2 && !!chosenOption?.selectable;
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
      skip={
        poolableDisks.length < 2
          ? { label: "Skip for now", onClick: onSkip }
          : undefined
      }
    >
      {/* Fixed-content body (drive cards + optional RAID/Adopt sections + help
          card) — NOT an unbounded list, so it is NOT wrapped in a <ScrollRegion>.
          WARP-820 had capped it at 44dvh, which forced an inner scrollbar on
          desktop with empty space below. The StepShell panel is now scroll-when-
          needed instead. The two destructive ConfirmDialog overlays stay OUTSIDE
          — they're portaled modals, not flow content. */}
      <>
        {/* WARP-820: fluid gap between drive cards so a multi-drive box fits the
            viewport before the list ever needs to scroll. */}
        <div className="space-y-[clamp(8px,1.6vh,12px)]">
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

        {/* WARP-936 — an existing array is surfaced, never silently ignored.
            Setup stays read-only about it: format/destroy live in Settings ›
            Storage behind the tier-3 confirm flow. */}
        {pools.length > 0 && (
          <div className="dp-card !p-4 mt-6 flex items-start gap-3">
            <span className="flex-none h-9 w-9 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
              <Layers size={18} />
            </span>
            <div className="min-w-0">
              <p className="type-subheadline text-label-primary">
                This Droplet already has a storage pool
              </p>
              <p className="type-caption-1 text-label-tertiary mt-0.5">
                {pools.length === 1
                  ? `A pool with ${pools[0].members.length} ${
                      pools[0].members.length === 1 ? "drive" : "drives"
                    } is set up on this box.`
                  : `${pools.length} pools are set up on this box.`}{" "}
                You can format or manage it anytime from Settings &rsaquo;
                Storage.
              </p>
            </div>
          </div>
        )}

        {/* BUG-3 / ADR-019 — optional storage-pool (RAID) setup. Default OFF. */}
        <RaidSection
          raidOn={raidOn}
          onToggle={() => {
            userToggledRaid.current = true;
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
          poolableCount={poolableDisks.length}
          inUseCount={physicalDisks.length - poolableDisks.length}
          createError={createError}
        />

        {/* WARP-662 — optional "reclaim existing drives" (wipe + adopt). OFF. */}
        <AdoptSection
          adoptOn={adoptOn}
          onToggle={() => {
            setAdoptOn((on) => {
              const next = !on;
              if (!next) setAdoptError(null);
              return next;
            });
          }}
          disks={reclaimDisks}
          wipeMethods={adoptWipe}
          onWipeMethodChange={(disk, m) =>
            setAdoptWipe((prev) => ({ ...prev, [disk]: m }))
          }
          onAdopt={handleStartAdopt}
          onReclaim={handleStartReclaim}
          busyDisk={adoptBusy}
          adoptError={adoptError}
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
      </>

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

      {/* WARP-662 — per-disk adopt confirm (wipe + reformat + mount). Names
          EVERY filesystem on the disk so the owner sees a same-disk sibling
          (e.g. an `nvr` partition next to `data`) gets erased too. */}
      <ConfirmDialog
        open={adoptConfirmOpen}
        onConfirm={handleConfirmAdopt}
        onCancel={() => {
          setAdoptConfirmOpen(false);
          setAdoptPending(null);
        }}
        title="Erase and adopt this drive?"
        description="This permanently erases EVERYTHING on the disk below — including every folder it holds — then formats it and adds it to your Droplet. This can't be undone — make sure anything you want is backed up first."
        confirmLabel="Erase & adopt"
        confirmedIdentifier={
          adoptPending
            ? adoptPending.disk.members
                .map((m) => `${driveName(m)} · ${formatBytes(m.size_bytes)}`)
                .join("\n") +
              ((adoptWipe[adoptPending.disk.disk] ?? "quick") === "secure"
                ? "\n· secure erase"
                : "")
            : ""
        }
        variant="destructive"
      />

      {/* WARP-1048 — reclaim a pool member: remove it from the array, then wipe
          + adopt it on its own. Names the disk + its size so the owner verifies
          the target before anything runs. */}
      <ConfirmDialog
        open={reclaimConfirmOpen}
        onConfirm={handleConfirmReclaim}
        onCancel={() => {
          setReclaimConfirmOpen(false);
          setReclaimPending(null);
        }}
        title="Reclaim this drive from the pool?"
        description="This removes the drive from your storage pool, then permanently erases it and adds it to your Droplet on its own. Your pool will have one less drive and won't be protected against a drive failure until you add another. This can't be undone — make sure anything you want is backed up first."
        confirmLabel="Reclaim & erase"
        confirmedIdentifier={
          reclaimPending
            ? `${
                reclaimPending.disk.members.map((m) => driveName(m)).join(", ") ||
                reclaimPending.disk.disk
              } · ${formatBytes(reclaimPending.disk.sizeBytes)} · ${reclaimPending.disk.disk}`
            : ""
        }
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
  poolableCount,
  inUseCount,
  createError,
}: {
  raidOn: boolean;
  onToggle: () => void;
  options: ReturnType<typeof calculateRaidOptions>;
  chosenLevel: RaidLevel | null;
  onChoose: (level: RaidLevel) => void;
  members: DriveInfo[];
  /** Number of FREE physical disks that could form a pool. < 2 → nothing to
   *  combine, so we show an honest explanation instead of a dead chooser. */
  poolableCount: number;
  /** Number of physical disks excluded because they're in use by the Droplet. */
  inUseCount: number;
  createError: string | null;
}) {
  // RAID only makes sense with 2+ FREE drives; we always render the toggle so
  // the option is discoverable, but when there aren't 2 poolable disks we say
  // why (honest) rather than showing a chooser with everything greyed out.
  const canPool = poolableCount >= 2;
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

      {raidOn && !canPool && (
        <div
          className="mt-4 flex items-start gap-2 type-footnote text-label-secondary bg-surface-secondary rounded-sm px-3 py-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200"
          role="note"
        >
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0 text-label-tertiary" />
          <span>
            {inUseCount > 0
              ? "Your drives are in use by your Droplet right now, so they can't be combined into a pool here. You can set one up later from Settings › Storage."
              : "You need at least two free drives to combine them into a pool."}
          </span>
        </div>
      )}

      {raidOn && canPool && (
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
 * run blind" gate requires every member's SHORT device basename as a whole
 * TOKEN of the phrase (split on non-alphanumerics, case-sensitive — WARP-848
 * hardening; a substring match used to let `sda1` ride on a phrase naming
 * `sda10`), e.g. for ["/dev/sda","/dev/sdb"] → "ERASE sda sdb". The
 * owner-facing confirmation (role + token + destructive ConfirmDialog naming
 * each drive) is the human gate; this is the machine token that satisfies the
 * last-line script check.
 */
export function buildConfirmPhrase(members: string[]): string {
  const shorts = members
    .map((m) => m.split("/").filter(Boolean).pop() ?? "")
    .filter(Boolean);
  return `ERASE ${shorts.join(" ")}`.trim();
}

/**
 * WARP-662 — resolve a drive's device path to its WHOLE-disk kernel name (the
 * adopt route + host script wipe the whole disk, not a single partition).
 *   /dev/sda1 → sda ; /dev/nvme0n1p2 → nvme0n1 ; /dev/mmcblk0p1 → mmcblk0 ;
 *   /dev/sdb → sdb. Returns "" for an unrecognized shape (caller no-ops).
 */
export function wholeDiskName(devicePath: string): string {
  const tail = (devicePath || "").split("/").filter(Boolean).pop() ?? "";
  const nvme = tail.match(/^(nvme\d+n\d+)(p\d+)?$/);
  if (nvme) return nvme[1];
  const mmc = tail.match(/^(mmcblk\d+)(p\d+)?$/);
  if (mmc) return mmc[1];
  const sd = tail.match(/^((?:sd|vd)[a-z]+)\d*$/);
  if (sd) return sd[1];
  // Unrecognised shape (loop*, md*, dm-*, mapper names, …): NOT a whole disk
  // the adopt route / host wipe script can act on. Return "" per the contract
  // above — every caller treats falsy as "skip / no-op" (the adopt picker
  // bails, the Danger-zone reformat guard excludes it). Never leak the raw
  // tail: a truthy non-disk name lets these slip into a wipe flow and 400 at
  // the server instead of being filtered out up front.
  return "";
}

/**
 * WARP-662 / setup — a physical disk and the mounted filesystems (partitions)
 * that live on it. The reclaim + pool flows act on the WHOLE disk, so the
 * per-mount drive list the bridge returns is grouped by backing disk: a single
 * physical disk that holds two filesystems (e.g. an `nvr` + a `data` partition
 * on `sda`) is ONE reclaim/pool target — not two — and wiping it erases both.
 */
export interface PhysicalDisk {
  /** Whole-disk kernel name, e.g. "sda" / "nvme0n1". */
  disk: string;
  /** The mounted filesystems (partitions) that live on this disk. */
  members: DriveInfo[];
  /** Sum of member sizes — approximates the whole-disk capacity for the pool
   *  calculator without a second bridge round-trip. */
  sizeBytes: number;
  /** True when any member is the box's INSTALLED storage (bridge `removable:
   *  false`) — a disk the Droplet is actively using. Reclaiming/pooling it from
   *  the setup wizard is disabled (it's not a "previously-used" foreign drive);
   *  the owner manages it from Settings › Storage. A hot-plug drive
   *  (`removable: true`) or an older bridge that omits the flag stays eligible —
   *  the host script remains the real, last-line gate either way. */
  inUse: boolean;
  /** WARP-936: explicit bridge-classified state when the whole-disk inventory
   *  is available. Absent on the mounted-drives fallback path. `pool_member`
   *  is routed to the pool (never individually adoptable). */
  state?: DiskState;
  /** md array name (e.g. "md127") when state is pool_member. */
  md?: string;
}

/**
 * Group the bridge's per-filesystem drive list by backing physical disk. Order
 * is stable (first-seen). Uses the bridge's `parent_disk` when present, else
 * derives it from the device path via wholeDiskName().
 */
export function groupPhysicalDisks(list: DriveInfo[]): PhysicalDisk[] {
  const order: string[] = [];
  const map = new Map<string, PhysicalDisk>();
  for (const d of list) {
    const key = d.parent_disk || wholeDiskName(d.device) || d.device;
    let pd = map.get(key);
    if (!pd) {
      pd = { disk: key, members: [], sizeBytes: 0, inUse: false };
      map.set(key, pd);
      order.push(key);
    }
    pd.members.push(d);
    if (d.size_bytes > 0) pd.sizeBytes += d.size_bytes;
    if (d.removable === false) pd.inUse = true;
  }
  return order.map((k) => map.get(k)!);
}

/** Calm, honest copy for an adopt failure. The OS-disk refusal is the one we
 *  name specifically; a mounted/busy disk gets the actionable "in use" copy;
 *  everything else is a generic retry. Raw mkfs/wipefs messages never reach the
 *  screen. The OS-disk test uses PRECISE tokens the host script emits — NOT a
 *  bare "os"/"boot" substring, which used to match "close", "reboot", "host", …
 *  and made a plain "drive busy" refusal read as "system disk". */
export function friendlyAdoptError(err: unknown): string {
  const raw = err instanceof Error ? err.message.toLowerCase() : "";
  // eslint-disable-next-line no-console
  console.error("[storage-step:adopt]", err);
  if (/system disk|never adoptable|os\/boot|backs the os|boot disk/.test(raw)) {
    return "That's the Droplet's system disk — it can't be erased or adopted.";
  }
  if (/busy|in use|mounted|unmount|close open files|open file/.test(raw)) {
    return "That drive is in use right now — close anything using it, then try again.";
  }
  return "We couldn't reclaim that drive right now. Try again in a moment.";
}

/** Customer-facing drive name for the wizard's rows + confirm dialogs — the
 *  SHARED WARP-1337 chain (displayName → label → tail), so this can't drift
 *  from DrivesPanel/VolumesPanel again (code review). The DEVICE path feeds
 *  the tail fallback here (its tail, e.g. "sdb1", is the honest short
 *  disambiguator the reclaim rows already print — a setup-time mount can be
 *  transient); the shared helper GUID-guards it either way. */
function driveName(d: DriveInfo): string {
  return driveDisplayName({
    mount: d.device,
    label: d.label,
    displayName: d.displayName,
  });
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

/**
 * WARP-662 — optional "reclaim existing drives" block: a default-OFF switch and,
 * when ON, a per-PHYSICAL-DISK list with a quick/secure wipe choice + an
 * "Erase & adopt" button. Grouped by whole disk so a disk holding two
 * filesystems shows ONCE (and the confirm names both). The box's installed
 * storage (disk.inUse) is shown but disabled — it's in use by the Droplet, not
 * a previously-used foreign drive; the OS disk is never listed and is refused
 * server-side regardless. Pure presentation — the destructive request/confirm
 * wiring lives in the parent.
 */
function AdoptSection({
  adoptOn,
  onToggle,
  disks,
  wipeMethods,
  onWipeMethodChange,
  onAdopt,
  onReclaim,
  busyDisk,
  adoptError,
}: {
  adoptOn: boolean;
  onToggle: () => void;
  disks: PhysicalDisk[];
  wipeMethods: Record<string, "quick" | "secure">;
  onWipeMethodChange: (disk: string, m: "quick" | "secure") => void;
  onAdopt: (disk: PhysicalDisk) => void;
  /** WARP-1048: reclaim a pool member (detach from md, then adopt). */
  onReclaim: (disk: PhysicalDisk) => void;
  busyDisk: string | null;
  adoptError: string | null;
}) {
  const anyInUse = disks.some((d) => d.inUse);
  return (
    <div className="rounded-lg border border-separator p-4 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="type-callout font-medium text-label-primary">
            Reclaim existing drives
          </p>
          <p className="type-footnote text-label-secondary">
            Wipe a drive you&rsquo;ve used before and add it to this Droplet — like
            a fresh install. Everything on the drive is erased.
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={adoptOn}
          aria-label="Reclaim existing drives"
          onClick={onToggle}
          className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors ${
            adoptOn ? "bg-accent" : "bg-surface-tertiary"
          }`}
        >
          <span
            className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white transition-transform ${
              adoptOn ? "translate-x-[22px]" : "translate-x-0.5"
            }`}
          />
        </button>
      </div>

      {adoptOn && (
        <div className="space-y-2" data-testid="adopt-list">
          {disks.length === 0 ? (
            <p className="type-footnote text-label-tertiary">
              No drives detected to reclaim.
            </p>
          ) : (
            disks.map((disk) => {
              // What the disk holds, in friendly names — so the owner connects
              // "sda" to the folders on it (e.g. "Nvr, Data") and sees that a
              // wipe takes both.
              const heldNames =
                disk.members.map((m) => driveName(m)).join(", ") || disk.disk;
              const busy = busyDisk === disk.disk;
              return (
                <div
                  key={disk.disk}
                  data-testid={`adopt-row-${disk.disk}`}
                  className="flex items-center justify-between gap-3 rounded-md bg-surface-secondary px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="type-subhead text-label-primary truncate">
                      {heldNames}{" "}
                      <span className="font-mono text-label-tertiary">
                        {formatBytes(disk.sizeBytes)}
                      </span>
                    </p>
                    <p className="type-caption-2 text-label-tertiary truncate">
                      {disk.state === "pool_member"
                        ? disk.md
                          ? `In your storage pool · reclaiming removes it from the pool and erases everything on it · ${disk.disk}`
                          : `Part of your storage pool · ${disk.disk}`
                        : disk.inUse
                          ? `In use by your Droplet · ${disk.disk}`
                          : disk.members.length > 1
                            ? `${disk.disk} · wiping this disk clears all ${disk.members.length} folders on it`
                            : disk.disk}
                    </p>
                  </div>
                  {disk.state === "pool_member" ? (
                    // WARP-1048: an md member can be RECLAIMED — the host
                    // script breaks it out of the array (mdadm --fail/--remove
                    // + --zero-superblock) before wiping it, so the EBUSY a
                    // plain per-disk wipe would hit is avoided. We can only do
                    // this when the bridge named the owning array; without `md`
                    // fall back to the read-only "manage from the pool" copy.
                    disk.md ? (
                      <button
                        type="button"
                        onClick={() => onReclaim(disk)}
                        disabled={busy}
                        className="flex-none whitespace-nowrap rounded-md bg-system-red/90 hover:bg-system-red text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-system-red/40"
                      >
                        {/* WARP-1945: the label names both halves of the
                            destructive action — parity with the Drives page
                            (WARP-1915); never a bare "Reclaim". */}
                        {busy ? "Working…" : "Reclaim & erase"}
                      </button>
                    ) : (
                      <span className="flex-none whitespace-nowrap type-caption-1 text-label-tertiary">
                        In your storage pool
                      </span>
                    )
                  ) : disk.inUse ? (
                    // Installed box storage — not a "previously-used" foreign
                    // drive. Reclaiming it would tear down storage the Droplet
                    // is actively using, so it's managed from Settings, not here.
                    <span className="flex-none whitespace-nowrap type-caption-1 text-label-tertiary">
                      In use
                    </span>
                  ) : (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <select
                        aria-label={`Wipe method for ${heldNames}`}
                        className="dp-input py-1 text-sm"
                        value={wipeMethods[disk.disk] ?? "quick"}
                        onChange={(e) =>
                          onWipeMethodChange(
                            disk.disk,
                            e.target.value as "quick" | "secure",
                          )
                        }
                      >
                        <option value="quick">Quick wipe</option>
                        <option value="secure">Secure erase</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => onAdopt(disk)}
                        disabled={busy}
                        className="flex-none whitespace-nowrap rounded-md bg-system-red/90 hover:bg-system-red text-white px-3 py-1.5 text-sm font-medium disabled:opacity-60"
                      >
                        {busy ? "Working…" : "Erase & adopt"}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
          {anyInUse && (
            <p className="type-caption-1 text-label-tertiary">
              Drives your Droplet is already using stay put — manage them anytime
              from Settings &rsaquo; Storage.
            </p>
          )}
          {adoptError && (
            <div className="flex items-start gap-2 type-footnote text-system-red bg-system-red/10 rounded-sm px-3 py-2">
              <AlertCircle size={14} className="mt-0.5 flex-shrink-0" />
              <span>{adoptError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
