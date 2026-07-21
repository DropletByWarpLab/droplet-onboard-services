import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, { Request, Response, NextFunction } from "express";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";

// Mock config BEFORE importing the route — env-validated config needs real env.
vi.mock("../config.js", () => ({
  config: {
    AUTH_ENABLED: false,
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

import { createVpnRouter } from "../routes/vpn.js";
import { createRequestLogger } from "../middleware/request-logger.js";
import { config } from "../config.js";
import {
  buildStatusPopMessage,
  signKeyFingerprint,
  OVERLAY_LINK_TOKEN_TTL_MS,
} from "../services/overlay-link.service.js";

const VALID_WG_KEY = "A".repeat(43) + "=";
const VALID_WG_KEY_2 = "B".repeat(43) + "=";

function p256() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey,
  };
}

function popHeader(privateKey: any, pendingId: string): string {
  return cryptoSign("sha256", Buffer.from(buildStatusPopMessage(pendingId), "ascii"), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64");
}

// ── In-memory Prisma stand-in covering the tables the overlay routes touch ──
function matchWhere(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (v && typeof v === "object" && !(v instanceof Date)) {
      if ("gt" in v && !(row[k] > (v as any).gt)) return false;
      if ("lt" in v && !(row[k] < (v as any).lt)) return false;
      if ("in" in v && !(v as any).in.includes(row[k])) return false;
      if ("not" in v && row[k] === (v as any).not) return false;
    } else if (row[k] !== v) {
      return false;
    }
  }
  return true;
}

function createPrismaMock() {
  let n = 0;
  const linkTokens: any[] = [];
  const pendings: any[] = [];
  const vpnPeers: any[] = [];
  const table = (rows: any[], prefix: string, defaults: any = {}) => ({
    rows,
    create: vi.fn(async ({ data }: any) => {
      // Mirror Prisma column defaults (e.g. PendingOverlayEnrollment.conflict).
      const row = { id: `${prefix}-${++n}`, ...defaults, ...data };
      rows.push(row);
      return row;
    }),
    findUnique: vi.fn(async ({ where }: any) => {
      const [k, v] = Object.entries(where)[0] as any;
      return rows.find((r) => r[k] === v) ?? null;
    }),
    findFirst: vi.fn(async ({ where, orderBy }: any = {}) => {
      let out = rows.filter((r) => matchWhere(r, where));
      if (orderBy?.presentedAt === "desc") out = out.reverse();
      return out[0] ?? null;
    }),
    findMany: vi.fn(async ({ where, orderBy }: any = {}) => {
      let out = rows.filter((r) => matchWhere(r, where));
      if (orderBy?.presentedAt === "desc") out = [...out].reverse();
      return out;
    }),
    count: vi.fn(async ({ where }: any = {}) => rows.filter((r) => matchWhere(r, where)).length),
    update: vi.fn(async ({ where, data }: any) => {
      const row = rows.find((r) => r.id === where.id);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hits = rows.filter((r) => matchWhere(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
  });
  return {
    overlayLinkToken: table(linkTokens, "tok"),
    pendingOverlayEnrollment: table(pendings, "pend", { conflict: false }),
    vpnPeer: table(vpnPeers, "vp"),
    _linkTokens: linkTokens,
    _pendings: pendings,
    _vpnPeers: vpnPeers,
  } as any;
}

interface AuditEntry {
  event: string;
  method: string;
  route: string;
  status: number;
  clientId: string;
  refs?: Record<string, unknown>;
}

function buildApp(opts: {
  prisma?: any;
  overlayEnroll?: any;
  audit?: AuditEntry[];
  rateLimits?: any;
  user?: { id: string; username: string; role: string } | null;
  now?: () => Date;
} = {}) {
  const prisma = opts.prisma ?? createPrismaMock();
  const audit = opts.audit ?? [];
  const app = express();
  app.set("trust proxy", 1); // mirror app.ts — exactly one hop
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (opts.user !== null) {
      (req as any).user = opts.user ?? {
        id: "owner-1",
        username: "alice",
        role: "owner",
        displayName: "alice",
      };
    }
    next();
  });
  app.use(
    "/api",
    createVpnRouter(prisma, {
      overlayEnroll: opts.overlayEnroll ?? vi.fn(async () => ({ device_ref: "hq-dev-1" })),
      recordOverlayAudit: (e: AuditEntry) => audit.push(e),
      overlayRateLimits: opts.rateLimits,
      now: opts.now,
    }),
  );
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message ?? "internal" });
  });
  return { app, prisma, audit };
}

