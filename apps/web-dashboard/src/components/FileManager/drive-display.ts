/**
 * WARP-1337 — ONE shared display-name chain for storage volumes, used by both
 * the Files screen's VolumesPanel tiles and the Storage screen's DrivesPanel
 * cards (which previously carried private, drifting copies — VolumesPanel's
 * never consulted `displayName`, so a pool mounted at /mnt/droplet/<fs-uuid>
 * showed the customer its raw GUID).
 *
 * Chain: optimistic override → customer displayName → FS label → humanized
 * mount tail. The tail fallback is GUID-guarded: a machine-generated tail
 * (full fs UUID, vfat-style hex serial, "drive-<hex>"/"pool-<hex>") is never
 * rendered — the customer sees a friendly generic instead ("Drive", or
 * "Storage pool" when the caller knows the volume is pool-backed).
 *
 * Casing intentionally mirrors DrivesPanel's pre-existing driveName() EXACTLY
 * ([-_]+ → space, then title-case each lowercase word start). WARP-832 owns
 * any casing change — do not alter it here.
 */

/** Full filesystem UUID — the tail pool_format/automount fall back to when a
 *  volume has no label (e.g. a0f10a84-7116-46a7-a3e3-5e00ea1c7d08). */
const UUID_TAIL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** vfat-style volume serial (e.g. B0C1-D2E3) — a machine id, not a name. */
const HEX_SERIAL_TAIL = /^[0-9a-f]{4}-[0-9a-f]{4}$/i;

/** Machine-generated "drive-<hex>" / "pool-<hex>" mount tails. Dashed hex
 *  segments are part of the shape: droplet-automount.sh names an unlabeled
 *  volume `drive-<first-8-UUID-chars>`, and a vfat UUID is XXXX-XXXX, so the
 *  tail comes out as e.g. "drive-B0C1-D2E" (code review, WARP-1337). A human
 *  "drive-…"/"pool-…" name survives — any non-hex segment breaks the match. */
const PREFIXED_HEX_TAIL = /^(?:drive|pool)-[0-9a-f]{2,}(?:-[0-9a-f]{1,8})*$/i;

/** True when a mount tail is machine-generated and must never be shown as a
 *  volume's title (home-user persona, ADR-002). */
/**
 * WARP-2098 — ONE usage-meter percentage, shared by the Storage screen's
 * DrivesPanel (drive cards, pool card, system-drive card) and the Files
 * screen's VolumesPanel tiles.
 *
 * These were byte-identical private copies (`usagePctOf` / `pctOf`) added in
 * the same change, which is the same duplication-drift class this ticket
 * fixed for `fmtBytes`/`formatBytes` — two meters for the same volume must
 * not be able to disagree.
 *
 * A zero or absent capacity yields 0, not NaN: NaN renders as an empty bar,
 * which reads as "0% used" rather than "unknown".
 */
export function usagePctOf(used: number, size: number): number {
  if (!size) return 0;
  return Math.max(0, Math.min(100, (used / size) * 100));
}

export function isMachineTail(tail: string): boolean {
  return UUID_TAIL.test(tail) || HEX_SERIAL_TAIL.test(tail) || PREFIXED_HEX_TAIL.test(tail);
}

/** True when a volume's backing device is an md array (or a partition of
 *  one) — i.e. the volume is pool-backed, so its nameless fallback should
 *  read "Storage pool" rather than "Drive". */
export function isPoolBackedDevice(device: string | null | undefined): boolean {
  return !!device && /^\/dev\/md\d+(p\d+)?$/.test(device);
}

/** WARP-1339: md node (/dev/md127) or a partition of one (/dev/md127p1);
 *  capture group 1 is the BARE array name — the /storage/pools join key.
 *  Anchored so /dev/md127p1 can never resolve to md12 (the same prefix-match
 *  pitfall DrivesPanel's poolHasMountedFs matcher guards). */
const MD_DEVICE_RE = /^\/dev\/(md\d+)(?:p\d+)?$/;

/** The volume fields the WARP-1339 pool↔drive join needs. */
export interface PoolJoinSource {
  device: string;
  /** Orchestrator's explicit annotation (bare md array name, or null for a
   *  standalone drive). Absent on an older orchestrator. */
  pool?: string | null;
}

/**
 * WARP-1339 — bare md array name ("md127") backing a mounted drive, or null
 * for a standalone drive. Prefers the orchestrator's explicit `pool`
 * annotation; falls back to the anchored md-device matcher so the merge
 * still happens against an older orchestrator that predates the field.
 */
export function drivePoolName(d: PoolJoinSource): string | null {
  if (d.pool) return d.pool;
  return MD_DEVICE_RE.exec(d.device)?.[1] ?? null;
}

