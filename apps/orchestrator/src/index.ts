import { createServer } from "node:http";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { assertFipsAtBootOrExit } from "@droplet/fips-selftest";
import { config } from "./config.js";
import { createApp } from "./app.js";
import { connectRedis } from "./services/cache.service.js";
import { connectMqtt } from "./services/mqtt.service.js";
import { initDeviceService } from "./services/device.service.js";
import { initNetworkService } from "./services/network.service.js";
import { initCameraService, shutdownCameraService } from "./services/camera.service.js";
import { attachWsBridge } from "./services/ws-bridge.service.js";
import {
  initMatterService,
  shutdownMatterService,
} from "./services/matter.service.js";
import {
  initDeviceRegistration,
  shutdownDeviceRegistration,
} from "./services/device-registration.service.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
} from "./services/health-monitor.service.js";
import { ensureMcpStarted, stopMcp } from "./services/mcp-client.singleton.js";
import { stopScreenQRPoller } from "./services/screen-qr.service.js";
import { createOuiLookup } from "./services/oui-lookup.service.js";
import { createDeviceRegistry } from "./services/device-registry.service.js";
import * as openwrt from "./services/openwrt.client.js";
import { createCronRuntime } from "./services/cron-runtime.service.js";
import { createDeviceReconcilePoller } from "./services/device-reconcile-poller.js";
import { startApDiscoveryPoller } from "./services/ap-discovery-poller.js";
import { sweepExpiredGuests } from "./services/guest-expiry-sweep.service.js";
import {
  createScheduleTicker,
  type FirewallClient,
} from "./services/schedule-ticker.js";
import {
  purgeScheduleEvents,
  purgeExpiredOverrides,
} from "./services/schedule-purge.js";
import { tickToolSchedules } from "./services/tool-schedule-ticker.service.js";
import { mcpClient } from "./services/mcp-client.singleton.js";
import type { StepDispatcher } from "./services/tool-spec-runner.service.js";
import { mineToolCallPatterns } from "./services/pattern-miner.service.js";
import { startContextStatsInvalidator } from "./services/context-stats-invalidation.service.js";
import { initActivityRecorder, recordActivity } from "./services/activity.singleton.js";
import { attachFileIndexerActivityBridge } from "./services/activity-file-indexer-bridge.js";
import { ensureDefaultModelPulled } from "./services/model-readiness.service.js";

const logger = pino({ name: "orchestrator" });

// WARP-229: FIPS 140-3 boot self-test. Runs synchronously before any
// async crypto operation (Prisma connect, TLS to Redis/MQTT, etc.).
//
// Gate: `DROPLET_FIPS_REQUIRED` env var. Default behavior:
//   - "true" / "1" / unset-in-container        → enforce; exit 1 on failure
//   - "false" / "0" / dev (NODE_ENV !== "production") → skip with a warning
//
// Default to ENFORCING in production. Container Dockerfile sets
// `OPENSSL_CONF=/etc/ssl/openssl-fips.cnf` and the bookworm-slim image
// has the OpenSSL FIPS provider available; the only way the self-test
// can fail at this point is a misconfiguration in the image, which we
// want to catch immediately rather than at first real crypto use.
function runFipsBootSelfTest(): void {
  const required =
    process.env.DROPLET_FIPS_REQUIRED?.toLowerCase() === "true" ||
    process.env.DROPLET_FIPS_REQUIRED === "1" ||
    (process.env.DROPLET_FIPS_REQUIRED === undefined &&
      process.env.NODE_ENV === "production");
  if (!required) {
    logger.warn(
      "FIPS boot self-test skipped (DROPLET_FIPS_REQUIRED=false or non-production env)",
    );
    return;
  }
  // assertFipsAtBootOrExit logs structured JSON + exits non-zero on
  // failure; if it returns, the provider is loaded AND enforcing.
  assertFipsAtBootOrExit("orchestrator");
}

