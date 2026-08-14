/**
 * WARP-851 — Matter commissioning error honesty.
 *
 * On a box with no BLE and no LAN mDNS reachability (the compose bridge
 * network), matter.js commissioning fails on discovery. Under 0.16 the error
 * was `CommissionableDeviceDiscoveryFailedError` whose message is:
 *
 *   No device discovered using identifier {"shortDiscriminator":7}!
 *   Please check that the relevant device is online.
 *
 * (Verified live on box 192.168.1.87 and reproduced against
 * @matter/protocol's ControllerDiscovery in this repo's dependency
 * tree.) That message matches NONE of the regexes in
 * `translateCommissionError()` — "discovered" is not "discovery" — so
 * it fell through to the generic 500 whose copy tells the customer to
 * factory-reset their device. The box can't hear the device; a factory
 * reset will never help. This suite pins the mapping to the honest
 * network-discovery copy with a 502.
 *
 * matter.js 0.17 removed that error class AND reworded the message (see
 * DISCOVERY_TIMEOUT_MESSAGE_017 below). Both wordings are pinned here: the
 * 0.16 one so a rollback can't regress, the 0.17 one because it is what the
 * shipping box now actually raises.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
// matter.js 0.17 removed `CommissionableDeviceDiscoveryFailedError` (and the
// whole @matter/protocol `ControllerDiscovery` module) — commissioning
// discovery moved to @matter/node and now raises `DiscoveryError`, re-exported
// from @matter/main. The mapping under test is message-based, so the class
// only has to be the real one matter.js throws.
import { DiscoveryError } from "@matter/main";

// ── Config mock — hoisted above route imports (same pattern as rbac.test). ──
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
    JWT_SECRET: "test-secret-32-bytes-long-aaaaaaaa",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../services/cache.service.js", () => ({
  cacheGet: vi.fn().mockResolvedValue(null),
  cacheSet: vi.fn().mockResolvedValue(undefined),
}));

// Matter service — the route only needs isMatterInitialized + commissionDevice
// for the commission path; the rest are inert stubs so the router mounts.
const { commissionDeviceMock } = vi.hoisted(() => ({
  commissionDeviceMock: vi.fn(),
}));
vi.mock("../services/matter.service.js", () => ({
  isMatterInitialized: vi.fn(() => true),
  commissionDevice: commissionDeviceMock,
  getCommissionedDevices: vi.fn(),
  getDevice: vi.fn(),
  sendMatterCommand: vi.fn(),
  discoverDevices: vi.fn(),
  decommissionDevice: vi.fn(),
  subscribeStateChanges: vi.fn(() => () => {}),
  subscribeConnectionChanges: vi.fn(() => () => {}),
  getMatterCapabilities: vi.fn(() => ({ bleCommissioning: false })),
}));

vi.mock("../services/safety-tier.service.js", () => ({
  evaluateCommand: vi.fn(),
  confirmCommand: vi.fn(),
  getAuditLog: vi.fn(),
}));

import { createMatterRouter, translateCommissionError } from "../routes/matter.js";
import type { AuthUser } from "../middleware/auth.js";
import type { PrismaClient } from "@prisma/client";

/**
 * The EXACT message matter.js throws when mDNS discovery for a manual
 * pairing code (short discriminator 7, e.g. 1602-004-8090) finds
 * nothing before the 30s waiter expires. Source:
 * @matter/protocol ControllerDiscovery.discoverDeviceAddressesByIdentifier.
 */
const DISCOVERY_TIMEOUT_MESSAGE =
  'No device discovered using identifier {"shortDiscriminator":7}! Please check that the relevant device is online.';

/** The second discovery-failure variant from the same matter.js function. */
const NO_ADDRESSES_MESSAGE =
  'Device discovered using identifier {"shortDiscriminator":7}, but no Network addresses discovered.';

/**
 * matter.js 0.17 REWORDED this failure. `ControllerDiscovery` is gone;
 * commissioning discovery is now @matter/node's `ParallelPaseDiscovery`, which
 * throws `DiscoveryError` built as `` `${this} failed: ${detail}` `` where
 * `toString()` renders "discovery of <what>" and, when nothing answered at all,
 * `detail` is "No commissionable device was discovered".
 *
 * Source: @matter/node/behavior/system/controller/discovery/
 *   ParallelPaseDiscovery.js (detail) + Discovery.js (toString).
 *
 * Note it no longer contains the contiguous phrase "no device discovered", so
 * the WARP-851 pattern written against the 0.16 wording does NOT match it.
 */
const DISCOVERY_TIMEOUT_MESSAGE_017 =
  "discovery of 1602-004-8090 failed: No commissionable device was discovered";

const NETWORK_DISCOVERY_COPY =
  "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.";