beforeEach(() => {
  vi.clearAllMocks();
  (config as any).HQ_ISSUANCE_URL = "https://hq.test";
});

async function mint(app: any) {
  const res = await request(app).post("/api/vpn/overlay/link-tokens").send({});
  return res;
}

describe("POST /api/vpn/overlay/link-tokens (mint)", () => {
  it("owner mints: 201 { token, server, box_name, expires_at }; only the hash is stored", async () => {
    const { app, prisma } = buildApp();
    const res = await mint(app);
    expect(res.status).toBe(201);
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(res.body.server).toBe("d-abc.droplet-us.com");
    expect(res.body.box_name).toBe("living-room");
    expect(typeof res.body.expires_at).toBe("string");
    // The plaintext token is NEVER persisted — only sha256(token).
    expect(prisma._linkTokens).toHaveLength(1);
    const row = prisma._linkTokens[0];
    expect(row.tokenHash).toBeDefined();
    expect(JSON.stringify(row)).not.toContain(res.body.token);
    expect(row.state).toBe("available");
    expect(row.createdBy).toBe("owner-1");
  });

  it("rejects a non-owner (403) and audits the 4xx", async () => {
    const audit: AuditEntry[] = [];
    const { app } = buildApp({ audit, user: { id: "u2", username: "bob", role: "family" } });
    const res = await mint(app);
    expect(res.status).toBe(403);
    expect(audit.some((a) => a.status === 403 && a.route.includes("link-tokens"))).toBe(true);
  });

  it("single-active-per-owner: minting flips the prior available token to expired", async () => {
    const { app, prisma } = buildApp();
    await mint(app);
    await mint(app);
    const states = prisma._linkTokens.map((t: any) => t.state).sort();
    expect(states).toEqual(["available", "expired"]);
  });

  it("emits an overlay_link_mint audit on success", async () => {
    const audit: AuditEntry[] = [];
    const { app } = buildApp({ audit });
    await mint(app);
    expect(audit.some((a) => a.event === "overlay_link_mint")).toBe(true);
  });
});

