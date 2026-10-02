/**
 * WARP-2985 — the one definition of "DEVICE_SECRET is unusable".
 *
 * DEVICE_SECRET keys the setup claim-code hashes, clip share URLs and (in
 * ai-gateway) the BYOK keystore. A missing value, or any value that is
 * published in this repository, makes every one of those computable offline.
 * The public values are the `.env.example` placeholder and every literal that
 * a code path or dev compose file ever fell back to.
 *
 * Standalone (no imports) on purpose: config.ts and the services both use it,
 * and many tests `vi.mock("../config.js")` with a partial object — a helper
 * exported from config.ts would vanish under those mocks.
 */
export const PUBLIC_DEVICE_SECRET_VALUES: ReadonlySet<string> = new Set([
  "change-me",
  "dev-only-not-secure",
  "dev-secret-change-in-production",
  "dev-only-device-secret-do-not-ship",
]);

/** PURE — true when `v` must never be used as DEVICE_SECRET. */
export function isWeakDeviceSecret(v: unknown): boolean {
  if (typeof v !== "string") return true;
  const t = v.trim();
  return t === "" || PUBLIC_DEVICE_SECRET_VALUES.has(t);
}