describe("translateCommissionError — discovery-timeout mapping (WARP-851)", () => {
  it("maps the real 'No device discovered' message to 502 with the network-discovery copy", () => {
    const err = new DiscoveryError(DISCOVERY_TIMEOUT_MESSAGE);
    const friendly = translateCommissionError(err);
    expect(friendly.status).toBe(502);
    expect(friendly.message).toBe(NETWORK_DISCOVERY_COPY);
    expect(friendly.internalReason).toBe(DISCOVERY_TIMEOUT_MESSAGE);
  });

  it("never surfaces factory-reset advice for the discovery-timeout case", () => {
    const friendly = translateCommissionError(
      new Error(DISCOVERY_TIMEOUT_MESSAGE),
    );
    expect(friendly.message).not.toMatch(/factory[- ]reset/i);
    expect(friendly.status).not.toBe(500);
  });

  it("maps the 'no Network addresses discovered' variant to 502 (non-regression)", () => {
    const friendly = translateCommissionError(new Error(NO_ADDRESSES_MESSAGE));
    expect(friendly.status).toBe(502);
    expect(friendly.message).toBe(NETWORK_DISCOVERY_COPY);
  });

  // --- matter.js 0.17 rewording ---
  //
  // The 0.16 wording the WARP-851 pattern was written against no longer
  // exists. Pin the 0.17 wording EXPLICITLY: without its own pattern this
  // case only reaches the honest 502 by accidentally containing the word
  // "discovery" (from `toString()`) and hitting the broad network/ble/
  // discovery catch-all further down. That is one upstream `toString()`
  // tweak away from silently falling through to the generic 500 whose copy
  // tells the customer to factory-reset a device the box simply cannot hear
  // — the precise harm WARP-851 exists to prevent.
  it("maps the matter.js 0.17 discovery wording to 502 with the network-discovery copy", () => {
    const friendly = translateCommissionError(
      new DiscoveryError(DISCOVERY_TIMEOUT_MESSAGE_017),
    );
    expect(friendly.status).toBe(502);
    expect(friendly.message).toBe(NETWORK_DISCOVERY_COPY);
    expect(friendly.internalReason).toBe(DISCOVERY_TIMEOUT_MESSAGE_017);
  });

  it("never surfaces factory-reset advice for the 0.17 discovery wording", () => {
    const friendly = translateCommissionError(
      new Error(DISCOVERY_TIMEOUT_MESSAGE_017),
    );
    expect(friendly.message).not.toMatch(/factory[- ]reset/i);
    expect(friendly.status).not.toBe(500);
  });

  it("maps the 0.17 wording on its own, without leaning on the word 'discovery'", () => {
    // Same detail, but with the `toString()` prefix stripped — proves the
    // mapping binds on the failure DETAIL, not on an incidental word in the
    // object description that upstream is free to change.
    const friendly = translateCommissionError(
      new Error("No commissionable device was discovered"),
    );
    expect(friendly.status).toBe(502);
    expect(friendly.message).toBe(NETWORK_DISCOVERY_COPY);
  });

  it("prefers 'nothing was discovered' over the generic timeout branch", () => {
    // The 0.17 discovery scan is timeout-bounded (@matter/node Discovery.js
    // wraps the whole thing in `withTimeout`), so a real failure can carry
    // BOTH "nothing discovered" and timeout wording. "We never heard the
    // device at all" is the more specific and more actionable truth, so it
    // must win over the 504 "move it closer and retry" copy.
    //
    // This is also the case that proves the mapping is INTENTIONAL: without
    // an explicit 0.17 pattern ordered above the timeout branch, the only
    // reason any of these land on the honest 502 is that /ble/ happens to
    // match the substring inside "commissiona-ble".
    const friendly = translateCommissionError(
      new Error(
        "discovery of 1602-004-8090 failed: No commissionable device was discovered before the scan timed out",
      ),
    );
    expect(friendly.status).toBe(502);
    expect(friendly.message).toBe(NETWORK_DISCOVERY_COPY);
  });

  // Non-regression on the pre-existing branches — the new pattern must
  // not shadow the more specific mappings.
  it("keeps invalid-pairing-code errors at 400", () => {
    const friendly = translateCommissionError(
      new Error("Invalid manual code: non-numeric character at position 3"),
    );
    expect(friendly.status).toBe(400);
  });

  it("keeps already-commissioned errors at 409", () => {
    const friendly = translateCommissionError(
      new Error("Node 42 already commissioned"),
    );
    expect(friendly.status).toBe(409);
  });

  it("keeps PASE failures at 400", () => {
    const friendly = translateCommissionError(
      new Error("PASE handshake failed"),
    );
    expect(friendly.status).toBe(400);
  });

  it("keeps unknown errors at the generic 500", () => {
    const friendly = translateCommissionError(
      new Error("something completely unexpected"),
    );
    expect(friendly.status).toBe(500);
  });
});

describe("POST /api/matter/commission — discovery-timeout response (WARP-851)", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    // Synthetic auth: stuff req.user so the real requireRole guard passes
    // (same pattern as rbac.test.ts — avoids minting JWTs).
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user: AuthUser }).user = {
        id: "u1",
        username: "owner",
        displayName: "Owner",
        role: "owner",
      };
      next();
    });
    app.use("/api", createMatterRouter({} as unknown as PrismaClient));
    return app;
  }

  beforeEach(() => {
    commissionDeviceMock.mockReset();
  });

  it("returns 502 + network-discovery copy when matter.js throws the discovery failure", async () => {
    commissionDeviceMock.mockRejectedValue(
      new DiscoveryError(DISCOVERY_TIMEOUT_MESSAGE),
    );

    const res = await request(buildApp())
      .post("/api/matter/commission")
      .send({ pairing_code: "1602-004-8090" });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe(NETWORK_DISCOVERY_COPY);
    expect(res.body.error).not.toMatch(/factory[- ]reset/i);
    expect(res.body.internalReason).toBe(DISCOVERY_TIMEOUT_MESSAGE);
  });
});