async function main() {
  runFipsBootSelfTest();

  // Initialize Prisma
  const prisma = new PrismaClient();
  await prisma.$connect();
  logger.info("Connected to PostgreSQL");

  // WARP-456: initialize the signed activity recorder. Boot-fatal —
  // an orchestrator that can't sign audit rows must NOT start.
  initActivityRecorder(prisma);
  // Genesis-or-restart event so the first row of every container's
  // lifetime is always a `system` start-up. Makes the chain easier to
  // segment in the dashboard's activity feed.
  await recordActivity({
    kind: "system",
    severity: "info",
    sourceIcon: "power",
    what: "Orchestrator started",
    sub: `pid ${process.pid}`,
  });
  logger.info("Activity recorder initialized");

  // Initialize services
  initDeviceService(prisma);

  // Start periodic device self-registration (detects hostname, IP, hardware)
  await initDeviceRegistration(prisma);

  // Connect Redis (non-fatal if unavailable)
  try {
    await connectRedis();
    logger.info("Connected to Redis");
  } catch (err) {
    logger.warn("Redis unavailable, running without cache");
  }

  // Connect MQTT (non-fatal if unavailable)
  try {
    await connectMqtt();
  } catch (err) {
    logger.warn("MQTT broker unavailable");
  }

  // WARP-225: subscribe to file-indexer's
  // `droplet/context-stats/invalidate` events so per-user dashboard
  // caches drop within the next round-trip on a write. Best-effort —
  // if MQTT is down we still bound staleness via the cache TTL.
  startContextStatsInvalidator();

  // WARP-456: bridge file-indexer MQTT events into ActivityRow so the
  // sealed audit log captures filesystem activity. Subscribes to
  // `droplet/index/+/indexed` and `droplet/index/+/deleted`. Best-
  // effort like the bridge above — if MQTT is down we miss the rows.
  attachFileIndexerActivityBridge();

  // Initialize Matter controller (non-fatal if unavailable)
  try {
    await initMatterService();
    logger.info("Matter controller initialized");
  } catch (err) {
    logger.warn("Matter controller unavailable: %s", (err as Error).message);
  }

  // Connect OpenWrt router (non-fatal if unavailable)
  try {
    await initNetworkService();
    logger.info("Connected to OpenWrt router");
  } catch (err) {
    logger.warn("OpenWrt router unavailable, network features disabled");
  }

  // Connect Frigate NVR (non-fatal if unavailable)
  try {
    await initCameraService(prisma);
    logger.info("Connected to Frigate NVR");
  } catch (err) {
    logger.warn("Frigate NVR unavailable, camera features disabled");
  }

  // WARP-43: begin background polling of component health. Non-blocking —
  // the first snapshot is seeded immediately and the poller keeps running.
  startHealthMonitor(prisma);

  // WARP-101: spawn the MCP stdio child so /api/llm/chat can drive the
  // orchestrator agent loop. Non-fatal: if the child crashes the chat
  // route falls through to "no tools available" and surfaces the error
  // to the model. SIGTERM/SIGINT below stops the child on shutdown.
  try {
    await ensureMcpStarted();
    logger.info("MCP stdio child started");
  } catch (err) {
    logger.warn("MCP stdio child failed to start: %s", (err as Error).message);
  }

  // First-boot model readiness: if LLM_MODEL is set and Ollama doesn't
  // have it yet, fire a background pull so the user lands on a working
  // dashboard ~20 min after first boot without any manual `ollama pull`.
  // Non-blocking — the orchestrator is fully serving requests while the
  // model downloads in the background. See model-readiness.service.ts.
  try {
    await ensureDefaultModelPulled();
  } catch (err) {
    logger.warn(
      "Model readiness check failed: %s (orchestrator continues serving requests)",
      (err as Error).message,
    );
  }

  // WARP-81: device-intelligence reconciler. Loads the bundled OUI CSV once
  // at startup (best-effort — missing file is logged, lookups degrade to
  // null) and constructs the registry that drives NetworkDevice /
  // DevicePresenceDay from DHCP + wireless + firewall snapshots.
  const ouiCsvPath =
    process.env.OUI_CSV_PATH ?? path.resolve(process.cwd(), "data/oui.csv");
  const ouiLookup = createOuiLookup(ouiCsvPath);
  const deviceRegistry = createDeviceRegistry(prisma, ouiLookup);

  // WARP-93: Phase 2 scheduling runtime. Every 30s the ticker diffs
  // the desired blocked state (from computeDesiredBlocked) against the
  // live firewall state and dispatches block/unblock via the openwrt
  // client. A daily 03:00 cron purges old schedule events (>7d) and
  // long-expired overrides (>24h past endAt).
  const firewall: FirewallClient = {
    async block(mac) {
      await openwrt.blockDevice(mac);
    },
    async unblock(mac) {
      await openwrt.unblockDevice(mac);
    },
  };
  // Critical fix #1: pass prisma so `scheduleInterval`/`scheduleCron` can
  // acquire a pg advisory lock per tick. In multi-instance deploys (K8s
  // replicas, warm standby) only the replica that wins the lock runs
  // the handler; the others silently skip. Each distinct cron task gets
  // its own lock key so they don't starve each other.
  const cronRuntime = createCronRuntime(prisma);
  const scheduleTicker = createScheduleTicker(prisma, firewall);
  const tickMs = Number(process.env.SCHEDULE_TICK_MS ?? 30_000);
  cronRuntime.scheduleInterval(
    tickMs,
    () => scheduleTicker.tickOnce(),
    { lockKey: "droplet:schedule-ticker" },
  );

  // WARP-89: device-intelligence reconciler poller + daily presence purge.
  // Reuses the same cron runtime as the schedule ticker. The poller pulls
  // DHCP + wireless + firewall snapshots from the routing service every
  // `DEVICE_RECONCILE_MS` (default 10s) and feeds them into the registry
  // from WARP-81; the 03:00 purge drops `DevicePresenceDay` rows older
  // than 30 days per spec §5.4.
  const reconcileMs = Number(process.env.DEVICE_RECONCILE_MS ?? 10_000);
  const reconcilePoller = createDeviceReconcilePoller(
    deviceRegistry,
    openwrt,
    reconcileMs,
  );
  cronRuntime.scheduleInterval(
    reconcileMs,
    () => reconcilePoller.pollOnce(),
    { lockKey: "droplet:device-reconcile-poller" },
  );
  logger.info({ reconcileMs }, "device reconcile poller started");

  // WARP-463 (C2): tool-schedule-ticker. Every 60s scans due
  // ToolSchedule rows, dispatches via the imperative walker shared
  // with run-now. Multi-instance deploys lock on `droplet:tool-
  // schedule-ticker` so only one replica fires each due schedule.
  const toolSchedulerDispatcher: StepDispatcher = {
    async call(tool, args) {
      const result = await mcpClient.callTool(tool, args);
      if (result.isError) {
        const detail = result.content?.[0]?.text ?? "tool reported error";
        throw new Error(typeof detail === "string" ? detail : String(detail));
      }
      const text = result.content?.[0]?.text;
      if (typeof text === "string" && text.length > 0) {
        try {
          return JSON.parse(text);
        } catch {
          return { raw: text };
        }
      }
      return null;
    },
  };
  cronRuntime.scheduleInterval(
    60_000,
    async () => {
      await tickToolSchedules(prisma, toolSchedulerDispatcher);
    },
    { lockKey: "droplet:tool-schedule-ticker" },
  );

  // WARP-446 (AC #1): mDNS coverage-extender discovery. Every
  // DROPLET_AP_DISCOVERY_INTERVAL seconds (default 10 s) the poller
  // queries the routing service's /aps/discovered endpoint and
  // upserts each observed MAC into ApDevice via reconcileDiscovered.
  // New extenders surface as AWAITING_APPROVAL within one tick — well
  // inside the 30 s AC #1 budget. Same advisory-lock pattern as the
  // schedule ticker / reconcile poller above so multi-instance
  // deploys don't double-fire.
  const apDiscoveryIntervalMs = config.DROPLET_AP_DISCOVERY_INTERVAL * 1000;
  startApDiscoveryPoller(cronRuntime, prisma, openwrt, apDiscoveryIntervalMs);

  cronRuntime.scheduleCron(
    "0 3 * * *",
    async () => {
      const eventsDeleted = await purgeScheduleEvents(prisma, 7);
      const overridesDeleted = await purgeExpiredOverrides(prisma, 24);
      const presenceDeleted = await deviceRegistry.purgePresenceRows(30);
      logger.info(
        {
          eventsDeleted,
          overridesDeleted,
          presenceDeleted: presenceDeleted.count,
        },
        "daily purges complete",
      );
    },
    { lockKey: "droplet:daily-purge" },
  );

  // WARP-455: nightly guest-expiry sweep. Fires 15 minutes after the
  // daily purge so the two cron jobs don't contend on the advisory
  // lock pool. Flips any ACTIVE GuestExpiry row past its expiresAt to
  // EXPIRED, emitting one auth-kind ActivityRow per flip. Idempotent
  // by construction (re-runs on the same minute walk zero rows).
  cronRuntime.scheduleCron(
    "15 3 * * *",
    async () => {
      const { expired } = await sweepExpiredGuests(prisma, new Date());
      if (expired > 0) {
        logger.info({ expired }, "guest-expiry-sweep flipped rows");
      }
    },
    { lockKey: "droplet:guest-expiry-sweep" },
  );

  // WARP-464 (C3): hourly tool-call pattern miner. Reads the last
  // 7 days of kind=tool_call ActivityRow rows, detects repeating
  // N-gram sequences (N=2..5, ≥3 occurrences), writes ToolSpec rows
  // with status=suggested. Dedupe is by SHA-256 fingerprint slug, so
  // re-running the same hour writes zero rows the second time.
  //
  // Let errors propagate naked to cron-runtime's `safeRun` — it logs +
  // increments the per-handler consecutiveFailures counter that
  // downstream alerting reads. Swallowing here would zero out the
  // counter and silence the canary; every other cron handler in this
  // file follows the same pattern.
  cronRuntime.scheduleCron(
    "0 * * * *",
    async () => {
      const result = await mineToolCallPatterns(prisma);
      if (result.inserted > 0) {
        logger.info(result, "pattern-miner produced suggestions");
      }
    },
    { lockKey: "droplet:pattern-miner-hourly" },
  );

  // Start Express on top of a raw http.Server so we can attach the
  // WebSocket bridge (MQTT → browser) to the same listen socket.
  const app = createApp(prisma);
  const server = createServer(app);
  attachWsBridge(server);
  server.listen(config.PORT, () => {
    logger.info("API server listening on port %d", config.PORT);
  });

  // Graceful shutdown
  const shutdown = async () => {
    logger.info("Shutting down...");
    cronRuntime.stop();
    stopHealthMonitor();
    // WARP-165: stop the screen-QR poller's setInterval so integration
    // test suites that drive `createApp()` end-to-end don't leak the
    // timer (the handle is unref'd so it doesn't block process exit in
    // production, but explicit stop keeps shutdown ordering predictable).
    stopScreenQRPoller();
    shutdownDeviceRegistration();
    await shutdownMatterService();
    await shutdownCameraService();
    // Stop the MCP stdio child first so it doesn't keep its Prisma
    // connection pool alive past our $disconnect below. stopMcp() is
    // best-effort; even if the SDK close hangs we time out via
    // process.exit(0) regardless.
    await stopMcp().catch((err) => {
      logger.warn("MCP stdio child stop failed: %s", (err as Error).message);
    });
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  logger.fatal({ err }, "Failed to start API server");
  process.exit(1);
});
