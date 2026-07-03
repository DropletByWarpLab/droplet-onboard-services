/**
 * WARP-615 — analytics façade: Noop selection, fail-open wrapper, singleton.
 *
 * FAIL-OPEN CONTRACT (decision D5): analytics can NEVER throw into business
 * logic. Two layers enforce it:
 *
 *   1. Selection — disabled (`ANALYTICS_ENABLED=false`) or unconfigured
 *      (no URL, or neither ingest token nor provisioning code) boxes get
 *      `NoopAnalytics` plus exactly ONE info log at boot, then behave as if
 *      this module didn't exist.
 *   2. `wrapFailOpen` — an active agent is wrapped so every façade call
 *      swallows sync throws AND async rejections (first failure logged at
 *      warn, the rest at debug — a flapping portal must not spam logs).
 *
 * Call sites import the `analytics` proxy (or `getAnalytics()`); boot calls
 * `initAnalytics()` once so the selection log lands at startup.
 */
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { AnalyticsAgent } from "./agent.js";
import { AnalyticsClient, machineIdFromIngestToken } from "./client.js";
import type {
  Analytics,
  AnalyticsErrorInput,
  AnalyticsEventInput,
  AnalyticsLlmRecord,
  AnalyticsServiceRecord,
} from "./types.js";

export type * from "./types.js";
export { AnalyticsAgent } from "./agent.js";
export {
  AnalyticsApiError,
  AnalyticsClient,
  machineIdFromIngestToken,
} from "./client.js";

/**
 * Reported as `X-Droplet-FW` on every portal request. Matches the version
 * routes/health.ts reports (and package.json). A single canonical runtime
 * version source doesn't exist yet — when one lands, both should read it.
 */
const ORCHESTRATOR_FW_VERSION = "0.1.0";

