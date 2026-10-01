/**
 * The shipped-box posture signal, `DROPLET_ENV`.
 *
 * setup.sh writes `DROPLET_ENV=production` on every provisioning path
 * (generate_env fresh; migrate_env backfills existing installs), so it is the
 * one env value that reliably says "this is a real box". `NODE_ENV` is not:
 * nothing sets it on a box (WARP-2551), and config.ts defaults it to
 * `development`.
 *
 * Standalone (no imports) on purpose, like lib/device-secret.ts: config.ts and
 * the services both use it, and many tests `vi.mock("../config.js")` with a
 * partial object — a helper exported only from config.ts would vanish under
 * those mocks.
 */

/** PURE — the shipped-box posture signal (mirrors ai-gateway
 *  keystore._is_production). */
export function isShippedDropletEnv(v: string | undefined): boolean {
  const t = (v ?? "").trim().toLowerCase();
  return t === "production" || t === "prod";
}