/**
 * WARP-827 / WARP-1338 — deep link into the existing Nextcloud-backed file
 * browser at the volume's registered path. The automount service (and, as of
 * WARP-1338, droplet-storage-pool.sh at pool_format/adopt/reclaim time)
 * registers each volume as external storage at `/<mount-tail>` — the host
 * mount's last path segment — so the drive's contents are browsable at that
 * path with the user's own account (reuse, no new endpoint). FilesPage reads
 * `?path=` on mount. Shared by DrivesPanel cards and VolumesPanel tiles so
 * the target can never drift between the two surfaces.
 */
export function driveContentsHref(d: { mount: string }): string {
  const tail = d.mount.split("/").filter(Boolean).pop() ?? "";
  return `/files?path=${encodeURIComponent(`/${tail}`)}`;
}

/**
 * WARP-1339 — the mounted filesystem backing a pool: the drives-list entry
 * whose device is the pool's md node (or a partition of it). This is the
 * pool's ONLY fs-level capacity/browse source (ADR-019 — real usable
 * capacity, never a fabricated raw-member sum). The join key is normalized
 * here: `poolDevice` is the BARE array name the pools payload carries
 * ("md127"), while drive devices carry the /dev/ prefix. Prefers the md node
 * itself over a partition when both are mounted. Returns undefined when the
 * pool backs no mounted filesystem (created-but-never-formatted).
 */
export function poolBackingDrive<D extends PoolJoinSource>(
  poolDevice: string,
  drives: readonly D[],
): D | undefined {
  // Defensive: only bare md names are valid join keys (they also feed a
  // constructed template below — never build it from an arbitrary string).
  if (!/^md\d+$/.test(poolDevice)) return undefined;
  const matches = drives.filter((d) => drivePoolName(d) === poolDevice);
  return matches.find((d) => d.device === `/dev/${poolDevice}`) ?? matches[0];
}

export interface DriveNameSource {
  /** Path whose TAIL is the last-resort fallback name — the mount point for
   *  the Files/Storage panels; the setup wizard passes the device path
   *  instead (its tail, e.g. "sdb1", is the honest pre-mount disambiguator).
   *  Machine-generated tails are guarded against either way. */
  mount: string;
  /** FS-provided label from the bridge (e.g. "TOSHIBA EXT"). */
  label?: string | null;
  /** Customer-chosen friendly name from the Drive row; null until set. */
  displayName?: string | null;
}

/**
 * Customer-facing volume name. `override` lets a card show an optimistic
 * just-typed name before its data hook refetches (DrivesPanel rename);
 * `poolBacked` switches the nameless generic to "Storage pool".
 */
