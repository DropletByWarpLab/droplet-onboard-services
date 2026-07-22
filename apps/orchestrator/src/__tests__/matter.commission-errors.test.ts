/**
 * WARP-851 — Matter commissioning error honesty.
 *
 * On a box with no BLE and no LAN mDNS reachability (the compose bridge
 * network), matter.js commissioning fails with
 * `CommissionableDeviceDiscoveryFailedError` whose message is:
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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { type Request, type Response, type NextFunction } from "express";
import { CommissionableDeviceDiscoveryFailedError } from "@matter/main/protocol";

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

const NETWORK_DISCOVERY_COPY =
  "Couldn't find the device on the network. Make sure it's powered on, in pairing mode, and on the same Wi-Fi as the Droplet.";

describe("translateCommissionError — discovery-timeout mapping (WARP-851)", () => {
  it("maps the real 'No device discovered' message to 502 with the network-discovery copy", () => {
    const err = new CommissionableDeviceDiscoveryFailedError(
      DISCOVERY_TIMEOUT_MESSAGE,
    );
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
      new CommissionableDeviceDiscoveryFailedError(DISCOVERY_TIMEOUT_MESSAGE),
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