describe("POST /api/vpn/overlay/devices/by-token (redeem — NO bearer)", () => {
  async function freshToken(app: any) {
    const res = await mint(app);
    return res.body.token;
  }

  it("stages a pending enrollment WITHOUT any HQ vouch (202 pending)", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "x" }));
    const { app, prisma } = buildApp({ overlayEnroll });
    const token = await freshToken(app);
    const { pem } = p256();
    const res = await request(app)
      .post("/api/vpn/overlay/devices/by-token")
      .send({ token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "My phone" });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ state: "pending", pending_id: expect.any(String) });
    // The redeem must NOT vouch to HQ and must NOT create a wg peer.
    expect(overlayEnroll).not.toHaveBeenCalled();
    expect(prisma._vpnPeers).toHaveLength(0);
    const pend = prisma._pendings[0];
    expect(pend.state).toBe("pending");
    expect(pend.signPublicKeyPem).toBe(pem); // exact bytes, un-trimmed
    expect(pend.signKeyFingerprint).toBe(signKeyFingerprint(pem));
    // Token consumed + bound to the first fingerprint.
    expect(prisma._linkTokens[0].state).toBe("consumed");
    expect(prisma._linkTokens[0].boundSignFp).toBe(signKeyFingerprint(pem));
  });

  it("same-fingerprint re-redeem is idempotent (202, same pending_id)", async () => {
    const { app } = buildApp();
    const token = await freshToken(app);
    const { pem } = p256();
    const body = { token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone" };
    const first = await request(app).post("/api/vpn/overlay/devices/by-token").send(body);
    const second = await request(app).post("/api/vpn/overlay/devices/by-token").send(body);
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(second.body.pending_id).toBe(first.body.pending_id);
  });

  it("different-fingerprint second redeem: 409 token_conflict + audit + pending.conflict flag", async () => {
    const audit: AuditEntry[] = [];
    const { app, prisma } = buildApp({ audit });
    const token = await freshToken(app);
    const a = p256();
    const b = p256();
    await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: a.pem, label: "First",
    });
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY_2, sign_public_key_pem: b.pem, label: "Attacker",
    });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: "token_conflict" });
    expect(audit.some((a) => a.event === "overlay_enroll_token_conflict")).toBe(true);
    expect(prisma._pendings[0].conflict).toBe(true);
  });

  it("expired token (single-active supersession) → 410", async () => {
    const { app } = buildApp();
    const token = await freshToken(app);
    await mint(app); // supersede the first token → state 'expired'
    const { pem } = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone",
    });
    expect(res.status).toBe(410);
  });

  it("the 410 expiry path stages NOTHING (no PendingOverlayEnrollment row)", async () => {
    // AC4: a rejected redeem must never leave a staged pending row behind — the
    // owner's review queue must stay clean of expired attempts.
    const { app, prisma } = buildApp();
    const token = await freshToken(app);
    await mint(app); // supersede the first token → state 'expired'
    const { pem } = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone",
    });
    expect(res.status).toBe(410);
    expect(prisma._pendings).toHaveLength(0);
  });

  it("time-based TTL: an 'available' token past expiresAt → 410 and stages nothing", async () => {
    // AC4: prove the TTL is enforced TRANSACTIONALLY by the `expiresAt > now`
    // predicate on the atomic consume, NOT by the GC sweep or the single-active
    // supersession flip. Pin a mutable clock, mint at T0 (expiresAt = T0 + TTL),
    // then advance PAST the TTL without ever superseding the row.
    let clock = new Date("2026-01-01T00:00:00.000Z");
    const { app, prisma } = buildApp({ now: () => clock });
    const token = await freshToken(app);
    clock = new Date(clock.getTime() + OVERLAY_LINK_TOKEN_TTL_MS + 1_000);
    const { pem } = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone",
    });
    expect(res.status).toBe(410);
    // The row was NEVER superseded — it is still 'available', so the 410 came
    // purely from the time predicate, not a state flip.
    expect(prisma._linkTokens[0].state).toBe("available");
    expect(prisma._pendings).toHaveLength(0);
  });

  it("unknown token → 401", async () => {
    const { app } = buildApp();
    const { pem } = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: "Z".repeat(43), wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone",
    });
    expect(res.status).toBe(401);
  });

  it("malformed body → 400 (audited) — boundary-validated before any work", async () => {
    const audit: AuditEntry[] = [];
    const { app, prisma } = buildApp({ audit });
    const token = await freshToken(app);
    // Bad WireGuard key.
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: "not-a-key", sign_public_key_pem: p256().pem, label: "Phone",
    });
    expect(res.status).toBe(400);
    expect(audit.some((a) => a.status === 400 && a.route.includes("by-token"))).toBe(true);
    // Token must NOT be consumed by a request that fails boundary validation.
    expect(prisma._linkTokens[0].state).toBe("available");
  });

  it("rejects an oversized / non-P256 sign_public_key_pem with 400", async () => {
    const { app } = buildApp();
    const token = await freshToken(app);
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
    const p384 = publicKey.export({ type: "spki", format: "pem" }).toString();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: p384, label: "Phone",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /api/vpn/overlay/devices/by-token/:pending_id/status (PoP)", () => {
  async function stage(app: any) {
    const tokenRes = await mint(app);
    const key = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: tokenRes.body.token,
      wg_public_key: VALID_WG_KEY,
      sign_public_key_pem: key.pem,
      label: "Phone",
    });
    return { pendingId: res.body.pending_id, key };
  }

  it("valid PoP → 200 { state }", async () => {
    const { app } = buildApp();
    const { pendingId, key } = await stage(app);
    const res = await request(app)
      .get(`/api/vpn/overlay/devices/by-token/${pendingId}/status`)
      .set("X-Overlay-PoP", popHeader(key.privateKey, pendingId));
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("pending");
  });

  it("missing PoP header → 401", async () => {
    const { app } = buildApp();
    const { pendingId } = await stage(app);
    const res = await request(app).get(`/api/vpn/overlay/devices/by-token/${pendingId}/status`);
    expect(res.status).toBe(401);
  });

  it("PoP signed by a different key → 401", async () => {
    const { app } = buildApp();
    const { pendingId } = await stage(app);
    const other = p256();
    const res = await request(app)
      .get(`/api/vpn/overlay/devices/by-token/${pendingId}/status`)
      .set("X-Overlay-PoP", popHeader(other.privateKey, pendingId));
    expect(res.status).toBe(401);
  });

  it("unknown pending id → 401 (no existence leak)", async () => {
    const { app } = buildApp();
    const key = p256();
    const res = await request(app)
      .get(`/api/vpn/overlay/devices/by-token/does-not-exist/status`)
      .set("X-Overlay-PoP", popHeader(key.privateKey, "does-not-exist"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/vpn/overlay/pending-enrollments (owner)", () => {
  it("lists pending rows with the coarse shape", async () => {
    const { app } = buildApp();
    const tokenRes = await mint(app);
    const key = p256();
    await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: tokenRes.body.token,
      wg_public_key: VALID_WG_KEY,
      sign_public_key_pem: key.pem,
      label: "Phone",
    });
    const res = await request(app).get("/api/vpn/overlay/pending-enrollments");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const item = res.body[0];
    expect(item).toMatchObject({
      label: "Phone",
      fingerprint_short: signKeyFingerprint(key.pem).slice(0, 8),
      state: "pending",
      conflict: false,
    });
    expect(item.id).toBeDefined();
    expect(item.presented_at).toBeDefined();
    // Must NOT leak the full PEM / wg key on the list.
    expect(JSON.stringify(item)).not.toContain("PUBLIC KEY");
  });

  it("non-owner → 403", async () => {
    const { app } = buildApp({ user: { id: "u2", username: "bob", role: "family" } });
    const res = await request(app).get("/api/vpn/overlay/pending-enrollments");
    expect(res.status).toBe(403);
  });
});

