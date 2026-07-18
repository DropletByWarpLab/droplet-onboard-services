/**
 * matter-controller sidecar entrypoint (WARP-850).
 *
 * Boot order is load-bearing:
 *   1. FIPS boot self-test (same posture as every other Node service).
 *   2. BLE transport registration into Environment.default — at PROCESS
 *      START, before the CommissioningController exists, so the
 *      bleCommissioning capability is decided exactly once and never
 *      flips mid-boot (WARP-850 ticket comment).
 *   3. Controller init (storage + matter.js start). Non-fatal: a failed
 *      start leaves /health and /capabilities serving while data routes
 *      503 — mirrors the orchestrator's old non-fatal initMatterService.
 *   4. HTTP listen on DROPLET host-service port 8083 (ladder: routing
 *      8080, switch 8081, display 8082 → matter-controller 8083).
 */

import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:https";
import pino from "pino";
import { Environment } from "@matter/main";
import { assertFipsAtBootOrExit } from "@droplet/fips-selftest";
import { config } from "./config.js";
import { registerBleAtProcessStart } from "./ble.js";
import { createMatterControllerCore } from "./controller.js";
import { httpsServerOptions, internalTlsEnabled } from "./internal-tls.js";
import { createApp } from "./server.js";

const logger = pino({ name: "matter-controller" });

function runFipsBootSelfTest(): void {
  const required =
    process.env.DROPLET_FIPS_REQUIRED?.toLowerCase() === "true" ||
    process.env.DROPLET_FIPS_REQUIRED === "1" ||
    (process.env.DROPLET_FIPS_REQUIRED === undefined &&
      config.NODE_ENV === "production");
  if (!required) {
    logger.warn(
      "FIPS boot self-test skipped (DROPLET_FIPS_REQUIRED=false or non-production env)",
    );
    return;
  }
  assertFipsAtBootOrExit("matter-controller");
}

async function main() {
  runFipsBootSelfTest();

  // Step 2 — BLE, once, before anything else touches matter.js.
  const capabilities = await registerBleAtProcessStart({
    hciId: config.DROPLET_MATTER_BLE_HCI_ID,
    environment: Environment.default,
  });
  logger.info(
    { bleCommissioning: capabilities.bleCommissioning },
    capabilities.reason,
  );

  const core = createMatterControllerCore({
    storagePath: config.MATTER_STORAGE_PATH,
    adminFabricLabel: config.DROPLET_MATTER_CONTROLLER_NAME,
    // WARP-895: Wi-Fi credentials for BLE-first commissioning (empty ⇒
    // on-network-only). Resolved per-commission inside the core.
    wifiSsid: config.DROPLET_MATTER_WIFI_SSID,
    wifiPsk: config.DROPLET_MATTER_WIFI_PSK,
    wifiPskFile: config.DROPLET_MATTER_WIFI_PSK_FILE,
    regulatoryCountryCode: config.DROPLET_MATTER_REGULATORY_COUNTRY,
    // Discovery must know which transports exist: without this the core
    // omits discoveryCapabilities and matter.js scans mDNS only, so a
    // freshly-reset BLE-first device is never found.
    bleCommissioning: capabilities.bleCommissioning,
  });

  // Step 3 — controller init, non-fatal (matches the orchestrator's
  // historical posture: a box with a broken Matter stack still boots).
  try {
    await core.init();
    logger.info("Matter controller initialized");
  } catch (err) {
    logger.warn(
      "Matter controller unavailable: %s",
      (err as Error).message,
    );
  }

  const app = createApp({
    core,
    authToken: config.DROPLET_MATTER_SERVICE_TOKEN,
    capabilities,
    // WARP-1035: same values the core resolves per commission —
    // /capabilities answers wifiProvisioning from the identical inputs.
    wifiOptions: {
      wifiSsid: config.DROPLET_MATTER_WIFI_SSID,
      wifiPsk: config.DROPLET_MATTER_WIFI_PSK,
      wifiPskFile: config.DROPLET_MATTER_WIFI_PSK_FILE,
    },
  });
  // WARP-1061: with internal mTLS on, the SAME port serves HTTPS and every
  // caller (the orchestrator's matter.service.ts) must present a CA-signed
  // client cert. Flag off (default) keeps plain HTTP — mirrors the
  // orchestrator's WARP-236 listener switch in apps/orchestrator/src/index.ts.
  const server = internalTlsEnabled()
    ? createTlsServer(httpsServerOptions(), app)
    : createServer(app);
  server.listen(config.PORT, () => {
    logger.info("matter-controller listening on port %d", config.PORT);
  });

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info("Shutting down...");
    // Bound the teardown — a hung matter.js close must not strand the
    // container past Docker's stop timeout.
    const forceExit = setTimeout(() => {
      logger.fatal("Graceful shutdown timed out, forcing exit");
      process.exit(0);
    }, 10_000);
    forceExit.unref();
    server.close();
    await core.shutdown().catch((err) => {
      logger.warn("Controller shutdown failed: %s", (err as Error).message);
    });
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal({ err }, "Failed to start matter-controller");
    process.exit(1);
  });
}
