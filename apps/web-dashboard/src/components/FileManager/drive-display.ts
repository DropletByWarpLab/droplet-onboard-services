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
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Za-z0-9_-]/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 16);
  return cleaned || undefined;
}