export function driveDisplayName(
  d: DriveNameSource,
  opts: { override?: string | null; poolBacked?: boolean } = {},
): string {
  const tail = d.mount.split("/").filter(Boolean).pop() ?? "";
  // Never surface a machine-generated tail — fall through to the generic.
  const namedTail = isMachineTail(tail) ? "" : tail;
  const raw = (opts.override || d.displayName || d.label || namedTail)
    .replace(/[-_]+/g, " ")
    .trim();
  if (!raw) return opts.poolBacked ? "Storage pool" : "Drive";
  return raw.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * WARP-1338 (UX review) — friendly label for the FIRST breadcrumb segment on
 * the Files screen. A volume deep-link lands on /files?path=/<mount-tail>;
 * for the live box's legacy pool that tail is the FULL fs UUID, and rendering
 * it raw as the current-folder crumb re-introduces the exact
 * GUID-as-primary-label the WARP-1337 chain exists to prevent — one click
 * after the GUID-guarded tile.
 *
 * Resolution: match the segment against the known volumes' mount tails and
 * run the SAME display chain the tiles/cards use (pool displayName leads for
 * a pool-backed volume, mirroring VolumesPanel's pooled-tile naming). An
 * UNMATCHED machine tail (drives payload still loading, dead link) still
 * humanizes to the generic — "Storage pool" for pool-<hex>, else "Drive" —
 * rather than leaking the GUID. A human segment returns undefined so real
 * folder names keep rendering raw.
 */
export function volumeCrumbLabel(
  segment: string,
  drives: ReadonlyArray<DriveNameSource & PoolJoinSource>,
  pools: ReadonlyArray<{ device: string; displayName?: string | null }>,
): string | undefined {
  for (const d of drives) {
    const tail = d.mount.split("/").filter(Boolean).pop();
    if (!tail || tail !== segment) continue;
    const md = drivePoolName(d);
    const pool = md ? pools.find((p) => p.device === md) : undefined;
    if (pool) {
      // Pool's OWN displayName leads; the backing drive's label / GUID-guarded
      // tail back it up (same shape as VolumesPanel's pooled tile).
      return driveDisplayName(
        { mount: d.mount, label: d.label, displayName: pool.displayName },
        { poolBacked: true },
      );
    }
    return driveDisplayName(d, { poolBacked: isPoolBackedDevice(d.device) || !!md });
  }
  if (isMachineTail(segment)) {
    return /^pool-/i.test(segment) ? "Storage pool" : "Drive";
  }
  return undefined;
}

/**
 * WARP-1337 AC4 — sanitize a customer-facing name into a filesystem label the
 * orchestrator's adopt/reclaim routes accept (^[A-Za-z0-9_-]{1,16}$). The
 * label seeds the post-wipe mount tail, so a named drive never lands back on
 * a GUID mount. Whitespace runs become "_" so multi-word names round-trip
 * through the [-_]→space humanizer above ("Family Photos" → "Family_Photos"
 * → renders "Family Photos"); everything else invalid is stripped. Returns
 * undefined when nothing usable remains — callers must then OMIT the label.
 */
export function sanitizeFsLabel(name: string | null | undefined): string | undefined {
  if (!name) return undefined;
  const cleaned = name
    // Transliterate before stripping: the server contract is ASCII-only, but
    // an accented letter should survive as its base letter ("Média" →
    // "Media"), not vanish ("Mdia"). NFKD splits the diacritic off as a
    // combining mark (\p{M}), which is then dropped before the invalid-char
    // strip below can take the whole letter with it.
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 16)
    // The cap can cut mid-word and re-introduce a trailing separator
    // ("Samsung SSD 870 EVO" → "Samsung_SSD_870_") — strip it again. Never
    // empties the result: the pre-slice strip guarantees a non-separator
    // first character (code review, WARP-1337).
    .replace(/[_-]+$/, "");
  return cleaned || undefined;
}

/**
 * Code review (WARP-1337) — every name the host could mount a volume under,
 * from the caller's current drives snapshot: the FS label AND the mount tail
 * of each volume. This is the "taken" set uniqueFsLabel() checks a seeded
 * label against. Callers EXCLUDE the volume(s) the wipe is about to erase
 * (their labels/mounts vanish with the wipe, so they can't collide).
 */
export function takenVolumeNames(
  volumes: ReadonlyArray<{ mount?: string | null; label?: string | null }>,
): string[] {
  const names: string[] = [];
  for (const v of volumes) {
    const tail = (v.mount ?? "").split("/").filter(Boolean).pop();
    if (tail) names.push(tail);
    if (v.label) names.push(v.label);
  }
  return names;
}

/**
 * Code review (WARP-1337) — shadow-mount guard for seeded FS labels.
 *
 * droplet-storage-pool.sh mounts an adopted/reclaimed drive at
 * /mnt/droplet/<LABEL> via a raw host_mount with NO busy-target guard, so
 * seeding a label another volume already carries STACKS the new mount over
 * the old one — shadowing it until reboot, with writes meant for drive A
 * silently landing on drive B. (Two identical-model drives adopted in one
 * session — 2× "Samsung T7" — is the realistic home-NAS trigger.) The ticket
 * forbids changing the host script, so the guard lives caller-side: when the
 * sanitized candidate collides (case-insensitively — vfat uppercases labels)
 * with the taken set, suffix it with the disk serial's tail (else a numeric
 * bump), truncating the base to keep the ^[A-Za-z0-9_-]{1,16}$ contract. If
 * nothing collision-free fits, return undefined — the caller OMITS the label
 * and the fs-UUID mount keeps the path unique (the udev automount already
 * uniquifies on reboot; this closes the same-session window).
 */
export function uniqueFsLabel(
  candidate: string | undefined,
  taken: Iterable<string>,
  serialHint?: string | null,
): string | undefined {
  if (!candidate) return undefined;
  const used = new Set<string>();
  for (const name of taken) used.add(name.toLowerCase());
  if (!used.has(candidate.toLowerCase())) return candidate;

  const suffixes: string[] = [];
  const serialTail = sanitizeFsLabel(serialHint)?.slice(-4);
  if (serialTail) suffixes.push(serialTail);
  for (let n = 2; n <= 9; n++) suffixes.push(String(n));

  for (const suffix of suffixes) {
    const tail = `_${suffix}`;
    const base = candidate.slice(0, 16 - tail.length).replace(/[_-]+$/, "");
    if (!base) continue;
    const next = `${base}${tail}`;
    if (!used.has(next.toLowerCase())) return next;
  }
  return undefined;
}
