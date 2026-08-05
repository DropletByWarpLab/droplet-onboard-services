/**
 * WARP-1474 — production auth-mount regression (SEND-BACK MUST-FIX).
 *
 * The route unit tests (`vpn-overlay-qr-enroll.test.ts`) mount `createVpnRouter`
 * WITHOUT the global `authMiddleware` and with `AUTH_ENABLED:false` — a
 * seam-mocked false green (the WARP-1288 anti-pattern). On a real box,
 * `app.ts` runs `app.use(authMiddleware)` BEFORE `createVpnRouter`, and the
 * global auth public-allowlist had no overlay entry, so a bearer-less
 * `POST /api/vpn/overlay/devices/by-token` (the QR-scanning phone has NO bearer
 * by design — ADR-030/031) hit the middleware 401 BEFORE the vpn router ran.
 * The redeem→stage→approve→status flow was dead in production.
 *
 * This test builds the app with the REAL `authMiddleware` in front of the REAL
 * `createVpnRouter` and `AUTH_ENABLED=true`, exactly as `app.ts` wires them, and
 * proves:
 *   1. bearer-less `POST /vpn/overlay/devices/by-token` REACHES the handler,
 *   2. bearer-less `GET  /vpn/overlay/devices/by-token/:id/status` REACHES it,
 *   3. the owner-gated routes (link-tokens, pending-enrollments[/approve], and
 *      the WARP-1385 `POST /vpn/overlay/devices`) STILL return the middleware
 *      401 — the allowlist prefix must open ONLY the by-token surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

// AUTH_ENABLED:true so the REAL middleware gates every route. The remaining
// fields feed createVpnRouter's module + build path (mirrors the qr-enroll
// test's config mock).
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: true,
    NEXTCLOUD_URL: "http://nextcloud.test",
    HQ_ISSUANCE_URL: "https://hq.test",
    DROPLET_DEVICE_ID: "droplet-abc",
    DROPLET_BOX_NAME: "living-room",
    DROPLET_PUBLIC_FQDN: "d-abc.droplet-us.com",
    WIREGUARD_ENDPOINT_HOST: "d-abc.droplet-us.com",
    WIREGUARD_LISTEN_PORT: 51820,
    ROUTING_MODE: "real",
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    WIREGUARD_HOME_ENDPOINT_HOST: "",
  },
}));

import { authMiddleware } from "../middleware/auth.js";
import { createVpnRouter } from "../routes/vpn.js";
import {
  hashToken,
  buildProfilePopMessage,
  buildStatusPopMessage,
} from "../services/overlay-link.service.js";

const VALID_WG_KEY = "A".repeat(43) + "=";
// The middleware's own 401 body — distinct from every handler 4xx, so a body
// match proves whether the request reached the handler or died at the gate.
const MIDDLEWARE_401 = "Missing or invalid authentication";

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function popHeader(privateKey: unknown, pendingId: string): string {
  return cryptoSign(
    "sha256",
    Buffer.from(buildStatusPopMessage(pendingId), "ascii"),
    { key: privateKey as never, dsaEncoding: "ieee-p1363" },
  ).toString("base64");
}

/** WARP-1757 — the profile fetch's PoP, over its own domain prefix. */
function profilePopHeader(privateKey: unknown, pendingId: string): string {
  return cryptoSign(
    "sha256",
    Buffer.from(buildProfilePopMessage(pendingId), "ascii"),
    { key: privateKey as never, dsaEncoding: "ieee-p1363" },
  ).toString("base64");
}

// Minimal in-memory Prisma stand-in for the two overlay tables the by-token +
// status handlers touch. Seeded per-case so the handlers can run to completion.
function createPrismaMock() {
  let n = 0;
  const linkTokens: any[] = [];
  const pendings: any[] = [];
  const matches = (row: any, where: any): boolean => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (v && typeof v === "object" && !(v instanceof Date)) {
        if ("gt" in v && !(row[k] > (v as any).gt)) return false;
      } else if (row[k] !== v) {
        return false;
      }
    }
    return true;
  };
  return {
    overlayLinkToken: {
      findUnique: vi.fn(async ({ where }: any) => {
        const [k, val] = Object.entries(where)[0] as any;
        return linkTokens.find((r) => r[k] === val) ?? null;
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const hits = linkTokens.filter((r) => matches(r, where));
        for (const r of hits) Object.assign(r, data);
        return { count: hits.length };
      }),
    },
    pendingOverlayEnrollment: {
      create: vi.fn(async ({ data }: any) => {
        const row = { id: `pend-${++n}`, conflict: false, ...data };
        pendings.push(row);
        return row;
      }),
      findUnique: vi.fn(async ({ where }: any) => {
        const [k, val] = Object.entries(where)[0] as any;
        return pendings.find((r) => r[k] === val) ?? null;
      }),
      findFirst: vi.fn(async ({ where }: any = {}) =>
        pendings.filter((r) => matches(r, where))[0] ?? null,
      ),
    },
    _linkTokens: linkTokens,
    _pendings: pendings,
  } as any;
}

