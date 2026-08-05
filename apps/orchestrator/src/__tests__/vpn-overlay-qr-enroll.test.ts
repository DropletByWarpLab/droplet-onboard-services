import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
    // WARP-1757 — approval now provisions a real wg0 peer, so the route needs
    // the subnet/CIDR/DNS the profile is assembled from.
    //
    // These are the REAL stock defaults (config.ts:423/427/428/441/447), not
    // convenience values. An earlier revision set WIREGUARD_LAN_CIDR to the
    // HOME subnet's value, which made the away CIDR and the home resolver agree
    // by accident and hid a profile that paired away-mode AllowedIPs with the
    // home-mode resolver. Keeping the two modes on genuinely different subnets
    // is what makes a crossed pair observable here.
    WIREGUARD_VPN_SUBNET: "10.13.13.0/24",
    WIREGUARD_LAN_CIDR: "192.168.50.0/24",
    WIREGUARD_DNS: "192.168.50.1",
    WIREGUARD_HOME_ALLOWED_IPS: "192.168.20.0/24",
    WIREGUARD_HOME_DNS: "192.168.20.1",
  },
}));

// WARP-1757 — the routing sidecar. Approve installs the wg0 peer and the
// profile route reads the server public key, so both must be stubbed here;
// before this ticket the overlay routes never touched the router at all.
// vi.mock's factory is hoisted above every top-level const, so the doubles it
// returns must be created inside vi.hoisted() rather than referenced from
// module scope.
const { vpnSetupMock, installOverlayPeerMock, FakeRouterError } = vi.hoisted(
  () => {
    class FakeRouterError extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.name = "RouterError";
        this.code = code;
      }
    }
    return {
      // Params are declared so the mock's call tuple is typed — the assertions
      // below read `.mock.calls[0][0]`.
      vpnSetupMock: vi.fn(async (_opts: Record<string, unknown>) => ({
        public_key: "SERVERPUBKEY0000000000000000000000000000000=",
      })),
      installOverlayPeerMock: vi.fn(
        async (_opts: Record<string, unknown>) => ({ status: "ok" as const }),
      ),
      FakeRouterError,
    };
  },
);
vi.mock("../services/openwrt.client.js", () => ({
  vpnSetup: vpnSetupMock,
  installOverlayVpnPeer: installOverlayPeerMock,
  vpnStatus: vi.fn(async () => ({})),
  createVpnPeer: vi.fn(),
  deleteVpnPeer: vi.fn(async () => ({ status: "ok", removed: 1 })),
  fetchNetworkSummary: vi.fn(async () => {
    throw new Error("no summary in unit tests");
  }),
  RouterError: FakeRouterError,
}));

import { createVpnRouter } from "../routes/vpn.js";
import { createRequestLogger } from "../middleware/request-logger.js";
import { config } from "../config.js";
import {
  buildProfilePopMessage,
  buildStatusPopMessage,
  signKeyFingerprint,
  OVERLAY_LINK_TOKEN_TTL_MS,
} from "../services/overlay-link.service.js";

const VALID_WG_KEY = "A".repeat(43) + "=";
const VALID_WG_KEY_2 = "B".repeat(43) + "=";

/** Is `ip` inside `cidr`? Lets the profile assertions check that the resolver
 *  it advertises is actually ROUTED over the tunnel, rather than just matching
 *  a literal the test itself supplied. */
