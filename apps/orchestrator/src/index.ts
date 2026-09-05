import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { assertFipsAtBootOrExit } from "@droplet/fips-selftest";
import { config } from "./config.js";
import { internalTlsEnabled, httpsServerOptions } from "./lib/internal-tls.js";
import { createApp } from "./app.js";
import { connectRedis } from "./services/cache.service.js";
import { connectMqtt } from "./services/mqtt.service.js";
import { initDeviceService } from "./services/device.service.js";
import { initNetworkService } from "./services/network.service.js";
import { initCameraService, shutdownCameraService } from "./services/camera.service.js";
import { attachWsBridge } from "./services/ws-bridge.service.js";
import { attachClientDispatchBridge } from "./services/client-dispatch.service.js";
import {
  initMatterService,
  shutdownMatterService,
  setPrismaForMatter,
} from "./services/matter.service.js";
import {
  initDeviceRegistration,
  shutdownDeviceRegistration,
} from "./services/device-registration.service.js";
import {
  startHealthMonitor,
  stopHealthMonitor,
  onHealthSnapshot,
} from "./services/health-monitor.service.js";
import {
  ensureMcpStarted,
  ensureRemoteMcpAttached,
  stopMcp,
} from "./services/mcp-client.singleton.js";
import { stopScreenQRPoller } from "./services/screen-qr.service.js";
import { createOuiLookup } from "./services/oui-lookup.service.js";
import { createDeviceRegistry } from "./services/device-registry.service.js";
import * as openwrt from "./services/openwrt.client.js";
import { createCronRuntime } from "./services/cron-runtime.service.js";
import {
  AGENT_RUN_LOCK_KEY,
  createAgentRunWorker,
} from "./services/agent-run-worker.service.js";
import {
  AGENT_RUN_SCHEDULE_LOCK_KEY,
  tickAgentRunSchedules,
} from "./services/agent-run-schedule-ticker.service.js";
import * as aiGateway from "./services/ai-gateway.client.js";
import { runBusinessReviewCheck } from "./services/business-review-nudge.service.js";
import { createDeviceReconcilePoller } from "./services/device-reconcile-poller.js";
import { startApDiscoveryPoller } from "./services/ap-discovery-poller.js";
import { startFabricMemberReconciler } from "./services/fabric-member-reconciler.js";
import { startWifiIntentConverger } from "./services/wifi-intent-converger.js";
import { sweepExpiredGuests } from "./services/guest-expiry-sweep.service.js";
import {
  reconcileDepartments,
  initReconcileKick,
} from "./services/department-reconciler.service.js";
import { seedHouseholdDepartment } from "./services/household-seed.service.js";
import { checkStorageNearFull } from "./services/camera-storage.service.js";
import { reconcileCameraBudgets } from "./services/camera-budget.service.js";
import { reconcileStaleSending } from "./services/email-reconcile.service.js";
import { checkForUpdate } from "./services/update-agent/poller.js";
import { getUpdateAgentSettings } from "./services/update-agent/settings.js";
import {
  applyWindowTick,
  resumeInterruptedApply,
} from "./services/update-agent/apply.js";
import { createHostComposeRunner } from "./services/update-agent/host-compose-runner.js";
import { purgeUpdateBackups } from "./services/update-agent/purge-update-backups.js";
import { purgeSelfSwapHelpers } from "./services/update-agent/purge-self-swap-helpers.js";
import { createTlsIssuanceService } from "./services/tls-issuance.service.js";
import { initTlsReissueHook } from "./services/tls-reissue.singleton.js";
import {
  createHqIssuanceClient,
  createPrismaTlsCertStore,
  createDiskTlsFileOps,
  bridgeNginxReloader,
  createBridgeFqdnPersister,
  createRoutingDnsRegistrar,
} from "./services/tls-issuance.adapters.js";
import { scheduleTlsBootTick } from "./services/tls-issuance.boot-tick.js";
import { createDeviceIdentityClient } from "./services/device-identity.client.js";
import {
  runOverlayConnectTick,
  expireIdleOverlayPeers,
  type OverlayConnectDeps,
} from "./services/overlay-connect.service.js";
import { allocatePeerIp } from "./services/vpn.service.js";
import { bridgeAuthToken } from "./lib/bridge-errors.js";
import { createScheduleTicker } from "./services/schedule-ticker.js";
import { createFirewallAdapter } from "./services/firewall-adapter.service.js";
import {
  createEgressReconciler,
  type EgressClient,
} from "./services/egress-reconciler.js";
import {
  purgeScheduleEvents,
  purgeExpiredOverrides,
} from "./services/schedule-purge.js";
import { purgeAuditLogs } from "./services/audit-retention-purge.service.js";
import { pruneExpiredChallenges } from "./services/webauthn-challenge.service.js";
import { pruneExpiredLoginStates } from "./services/sso-login-state.service.js";
import { sweepPairingCodes } from "./services/pairing-code-purge.service.js";
import { tickToolSchedules } from "./services/tool-schedule-ticker.service.js";
import { tickSceneSchedules } from "./services/scene-schedule-ticker.service.js";
import { backfillLegacySceneScheduleTimezones } from "./services/scene-schedule-tz-backfill.service.js";
import type { MatterDispatcher } from "./routes/scenes.js";
import { sendMatterCommand } from "./services/matter.service.js";
import { mcpClient } from "./services/mcp-client.singleton.js";
import type { StepDispatcher } from "./services/tool-spec-runner.service.js";
import { mineToolCallPatterns } from "./services/pattern-miner.service.js";
import { runTeamChatMeetingReminderSweep } from "./services/team-chat-reminders.service.js";
import { runActivityNotifySweep } from "./services/activity-notify.service.js";
import {
  purgeNetworkThroughputSamples,
  purgeDnsBlockSamples,
} from "./routes/network-throughput.js";
import { purgeOffLanEgressSamples } from "./routes/off-lan-network.js";
import { startContextStatsInvalidator } from "./services/context-stats-invalidation.service.js";
import {
  initActivityRecorder,
  recordActivity,
  getActivityRecorder,
} from "./services/activity.singleton.js";
import { createErpSyncRunner } from "./services/erp-sync/erp-sync.service.js";
import {
  discoverResources,
  runSyncTick,
  type M365SyncDeps,
} from "./services/m365/m365-sync.service.js";
import { GraphClient } from "./services/m365/graph-client.js";
import { initialUrlFor } from "./services/m365/graph-resources.js";
import { createEntraClient, isM365Configured } from "./services/m365/entra-client.js";

/**
 * Product version for the Graph `User-Agent` Microsoft asks integrators to
 * send. Duplicated from `services/analytics/index.ts`'s
 * `ORCHESTRATOR_FW_VERSION` and carrying the same caveat it does: a single
 * canonical runtime version source does not exist yet, and when one lands both
 * should read it.
 */
const ORCHESTRATOR_M365_UA_VERSION = "0.1.0";
import { jitteredPeriodMs } from "./services/erp-sync/schedule-jitter.js";
import { registerErpDriftRetention } from "./services/erp-sync/drift-record.service.js";
import { attachFileIndexerActivityBridge } from "./services/activity-file-indexer-bridge.js";
import { runDailyRootJob } from "./services/audit-daily-root.service.js";
import { runNightlyChainVerification } from "./services/audit-verify.service.js";
import { checkHardwareInventory } from "./services/hardware-bom.service.js";
import { createLinuxHardwareInventoryCollector } from "./services/hardware-inventory.collector.js";
import {
  BRAIN_ROOT,
  migrateBrainMemoryDirectoryLayout,
} from "./services/brain-memory.service.js";
import { ensureDefaultModelPulled } from "./services/model-readiness.service.js";
import { initAnalytics, analytics } from "./services/analytics/index.js";
import { forwardHealthSnapshot } from "./services/analytics/service-health.js";
import { createLogger } from "./lib/logger.js";

const logger = createLogger("orchestrator");

// WARP-572: re-entrancy guard for the graceful-shutdown path. After an
// uncaughtException the process is (by Node's contract) in an undefined state
// and the event loop keeps turning while teardown `await`s resolve. A second
// uncaughtException — or an overlapping SIGTERM/SIGINT during teardown — would
// otherwise re-enter `shutdown` and run a second concurrent teardown (double
// `$disconnect`, double `process.exit`, interleaved SDK closes). The flag is
// module-scoped so it is shared across every shutdown trigger.
let shuttingDown = false;