function buildApp(prisma: any) {
  const app = express();
  app.set("trust proxy", 1); // mirror app.ts
  app.use(express.json());
  // The REAL global gate, exactly as app.ts mounts it — BEFORE the vpn router.
  app.use(authMiddleware);
  app.use(
    "/api",
    createVpnRouter(prisma, {
      overlayEnroll: vi.fn(async () => ({ device_ref: "hq-dev-1" })),
      recordOverlayAudit: vi.fn(),
    }),
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WARP-1474 — bearer-less by-token routes REACH the handler behind the real authMiddleware", () => {
  it("POST /api/vpn/overlay/devices/by-token is reachable with NO bearer (202 from the handler)", async () => {
    const prisma = createPrismaMock();
    const token = "T".repeat(43);
    prisma._linkTokens.push({
      id: "tok-1",
      tokenHash: hashToken(token),
      state: "available",
      expiresAt: new Date(Date.now() + 60_000),
      createdBy: "owner-1",
      boundSignFp: null,
    });
    const app = buildApp(prisma);
    const { pem } = p256();

    const res = await request(app)
      .post("/api/vpn/overlay/devices/by-token")
      .send({
        token,
        wg_public_key: VALID_WG_KEY,
        sign_public_key_pem: pem,
        label: "My phone",
      });

    // The whole point: the request must penetrate to the redeem handler
    // (202 pending), NOT die at the middleware 401.
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      state: "pending",
      pending_id: expect.any(String),
    });
    expect(res.body.error).not.toBe(MIDDLEWARE_401);
    expect(prisma._pendings).toHaveLength(1);
  });

  it("GET /api/vpn/overlay/devices/by-token/:pending_id/status is reachable with NO bearer (200 from the handler)", async () => {
    const prisma = createPrismaMock();
    const { pem, privateKey } = p256();
    prisma._pendings.push({
      id: "pend-1",
      signPublicKeyPem: pem,
      state: "pending",
      conflict: false,
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .get("/api/vpn/overlay/devices/by-token/pend-1/status")
      .set("X-Overlay-PoP", popHeader(privateKey, "pend-1"));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "pending" });
  });

  // WARP-1757 — the profile fetch is the same bearer-less device using the same
  // enrollment identity key, so it rides the same trailing-slash prefix. Prove
  // it REACHES the handler: the tell is a handler-issued 409/503, not the
  // middleware's 401.
  it("GET …/by-token/:pending_id/profile is reachable with NO bearer (handler 409, not middleware 401)", async () => {
    const prisma = createPrismaMock();
    const { pem, privateKey } = p256();
    prisma._pendings.push({
      id: "pend-1",
      signPublicKeyPem: pem,
      state: "pending",
      conflict: false,
    });
    const app = buildApp(prisma);

    const res = await request(app)
      .get("/api/vpn/overlay/devices/by-token/pend-1/profile")
      .set("X-Overlay-PoP", profilePopHeader(privateKey, "pend-1"));

    // 409 = the handler ran and refused a not-yet-approved enrollment.
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_approved");
  });

  // Domain separation must hold behind the real gate too: reaching the handler
  // is not the same as being authorized by it.
  it("a STATUS signature replayed at …/profile reaches the handler and is refused (401 from the handler)", async () => {
    const prisma = createPrismaMock();
    const { pem, privateKey } = p256();
    prisma._pendings.push({
      id: "pend-1",
      signPublicKeyPem: pem,
      state: "approved",
      conflict: false,
    });
    const app = buildApp(prisma);
    const res = await request(app)
      .get("/api/vpn/overlay/devices/by-token/pend-1/profile")
      .set("X-Overlay-PoP", popHeader(privateKey, "pend-1"));
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("a malformed bearer-less by-token POST reaches the handler's 400 (not the middleware 401)", async () => {
    // Even the rejected path must be the HANDLER's rejection — proving the
    // request is no longer intercepted by the auth gate.
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/overlay/devices/by-token")
      .send({ token: "x", wg_public_key: "not-a-key", sign_public_key_pem: "x" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

describe("WARP-1474 — scoping guard: the allowlist prefix opens ONLY the by-token surface", () => {
  // Pre-condition on the prefix itself: neither owner-route path starts with the
  // opened prefix, so the allowlist can never match them.
  it("the owner-route paths do NOT start with the opened by-token prefix", () => {
    const OPENED = "/api/vpn/overlay/devices/by-token";
    expect("/api/vpn/overlay/link-tokens".startsWith(OPENED)).toBe(false);
    expect("/api/vpn/overlay/pending-enrollments".startsWith(OPENED)).toBe(false);
    // The WARP-1385 owner enroll route is SHORTER than the prefix — no match.
    expect("/api/vpn/overlay/devices".startsWith(OPENED)).toBe(false);
  });

  it("bearer-less POST /api/vpn/overlay/link-tokens STILL 401s at the middleware", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app).post("/api/vpn/overlay/link-tokens").send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });

  it("bearer-less GET /api/vpn/overlay/pending-enrollments STILL 401s at the middleware", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app).get("/api/vpn/overlay/pending-enrollments");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });

  it("bearer-less POST /api/vpn/overlay/pending-enrollments/:id/approve STILL 401s at the middleware", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/overlay/pending-enrollments/pend-1/approve")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });

  it("bearer-less POST /api/vpn/overlay/devices (WARP-1385 owner enroll) STILL 401s at the middleware", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/overlay/devices")
      .send({ wg_public_key: VALID_WG_KEY, sign_public_key_pem: p256().pem, label: "x" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });

  // SEND-BACK #4 — the old allowlist used a NO-trailing-slash prefix
  // (`startsWith("/api/vpn/overlay/devices/by-token")`), which would fail OPEN
  // for any future sibling like `…/by-token-admin`. The fix pins the exact POST
  // path in the exact-match list and uses a TRAILING-SLASH prefix for the
  // `/status` subpath, so a hypothetical sibling is NOT public.
  it("a sibling path (…/by-token-admin) is NOT de-authed by the prefix (401 at middleware)", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/overlay/devices/by-token-admin")
      .send({ token: "x", wg_public_key: VALID_WG_KEY, sign_public_key_pem: p256().pem });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });

  it("another sibling (…/by-token-x) is NOT public either (401 at middleware)", async () => {
    const app = buildApp(createPrismaMock());
    const res = await request(app)
      .post("/api/vpn/overlay/devices/by-token-x")
      .send({});
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(MIDDLEWARE_401);
  });
});
