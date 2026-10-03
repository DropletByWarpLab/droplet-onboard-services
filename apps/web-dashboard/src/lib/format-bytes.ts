/**
 * Human-readable byte size formatter, shared across the dashboard so sizes read
 * identically on every surface (Files, Storage, Danger Zone, context cards, the
 * onboarding walkthrough …). Previously copy-pasted into a handful of
 * components; this is the single source of truth.
 *
 * Non-positive / falsy input renders "0 B". Scales up to TB and clamps to the
 * largest unit so absurd inputs don't index past the table.
 */
export function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

/**
 * Binary maths with binary labels (KiB / MiB / GiB / TiB), the way the
 * /cameras/system page has always printed drive figures.
 *
 * That page used to divide by 1024 while labelling the result "KB"/"MB"/"GB" —
 * SI names for binary quantities, so every drive figure read ~2.4% low against
 * the label it carried (WARP-1960). Frigate reports MiB and the arrays are sized
 * in TiB, so binary is the right base and the labels were what was wrong. This
 * is that page's formatter, moved here (WARP-3515) so the Recording storage card
 * beside it prints identically instead of carrying a second copy.
 *
 * Digits scale with magnitude (2 below 10, 1 below 100, none from 100) so a
 * column of figures stays the same width. A figure it cannot trust — NaN,
 * negative, infinite — is an em dash, never "NaN GiB".
 */
export function formatBinaryBytes(b: number): string {
  if (!Number.isFinite(b) || b < 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[i]}`;
}