// WARP-572: how long the graceful teardown is allowed to run before we hard-
// exit regardless. The fatal/SIGTERM paths await `shutdownMatterService()`,
// `shutdownCameraService()`, `stopMcp()`, and `prisma.$disconnect()`; if any
// of those hangs (the exact silent-hang WARP-572 targets) the normal
// `process.exit()` at the end of `shutdown` never runs. An unref'd timer armed
// at the top of `shutdown` bounds that — see registerShutdown.
const SHUTDOWN_FORCE_EXIT_MS = Number(
  process.env.SHUTDOWN_FORCE_EXIT_MS ?? 10_000,
);

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
    actor: { type: "system" },
  });
  logger.info("Activity recorder initialized");

  // WARP-263: per-device hardware inventory (NIST SSDF supply-chain
  // transparency). Runs every boot, not just the literal first one — the
  // components genuinely can't change without a reboot, so "check every
  // boot" is the honest way to catch a first-boot baseline AND any later
  // component swap. Signs with the same WARP-230 device-identity key as
  // the audit chain; a divergence overwrites the baseline and emits a
  // `hardware_changed` ActivityRow via the recorder just initialized
  // above. Non-fatal: device-identity-svc being down (or a Windows/dev
  // host missing dmidecode/lsblk/lsusb/lspci) must not block startup —
  // the collector already degrades per-category, this just guards the
  // signer/DB round-trip too.
  try {
    const hwResult = await checkHardwareInventory({
      prisma,
      identity: createDeviceIdentityClient(),
      collector: createLinuxHardwareInventoryCollector(),
      recordActivity,
    });
    logger.info({ status: hwResult.status }, "hardware inventory check complete");
  } catch (err) {
    logger.warn({ err }, "hardware inventory check failed (continuing startup)");
  }

  // KAN-6 — one-shot, idempotent backfill: convert pre-KAN-6 SceneSchedule
  // rows (which stored the fire HOUR as a UTC value in BYHOUR, timezone='UTC')
  // to the box's local IANA zone so describeRrule shows the owner's local time
  // again while the firing instant stays put. Runs here, right after migrations
  // applied (migrate-and-start.sh's `prisma migrate deploy && node …`) and
  // BEFORE the scene-schedule ticker starts. Records completion in SystemFlag,
  // so every later boot short-circuits and UI-authored rows are never touched.
  // Non-fatal: a backfill must not wedge startup.
  try {
    const tzBackfill = await backfillLegacySceneScheduleTimezones(prisma);
    if (tzBackfill.ran) {
      logger.info(
        { converted: tzBackfill.converted, skipped: tzBackfill.skipped },
        "scene-schedule timezone backfill applied",
      );
    }
  } catch (err) {
    logger.warn(
      { err },
      "scene-schedule timezone backfill threw (continuing startup)",
    );
  }

  // WARP-493 — one-shot rename of pre-WARP-485 username-keyed brain-memory
  // dirs (`BRAIN_ROOT/<username>/`) to UUID-keyed (`BRAIN_ROOT/<User.id>/`).
  // Idempotent (UUID-named dirs are skipped); non-fatal — log loud but let
  // the orchestrator boot so the operator can recover via dashboard / SSH.
  try {
    const brainMig = await migrateBrainMemoryDirectoryLayout(prisma, BRAIN_ROOT);
    if (brainMig.renamed > 0 || brainMig.orphans.length > 0 || brainMig.conflicts.length > 0) {
      logger.info(
        {
          renamed: brainMig.renamed,
          orphans: brainMig.orphans.length,
          conflicts: brainMig.conflicts.length,
        },
        "WARP-493: brain-memory directory layout migration ran at boot",
      );
    }
  } catch (err) {
    logger.error(
      { err },
      "WARP-493: brain-memory directory layout migration failed — operator review needed",
    );
  }

  // Initialize services
  initDeviceService(prisma);

  // Start periodic device self-registration (detects hostname, IP, hardware)
  await initDeviceRegistration(prisma);

  // WARP-615: fleet-analytics agent — fail-open; a no-op until configured.
  initAnalytics();

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

  // WARP-353 (ADR-014): orchestrator side of the desktop tool-host bridge.
  // Subscribes droplet/client-hello/+, droplet/client-presence/+ and
  // droplet/llm-tool-response/+ (signed, replay-checked consent outcomes).
  // Best-effort like the bridges above — if MQTT is down the appliance
  // keeps running and clients simply appear offline.
  attachClientDispatchBridge(prisma);

  // Initialize Matter controller (non-fatal if unavailable)
  // WARP-1447: wire prisma for DeviceAlias cleanup on decommission BEFORE
  // the init attempt — the SSE bridge self-heals a failed init, so
  // decommissions can succeed later even when this try throws now.
  setPrismaForMatter(prisma);
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

  // WARP-618: service-onboard monitoring — bridge every health snapshot
  // into the fleet-analytics agent (per-poll `service.health` metric +
  // transition-only `service.*` events, both derived analytics-side).
  // Subscribed BEFORE the monitor starts so the seeded first snapshot is
  // observed and becomes the transition baseline (metrics only, no events).
  // The monitor stays analytics-unaware — this generic observer is the only
  // coupling — and the fail-open façade means a broken portal can never
  // disturb health polling.
  onHealthSnapshot((snapshot) => forwardHealthSnapshot(snapshot));

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

  // WARP-2627 / ADR-043 §5: attach the OUTBOUND MCP session, if this box is
  // entitled to one. On the shipping default (REMOTE_MCP_SERVER_ALLOWLIST
  // empty) this constructs nothing and dials nothing — it returns
  // `not_allowlisted` and the boot path is unchanged. Non-fatal either way: a
  // vendor session that cannot be opened must not stop the appliance booting.
  try {
    const attached = await ensureRemoteMcpAttached(prisma);
    if (!attached.attached) {
      logger.info(
        "Remote MCP not attached (%s): %s",
        attached.reason,
        attached.message,
      );
    }
  } catch (err) {
    logger.warn("Remote MCP attach failed: %s", (err as Error).message);
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
  const firewall = createFirewallAdapter(openwrt);
  // Critical fix #1: pass prisma so `scheduleInterval`/`scheduleCron` can
  // acquire a pg advisory lock per tick. In multi-instance deploys (K8s
  // replicas, warm standby) only the replica that wins the lock runs
  // the handler; the others silently skip. Each distinct cron task gets
  // its own lock key so they don't starve each other.
  const cronRuntime = createCronRuntime(prisma);

  // Router-dependent schedulers only run when routing supervision is active.
  // With ROUTING_MODE=disabled (dev / CI / router-less deploys) every openwrt
  // call short-circuits to RouterError.disabled, so scheduling these would emit
  // a warn-level error every tick — a 47h dev-stack run logged 16k+
  // "firewall error; preserving state" lines this way. Surface the disabled
  // state once at boot instead. No-op in production (ROUTING_MODE=real).
  const routerSupervisionEnabled = config.ROUTING_MODE !== "disabled";
  if (!routerSupervisionEnabled) {
    logger.warn(
      "ROUTING_MODE=disabled — skipping router-dependent schedulers " +
        "(schedule-ticker, egress-reconciler, device-reconcile, ap-discovery). " +
        "API writes to schedule/phone-home/firewall state will be persisted to the " +
        "database but will NOT be enforced on the router until ROUTING_MODE is set " +
        "to real or mock.",
    );
  }

  const scheduleTicker = createScheduleTicker(prisma, firewall);
  const tickMs = Number(process.env.SCHEDULE_TICK_MS ?? 30_000);
  if (routerSupervisionEnabled) {
    cronRuntime.scheduleInterval(
      tickMs,
      () => scheduleTicker.tickOnce(),
      { lockKey: "droplet:schedule-ticker" },
    );
  }

  // WARP-613: phone-home egress reconciler (ADR-012). Additive sibling to the
  // schedule ticker — enforces per-group/master phone-home WAN-egress blocks
  // (and the camera-VLAN toggle) using distinct `phonehome-*` rules, yielding
  // to any full block the schedule ticker holds. Same advisory-lock pattern.
  const egressClient: EgressClient = {
    async blockPhoneHome(mac) {
      await openwrt.blockPhoneHome(mac);
    },
    async unblockPhoneHome(mac) {
      await openwrt.unblockPhoneHome(mac);
    },
    async setCameraPhoneHome(blocked) {
      await openwrt.setCameraPhoneHome(blocked);
    },
  };
  const egressReconciler = createEgressReconciler(prisma, egressClient);
  if (routerSupervisionEnabled) {
    cronRuntime.scheduleInterval(
      tickMs,
      () => egressReconciler.tickOnce(),
      { lockKey: "droplet:egress-reconciler" },
    );
  }

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
  if (routerSupervisionEnabled) {
    cronRuntime.scheduleInterval(
      reconcileMs,
      () => reconcilePoller.pollOnce(),
      { lockKey: "droplet:device-reconcile-poller" },
    );
    logger.info({ reconcileMs }, "device reconcile poller started");
  }

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

  // feat/scene-schedules: scene-schedule-ticker. Every 60s scans due
  // SceneSchedule rows and fires each routine via the SAME executeScene
  // path the interactive POST /scenes/:id/run route uses. The dispatcher
  // is hoisted here and shared with createScenesRouter (passed to
  // createApp below) so the run route and the ticker dispatch through one
  // Matter wrapper. NOT gated on ROUTING_MODE — Matter rides the sidecar,
  // independent of OpenWrt router supervision (the router-dependent
  // schedulers above short-circuit when ROUTING_MODE=disabled; Matter does
  // not). Multi-instance deploys lock on `droplet:scene-schedule-ticker`
  // so only one replica fires each due schedule.
  const sceneMatterDispatcher: MatterDispatcher = {
    sendCommand: (nodeId, command, actor, args) =>
      sendMatterCommand(nodeId, command, actor, args),
  };
  cronRuntime.scheduleInterval(
    60_000,
    async () => {
      await tickSceneSchedules(prisma, sceneMatterDispatcher);
    },
    { lockKey: "droplet:scene-schedule-ticker" },
  );

  // WARP-2177 — durable agent-run worker (epic WARP-2176). Two ticks on the
  // one sanctioned clock, no second scheduler:
  //   - the claim/reclaim tick runs under its own advisory lock so only one
  //     replica claims each queued row (the claim itself is a conditional
  //     updateMany, so even a lost lock cannot double-claim);
  //   - the heartbeat tick is per process and unlocked: it beats the runs
  //     THIS process is executing. Timer-driven, not iteration-driven, so a
  //     run sitting in a slow model call still holds its lease.
  // The run executes OUTSIDE the tick — the lock is transaction-scoped with a
  // 60 s timeout, which is right for a tick and wrong for a 40-minute run.
  // NOT gated on ROUTING_MODE: runs need the model and the tool registry,
  // neither of which depends on router supervision.
  const agentRunWorker = createAgentRunWorker({
    prisma,
    agent: { mcp: mcpClient, aiGateway: { chat: aiGateway.chat } },
  });
  cronRuntime.scheduleInterval(
    config.agentRuns.tickMs,
    async () => {
      await agentRunWorker.tickOnce();
    },
    { lockKey: AGENT_RUN_LOCK_KEY },
  );
  cronRuntime.scheduleInterval(config.agentRuns.heartbeatMs, async () => {
    await agentRunWorker.heartbeatOnce();
  });
  // WARP-2180 — recurring runs. Every 60 s, due AgentRunSchedule rows are
  // ENQUEUED (never executed here); the worker above claims them. Same
  // clock, its own lock key, no second scheduler.
  cronRuntime.scheduleInterval(
    60_000,
    async () => {
      await tickAgentRunSchedules(prisma);
    },
    { lockKey: AGENT_RUN_SCHEDULE_LOCK_KEY },
  );
  logger.info(
    {
      workerId: agentRunWorker.workerId,
      concurrency: config.agentRuns.concurrency,
      tickMs: config.agentRuns.tickMs,
      heartbeatMs: config.agentRuns.heartbeatMs,
      reclaimAfterMs: config.agentRuns.reclaimAfterMs,
    },
    "agent run worker started",
  );

  // WARP-1385 (ADR-030) — direct-punch remote-access overlay connect agent.
  // Explicit opt-in (OVERLAY_CONNECT_ENABLED) AND HQ configured AND router
  // supervision active (the peer install goes through the routing service). The
  // HQ long-poll + the idle-expiry sweep are cron-driven — event-driven bounded
  // ticks, NO while(true) — and each ticks under an advisory lock so only one
  // replica polls HQ / sweeps.
  if (
    config.OVERLAY_CONNECT_ENABLED &&
    config.HQ_ISSUANCE_URL &&
    routerSupervisionEnabled
  ) {
    const overlayDeps: OverlayConnectDeps = {
      config: {
        hqBaseUrl: config.HQ_ISSUANCE_URL,
        deviceId: config.DROPLET_DEVICE_ID,
        bridgeUrl: config.DEVICE_BRIDGE_URL,
        bridgeToken: bridgeAuthToken(),
        vpnInterface: "wg0",
        keepaliveSeconds: 25,
        idleExpiryHours: config.OVERLAY_PEER_IDLE_EXPIRY_HOURS,
      },
      identity: createDeviceIdentityClient(),
      prisma,
      peers: {
        install: async (p) => {
          await openwrt.installOverlayVpnPeer(p);
        },
        // WARP-2060 — the staged-vs-applied distinction must survive this
        // seam: a `staged / applied:false` delete leaves the peer LIVE on wg0,
        // and the sweep must not mark the row revoked (mirrors the manual
        // revoke route's isRevokeApplied gate).
        remove: async (p) => {
          const result = await openwrt.deleteVpnPeer(p);
          return { applied: openwrt.isRevokeApplied(result) };
        },
        // WARP-1389 — real per-peer runtime handshake, read from the routing
        // peer list, so the idle-expiry sweep can settle each torn-down peer as
        // a punch success/failure. A peer is included ONLY when routing reported
        // a value (observed: 0 = never handshook, >0 = handshook); a peer whose
        // handshake is UNKNOWN (field absent — ubus data unavailable) is OMITTED
        // so the sweep skips it rather than scoring a false failure.
        listHandshakes: async (iface) => {
          const peers = await openwrt.listVpnPeers(iface);
          const out: Record<string, number> = {};
          for (const p of peers) {
            if (typeof p.latest_handshake === "number") {
              out[p.public_key] = p.latest_handshake;
            }
          }
          return out;
        },
      },
      allocateIp: () => allocatePeerIp(prisma, config.WIREGUARD_VPN_SUBNET),
      // WARP-1389 — box-side punch telemetry on the real analytics surface.
      metrics: analytics,
      logger: createLogger("overlay-connect"),
    };
    cronRuntime.scheduleInterval(
      config.OVERLAY_CONNECT_POLL_SECONDS * 1000,
      async () => {
        await runOverlayConnectTick(overlayDeps);
      },
      { lockKey: "droplet:overlay-connect-poll" },
    );
    // Sweep ~4× per idle window so an expired peer is torn down well within it.
    const overlaySweepMs = Math.max(
      15 * 60_000,
      (config.OVERLAY_PEER_IDLE_EXPIRY_HOURS * 3_600_000) / 4,
    );
    cronRuntime.scheduleInterval(
      overlaySweepMs,
      async () => {
        await expireIdleOverlayPeers(overlayDeps);
      },
      { lockKey: "droplet:overlay-peer-expiry" },
    );
    logger.info(
      "overlay connect agent enabled (HQ long-poll + idle-expiry sweep)",
    );
  }

  // WARP-446 (AC #1): mDNS coverage-extender discovery. Every
  // DROPLET_AP_DISCOVERY_INTERVAL seconds (default 10 s) the poller
  // queries the routing service's /aps/discovered endpoint and
  // upserts each observed MAC into ApDevice via reconcileDiscovered.
  // New extenders surface as AWAITING_APPROVAL within one tick — well
  // inside the 30 s AC #1 budget. Same advisory-lock pattern as the
  // schedule ticker / reconcile poller above so multi-instance
  // deploys don't double-fire.
  const apDiscoveryIntervalMs = config.DROPLET_AP_DISCOVERY_INTERVAL * 1000;
  if (routerSupervisionEnabled) {
    // ADR-024 Phase 2: the poller drives the discovery multiplexer. The
    // EasyMesh / UniFi sources are registered only when their flag is on;
    // both default off, so the shipping single-box runs only the live
    // mDNS source — the same single tick + advisory lock as Phase 1.
    startApDiscoveryPoller(cronRuntime, prisma, openwrt, apDiscoveryIntervalMs, {
      easymeshEnabled: config.DROPLET_AP_EASYMESH_ENABLED,
      unifiEnabled: config.DROPLET_AP_UNIFI_ENABLED,
    });

    // WARP-1732 (ADR-035 §5): fabric-member inventory. Rides the SAME
    // AP-discovery cadence deliberately — both sweeps read one mDNS-derived
    // routing endpoint, so a second interval would buy nothing but a second
    // knob to drift. No new env var.
    //
    // Distinct advisory lock key, so it is its own single scheduler and
    // cannot serialise behind (or double-fire with) AP discovery. Strictly
    // observational: it upserts FabricMember rows, never deletes one, and
    // never writes to a device — ApDevice above keeps owning AP lifecycle.
    startFabricMemberReconciler(
      cronRuntime,
      prisma,
      openwrt,
      apDiscoveryIntervalMs,
    );

    // WARP-1761 (ADR-035 §1/§7): converge `wifi.primary`. Rides the SAME
    // cadence as the two sweeps above — the tick is one read per approved
    // AP, the identical hop `GET /network/wifi/ap` already makes on every
    // dashboard poll, so a third interval would buy nothing but a third knob
    // to drift. No new env var.
    //
    // Its OWN advisory lock key, so it is its own single scheduler and
    // cannot serialise behind (or double-fire with) AP discovery or the
    // fabric reconciler. It writes ONE domain to ONE role: `wifi.primary`,
    // to fabric members with role='ap' that ADR-005 has approved and ADR-024
    // marks DROPLET_IMAGE. It never deletes a row, never writes intent, and
    // holds no passphrase to push.
    startWifiIntentConverger(
      cronRuntime,
      prisma,
      openwrt,
      apDiscoveryIntervalMs,
    );
  }

  // WARP-1122 — daily business-profile review check (03:30, offset from the
  // purge job). Registration gated on the EXPLICIT enable boolean; the
  // handler is one conditional update, so a skipped/raced tick is harmless.
  if (config.BUSINESS_PROFILE_REVIEW_ENABLED) {
    cronRuntime.scheduleCron(
      "30 3 * * *",
      async () => {
        const r = await runBusinessReviewCheck(
          prisma,
          config.BUSINESS_PROFILE_REVIEW_DAYS,
        );
        if (r.markedDue) {
          console.log(
            `[review-nudge] business profile marked review-due (via ${r.via})`,
          );
        }
      },
      { lockKey: "business-profile-review-nudge" },
    );
  }

  cronRuntime.scheduleCron(
    "0 3 * * *",
    async () => {
      const eventsDeleted = await purgeScheduleEvents(prisma, 7);
      const overridesDeleted = await purgeExpiredOverrides(prisma, 24);
      const presenceDeleted = await deviceRegistry.purgePresenceRows(30);
      // WARP-470: NetworkThroughputSample retention. 30 days keeps the
      // 24 h area chart's range comfortably within scope while bounding
      // table growth at ~43k rows (60 s sampler × 30 d).
      const throughputDeleted = await purgeNetworkThroughputSamples(prisma, 30);
      // WARP-468: 90-day retention on off-LAN egress samples. Longer
      // than throughput (30 d) because totals roll up to monthly
      // billing windows; 90 d covers QoQ review without bloat.
      const offLanDeleted = await purgeOffLanEgressSamples(prisma, 90);
      // WARP-468: DnsBlockSample retention. 30 days mirrors throughput —
      // the "DNS blocked today" chip only reads day-to-date, so a longer
      // horizon would just bloat the table.
      const dnsBlockDeleted = await purgeDnsBlockSamples(prisma, 30);
      // WARP-586: retention purge for the append-only audit/log tables
      // (ActivityRow, CommandAuditLog, NotificationLog). Window is
      // operator-tunable via DROPLET_AUDIT_RETENTION_DAYS (default 90);
      // <= 0 disables the purge. ActivityRow is hash-chained, so this is
      // an id-contiguous oldest-prefix seal-and-truncate, not a mid-chain
      // delete — see audit-retention-purge.service.ts for the integrity
      // argument. Deletes are batched and capped per run so a months-deep
      // first-run backlog can't push this handler past the 60 s
      // advisory-lock transaction (cron-runtime withAdvisoryLock) into a
      // permanent P2028 retry loop; the backlog drains over nights.
      const auditPurge = await purgeAuditLogs(
        prisma,
        config.DROPLET_AUDIT_RETENTION_DAYS,
      );
      // WARP-539: 7-day GC of the per-update rollback backups
      // (<updatesDir>/<id>/backup — previous digests + config pre-image +
      // schema dump). Only backups for TERMINAL updates older than the
      // window are reaped; a live rollback target (pending/verifying/applying)
      // is never touched. No-op on a box that never ran an apply.
      const backupPurge = await purgeUpdateBackups(prisma, {
        updatesDir: config.DROPLET_OTA_UPDATES_DIR,
      });
      // WARP-1044: GC the exited droplet-ota-self-swap-<id> helper containers
      // the self-swap deliberately leaves behind (no --rm — their logs are
      // the rollback forensic trail). Helpers exited longer than the same
      // 7-day backup-retention window are removed AFTER their logs are
      // captured to <updatesDir>/<id>/self-swap-helper.log; running helpers
      // and in-flight update ids are never touched. Gated like the apply
      // window: no apply script provisioned → no docker surface → no-op.
      const helperPurge = config.DROPLET_OTA_APPLY_SCRIPT
        ? await purgeSelfSwapHelpers(prisma, {
            scriptPath: config.DROPLET_OTA_APPLY_SCRIPT,
            updatesDir: config.DROPLET_OTA_UPDATES_DIR,
          })
        : { removed: 0, logsCaptured: 0 };
      // Bounded-growth sweeps for two auth tables whose mint endpoints run
      // before authMiddleware: WebAuthnChallenge (every /login/passkey page
      // load inserts one via the public authenticate/options route) and
      // SsoLoginState (one per SSO authorize redirect). Neither had a wired
      // prune despite pruneExpiredChallenges' docstring claiming it — expired
      // WebAuthnChallenge / consumed+expired SsoLoginState rows accumulated
      // forever, a slow DB-bloat DoS on the appliance Postgres. Both prunes
      // are batched + capped per run (same precedent as purgeAuditLogs above),
      // so a months-deep first-run backlog can't push this handler past the
      // 60 s advisory-lock transaction into a permanent P2028 retry loop; the
      // backlog drains over nights.
      const challengesDeleted = await pruneExpiredChallenges(prisma);
      const loginStatesDeleted = await pruneExpiredLoginStates(prisma);
      // WARP-1202/WARP-1203: PairingCode lifecycle sweep. First stamps overdue
      // `active` codes with the explicit `expired` status (state stays truthful
      // in the column, not re-derived from expiresAt), then purges terminal
      // rows — claimed/expired/revoked — created more than 7 days ago, keyed
      // on the explicit status. Keeps the code population flat so 6-char
      // collision odds stop rising with table age (the P2002 retry in
      // /devices/pair stays as the last-resort absorber). Batched + capped
      // like the two prunes above.
      const pairingSweep = await sweepPairingCodes(prisma);
      logger.info(
        {
          eventsDeleted,
          overridesDeleted,
          presenceDeleted: presenceDeleted.count,
          throughputDeleted,
          offLanDeleted,
          dnsBlockDeleted,
          activityDeleted: auditPurge.activityDeleted,
          commandAuditDeleted: auditPurge.commandAuditDeleted,
          notificationDeleted: auditPurge.notificationDeleted,
          auditRetentionSkipped: auditPurge.skipped,
          updateBackupsPurged: backupPurge.purged,
          otaHelpersRemoved: helperPurge.removed,
          challengesDeleted,
          loginStatesDeleted,
          pairingCodesExpired: pairingSweep.expired,
          pairingCodesPurged: pairingSweep.purged,
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

  // WARP-1263: household absorption seed (T11). Boot-time idempotent seed
  // that adopts the legacy WS-5 Household NC groupfolder verbatim into a
  // Department row with kind=HOUSEHOLD. Zero NC mutations — only reads from
  // gfListFolders() to discover the existing groupfolder id. Backfills User
  // memberships on every call (additive only, never downgrades). Non-fatal:
  // logs warnings and continues if the groupfolder is not found (will retry
  // on next boot via the 5-min reconciler cadence).
  await seedHouseholdDepartment(prisma).catch((err) => {
    logger.warn({ err }, "household-seed: boot seed failed (retrying on next boot)");
  });

  // WARP-1257: department/team NC provisioning reconciler (ADR-029 T5).
  // Binds the debounced kickReconcile() post-mutation trigger the future
  // department/membership routes (T6/T7) call after their write commits,
  // then boot-runs one tick immediately (fire-and-forget, so a stuck NC
  // instance never blocks orchestrator startup) followed by a recurring
  // tick every 5 minutes. Converges Prisma-desired department/membership
  // state toward Nextcloud, overwriting out-of-band drift and
  // re-discovering groupfolder ids after an NC reinstall.
  initReconcileKick(prisma);
  void reconcileDepartments(prisma).catch((err) => {
    logger.warn({ err }, "department-reconciler: boot tick failed (5-min cron will retry)");
  });
  cronRuntime.scheduleInterval(
    5 * 60_000,
    async () => {
      const result = await reconcileDepartments(prisma);
      if (
        result.departmentsConverged > 0 ||
        result.departmentsStillFailed > 0 ||
        result.membershipsSynced > 0 ||
        result.membershipsFailed > 0 ||
        result.membershipsRemoved > 0 ||
        result.usagePoliciesSynced > 0 ||
        result.usagePoliciesFailed > 0 ||
        // pr-reviewer #1229 N3: WARP-1531's role-default quota pushdown was
        // missing here, so a tick that ONLY did role-default work logged
        // nothing at all.
        result.roleDefaultQuotasSynced > 0 ||
        result.roleDefaultQuotasFailed > 0 ||
        // WARP-1526: droplet-admins tier-vs-group drift corrections are
        // rare and always worth a line in the log — including the failures
        // (B4), which is how a permanently-stuck sweep becomes visible.
        result.adminGroupAdded > 0 ||
        result.adminGroupRemoved > 0 ||
        result.adminGroupFailed > 0 ||
        // pr-reviewer #1229 N1: the directoryStatus → NC disable mirror.
        result.ncDisableMirrored > 0 ||
        result.ncDisableMirrorFailed > 0
      ) {
        logger.info(result, "department-reconciler tick complete");
      }
    },
    { lockKey: "droplet:department-reconciler" },
  );

  // WARP-237: nightly tamper detection. 03:25 — after the 03:00 purge
  // reshapes the chain origin and before the 03:35 root signing.
  cronRuntime.scheduleCron(
    "25 3 * * *",
    async () => {
      await runNightlyChainVerification(prisma);
    },
    { lockKey: "droplet:audit-verify" },
  );

  // WARP-237: sign yesterday's audit root with the device identity key.
  // 03:35 — after the 03:00 purge and the 03:15 guest sweep so the three
  // jobs never contend on the advisory-lock pool. device-identity-svc
  // being down is non-fatal: the job logs and the catch-up loop signs the
  // missed day on the next healthy night.
  const auditRootIdentity = createDeviceIdentityClient();
  cronRuntime.scheduleCron(
    "35 3 * * *",
    async () => {
      try {
        const res = await runDailyRootJob(prisma, auditRootIdentity);
        logger.info(
          { signed: res.signed, skipped: res.skipped },
          "daily audit-root job complete",
        );
      } catch (err) {
        logger.error(
          { err },
          "daily audit-root job failed (will catch up next night)",
        );
      }
    },
    { lockKey: "droplet:audit-daily-root" },
  );

  // WARP-890: stale-sending email reconcile, every 5 min. A draft claimed
  // (queued→sending) whose terminal status callback never landed strands in
  // `sending`. The email-indexer runs the same sweep inline on its 10s outbound
  // tick, but if the indexer is DOWN longer than the grace window those drafts
  // never recover — so the orchestrator owns an independent recovery path here,
  // direct via Prisma. The sweep is a single idempotent, conditional updateMany
  // (status='sending' AND claimedAt < cutoff → 'failed'); running it from both
  // the indexer and this cron concurrently cannot double-process, because the
  // loser's WHERE no longer matches once the rows flip to 'failed'.
  //
  // Let errors propagate naked to cron-runtime's `safeRun` — same posture as the
  // pattern-miner / purge handlers: swallowing here would zero out the
  // per-handler consecutiveFailures canary that downstream alerting reads.
  cronRuntime.scheduleInterval(
    5 * 60 * 1000,
    async () => {
      const reconciled = await reconcileStaleSending(prisma);
      if (reconciled > 0) {
        logger.info({ reconciled }, "email-stale-sending-reconcile failed-out drafts");
      }
    },
    { lockKey: "droplet:email-stale-sending-reconcile" },
  );

  // WARP-538: OTA update agent — poll + maintenance-window ticks.
  //
  // Poll (every DROPLET_OTA_POLL_INTERVAL s, default 15 min): discover the
  // latest GitHub Release, verify release.json through the WARP-537 trust
  // chain (baked-in cosign.pub; fails closed on the WARP-535 placeholder
  // until the key ceremony runs), and track it as a `pending` DeviceUpdate
  // superseding any prior pending. A verification failure writes NO row.
  //
  // Apply window (cron from the persisted update-agent settings, default
  // 03:00): WARP-539 — apply + health-gated swap + auto-rollback. When the
  // apply helper is provisioned (DROPLET_OTA_APPLY_SCRIPT set + the compose
  // socket mounted on this service ONLY, see docker/docker-compose.yml) the
  // window runs the full state machine over a production host-compose runner;
  // on a box/CI without the socket the script path is empty, the runner is
  // absent, and the window HONESTLY no-ops (the poller still tracks pending
  // releases — apply just never fires).
  //
  // Both ride cron-runtime (no `while (true)`, per CLAUDE.md) with
  // advisory locks so multi-instance deploys single-fire. Errors propagate
  // naked to safeRun — same consecutiveFailures-canary posture as every
  // other cron in this file (checkForUpdate + applyWindowTick return typed
  // outcomes for expected failures; only genuine bugs throw).
  const updateAgentSettings = await getUpdateAgentSettings(prisma);
  const otaApplyRunner = config.DROPLET_OTA_APPLY_SCRIPT
    ? createHostComposeRunner({
        scriptPath: config.DROPLET_OTA_APPLY_SCRIPT,
        composeFile: config.DROPLET_OTA_COMPOSE_FILE,
        updatesDir: config.DROPLET_OTA_UPDATES_DIR,
      })
    : null;
  const otaApplyOpts = otaApplyRunner
    ? {
        prisma,
        runner: otaApplyRunner,
        releasesLatestUrl: config.DROPLET_OTA_RELEASES_URL,
        githubToken: config.DROPLET_OTA_GITHUB_TOKEN || undefined,
      }
    : null;

  // onStart resume hook: if the previous orchestrator process died mid-apply,
  // this boot is either the freshly-swapped orchestrator (health-gate all +
  // commit) or the old one after a detached rollback (write the rolled_back /
  // failed verdict). Runs BEFORE the window cron so a resumed apply settles
  // before a new window can start. No-op when the row set is clean or apply is
  // disabled on this box.
  if (otaApplyOpts) {
    try {
      const resumed = await resumeInterruptedApply(otaApplyOpts);
      if (resumed.outcome !== "nothing_to_resume") {
        logger.info(
          { event: "update.resume", outcome: resumed.outcome },
          "OTA apply resume hook ran at boot",
        );
      }
    } catch (err) {
      // A resume failure must not block orchestrator boot — log loudly and
      // let the next window retry (the row's status is still an exact cursor).
      logger.error({ err, event: "update.resume_failed" }, "OTA apply resume hook threw at boot");
    }
  }

  cronRuntime.scheduleInterval(
    config.DROPLET_OTA_POLL_INTERVAL * 1000,
    async () => {
      await checkForUpdate({
        prisma,
        releasesLatestUrl: config.DROPLET_OTA_RELEASES_URL,
        githubToken: config.DROPLET_OTA_GITHUB_TOKEN || undefined,
      });
    },
    { lockKey: "droplet:update-agent.poll" },
  );
  cronRuntime.scheduleCron(
    updateAgentSettings.applyWindowCron,
    async () => {
      if (!otaApplyOpts) {
        // Apply is disabled on this box (no host compose socket) — the poller
        // keeps tracking pending releases; the swap just never fires here.
        return;
      }
      await applyWindowTick(otaApplyOpts);
    },
    { lockKey: "droplet:update-agent.apply-window" },
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

  // WARP-1685 — team-chat meeting reminders. Every 60s, posts the
  // meeting_reminder card for meetings whose window (startsAt −
  // reminderMinutesBefore) has opened; exactly-once via the pending→sent
  // claim inside the sweep's own transaction, so a tick racing a restart
  // (or a second replica after an advisory-lock handoff) never
  // double-posts. Errors propagate naked to cron-runtime's `safeRun` —
  // same posture as every other handler here; only the per-participant
  // notification fan-out is absorbed inside the service (leaf effect).
  cronRuntime.scheduleInterval(
    60_000,
    async () => {
      const result = await runTeamChatMeetingReminderSweep(prisma);
      if (result.remindersSent > 0 || result.markedNotNeeded > 0) {
        logger.info(result, "team-chat meeting reminder sweep");
      }
    },
    { lockKey: "droplet:team-chat-meeting-reminders" },
  );

  // WARP-2587 (ADR-045 slice I) — PM + CRM notification sweep. Every 60s,
  // projects pending PmActivity / CrmActivity rows into NotificationLog +
  // MQTT toasts; exactly-once via the pending→sent claim inside the sweep's
  // own transaction, coalesced to at most one notification per recipient per
  // tick per source so a bulk import cannot fan out 200 toasts.
  //
  // Its own lockKey, distinct from the meeting sweep's, so the two 60s jobs
  // never contend on one advisory lock and starve each other.
  //
  // The second argument is the SLICE-H SEAM: `departmentWatchers` defaults to
  // assignees-only because PmProject has no department today. When slice H
  // lands, pass its resolver here — that is the whole integration; nothing in
  // activity-notify.service.ts changes.
  //
  // Errors propagate naked to cron-runtime's `safeRun`, matching every other
  // handler here; only the MQTT toast and the department resolver are
  // absorbed inside the service (leaf effects).
  cronRuntime.scheduleInterval(
    60_000,
    async () => {
      const result = await runActivityNotifySweep(prisma);
      if (result.notificationsSent > 0 || result.pmSkipped > 0 || result.crmSkipped > 0) {
        logger.info(result, "activity notify sweep");
      }
    },
    { lockKey: "droplet:activity-notify" },
  );

  // WARP-475's nightly camera-retention purge used to fire here at 03:30.
  // WARP-1849 removed it: both endpoints it called —
  // `DELETE /api/recordings?before=` and `DELETE /api/events?before=` —
  // return 405 on Frigate 0.17. They do not exist and, per Frigate's
  // route table, never did in the form this cron assumed. The purge had
  // therefore deleted nothing for its entire lifetime while writing a
  // nightly ActivityRow that read "0 clips · 0 events" — indistinguishable
  // from a healthy no-op run.
  //
  // Retention is not reimplemented here. Frigate expires recordings per
  // camera natively (`frigate/record/cleanup.py`) from the config keys
  // camera-settings.service.ts now writes, and evicts on a full disk via
  // `frigate/storage.py`. The orchestrator's job is to set that config,
  // not to duplicate the deletion.

  // WARP-1850: hourly near-full check on the recordings volume. Edge-
  // triggered inside the service — one ActivityRow per crossing, not one
  // per tick — so the warning still means something when it appears.
  //
  // Hourly rather than by-the-minute because Frigate recomputes usage by
  // summing segment sizes; the volume cannot go from healthy to full in
  // under an hour on any realistic camera count, and Frigate evicts
  // oldest-first before anything is actually lost.
  //
  // Errors propagate naked to cron-runtime's `safeRun`, matching every
  // other handler here: an unreachable Frigate SHOULD increment the
  // canary rather than be silently absorbed. That is the direct lesson of
  // WARP-1849, where swallowed failures read as healthy for months.
  cronRuntime.scheduleCron(
    "20 * * * *",
    async () => {
      const result = await checkStorageNearFull();
      if (result.warned) {
        logger.warn(result, "camera storage near-full warning raised");
      }
    },
    { lockKey: "droplet:camera-storage-near-full" },
  );

  // WARP-1851: re-derive budget-managed retention windows. Fires at 03:40,
  // after the near-full check has settled and clear of the 03:00/03:15
  // purges on the advisory-lock pool.
  //
  // Daily, not hourly: the input is a camera's average bitrate over its
  // last 100 segments, which moves slowly. Reconciling more often would
  // restart budgeted cameras (every Frigate config write does) for
  // sub-percent drift.
  //
  // The pass is idempotent — a camera already at its derived window is
  // skipped, so a steady system issues no writes at all.
  cronRuntime.scheduleCron(
    "40 3 * * *",
    async () => {
      const result = await reconcileCameraBudgets(prisma);
      if (result.applied.length > 0 || result.held.length > 0) {
        logger.info(result, "camera storage budget reconcile complete");
      }
      // A pass where every camera failed must NOT look like a quiet success.
      // The service collects per-camera errors so one broken camera can't
      // strand the rest, but a pass that achieved nothing has to reach the
      // cron canary — reporting success never achieved is the failure mode
      // this whole epic was created by (WARP-1849).
      if (result.failed.length > 0) {
        throw new Error(
          `camera storage budget reconcile: ${result.failed.length} of ` +
            `${result.failed.length + result.applied.length + result.held.length} ` +
            `camera(s) failed — ${result.failed
              .map((f) => `${f.camera}: ${f.error}`)
              .join("; ")}`,
        );
      }
    },
    { lockKey: "droplet:camera-budget-reconcile" },
  );

  // ADR-023 (C2): daily public-CA TLS issuance / renewal. Fires at 04:00 so it
  // doesn't contend with the 03:00 daily purge or the 03:15 guest sweep on the
  // advisory-lock pool. Reads the explicit TlsCert state
  // row + the installed cert: a BOOTSTRAP_SELF_SIGNED box issues a publicly-
  // trusted cert now; an LE_ISSUED cert renews when <=30 days remain. HQ-
  // unreachable keeps the current cert and sets LE_RENEW_FAILED inside the
  // service (it does NOT throw), so a flaky HQ never increments the canary;
  // only an unexpected (programming) error bubbles up here — exactly what the
  // canary should escalate, same posture as the purge handlers above.
  // ADR-023 PR-1 — zero-touch. `hqConfigured` gates the empty-fqdn bootstrap
  // path so a fresh box LEARNS its opaque name from HQ (and persists it back to
  // .env via the bridge); `dns` registers that learned name with the routing
  // service's split-horizon dnsmasq on every install. Both extra collaborators
  // are best-effort — a persist/DNS failure never aborts issuance.
  const hqConfigured = !!config.HQ_ISSUANCE_URL;
  const tlsIssuance = createTlsIssuanceService({
    fqdn: config.DROPLET_PUBLIC_FQDN,
    deviceId: config.DROPLET_DEVICE_ID,
    hq: createHqIssuanceClient(),
    identity: createDeviceIdentityClient(),
    store: createPrismaTlsCertStore(prisma),
    files: createDiskTlsFileOps(),
    reloadNginx: bridgeNginxReloader,
    logger,
    hqConfigured,
    persistFqdn: createBridgeFqdnPersister(),
    dns: createRoutingDnsRegistrar(),
    // WARP-979 — send the owner-chosen box name to HQ as `requested_name` so it
    // issues `<name>.droplet-us.com`. Empty when no name chosen (opaque-HMAC
    // fallback). Harmless if HQ ignores it (coupled fleet-hq follow-up).
    requestedName: config.DROPLET_BOX_NAME,
    // WARP-983 — one-time provisioning token. When set, a fresh / factory-reset
    // box whose HQ registry row was freed by the ADR-023 deregister self-enrolls
    // (POST /api/issuance/provision) on the 404 and retries issuance once. Empty
    // = self-provision disabled (dev/CI + boxes provisioned by another path).
    provisionToken: config.DROPLET_PROVISION_TOKEN,
  });
  cronRuntime.scheduleCron(
    "0 4 * * *",
    async () => {
      await tlsIssuance.runOnce();
    },
    { lockKey: "droplet:tls-renewal" },
  );
  // WARP-1109 — register the composed issuance service's runOnce so the rename
  // endpoint (POST /api/setup/box-name/rename) can trigger an immediate re-issue
  // under the box's NEW FQDN. Composed once here (the collaborators are heavy);
  // the setup route reads it via reissueTlsNow() (a no-op until this runs).
  initTlsReissueHook(() => tlsIssuance.runOnce());
  // ADR-023 PR-1 (Gap 3) — immediate, idempotent, fail-soft boot tick so a
  // reflash gets its publicly-trusted cert within seconds instead of waiting up
  // to 24h for the 04:00 cron. Gated on HQ being configured (no-op on dev/CI);
  // the service's provisioned-guard short-circuits an un-provisioned box inside
  // runOnce(). The unref'd timer never holds the loop open and a rejection is
  // caught (NOT via cron-runtime.safeRun, so it never churns the cron canary).
  scheduleTlsBootTick({
    hqConfigured,
    runOnce: () => tlsIssuance.runOnce(),
    logger,
  });

  // WARP-2218 — connector sync. The escape this closes: BEFORE this leg
  // existed, no connector sync was scheduled anywhere in the product, and
  // `lastHealthyAt` — the column the hub renders as "last synced" — was
  // written in exactly one place, inside `connect()`. A connection that
  // succeeded in March and had served reads ever since still displayed its
  // March timestamp. "Last synced" meant "last connected", which is a
  // confidently wrong statement about how fresh a customer's money data is.
  //
  // Two legs, deliberately on different cadences:
  //
  //   incremental  reads from the persisted watermark. Frequent and cheap.
  //   sweep        re-enumerates from the beginning and emits a drift report.
  //                Rare and expensive.
  //
  // The sweep is not an optimisation to add later. Xero's `UpdatedDateUTC`
  // does not fire on DueDate / SentToContact / contact-balance changes,
  // HubSpot's Search API is eventually consistent, and Stripe does not
  // guarantee event ordering — so the incremental path can report SUCCESS
  // while silently missing records, which is worse than failing, because the
  // owner has no way to find out. See `services/erp-sync/reconcile.ts`.
  //
  // Both carry a `lockKey`: `cron-runtime.service.ts:154` `withAdvisoryLock`
  // pins acquire+release to one backend connection inside a `$transaction` and
  // SKIPS the tick when another replica holds it. Without it a multi-instance
  // box double-polls every vendor and burns a shared rate budget twice.
  //
  // Errors propagate naked to `safeRun`, matching every other cron leg in this
  // file — swallowing them would zero the per-handler consecutiveFailures
  // canary that downstream alerting reads.
  const erpSyncRecorder = getActivityRecorder();
  if (erpSyncRecorder) {
    const erpSyncRunner = createErpSyncRunner({
      prisma: prisma as never,
      recorder: erpSyncRecorder,
    });

    // Read at BOOT, inside main() — never at module import. A schedule frozen
    // at import is the `INFERENCE_RUNTIME` bug again: `docker restart` does not
    // re-read `env_file`, so the operator changes the value, restarts, and
    // nothing happens. Reading here means `up -d --force-recreate` is enough.
    const erpTickMs = Number(process.env.DROPLET_ERP_SYNC_TICK_MS ?? 15 * 60 * 1000);
    const erpSweepLegMs = Number(process.env.DROPLET_ERP_SYNC_SWEEP_LEG_MS ?? 60 * 60 * 1000);

    // Per-box jitter, derived from device identity — NOT `Math.random()`.
    // Xero's rate limit is app-wide and POOLED at 10,000 calls/min across
    // every box we ship, which saturates at roughly 1,250 boxes syncing on the
    // same minute. On-prem appliances otherwise align on round times, and that
    // is a limit we neither control nor can raise per customer. Deriving the
    // offset keeps the same box in the same slot across restarts, so an
    // incident can be explained rather than shrugged at.
    const deviceId = config.DROPLET_DEVICE_ID;

    cronRuntime.scheduleInterval(
      jitteredPeriodMs(erpTickMs, deviceId),
      async () => {
        await erpSyncRunner.registerCursors();
        const out = await erpSyncRunner.runIncrementalTick();
        if (out.cursorsClaimed > 0) {
          logger.info(out, "erp connector sync tick");
        }
      },
      { lockKey: "droplet:erp-connector-sync" },
    );

    // The sweep LEG runs hourly; whether any cursor is actually re-enumerated
    // is gated inside the runner on the persisted `lastSweepAt` (24h default).
    // Splitting it this way means a box that was powered off over its sweep
    // window picks the work up within the hour instead of skipping a full day,
    // while the expensive re-enumeration itself still happens only daily.
    cronRuntime.scheduleInterval(
      jitteredPeriodMs(erpSweepLegMs, `${deviceId}:sweep`),
      async () => {
        const out = await erpSyncRunner.runReconciliationSweep();
        const drifted = out.reports.filter((r) => r.driftDetected);
        if (drifted.length > 0) {
          logger.warn(
            { connections: drifted.length, totalMissed: drifted.reduce((n, r) => n + r.totalMissed, 0) },
            "erp reconciliation sweep found records the incremental path missed",
          );
        }
      },
      { lockKey: "droplet:erp-connector-reconciliation" },
    );

    // WARP-2463 — retention for the sweep's STORED drift report.
    //
    // The sweep writes one row per (connection, entity) per pass, INCLUDING a
    // clean pass, so the table grows on a fixed schedule forever and needs a
    // trim by construction. Its own leg at 03:30 rather than a line in the
    // 03:00 daily-purge handler: that handler runs every retention sweep on
    // the box inside ONE 60 s advisory-lock transaction, and adding a table
    // spends from the same budget (see audit-retention-purge.service.ts, which
    // is mostly an argument about exactly that). 03:30 continues the 03:00 /
    // 03:15 spacing that keeps the legs off each other's lock pool.
    //
    // Window read at BOOT, like the two schedules above — never at module
    // import, so `up -d --force-recreate` is enough to change it.
    registerErpDriftRetention(cronRuntime, prisma as never, {
      retentionDays: config.DROPLET_ERP_DRIFT_RETENTION_DAYS,
      onTrimmed: (result) => {
        if (result.deleted > 0 || result.skipped) {
          logger.info(result, "erp drift record retention trim");
        }
      },
    });
  }

  // WARP-2118 (ADR-041) — the Microsoft 365 delta sync tick.
  //
  // This is the caller WARP-2115 shipped without. Every decision it makes
  // already existed and was already tested — `sync-policy.ts` classifies the
  // failure, `delta-cursor.service.ts` moves the cursor, `m365-auth.service.ts`
  // resolves the grant — and none of them had anything calling them in
  // sequence, so no mailbox was ever read.
  //
  // Gated on `isM365Configured()`: with no client id there is no app to
  // authenticate against, and a tick that runs anyway would mark every cursor
  // failed on a box that simply does not offer the feature.
  //
  // Discovery runs BEFORE the tick, every time, and that ordering is
  // load-bearing rather than tidy: mail delta is per-folder, so a folder
  // created since the last tick has no cursor and its mail is invisible until
  // discovery registers one. `upsertCursor` touches nothing on an existing row,
  // so re-running it is free.
  //
  // `lockKey` for the same reason as the ERP legs: without it a multi-instance
  // box double-polls Microsoft and spends the tenant's throttling budget twice.
  if (isM365Configured()) {
    const m365Deps: M365SyncDeps = {
      prisma: prisma as never,
      client: new GraphClient({ version: ORCHESTRATOR_M365_UA_VERSION }),
      entra: createEntraClient(),
      initialUrlFor,
    };

    // Read at BOOT, never at module import — `docker restart` does not re-read
    // `env_file`, so a schedule frozen at import ignores an operator's change.
    const m365TickMs = Number(process.env.DROPLET_M365_SYNC_TICK_MS ?? 5 * 60 * 1000);

    cronRuntime.scheduleInterval(
      jitteredPeriodMs(m365TickMs, `${config.DROPLET_DEVICE_ID}:m365`),
      async () => {
        // Only CONNECTED grants. A NEEDS_RECONNECT row has a dead refresh
        // token, and enumerating it every tick would hammer Entra to produce
        // the same failure the person already has to act on.
        const connected = (await prisma.m365Connection.findMany({
          where: { state: "CONNECTED" },
          select: { userId: true },
        })) as Array<{ userId: string }>;

        for (const { userId } of connected) {
          const found = await discoverResources(m365Deps, userId);
          if (found.skipped.length > 0) {
            // A licence gap or a declined scope, not a crash — but silence here
            // would look identical to "that workload has no data".
            logger.info(
              { skipped: found.skipped, registered: found.registered },
              "m365 discovery skipped workloads",
            );
          }
        }

        const out = await runSyncTick(m365Deps);
        if (out.cursorsClaimed > 0) {
          logger.info(
            {
              cursorsClaimed: out.cursorsClaimed,
              cursorsCompleted: out.cursorsCompleted,
              itemsSeen: out.itemsSeen,
            },
            "m365 delta sync tick",
          );
        }
      },
      { lockKey: "droplet:m365-delta-sync" },
    );
  }

  // Start Express on top of a raw http.Server so we can attach the
  // WebSocket bridge (MQTT → browser) to the same listen socket.
  // feat/scene-schedules: pass the hoisted Matter dispatcher so the scenes
  // router and the scene-schedule ticker share ONE instance.
  const app = createApp(prisma, sceneMatterDispatcher);
  // WARP-236: when internal mTLS is enabled the SAME port serves HTTPS and
  // every caller (nginx gateway included) must present a CA-signed client
  // cert. Dev installs (DROPLET_INTERNAL_TLS unset) keep plain HTTP.
  const server = internalTlsEnabled()
    ? createTlsServer(httpsServerOptions(), app)
    : createServer(app);
  attachWsBridge(server);
  server.listen(config.PORT, () => {
    logger.info("API server listening on port %d", config.PORT);
  });

  // Graceful shutdown. `exitCode` defaults to 0 so SIGTERM/SIGINT keep their
  // clean-exit semantics; the uncaughtException path (WARP-572) passes 1 so
  // Docker's restart policy brings a fresh instance back.
  const shutdown = createShutdownRunner(logger, async () => {
    cronRuntime.stop();
    // WARP-2177 — hand in-flight runs back to `queued` (not charged as an
    // attempt) so the restarted process resumes them from their checkpoint
    // on its first tick instead of after the reclaim threshold.
    await agentRunWorker.releaseAll().catch((err) => {
      logger.warn("agent run release failed: %s", (err as Error).message);
    });
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
    // best-effort; if the SDK close throws we log and continue, and if it
    // hangs the force-exit timer armed inside createShutdownRunner bounds
    // the wait.
    await stopMcp().catch((err) => {
      logger.warn("MCP stdio child stop failed: %s", (err as Error).message);
    });
    await prisma.$disconnect();
  });

  process.on("SIGTERM", () => void shutdown(0));
  process.on("SIGINT", () => void shutdown(0));

  // WARP-572: process-level safety net. The orchestrator is an always-on
  // control plane that fires many background promises outside the request
  // lifecycle (cron ticks, pollers, the streaming flush timer, best-effort
  // MQTT / activity writes). On modern Node an unhandled rejection or
  // uncaught exception terminates the process by default — so one stray
  // background throw could take down the whole appliance with only Node's
  // default stderr dump. Wire structured handlers so the failure is logged
  // and recovery is deterministic. onFatal runs the graceful shutdown with a
  // non-zero exit code.
  registerProcessSafetyNet(logger, () => void shutdown(1));
}

// WARP-572: graceful-shutdown runner, extracted so the re-entrancy guard and
// force-exit failsafe are unit-testable without booting Prisma/Redis/MQTT (see
// src/__tests__/process-safety-net.test.ts). `teardown` is the injectable body
// — in production it stops the cron runtime, Matter/Camera/MCP services and
// disconnects Prisma; in tests it's a stub.
//
// Behavior:
//   - Re-entrancy guard: a second call (second uncaughtException, or a SIGTERM
//     arriving mid-teardown) short-circuits — no double teardown, no double
//     process.exit. Shared via the module-scope `shuttingDown` flag.
//   - Force-exit failsafe: an unref'd timer is armed before teardown begins, so
//     a hung teardown step can't strand the corrupted process. unref() keeps
//     the timer from holding the loop open when teardown finishes first.
export function createShutdownRunner(
  log: pino.Logger,
  teardown: () => Promise<void>,
): (exitCode?: number) => Promise<void> {
  return async (exitCode = 0) => {
    if (shuttingDown) {
      log.warn("Shutdown already in progress, ignoring re-entry");
      return;
    }
    shuttingDown = true;

    const forceExit = setTimeout(() => {
      log.fatal(
        { code: "shutdownForceExit", timeoutMs: SHUTDOWN_FORCE_EXIT_MS },
        "Graceful shutdown timed out, forcing exit",
      );
      process.exit(exitCode);
    }, SHUTDOWN_FORCE_EXIT_MS);
    forceExit.unref();

    log.info("Shutting down...");
    await teardown();
    clearTimeout(forceExit);
    process.exit(exitCode);
  };
}

// Test-only: reset the shutdown re-entrancy latch so each unit test starts
// clean. Not called from production code paths.
export function __resetShutdownGuardForTests(): void {
  shuttingDown = false;
}

// WARP-572: extracted so the handler wiring is unit-testable without booting
// the full stack (see src/__tests__/process-safety-net.test.ts). Kept in
// index.ts so process lifecycle stays centralized.
//
// - unhandledRejection is logged-but-survivable: log at error with a stable,
//   greppable `code` and DO NOT exit, so a single stray background throw
//   degrades rather than kills the control plane. This mirrors the
//   never-silently-swallow posture of cron-runtime's safeRun logging.
// - uncaughtException is fatal-after-flush: log at fatal (matching the
//   boot-failure handler below), then run the caller's onFatal (graceful
//   shutdown + non-zero exit). Logged synchronously before onFatal so the
//   diagnostic lands in container logs even if exit races a pino flush.
// Idempotency guard: a double call (e.g. a botched merge wiring it from both
// main() and a test harness) must not attach two listeners that would log the
// same rejection twice and fire onFatal twice. Tracked at module scope so the
// guard survives across calls within one process.
let safetyNetRegistered = false;

export function registerProcessSafetyNet(
  log: pino.Logger,
  onFatal: () => void,
): void {
  if (safetyNetRegistered) {
    log.warn(
      { code: "safetyNetAlreadyRegistered" },
      "Process safety net already registered, skipping duplicate wiring",
    );
    return;
  }
  safetyNetRegistered = true;

  process.on("unhandledRejection", (reason) => {
    log.error(
      { err: reason, code: "unhandledRejection" },
      "Unhandled promise rejection (surviving)",
    );
  });
  process.on("uncaughtException", (err) => {
    log.fatal({ err, code: "uncaughtException" }, "Uncaught exception, shutting down");
    onFatal();
  });
}

// Test-only: reset the idempotency latch so each unit test starts clean. Not
// called from production code paths.
export function __resetProcessSafetyNetForTests(): void {
  safetyNetRegistered = false;
}

// Only boot the stack when this module is the process entrypoint. Importing
// it from a test (vitest) must not run main() — the runner is the entrypoint
// then, so this guard is false. The orchestrator package has no
// `"type": "module"`, so even with tsconfig `module: NodeNext` this file
// emits CommonJS — hence the `require.main`/`module` idiom rather than
// `import.meta` (which tsc rejects with TS1470 in CJS output). Works under
// `tsx src/index.ts` (dev) and `node dist/index.js` (prod); under vitest
// `require.main` is the runner, so the guard stays false.
if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, "Failed to start API server");
    process.exit(1);
  });
}
