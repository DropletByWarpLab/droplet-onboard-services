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