describe("POST /api/vpn/overlay/pending-enrollments/:id/approve", () => {
  async function stage(app: any) {
    const tokenRes = await mint(app);
    const key = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: tokenRes.body.token,
      wg_public_key: VALID_WG_KEY,
      sign_public_key_pem: key.pem,
      label: "Phone",
    });
    return res.body.pending_id;
  }

  it("fires enrollOverlayDevice exactly once and returns 200 { state:'approved', device_id }", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq-dev-42" }));
    const { app, prisma } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);
    const res = await request(app).post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`).send({});
    expect(res.status).toBe(200);
    expect(res.body.state).toBe("approved");
    expect(res.body.device_id).toBe("hq-dev-42");
    expect(overlayEnroll).toHaveBeenCalledTimes(1);
    expect(overlayEnroll).toHaveBeenCalledWith({
      wgPublicKey: VALID_WG_KEY,
      signPublicKeyPem: expect.stringContaining("PUBLIC KEY"),
      label: "Phone",
    });
    const pend = prisma._pendings[0];
    expect(pend.state).toBe("approved");
    expect(pend.approvedBy).toBe("owner-1");
    expect(pend.enrolledAt).toBeDefined();
  });

  it("non-owner → 403", async () => {
    const { app } = buildApp({ user: { id: "u2", username: "bob", role: "family" } });
    const res = await request(app).post(`/api/vpn/overlay/pending-enrollments/x/approve`).send({});
    expect(res.status).toBe(403);
  });

  it("enforces the hard cap on active QR-enrolled overlay devices", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq" }));
    const { app, prisma } = buildApp({ overlayEnroll, rateLimits: { maxActiveQrDevices: 1 } });
    const p1 = await stage(app);
    const first = await request(app).post(`/api/vpn/overlay/pending-enrollments/${p1}/approve`).send({});
    expect(first.status).toBe(200);
    const p2 = await stage(app);
    const second = await request(app).post(`/api/vpn/overlay/pending-enrollments/${p2}/approve`).send({});
    expect(second.status).toBe(409);
    // The broker must NOT be called once the cap is hit.
    expect(overlayEnroll).toHaveBeenCalledTimes(1);
  });

  it("emits overlay_enroll_approved audit", async () => {
    const audit: AuditEntry[] = [];
    const { app } = buildApp({ audit });
    const pendingId = await stage(app);
    await request(app).post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`).send({});
    expect(audit.some((a) => a.event === "overlay_enroll_approved")).toBe(true);
  });
});

