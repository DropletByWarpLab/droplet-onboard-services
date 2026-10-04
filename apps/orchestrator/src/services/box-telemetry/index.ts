/**
 * WARP-3504 (ADR-068) — boot wiring for the box telemetry sender: pick the
 * mode, build the buffer and the collectors, attach the three feeds (the pino
 * tap, the update agent's check and status observers) and register the three
 * schedules on cron-runtime. Imported by index.ts main() and routes/telemetry.ts;
 * importing it starts nothing.
 *
 * Modes (an explicit `state` on GET /api/telemetry/last, never inferred):
 *   disabled      DROPLET_TELEMETRY_DISABLED=1, a lab/dev kill switch
 *   unconfigured  no HQ_ISSUANCE_URL, so no token can ever be minted (dev/CI)
 *   otherwise     the sender runs; the link state follows what HQ and the
 *                 portal answer
 */
import { existsSync } from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@prisma/client";
import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { TELEMETRY_LOGGER_NAME, setLogTapSink } from "../../lib/log-tap.js";
import { fetchGpuTelemetry } from "../../lib/gpu-telemetry.js";
import { recordActivity } from "../activity.singleton.js";
import type { CronRuntime } from "../cron-runtime.service.js";
import type { HqTokenService } from "../hq-token.service.js";
import { dockerSocketRequest } from "../update-agent/host-exec.js";
import { onUpdateCheck } from "../update-agent/poller.js";
import { onDeviceUpdateTransition } from "../update-agent/transitions.js";
import {
  HEARTBEAT_INTERVAL_MS,
  WATCH_INTERVAL_MS,
  createBoxTelemetry,
  inertBoxTelemetry,
  type BoxTelemetry,
} from "./sender.js";
import { createCollectors } from "./sources.js";
import { TelemetryStore } from "./spool.js";

const DOCKER_SOCKET = "/var/run/docker.sock";
/** 23:55 local: the day's counters, before the next day's begin. */
const DAILY_SUMMARY_CRON = "55 23 * * *";

/**
 * The portal origin. The fleet-agent reads this same variable with `/api/v1`
 * on the end, so a value of that older shape is accepted and trimmed.
 */
export function portalOrigin(raw: string): string {
  return raw.trim().replace(/\/+$/, "").replace(/\/api\/v1$/, "").replace(/\/+$/, "");
}

let current: BoxTelemetry | null = null;

/** The running sender, or null before boot wiring (tests, dev tools). */
export function getBoxTelemetry(): BoxTelemetry | null {
  return current;
}

export async function startBoxTelemetry(opts: {
  prisma: PrismaClient;
  cron: Pick<CronRuntime, "scheduleInterval" | "scheduleCron">;
  /** Null when HQ is not configured. */
  hqTokens: HqTokenService | null;
}): Promise<BoxTelemetry> {
  const log = createLogger(TELEMETRY_LOGGER_NAME);
  if (config.DROPLET_TELEMETRY_DISABLED) {
    log.info("box telemetry is off: DROPLET_TELEMETRY_DISABLED is a lab/dev switch");
    return (current = inertBoxTelemetry("disabled"));
  }
  if (!opts.hqTokens) {
    log.info("box telemetry is idle: HQ_ISSUANCE_URL is empty, so no HQ token can be issued");
    return (current = inertBoxTelemetry("unconfigured"));
  }

  // Beside the OTA state: both are this box's dealings with Warp, both live on
  // a volume that survives an orchestrator recreate and that a factory reset wipes.
  const store = new TelemetryStore(
    path.join(config.DROPLET_OTA_UPDATES_DIR, "telemetry", "state.json"),
    Date.now,
    (msg) => log.warn({}, msg),
  );
  await store.load();

  const telemetry = createBoxTelemetry({
    hqTokens: opts.hqTokens,
    portalBase: portalOrigin(config.DROPLET_TELEMETRY_PORTAL_URL),
    store,
    collectors: createCollectors({
      prisma: opts.prisma,
      docker: existsSync(DOCKER_SOCKET) ? dockerSocketRequest(DOCKER_SOCKET) : null,
      fetchGpu: fetchGpuTelemetry,
      diskPaths: [config.DROPLET_OTA_UPDATES_DIR, "/"],
    }),
    record: recordActivity,
    log,
  });

  setLogTapSink((record) => telemetry.recordLog(record));
  onUpdateCheck((result) => telemetry.recordOtaCheck(result));
  onDeviceUpdateTransition((t) => telemetry.recordUpdateTransition(t));

  telemetry.start();
  opts.cron.scheduleInterval(HEARTBEAT_INTERVAL_MS, () => telemetry.heartbeatTick(), { immediate: true });
  opts.cron.scheduleInterval(WATCH_INTERVAL_MS, () => telemetry.watchTick());
  opts.cron.scheduleCron(DAILY_SUMMARY_CRON, () => telemetry.dailyTick());
  log.info({ portalHost: telemetry.snapshot().portalHost }, "box telemetry started");
  return (current = telemetry);
}
