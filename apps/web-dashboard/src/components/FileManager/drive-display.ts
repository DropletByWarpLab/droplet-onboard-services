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

/** Machine-generated "drive-<hex>" / "pool-<hex>" mount tails. */
const PREFIXED_HEX_TAIL = /^(?:drive|pool)-[0-9a-f]{4,}$/i;

/** True when a mount tail is machine-generated and must never be shown as a
 *  volume's title (home-user persona, ADR-002). */
export function isMachineTail(tail: string): boolean {
  return UUID_TAIL.test(tail) || HEX_SERIAL_TAIL.test(tail) || PREFIXED_HEX_TAIL.test(tail);
}

/** True when a volume's backing device is an md array (or a partition of
 *  one) — i.e. the volume is pool-backed, so its nameless fallback should
 *  read "Storage pool" rather than "Drive". */
export function isPoolBackedDevice(device: string | null | undefined): boolean {
  return !!device && /^\/dev\/md\d+(p\d+)?$/.test(device);
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
    .slice(0, 16);
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