describe("POST /api/vpn/overlay/pending-enrollments/:id/deny", () => {
  it("owner denies → 200 { state:'denied' } + audit; no HQ vouch", async () => {
    const overlayEnroll = vi.fn(async () => ({}));
    const audit: AuditEntry[] = [];
    const { app, prisma } = buildApp({ overlayEnroll, audit });
    const tokenRes = await mint(app);
    const key = p256();
    const staged = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: tokenRes.body.token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: key.pem, label: "Phone",
    });
    const res = await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${staged.body.pending_id}/deny`).send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ state: "denied" });
    expect(overlayEnroll).not.toHaveBeenCalled();
    expect(prisma._pendings[0].state).toBe("denied");
    expect(audit.some((a) => a.event === "overlay_enroll_denied")).toBe(true);
  });
});

describe("rate limiting + trust-proxy hardening", () => {
  it("429s a by-token flood from one IP (per-IP cap)", async () => {
    const { app } = buildApp({ rateLimits: { byTokenPerIp: 3, byTokenGlobal: 1000 } });
    let last = 0;
    for (let i = 0; i < 5; i++) {
      const r = await request(app)
        .post("/api/vpn/overlay/devices/by-token")
        .set("X-Forwarded-For", "203.0.113.7")
        .send({ token: "nope", wg_public_key: VALID_WG_KEY, sign_public_key_pem: p256().pem, label: "x" });
      last = r.status;
    }
    expect(last).toBe(429);
  });

  it("a spoofed (rotating) leftmost X-Forwarded-For does NOT raise the per-IP limit", async () => {
    const audit: AuditEntry[] = [];
    const { app } = buildApp({ audit, rateLimits: { byTokenPerIp: 3, byTokenGlobal: 1000 } });
    let last = 0;
    for (let i = 0; i < 5; i++) {
      // Attacker rotates the LEFT (client-forgeable) entry; trust proxy=1 keys
      // req.ip on the RIGHTMOST entry (the one the single trusted hop appended).
      const r = await request(app)
        .post("/api/vpn/overlay/devices/by-token")
        .set("X-Forwarded-For", `10.0.0.${i}, 203.0.113.9`)
        .send({ token: "nope", wg_public_key: VALID_WG_KEY, sign_public_key_pem: p256().pem, label: "x" });
      last = r.status;
    }
    expect(last).toBe(429);
    expect(audit.some((a) => a.status === 429 && a.route.includes("by-token"))).toBe(true);
  });

  it("429s a mint flood from one owner (per-owner cap)", async () => {
    const { app } = buildApp({ rateLimits: { mintPerOwner: 2, mintGlobal: 1000 } });
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await mint(app)).status;
    expect(last).toBe(429);
  });
});

describe("request-logging redaction — routes driven THROUGH the logger (WARP-1474 AC2)", () => {
  // Mount the REAL request logger in front of the REAL vpn router and drive the
  // mint + by-token routes end-to-end, capturing every emitted log line. The
  // plaintext link token (minted once) and the client sign-key PEM must never
  // ride out in a log line — the redaction contract, proven at runtime rather
  // than via an isolated serializer double.
  function buildLoggedApp(lines: string[]) {
    const prisma = createPrismaMock();
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    app.use(
      createRequestLogger({
        dest: { write: (s: string) => lines.push(s) },
        level: "info",
      }),
    );
    app.use((req: Request, _res: Response, next: NextFunction) => {
      (req as any).user = {
        id: "owner-1",
        username: "alice",
        role: "owner",
        displayName: "alice",
      };
      next();
    });
    app.use(
      "/api",
      createVpnRouter(prisma, {
        overlayEnroll: vi.fn(async () => ({ device_ref: "x" })),
        recordOverlayAudit: () => {},
      }),
    );
    return { app, prisma };
  }

  it("mint + by-token flow never emits the plaintext token or the sign-key PEM", async () => {
    const lines: string[] = [];
    const { app } = buildLoggedApp(lines);

    // Mint returns the plaintext token ONCE.
    const mintRes = await request(app).post("/api/vpn/overlay/link-tokens").send({});
    expect(mintRes.status).toBe(201);
    const token: string = mintRes.body.token;

    // Redeem it — token + PEM travel in the JSON request body.
    const { pem } = p256();
    const redeemRes = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token, wg_public_key: VALID_WG_KEY, sign_public_key_pem: pem, label: "Phone",
    });
    expect(redeemRes.status).toBe(202);

    // The logger MUST have emitted request-completed lines (guard against a
    // silent logger that would make the assertions below vacuous)…
    const output = lines.join("");
    expect(output.length).toBeGreaterThan(0);
    // …and none of them may carry the token or the PEM.
    expect(output).not.toContain(token);
    expect(output).not.toContain(pem);
    expect(output).not.toContain("PUBLIC KEY");
  });
});