/** Minimal logging surface — pino satisfies it; tests inject a fake. */
export interface AnalyticsLog {
  info(msg: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

const logger: AnalyticsLog = createLogger("analytics");

/** Selected when analytics is disabled or unconfigured. Pure no-op. */
export class NoopAnalytics implements Analytics {
  event(_input: AnalyticsEventInput): void {}
  metric(
    _name: string,
    _value: number,
    _labels?: Record<string, string>,
  ): void {}
  error(_input: AnalyticsErrorInput): void {}
  recordLlm(_record: AnalyticsLlmRecord): void {}
  recordService(_record: AnalyticsServiceRecord): void {}
}

/**
 * Wrap an Analytics implementation so no façade call can ever throw or leak
 * an unhandled rejection into the caller. The first swallowed failure logs
 * at warn (so a broken portal is visible once), subsequent ones at debug.
 */
export function wrapFailOpen(inner: Analytics, log: AnalyticsLog): Analytics {
  let firstFailureLogged = false;
  const swallow = (err: unknown): void => {
    if (!firstFailureLogged) {
      firstFailureLogged = true;
      log.warn(
        { err },
        "analytics emit failed — fail-open, business path unaffected (further failures logged at debug)",
      );
    } else {
      log.debug({ err }, "analytics emit failed (fail-open)");
    }
  };
  const guard = (fn: () => unknown): void => {
    try {
      const out = fn();
      // Defensive: façade methods are declared void, but if an underlying
      // implementation returns a promise, its rejection must not go
      // unhandled either. Duck-type `.then` rather than `instanceof Promise`
      // — cross-realm promises and library thenables fail the instanceof
      // check (PR #802 review). Promise.resolve assimilates any thenable.
      if (typeof (out as { then?: unknown } | null | undefined)?.then === "function") {
        void Promise.resolve(out).catch(swallow);
      }
    } catch (err) {
      swallow(err);
    }
  };
  return {
    event: (input) => guard(() => inner.event(input)),
    metric: (name, value, labels) => guard(() => inner.metric(name, value, labels)),
    error: (input) => guard(() => inner.error(input)),
    recordLlm: (record) => guard(() => inner.recordLlm(record)),
    recordService: (record) => guard(() => inner.recordService(record)),
  };
}

/** Boot inputs — a plain shape (not the config module) so tests inject it. */
export interface AnalyticsInit {
  enabled: boolean;
  url: string;
  ingestToken: string;
  provisioningCode: string;
  /** Used for `X-Droplet-Id` only when no machine id is derivable from the
   * ingest token; WARP-616's persisted AnalyticsIdentity supersedes both. */
  fallbackDropletId: string;
  firmwareVersion: string;
}

export function createAnalytics(
  init: AnalyticsInit,
  log: AnalyticsLog = logger,
): Analytics {
  // Structural fail-open (PR #802 review): the module contract "analytics
  // can NEVER throw into business logic" must hold against FUTURE editors of
  // this construction path, not by inspection of today's non-throwing code.
  // WARP-616 edits exactly this path (persisted identity / token
  // supersession); a throw here would otherwise escape into the first
  // business call site — or crash boot via initAnalytics(). A broken
  // analytics setup degrades to Noop, never to a broken orchestrator.
  try {
    return buildAnalytics(init, log);
  } catch (err) {
    log.warn(
      { err },
      "analytics init failed — falling back to no-op (fail-open)",
    );
    return new NoopAnalytics();
  }
}

function buildAnalytics(init: AnalyticsInit, log: AnalyticsLog): Analytics {
  if (!init.enabled) {
    log.info(
      "analytics: disabled (ANALYTICS_ENABLED=false) — fleet telemetry is a no-op",
    );
    return new NoopAnalytics();
  }
  const missing: string[] = [];
  if (init.url.trim() === "") missing.push("ANALYTICS_URL");
  if (init.ingestToken.trim() === "" && init.provisioningCode.trim() === "") {
    missing.push("ANALYTICS_INGEST_TOKEN or ANALYTICS_PROVISIONING_CODE");
  }
  if (missing.length > 0) {
    log.info(
      `analytics: enabled but not configured (missing ${missing.join(", ")}) — fleet telemetry is a no-op`,
    );
    return new NoopAnalytics();
  }

  const client = new AnalyticsClient({
    baseUrl: init.url,
    ingestToken: init.ingestToken,
    // §0: X-Droplet-Id must match the token's machine, so prefer the id
    // embedded in a pre-set token over the box-local fallback.
    dropletId:
      machineIdFromIngestToken(init.ingestToken) ?? init.fallbackDropletId,
    firmwareVersion: init.firmwareVersion,
  });
  const agent = new AnalyticsAgent({ client });
  agent.start(); // inert today — WARP-616/617 attach registration + flush here
  return wrapFailOpen(agent, log);
}

// ── Process-wide singleton (mirrors activity.singleton.ts) ────────────────

let singleton: Analytics | null = null;

/** Lazy singleton — first call selects Noop/active and logs once. */
export function getAnalytics(): Analytics {
  if (!singleton) {
    singleton = createAnalytics({
      enabled: config.ANALYTICS_ENABLED,
      url: config.ANALYTICS_URL,
      ingestToken: config.ANALYTICS_INGEST_TOKEN,
      provisioningCode: config.ANALYTICS_PROVISIONING_CODE,
      fallbackDropletId: config.DROPLET_DEVICE_ID,
      firmwareVersion: ORCHESTRATOR_FW_VERSION,
    });
  }
  return singleton;
}

/** Boot hook (src/index.ts). Idempotent — forces the one selection log. */
export function initAnalytics(): void {
  getAnalytics();
}

/**
 * The façade call sites import. Delegates per call so import order never
 * matters (same reasoning as activity.singleton.ts's recordActivity).
 */
export const analytics: Analytics = {
  event: (input) => getAnalytics().event(input),
  metric: (name, value, labels) => getAnalytics().metric(name, value, labels),
  error: (input) => getAnalytics().error(input),
  recordLlm: (record) => getAnalytics().recordLlm(record),
  recordService: (record) => getAnalytics().recordService(record),
};

/** Exposed only for tests. */
export function _resetAnalyticsForTests(): void {
  singleton = null;
}