function ipInCidr(ip: string, cidr: string): boolean {
  const [net, bitsRaw] = cidr.split("/");
  const bits = Number(bitsRaw);
  const toInt = (a: string) =>
    a.split(".").reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(net) & mask);
}

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
    // Prisma resolves `where` on ANY unique field, not just `id` —
    // VpnPeer.publicKey is @unique and the provisioning path updates by it.
    // Keying this double on `id` alone made such an update silently blow up on
    // `Object.assign(undefined, …)`; throwing on a miss (as Prisma does, P2025)
    // keeps a wrong `where` loud instead of mysterious.
    update: vi.fn(async ({ where, data }: any) => {
      const [k, v] = Object.entries(where)[0] as any;
      const row = rows.find((r) => r[k] === v);
      if (!row) throw new Error(`${prefix}.update: no row where ${k}=${v}`);
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }: any) => {
      const hits = rows.filter((r) => matchWhere(r, where));
      for (const r of hits) Object.assign(r, data);
      return { count: hits.length };
    }),
  });
  const client: any = {
    overlayLinkToken: table(linkTokens, "tok"),
    pendingOverlayEnrollment: table(pendings, "pend", { conflict: false }),
    vpnPeer: table(vpnPeers, "vp"),
    _linkTokens: linkTokens,
    _pendings: pendings,
    _vpnPeers: vpnPeers,
  };
  // Mirror PrismaClient.$transaction for BOTH the array form (mint supersession,
  // SEND-BACK #5) and the interactive callback form. The in-memory tables mutate
  // eagerly, so array ops have already run by the time they're awaited here; the
  // callback form receives the same client (shared table refs) as `tx`.
  client.$transaction = vi.fn(async (arg: any) => {
    if (Array.isArray(arg)) return Promise.all(arg);
    if (typeof arg === "function") return arg(client);
    return undefined;
  });
  return client;
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

  // SEND-BACK #5 — supersession (available→expired) + create must be atomic, or
  // a crash between them can leave an owner with ZERO available tokens (old one
  // expired, new one never created) or, worse, two available tokens.
  it("runs supersession + create inside a single $transaction", async () => {
    const { app, prisma } = buildApp();
    await mint(app);
    await mint(app);
    expect(prisma.$transaction).toHaveBeenCalled();
    // The end-state invariant still holds: exactly one available, one expired.
    const states = prisma._linkTokens.map((t: any) => t.state).sort();
    expect(states).toEqual(["available", "expired"]);
  });

  // ── WARP-1593: `server` is an HTTPS API host, never the WG transport ──
  describe("the QR's `server` never carries the WireGuard transport address", () => {
    const savedFqdn = config.DROPLET_PUBLIC_FQDN;
    const savedWgHost = config.WIREGUARD_ENDPOINT_HOST;

    afterEach(() => {
      (config as any).DROPLET_PUBLIC_FQDN = savedFqdn;
      (config as any).WIREGUARD_ENDPOINT_HOST = savedWgHost;
    });

    // The bug: with no FQDN the mint fell back to WIREGUARD_ENDPOINT_HOST,
    // which is a UDP transport address. The phone then aimed an HTTPS POST at
    // udp/51820 and failed with an opaque connection error.
    it("refuses to mint (503) rather than advertising `host:51820` as the API host", async () => {
      const { app, prisma } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = "";
      (config as any).WIREGUARD_ENDPOINT_HOST = "box.example:51820";
      const res = await mint(app);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("remote_access_not_configured");
      expect(JSON.stringify(res.body)).not.toContain("51820");
      // And nothing was minted — the owner keeps whatever code they had.
      expect(prisma._linkTokens).toHaveLength(0);
    });

    // The refusal must precede the supersession transaction, or asking for a
    // code on an unconfigured box would destroy a working one.
    it("does not expire the owner's existing token when it refuses", async () => {
      const { app, prisma } = buildApp();
      const first = await mint(app);
      expect(first.status).toBe(201);
      (config as any).DROPLET_PUBLIC_FQDN = "";
      (config as any).WIREGUARD_ENDPOINT_HOST = "box.example:51820";
      expect((await mint(app)).status).toBe(503);
      expect(prisma._linkTokens.map((t: any) => t.state)).toEqual(["available"]);
    });

    it("audits the refusal", async () => {
      const audit: AuditEntry[] = [];
      const { app } = buildApp({ audit });
      (config as any).DROPLET_PUBLIC_FQDN = "";
      (config as any).WIREGUARD_ENDPOINT_HOST = "box.example:51820";
      await mint(app);
      expect(
        audit.some(
          (a) => a.event === "overlay_link_mint_refused" && a.status === 503,
        ),
      ).toBe(true);
    });

    // A bare operator-supplied hostname is a legitimate box name, not a
    // transport address — keep honoring it so this fix isn't a regression.
    it("still accepts a bare WIREGUARD_ENDPOINT_HOST with no port", async () => {
      const { app } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = "";
      (config as any).WIREGUARD_ENDPOINT_HOST = "box.example";
      const res = await mint(app);
      expect(res.status).toBe(201);
      expect(res.body.server).toBe("box.example");
    });

    it("refuses when nothing at all is configured", async () => {
      const { app } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = "";
      (config as any).WIREGUARD_ENDPOINT_HOST = "";
      expect((await mint(app)).status).toBe(503);
    });

    it("strips an accidental scheme from the FQDN", async () => {
      const { app } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = "https://d-abc.droplet-us.com/";
      const res = await mint(app);
      expect(res.status).toBe(201);
      expect(res.body.server).toBe("d-abc.droplet-us.com");
    });

    // SEND-BACK — the guard above only ever ran on the WIREGUARD_ENDPOINT_HOST
    // branch. `DROPLET_PUBLIC_FQDN` is priority 1 and returned BEFORE it, so
    // every FQDN row here minted a QR carrying a transport address or a path —
    // the exact thing this function exists to refuse. The table IS the
    // reproduction, executed, so the two branches can never drift apart again.
    //
    // `DROPLET_PUBLIC_FQDN` is not the closed HQ-only channel it looks like:
    // config.ts declares it `z.string().default("")` with NO shape validation,
    // and scripts/lib/secrets.sh seeds it into .env as an empty key for an
    // operator to fill in by hand.
    it.each([
      { how: "an FQDN carrying the WG port", fqdn: "box.example:51820", wg: "" },
      {
        how: "an FQDN carrying a scheme AND the WG port",
        fqdn: "https://box.example:51820",
        wg: "",
      },
      { how: "an FQDN carrying a path", fqdn: "box.example/evil", wg: "" },
      {
        how: "a WG endpoint host carrying the WG port",
        fqdn: "",
        wg: "box.example:51820",
      },
      { how: "a WG endpoint host carrying a path", fqdn: "", wg: "box.example/evil" },
    ])("refuses to mint from $how", async ({ fqdn, wg }) => {
      const { app, prisma } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = fqdn;
      (config as any).WIREGUARD_ENDPOINT_HOST = wg;
      const res = await mint(app);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("remote_access_not_configured");
      // Nothing about the rejected value may reach the client.
      expect(JSON.stringify(res.body)).not.toContain("51820");
      expect(JSON.stringify(res.body)).not.toContain("evil");
      // And nothing was minted — the owner keeps whatever code they had.
      expect(prisma._linkTokens).toHaveLength(0);
    });

    // The guard must stay a scalpel: a legitimate bare host on EITHER branch
    // still mints, including a bracketed IPv6 literal whose colons belong to
    // the address rather than to a port.
    it.each([
      { how: "a bare FQDN", fqdn: "box.example", wg: "", server: "box.example" },
      {
        how: "a bracketed IPv6 FQDN",
        fqdn: "[2001:db8::1]",
        wg: "",
        server: "[2001:db8::1]",
      },
      {
        how: "a bracketed IPv6 WG endpoint host",
        fqdn: "",
        wg: "[2001:db8::1]",
        server: "[2001:db8::1]",
      },
    ])("still mints from $how", async ({ fqdn, wg, server }) => {
      const { app } = buildApp();
      (config as any).DROPLET_PUBLIC_FQDN = fqdn;
      (config as any).WIREGUARD_ENDPOINT_HOST = wg;
      const res = await mint(app);
      expect(res.status).toBe(201);
      expect(res.body.server).toBe(server);
    });
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
  async function stage(app: any, wgKey: string = VALID_WG_KEY) {
    const tokenRes = await mint(app);
    const key = p256();
    const res = await request(app).post("/api/vpn/overlay/devices/by-token").send({
      token: tokenRes.body.token,
      wg_public_key: wgKey,
      sign_public_key_pem: key.pem,
      label: "Phone",
    });
    return res.body.pending_id;
  }
  const approve = (app: any, id: string) =>
    request(app).post(`/api/vpn/overlay/pending-enrollments/${id}/approve`).send({});

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

  // ── SEND-BACK #2/#8 — the vouch must fire AT MOST ONCE per pending id ──
  it("idempotent re-approve returns the recorded device_id WITHOUT a second vouch", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq-dev-9" }));
    const { app } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);
    const first = await approve(app, pendingId);
    const second = await approve(app, pendingId);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.device_id).toBe("hq-dev-9");
    expect(overlayEnroll).toHaveBeenCalledTimes(1);
  });

  // ── re-approve is the RECOVERY path for a failed provision ──
  describe("re-approve retries provisioning (the only recovery a box has)", () => {
    // Provision failure leaves the row 'approved' with no peer, and /profile
    // 503s. The connect tick that would otherwise self-heal is behind
    // OVERLAY_CONNECT_ENABLED, which defaults false and appears in no
    // deployment artifact — so on a shipping box re-approve is the ONLY way
    // out. It must actually retry, not short-circuit to a no-op.
    it("recovers a device stuck approved-with-no-peer, still without a second vouch", async () => {
      const overlayEnroll = vi.fn(async () => ({ device_ref: "hq-dev-9" }));
      const { app, prisma } = buildApp({ overlayEnroll });
      const pendingId = await stage(app);

      installOverlayPeerMock.mockRejectedValueOnce(new Error("routing down"));
      const first = await approve(app, pendingId);
      expect(first.status).toBe(200);
      expect(first.body.tunnel_ready).toBe(false);
      // The row write precedes the router install, so model the harsher shape
      // the finding describes: approved, and no peer row at all.
      prisma._vpnPeers.length = 0;

      const second = await approve(app, pendingId);
      expect(second.status).toBe(200);
      expect(second.body.tunnel_ready).toBe(true);
      // The vouch is NOT idempotent — the retry must never re-fire it.
      expect(overlayEnroll).toHaveBeenCalledTimes(1);

      const peer = prisma._vpnPeers.find(
        (p: any) => p.publicKey === VALID_WG_KEY,
      );
      expect(peer).toBeDefined();
      expect(peer.status).toBe("active");
      expect(peer.kind).toBe("overlay");
    });

    // The first approve returns tunnel_ready; a re-approve that omitted it left
    // any UI reading `undefined` even when the tunnel was fine.
    it("reports tunnel_ready on re-approve, same contract as the first approve", async () => {
      const overlayEnroll = vi.fn(async () => ({ device_ref: "hq-dev-9" }));
      const { app } = buildApp({ overlayEnroll });
      const pendingId = await stage(app);
      await approve(app, pendingId);
      const second = await approve(app, pendingId);
      expect(second.body).toEqual({
        state: "approved",
        device_id: "hq-dev-9",
        tunnel_ready: true,
      });
    });

    it("still reports tunnel_ready:false when the retry itself fails", async () => {
      const { app, prisma } = buildApp();
      const pendingId = await stage(app);
      await approve(app, pendingId);
      prisma._vpnPeers.length = 0;
      installOverlayPeerMock.mockRejectedValueOnce(new Error("routing down"));
      const second = await approve(app, pendingId);
      expect(second.status).toBe(200);
      expect(second.body.tunnel_ready).toBe(false);
      expect(prisma._pendings[0].state).toBe("approved");
    });

    // A retry must not rewrite who linked the QR or when — that is the audit
    // trail. It SHOULD restart the idle clock, since the owner just asserted
    // the device should work.
    it("preserves enrolment provenance but refreshes the idle clock", async () => {
      let clock = new Date("2026-08-05T00:00:00.000Z");
      const { app, prisma } = buildApp({ now: () => clock });
      const pendingId = await stage(app);
      await approve(app, pendingId);
      const enrolledAt = prisma._vpnPeers[0].enrolledAt;
      const enrolledBy = prisma._vpnPeers[0].linkTokenEnrolledBy;

      clock = new Date(clock.getTime() + 6 * 3_600_000);
      await approve(app, pendingId);

      const peer = prisma._vpnPeers[0];
      expect(peer.enrolledAt).toEqual(enrolledAt);
      expect(peer.linkTokenEnrolledBy).toBe(enrolledBy);
      expect(peer.lastSessionAt).toEqual(clock);
    });
  });

  it("a claim that loses the race (count===0) gets a clean 409 and does NOT vouch", async () => {
    // Deterministically simulate the losing concurrent approver: the row still
    // reads 'pending' at findUnique, but the atomic pending→approving claim
    // matches 0 rows (another approver already flipped it). Must be a clean 409,
    // never a 500 or a second vouch.
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq" }));
    const { app, prisma } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);
    const realUpdateMany = prisma.pendingOverlayEnrollment.updateMany;
    prisma.pendingOverlayEnrollment.updateMany = vi.fn(async (args: any) => {
      // Force ONLY the claim (pending→approving) to lose; let every other
      // updateMany (compensation, finalize, provenance) behave normally.
      if (args?.data?.state === "approving" && args?.where?.state === "pending") {
        return { count: 0 };
      }
      return realUpdateMany(args);
    });
    const res = await approve(app, pendingId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_being_approved");
    expect(overlayEnroll).not.toHaveBeenCalled();
  });

  it("a row already mid-approve ('approving') is not re-vouched (clean 409)", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq" }));
    const { app, prisma } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);
    // Simulate another approver holding the claim: the row sits in 'approving'.
    prisma._pendings[0].state = "approving";
    const res = await approve(app, pendingId);
    expect(res.status).toBe(409);
    expect(overlayEnroll).not.toHaveBeenCalled();
  });

  it("two OVERLAPPING approves vouch exactly once; the loser gets a clean 409", async () => {
    // Gate the vouch so approver #1 holds the 'approving' claim while approver #2
    // runs to completion — the integration-level proof of exactly-once. (True
    // simultaneous claim collision can't be produced by a single-threaded
    // in-memory mock; the deterministic count===0 path is covered above.)
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const overlayEnroll = vi.fn(async () => {
      await gate;
      return { device_ref: "hq-dev-1" };
    });
    const { app } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);

    // Dispatch #1 NOW (supertest sends on `.then`) — it claims the row and then
    // parks in the gated vouch.
    let r1: any;
    const p1 = approve(app, pendingId).then((r: any) => (r1 = r));
    await new Promise((r) => setTimeout(r, 30)); // let #1 reach the gated vouch
    const r2 = await approve(app, pendingId); // must see the claim held → 409
    expect(r2.status).toBe(409);
    expect(overlayEnroll).toHaveBeenCalledTimes(1); // #2 never reached the vouch

    release();
    await p1;
    expect(r1.status).toBe(200);
    expect(r1.body.state).toBe("approved");
    expect(overlayEnroll).toHaveBeenCalledTimes(1); // still exactly once
  });

  it("compensates approving→pending and returns 503 when the vouch fails", async () => {
    const overlayEnroll = vi.fn(async () => {
      throw new Error("HQ unreachable");
    });
    const { app, prisma } = buildApp({ overlayEnroll });
    const pendingId = await stage(app);
    const res = await approve(app, pendingId);
    expect(res.status).toBe(503);
    // The row is back in the review queue (retryable), NOT stuck in 'approving'.
    expect(prisma._pendings[0].state).toBe("pending");
  });

  // ── SEND-BACK #7 — dedupe by wgPublicKey before vouching ──
  it("rejects a duplicate wgPublicKey with 409 BEFORE a second vouch", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq" }));
    const { app } = buildApp({ overlayEnroll });
    // Device A stages + approves with the shared wg key.
    const pA = await stage(app, VALID_WG_KEY);
    expect((await approve(app, pA)).status).toBe(200);
    // Device B stages with the SAME wg key and tries to approve.
    const pB = await stage(app, VALID_WG_KEY);
    const res = await approve(app, pB);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("wg_key_conflict");
    // Only device A's vouch fired — B never hit HQ (would 500 on peer-install).
    expect(overlayEnroll).toHaveBeenCalledTimes(1);
  });

  it("rejects a wgPublicKey already held by an active VpnPeer (409)", async () => {
    const overlayEnroll = vi.fn(async () => ({ device_ref: "hq" }));
    const { app, prisma } = buildApp({ overlayEnroll });
    // Seed an ACTIVE peer holding the wg key (e.g. a static peer or a prior
    // overlay peer the connect agent already installed).
    prisma._vpnPeers.push({ id: "vp-seed", publicKey: VALID_WG_KEY, status: "active" });
    const pendingId = await stage(app, VALID_WG_KEY);
    const res = await approve(app, pendingId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("wg_key_conflict");
    expect(overlayEnroll).not.toHaveBeenCalled();
  });

  // ── WARP-1757: approval provisions the tunnel, it doesn't just vouch ──
  describe("approval makes the box ready to accept the device's handshake", () => {
    it("ensures wg0 exists, allocates an address, and installs the ENROLLED key", async () => {
      const { app, prisma } = buildApp();
      const pendingId = await stage(app);
      const res = await approve(app, pendingId);

      expect(res.status).toBe(200);
      expect(res.body.tunnel_ready).toBe(true);

      // wg0 setup runs unconditionally — without it the FIRST overlay peer on a
      // box that never minted a legacy static peer fails "wg0 not configured".
      expect(vpnSetupMock).toHaveBeenCalled();

      // The peer row exists, is an active overlay peer, and holds the key the
      // DEVICE enrolled with — not a box-minted one.
      const peer = prisma._vpnPeers.find((p: any) => p.publicKey === VALID_WG_KEY);
      expect(peer).toBeDefined();
      expect(peer.kind).toBe("overlay");
      expect(peer.status).toBe("active");
      expect(peer.assignedIp).toMatch(/^10\.13\.13\.\d+$/);

      // Cryptokey routing: the router-side AllowedIPs must contain exactly the
      // address the client will be told to use. If these disagree, a handshake
      // can complete and every packet still gets dropped.
      expect(installOverlayPeerMock).toHaveBeenCalledTimes(1);
      const installed = installOverlayPeerMock.mock.calls[0][0] as any;
      expect(installed.publicKey).toBe(VALID_WG_KEY);
      expect(installed.allowedIps).toEqual([`${peer.assignedIp}/32`]);
    });

    // WireGuard learns a peer's endpoint from its first authenticated
    // handshake. Configuring one here would pin the box to the punch path and
    // break the case this whole feature has to serve: a box that is its own
    // edge router, or behind a port map, reached by a client that initiates.
    it("installs the peer WITHOUT an endpoint so the client can initiate", async () => {
      const { app } = buildApp();
      const pendingId = await stage(app);
      await approve(app, pendingId);
      const installed = installOverlayPeerMock.mock.calls[0][0] as any;
      expect(installed.endpoint).toBeUndefined();
    });

    it("stamps QR provenance on the peer row", async () => {
      const { app, prisma } = buildApp();
      const pendingId = await stage(app);
      await approve(app, pendingId);
      const peer = prisma._vpnPeers.find((p: any) => p.publicKey === VALID_WG_KEY);
      expect(peer.linkTokenLabel).toBe("Phone");
      expect(peer.linkTokenEnrolledBy).toBe("owner-1");
      expect(peer.linkTokenId).toBeDefined();
    });

    // The HQ vouch already succeeded and is not idempotent, so a provisioning
    // failure must NOT roll the enrollment back to 'pending' — that would
    // invite a second vouch for a device HQ already knows.
    it("keeps the enrollment approved when provisioning fails, and says so", async () => {
      const audit: AuditEntry[] = [];
      const { app, prisma } = buildApp({ audit });
      const pendingId = await stage(app);
      installOverlayPeerMock.mockRejectedValueOnce(new Error("routing down"));

      const res = await approve(app, pendingId);
      expect(res.status).toBe(200);
      expect(res.body.state).toBe("approved");
      expect(res.body.tunnel_ready).toBe(false);
      expect(prisma._pendings[0].state).toBe("approved");
      expect(
        audit.some((a) => a.event === "overlay_enroll_provision_failed"),
      ).toBe(true);
    });
  });
});

