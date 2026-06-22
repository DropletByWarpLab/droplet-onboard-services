/**
 * ADR-023 PR-1 (Gap 3) — boot/post-setup TLS-issuance tick.
 *
 * The tls-issuance service is wired to `scheduleCron("0 4 * * *")` in index.ts.
 * On a fresh reflash that means the box could wait up to 24h before it first
 * tries to obtain its publicly-trusted cert. This helper fires ONE immediate,
 * idempotent, fail-soft `runOnce()` shortly after boot so a just-provisioned
 * box gets its cert within seconds instead of by tomorrow morning.
 *
 * Design constraints (all enforced + tested):
 *   - GATED on HQ being configured — a no-op on dev laptops / CI (where
 *     `HQ_ISSUANCE_URL` is empty), so this never reaches out spuriously. The
 *     service's own provisioned-guard short-circuits an un-provisioned box
 *     cleanly inside runOnce(); here we only gate on the HQ URL.
 *   - DELAYED (~30s default) so the rest of boot (DB, MQTT, MCP) settles first.
 *   - `unref()`'d so the one-shot timer never holds the event loop open / blocks
 *     a clean shutdown.
 *   - FAIL-SOFT: a rejected runOnce is caught + warned. Deliberately NOT routed
 *     through cron-runtime's `safeRun`, so a boot-time HQ hiccup never increments
 *     the per-handler canary (consecutiveFailures) the 04:00 cron owns. The
 *     04:00 `scheduleCron` is left entirely untouched.
 */
import type { TlsLogger } from "./tls-issuance.service.js";

/** Default boot-tick delay (ms). Overridable via TLS_BOOT_TICK_DELAY_MS. */
export const TLS_BOOT_TICK_DELAY_MS = Number(
  process.env.TLS_BOOT_TICK_DELAY_MS ?? 30_000,
);

export interface TlsBootTickOptions {
  /** `!!config.HQ_ISSUANCE_URL` — gate the tick to boxes wired for live issuance. */
  hqConfigured: boolean;
  /** The service's runOnce — same one the 04:00 cron calls. */
  runOnce: () => Promise<void>;
  /** Delay before the single tick fires. */
  delayMs?: number;
  logger: TlsLogger;
  /** Injectable for tests; defaults to the global setTimeout. */
  setTimeoutFn?: typeof setTimeout;
}

/**
 * Schedule the one-shot boot tick. Returns the timer handle (already `unref`'d)
 * so callers can clear it on shutdown, or `null` when HQ is unconfigured and no
 * tick was scheduled.
 */
export function scheduleTlsBootTick(
  opts: TlsBootTickOptions,
): NodeJS.Timeout | null {
  const {
    hqConfigured,
    runOnce,
    delayMs = TLS_BOOT_TICK_DELAY_MS,
    logger,
    setTimeoutFn = setTimeout,
  } = opts;

  if (!hqConfigured) {
    // Dev / CI / un-provisioned-for-HQ box — nothing to do at boot.
    return null;
  }

  const handle = setTimeoutFn(() => {
    // Fire-and-forget; every failure is caught + warned so a boot-time HQ
    // hiccup can never surface as an unhandled rejection (which would crash the
    // process) nor churn the cron canary.
    runOnce().catch((err) => {
      logger.warn(
        { err },
        "tls-issuance: boot tick failed (non-fatal — the 04:00 cron will retry)",
      );
    });
  }, delayMs);

  // Never let the one-shot timer hold the event loop open or block shutdown.
  handle.unref();
  return handle;
}
