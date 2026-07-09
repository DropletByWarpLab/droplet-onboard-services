/**
 * WARP-1109 — process-wide TLS re-issue hook.
 *
 * The rename endpoint (`POST /api/setup/box-name/rename`) needs to trigger a
 * cert re-issue under the box's NEW FQDN right after it claims the new name — the
 * same work the 04:00 renewal cron and the boot tick do (`tlsIssuance.runOnce()`).
 * The issuance service is composed ONCE at boot in `index.ts` (its collaborators —
 * the HQ HTTP client, the Prisma cert store, disk file ops, the nginx reloader —
 * are heavy and must not be re-composed per request). Rather than thread that
 * instance through `createApp` → `createSetupRouter`, the boot wiring registers
 * its `runOnce` here and the setup route reads it via `reissueTlsNow()`.
 *
 * Before `initTlsReissueHook` runs (dev / CI / unit tests, or an HQ-unconfigured
 * box), `reissueTlsNow()` is a no-op — a rename still persists + claims the name;
 * only the immediate re-issue is skipped (the daily cron then re-issues). Mirrors
 * `activity.singleton.ts`.
 */

/** A single idempotent, fail-soft issuance tick — `tlsIssuance.runOnce()`. */
export type TlsReissueTick = () => Promise<void>;

let reissueTick: TlsReissueTick | null = null;

/**
 * Register the composed issuance service's `runOnce` at boot. Idempotent — a
 * second call is a no-op so re-entrant boot paths (and tests) don't stack hooks.
 */
export function initTlsReissueHook(tick: TlsReissueTick): void {
  if (reissueTick) return;
  reissueTick = tick;
}

/**
 * Trigger an immediate cert re-issue under the current FQDN. Best-effort by
 * contract: a no-op when no hook is registered, and any rejection from the tick
 * propagates to the caller (the rename flow catches it — the re-issue is
 * best-effort, the daily cron retries). Never throws synchronously.
 */
export async function reissueTlsNow(): Promise<void> {
  if (!reissueTick) return;
  await reissueTick();
}

/** Exposed only for tests. */
export function _setTlsReissueHookForTests(tick: TlsReissueTick | null): void {
  reissueTick = tick;
}