// ── WARP-1757 — GET …/by-token/:pending_id/profile ──
describe("GET /api/vpn/overlay/devices/by-token/:id/profile (NO bearer)", () => {
  async function stageWithKey(app: any) {
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
  const profilePop = (privateKey: any, pendingId: string): string =>
    cryptoSign(
      "sha256",
      Buffer.from(buildProfilePopMessage(pendingId), "ascii"),
      { key: privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64");

  const getProfile = (app: any, id: string, pop?: string) => {
    const r = request(app).get(
      `/api/vpn/overlay/devices/by-token/${id}/profile`,
    );
    return pop ? r.set("X-Overlay-PoP", pop) : r;
  };

  it("issues a complete, self-consistent profile to an approved device", async () => {
    const { app, prisma } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});

    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(res.status).toBe(200);

    const peer = prisma._vpnPeers.find((p: any) => p.publicKey === VALID_WG_KEY);
    // The address the client is handed MUST be the one wg0 accepts for its key.
    expect(res.body.address).toBe(`${peer.assignedIp}/32`);
    expect(res.body.server_public_key).toBe(
      "SERVERPUBKEY0000000000000000000000000000000=",
    );
    expect(res.body.allowed_ips).toEqual(["192.168.50.0/24", "10.13.13.0/24"]);
    expect(res.body.dns).toEqual(["192.168.50.1"]);
    expect(res.body.persistent_keepalive).toBe(25);
    // Split-tunnel by construction — a default route must never be issued.
    expect(res.body.allowed_ips).not.toContain("0.0.0.0/0");
  });

  // The peer row this flow writes is mode='away', so the profile must carry the
  // AWAY pair (WIREGUARD_LAN_CIDR + WIREGUARD_DNS) — not the away CIDR with the
  // HOME resolver. A resolver outside every AllowedIPs entry is sent out the
  // client's DEFAULT route, so <name>.droplet-us.com reaches a public resolver
  // and gets NXDOMAIN: the exact failure split-horizon DNS exists to prevent,
  // on a tunnel that handshakes fine and looks healthy.
  it("routes the resolver it advertises (DNS inside AllowedIPs)", async () => {
    const { app, prisma } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});
    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(res.status).toBe(200);

    const peer = prisma._vpnPeers.find((p: any) => p.publicKey === VALID_WG_KEY);
    expect(peer.mode).toBe("away");

    expect(res.body.dns.length).toBeGreaterThan(0);
    for (const resolver of res.body.dns) {
      expect(
        res.body.allowed_ips.some((cidr: string) => ipInCidr(resolver, cidr)),
      ).toBe(true);
    }
    // And explicitly NOT the other mode's resolver.
    expect(res.body.dns).not.toContain(config.WIREGUARD_HOME_DNS);
  });

  // The per-device FQDN is public-NXDOMAIN by design (ADR-023 split-horizon),
  // so advertising it as a WireGuard endpoint is the WARP-1391 dead-endpoint
  // bug. Until WARP-1758 derives real IP-literal candidates, the honest answer
  // is an empty list — a client can then say it has nowhere to dial, instead of
  // silently failing against a name it cannot resolve.
  it("never advertises the split-horizon FQDN as a WireGuard endpoint", async () => {
    const { app } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});
    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(res.status).toBe(200);
    expect(res.body.endpoint_candidates).toEqual([]);
    expect(JSON.stringify(res.body)).not.toContain("droplet-us.com");
  });

  it("never returns a private key", async () => {
    const { app } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});
    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain("private");
  });

  // Domain separation is the point of a second prefix: a status signature is a
  // coarse read primitive; a profile signature discloses the box's server key
  // and endpoints. Neither may be replayed as the other.
  it("rejects a signature made over the STATUS message", async () => {
    const { app } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});
    const res = await getProfile(app, pendingId, popHeader(key.privateKey, pendingId));
    expect(res.status).toBe(401);
  });

  it("401s with no PoP, a wrong key, and an unknown id alike (no existence leak)", async () => {
    const { app } = buildApp();
    const { pendingId } = await stageWithKey(app);
    const other = p256();
    expect((await getProfile(app, pendingId)).status).toBe(401);
    expect(
      (await getProfile(app, pendingId, profilePop(other.privateKey, pendingId)))
        .status,
    ).toBe(401);
    const unknown = await getProfile(
      app,
      "pend-does-not-exist",
      profilePop(other.privateKey, "pend-does-not-exist"),
    );
    expect(unknown.status).toBe(401);
    expect(unknown.body.error).toBe("unauthorized");
  });

  it("409s while the enrollment is still pending", async () => {
    const { app } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_approved");
    expect(res.body.state).toBe("pending");
  });

  // Approved but the wg0 peer never landed (provisioning failed, or the row
  // predates WARP-1757). Handing out a profile whose address nothing accepts
  // would be a silent dead tunnel; say it plainly instead.
  it("503s when the device is approved but has no active peer", async () => {
    const { app, prisma } = buildApp();
    const { pendingId, key } = await stageWithKey(app);
    installOverlayPeerMock.mockRejectedValueOnce(new Error("routing down"));
    await request(app)
      .post(`/api/vpn/overlay/pending-enrollments/${pendingId}/approve`)
      .send({});
    // Provisioning threw before the row was installed router-side; drop any
    // row so this models the "approved, not provisioned" state exactly.
    prisma._vpnPeers.length = 0;

    const res = await getProfile(app, pendingId, profilePop(key.privateKey, pendingId));
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("tunnel_not_ready");
    expect(res.body.message).not.toMatch(/[a-z]+_[a-z]+/);
    // Nothing retries this on its own: the connect tick that could self-heal is
    // behind OVERLAY_CONNECT_ENABLED (default false, in no deployment
    // artifact). "Try again in a moment" would promise progress that never
    // comes; the copy must name the action that DOES recover it — re-approval.
    expect(res.body.message).not.toMatch(/in a moment/i);
    expect(res.body.message).toMatch(/approv/i);
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

  // SEND-BACK #3 — the public status GET is unauthenticated and runs an ECDSA
  // verify per hit, so it needs the same per-IP/global DoS backstop + 4xx audit
  // as the redeem route.
  it("429s a status flood from one IP and audits the 4xx", async () => {
    const audit: AuditEntry[] = [];
    const { app } = buildApp({ audit, rateLimits: { byTokenPerIp: 3, byTokenGlobal: 1000 } });
    let last = 0;
    for (let i = 0; i < 6; i++) {
      const r = await request(app)
        .get("/api/vpn/overlay/devices/by-token/pend-unknown/status")
        .set("X-Forwarded-For", "203.0.113.20")
        .set("X-Overlay-PoP", "AAAA");
      last = r.status;
    }
    expect(last).toBe(429);
    // Both the pre-cap 401s and the 429 flood are 4xx → an audit row exists.
    expect(audit.some((a) => a.status === 429 && a.route.includes("status"))).toBe(true);
    expect(audit.some((a) => a.status === 401 && a.route.includes("status"))).toBe(true);
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
