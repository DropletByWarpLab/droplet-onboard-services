/**
 * WARP-3513 — the recovery-key reveal and regenerate (storage decision record
 * ADR-070, section 8.5)
 *
 * Every bay drive is prepared encrypted (LUKS2 + TPM2 + a recovery key). The
 * recovery key is escrowed on the HOST, root-only, on the encrypted /data, and is
 * shown to the owner exactly ONCE. Both custody operations ride the EXISTING
 * destructive-op handshake — mint a token, then confirm it — so they are mounted
 * as POSTs and executed by POST /api/storage/command/confirm:
 *
 *   POST /api/storage/drives/:uuid/recovery-key/reveal       owner, Tier 2
 *   POST /api/storage/drives/:uuid/recovery-key/regenerate   owner, Tier 3
 *     -> 202 { confirmationToken, tier, ... }  (nothing happens yet)
 *   POST /api/storage/command/confirm { confirmationToken }
 *     -> reveal:     200 { recoveryKey } the first time, 410 every time after
 *     -> regenerate: 200 { recoveryKeyPending: true } — NO key in the reply
 *
 * What is pinned here, and why each piece exists:
 *
 *   - OWNER ONLY (not owner/admin), twice: the mint routes use requireRole("owner")
 *     (a denial emits the WARP-237 "Access denied" row), and the shared confirm
 *     route refuses an admin session for these two ops even when it holds a token.
 *   - There is NO GET: a link prefetcher, a stray GET or a HEAD can never mint a
 *     token, let alone spend the one-time retrieval.
 *   - ONE TIME: the host answers revealed -> already_retrieved. The route maps that
 *     to 200 -> 410, proven here against a STATEFUL fake bridge, not in the
 *     abstract. A token is single-use even under two concurrent confirms.
 *   - THE KEY IS NEVER LOGGED, PERSISTED OR CACHED: the logger, console, the
 *     activity feed and every Prisma write are spied on, in every outcome.
 *   - The host's (and the bridge's) own words are never relayed on the reveal
 *     path: every failure there is a fixed sentence.
 *   - Regenerate replaces the key and its reply carries none; the owner fetches
 *     the new one through the same one-time reveal.
 *
 * Fake keys only. The bridge is a stub; no real host, no real key.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { inspect } from "node:util";
import request from "supertest";
import express from "express";
import pino from "pino";

// Every log call, any level, any module — so "the key never appears in a log"
// is checked against everything the route and the safety service emit.
const { logged, recordActivityMock } = vi.hoisted(() => ({
  logged: [] as unknown[][],
  recordActivityMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("../services/nextcloud-session.service.js", () => ({
  resolveNcToken: vi.fn(async () => null),
}));
vi.mock("../services/nextcloud.client.js", () => ({
  ncGetUserQuota: vi.fn(),
}));
vi.mock("../services/activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("../lib/logger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/logger.js")>();
  const capture =
    (level: string) =>
    (...args: unknown[]): void => {
      logged.push([level, ...args]);
    };
  const capturing = {
    fatal: capture("fatal"),
    error: capture("error"),
    warn: capture("warn"),
    info: capture("info"),
    debug: capture("debug"),
    trace: capture("trace"),
    level: "trace",
    isLevelEnabled: () => true,
    child: () => capturing,
  };
  return { ...actual, createLogger: () => capturing };
});

import { createStorageRouter } from "../routes/storage.js";
import { isRoleGuard } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import {
  cleanupExpiredStorageTokens,
  evaluateStorageCommand,
} from "../services/storage-safety.service.js";
import {
  STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS,
  STORAGE_MAX_PENDING_CONFIRMATIONS,
} from "../config/storage-safety-rules.js";
import { REQUEST_LOG_REDACT_PATHS } from "../middleware/request-logger.js";
import { redactSecretParams, redactSecrets } from "../lib/log-redaction.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** Obviously fake: never a real key, never anything that unlocks a real drive. */
const FAKE_RECOVERY_KEY = "cccccc-fakefake-cccccc-fakefake-cccccc-fakefake-cccccc-fakefake";
/** What a regenerate leaves in escrow: a different, equally fake, key. */
const FAKE_REGENERATED_KEY = "dddddd-fakefake-dddddd-fakefake-dddddd-fakefake-dddddd-fakefake";
const FAKE_OTHER_KEY = "cccccc-otherother-cccccc-otherother";
/** A string only a leaking bridge/host error body would ever carry. */
const BRIDGE_INTERNALS = "BRIDGE-INTERNAL: cryptsetup exploded at /dev/mapper/droplet-bay-1a2b3c4d";

const FS_UUID = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d";
const OTHER_UUID = "9f8e7d6c-1111-4222-8333-444455556666";

const REVEAL = "recovery_key_reveal";
const REGENERATE = "recovery_key_regenerate";
type Op = "reveal" | "regenerate";
const SERVICE_OF: Record<Op, string> = { reveal: REVEAL, regenerate: REGENERATE };
const TIER_OF: Record<Op, number> = { reveal: 2, regenerate: 3 };
const OPS: readonly Op[] = ["reveal", "regenerate"];

const mintPath = (op: Op, uuid: string): string => `/api/storage/drives/${uuid}/recovery-key/${op}`;
const CONFIRM_PATH = "/api/storage/command/confirm";

/** supertest's loopback client, as express-rate-limit keys it. */
const LOOPBACK_KEY = "127.0.0.1";
const BRIDGE_COMMAND_URL = "http://host.docker.internal:9090/pools/command";

interface SessionUser {
  id: string;
  role: string;
}
const OWNER: SessionUser = { id: "owner-1", role: "owner" };
const ADMIN: SessionUser = { id: "admin-1", role: "admin" };

function buildApp(prisma: unknown, user: SessionUser | null = OWNER): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (user) {
      (req as unknown as { user: unknown }).user = {
        id: user.id,
        username: user.id,
        displayName: user.id,
        role: user.role,
      };
    }
    next();
  });
  app.use("/api", createStorageRouter(prisma as never));
  return app;
}

/** A Prisma stand-in that records every call and persists nothing. */
interface PrismaCall {
  model: string;
  method: string;
  args: unknown[];
}
function recordingPrisma(): { prisma: unknown; calls: PrismaCall[] } {
  const calls: PrismaCall[] = [];
  const prisma = new Proxy(
    {},
    {
      get(_target, model) {
        if (typeof model !== "string" || model === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_t, method) {
              if (typeof method !== "string" || method === "then") return undefined;
              return async (...args: unknown[]): Promise<unknown> => {
                calls.push({ model, method, args });
                return {};
              };
            },
          },
        );
      },
    },
  );
  return { prisma, calls };
}

/** The `data` of every CommandAuditLog row written. */
interface AuditData {
  entityId: string;
  domain: string;
  service: string;
  data?: unknown;
  tier: number;
  confirmed: boolean;
  blocked: boolean;
  reason: string | null;
  userId: string | null;
}
function auditRows(calls: PrismaCall[]): AuditData[] {
  return calls
    .filter((c) => c.model === "commandAuditLog" && c.method === "create")
    .map((c) => (c.args[0] as { data: AuditData }).data);
}

// ── bridge doubles ──────────────────────────────────────────────────────────

interface BridgeInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}
interface FakeBridgeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
type FetchFn = (url: string, init?: BridgeInit) => Promise<FakeBridgeResponse>;

function reply(body: unknown, status = 200): FakeBridgeResponse {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

type RevealStatus = "revealed" | "already_retrieved" | "expired" | "not_found";
function hostReveal(status: RevealStatus, uuid: string, key?: string): Record<string, unknown> {
  return {
    ok: true,
    operation: REVEAL,
    status,
    uuid,
    ...(key !== undefined ? { recovery_key: key } : {}),
  };
}

type RegenerateStatus = "regenerated" | "not_found" | "drive_absent";
function hostRegenerate(status: RegenerateStatus, uuid: string): Record<string, unknown> {
  return {
    ok: true,
    operation: REGENERATE,
    status,
    uuid,
    ...(status === "regenerated" ? { recovery_key_pending: true } : {}),
  };
}

/** Installs `fn` as the global fetch and returns it so calls can be inspected. */
function stubBridge(fn: FetchFn): Mock<FetchFn> {
  const mock = vi.fn<FetchFn>(fn);
  vi.stubGlobal("fetch", mock);
  return mock;
}

/**
 * A fake bridge+host that behaves like the real escrow:
 *   reveal      first call returns the key and leaves a tombstone; later calls say
 *               already_retrieved; an unrevealed key past 7 days says expired; a
 *               uuid nobody escrowed is not_found.
 *   regenerate  swaps in a NEW key and makes it revealable again (also after an
 *               expiry); a uuid with no record is not_found; a drive that is not
 *               plugged in is drive_absent and keeps its old key.
 */
function escrowBridge(
  initial: Record<string, string>,
  opts: { expired?: string[]; absent?: string[] } = {},
): Mock<FetchFn> {
  const keys: Record<string, string> = { ...initial };
  const retrieved = new Set<string>();
  const expired = new Set(opts.expired ?? []);
  const absent = new Set(opts.absent ?? []);
  return stubBridge(async (_url, init) => {
    const sent = JSON.parse(init?.body ?? "{}") as { operation?: string; params?: { uuid?: string } };
    const uuid = sent.params?.uuid ?? "";
    if (sent.operation === REVEAL) {
      if (expired.has(uuid)) return reply(hostReveal("expired", uuid));
      if (retrieved.has(uuid)) return reply(hostReveal("already_retrieved", uuid));
      const key = keys[uuid];
      if (key === undefined) return reply(hostReveal("not_found", uuid));
      retrieved.add(uuid);
      return reply(hostReveal("revealed", uuid, key));
    }
    if (sent.operation === REGENERATE) {
      if (keys[uuid] === undefined && !expired.has(uuid)) return reply(hostRegenerate("not_found", uuid));
      if (absent.has(uuid)) return reply(hostRegenerate("drive_absent", uuid));
      keys[uuid] = FAKE_REGENERATED_KEY;
      retrieved.delete(uuid);
      expired.delete(uuid);
      return reply(hostRegenerate("regenerated", uuid));
    }
    return reply({ ok: true });
  });
}

interface CommandCall {
  url: string;
  init: BridgeInit;
  body: { operation: string; params: Record<string, unknown> };
}
/** Every POST /pools/command the stub bridge received. */
function commandCalls(mock: Mock<FetchFn>): CommandCall[] {
  return mock.mock.calls
    .filter(([url]) => String(url).endsWith("/pools/command"))
    .map(([url, init]) => ({
      url: String(url),
      init: init ?? {},
      body: JSON.parse(init?.body ?? "{}") as CommandCall["body"],
    }));
}

// ── handshake helpers ───────────────────────────────────────────────────────

/** Step 1: mint a confirmation token for `op` on `uuid`. */
async function mint(app: express.Express, op: Op, uuid = FS_UUID): Promise<string> {
  const res = await request(app).post(mintPath(op, uuid));
  expect(res.status).toBe(202);
  return res.body.confirmationToken as string;
}
/** Step 2: spend a token at the shared confirm route. */
function confirm(
  app: express.Express,
  token: string,
  echo: { service?: string; resourceId?: string } = {},
): request.Test {
  return request(app).post(CONFIRM_PATH).send({ confirmationToken: token, ...echo });
}
/** The whole reveal handshake. */
async function revealKey(app: express.Express, uuid = FS_UUID): Promise<request.Test> {
  return confirm(app, await mint(app, "reveal", uuid));
}
/** The whole regenerate handshake. */
async function regenerateKey(app: express.Express, uuid = FS_UUID): Promise<request.Test> {
  return confirm(app, await mint(app, "regenerate", uuid));
}

beforeEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.stubEnv("BRIDGE_AUTH_TOKEN", "test-bridge-token");
  logged.length = 0;
  recordActivityMock.mockClear();
  // The preset is a process-wide singleton keyed on the loopback address; reset
  // it so this file's request volume never trips the 60/min ceiling by accident.
  sensitiveRateLimit.resetKey(LOOPBACK_KEY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe("wiring — POST only, guarded, rate limited", () => {
  interface RouteLayer {
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }
  function routeFor(path: string): NonNullable<RouteLayer["route"]> {
    const router = createStorageRouter(recordingPrisma().prisma as never) as unknown as { stack: RouteLayer[] };
    const layer = router.stack.find((l) => l.route?.path === path);
    if (!layer?.route) throw new Error(`route ${path} is not registered`);
    return layer.route;
  }

  it.each(OPS)(
    "%s is a POST route carrying a role guard AND the sensitive rate limiter, ahead of its handler",
    (op) => {
      const route = routeFor(`/storage/drives/:uuid/recovery-key/${op}`);
      expect(route.methods.post).toBe(true);
      expect(route.methods.get, "no GET: a prefetcher must not be able to mint a token").toBeFalsy();
      const handles = route.stack.map((l) => l.handle);
      const guardIdx = handles.findIndex((h) => isRoleGuard(h));
      const limiterIdx = handles.indexOf(sensitiveRateLimit);
      expect(guardIdx, "requireRole guard").toBeGreaterThanOrEqual(0);
      expect(limiterIdx, "sensitiveRateLimit").toBeGreaterThanOrEqual(0);
      expect(handles.length - 1, "the handler comes last").toBeGreaterThan(Math.max(guardIdx, limiterIdx));
    },
  );

  it.each(OPS)("%s is rate limited per client: the 61st request inside a minute is answered 429", async (op) => {
    const app = buildApp(recordingPrisma().prisma);
    stubBridge(async () => reply({}));
    // An invalid uuid is the cheapest request that still passes through the
    // limiter: no token minted, no bridge call.
    let lastStatus = 0;
    for (let i = 0; i < 61; i++) {
      lastStatus = (await request(app).post(mintPath(op, "nope"))).status;
      if (i < 60) expect(lastStatus).toBe(400);
    }
    expect(lastStatus).toBe(429);
  });

  it.each(OPS)("a GET or HEAD on the %s URL mints nothing and reveals nothing (404)", async (op) => {
    const { prisma, calls } = recordingPrisma();
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(prisma);
    for (const res of [await request(app).get(mintPath(op, FS_UUID)), await request(app).head(mintPath(op, FS_UUID))]) {
      expect(res.status).toBe(404);
      expect(res.body.confirmationToken).toBeUndefined();
    }
    // The pre-ADR-070 shape — GET .../recovery-key — is gone too.
    expect((await request(app).get(`/api/storage/drives/${FS_UUID}/recovery-key`)).status).toBe(404);
    expect(calls).toEqual([]);
    expect(bridge).not.toHaveBeenCalled();
  });
});

describe.each(OPS)("%s — access: owner ONLY, denials audited (requireRole)", (op) => {
  it.each(["admin", "family", "guest", "service"])(
    "a %s session is refused 403 and nothing is minted or called",
    async (role) => {
      const { prisma, calls } = recordingPrisma();
      const bridge = stubBridge(async () => reply({}));
      const res = await request(buildApp(prisma, { id: `${role}-1`, role })).post(mintPath(op, FS_UUID));

      expect(res.status).toBe(403);
      expect(res.body.confirmationToken).toBeUndefined();
      expect(calls, "no token minted, no audit row written").toEqual([]);
      expect(bridge).not.toHaveBeenCalled();

      // The WARP-237 mandatory-emit policy-violation row — the denial is audited.
      expect(recordActivityMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "auth",
          severity: "warn",
          what: "Access denied",
          refs: expect.objectContaining({
            role,
            reason: "role-not-permitted",
            method: "POST",
            path: expect.stringContaining("/recovery-key/"),
          }),
        }),
      );
    },
  );

  it("a request with no authenticated user fails closed (403, audited as no-role)", async () => {
    const { prisma, calls } = recordingPrisma();
    const res = await request(buildApp(prisma, null)).post(mintPath(op, FS_UUID));
    expect(res.status).toBe(403);
    expect(calls).toEqual([]);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Access denied",
        refs: expect.objectContaining({ reason: "no-role" }),
      }),
    );
  });

  it("the owner is admitted (202)", async () => {
    const res = await request(buildApp(recordingPrisma().prisma)).post(mintPath(op, FS_UUID));
    expect(res.status).toBe(202);
    expect(recordActivityMock).not.toHaveBeenCalled();
  });
});

describe.each(OPS)("%s — uuid validation ^[A-Fa-f0-9-]{8,64}$", (op) => {
  it.each([
    ["too short (7)", "abcdef1"],
    ["not hex", "not-hex-zzzzzzzz"],
    ["the literal undefined", "undefined"],
    ["a space", "abcd1234%20ef"],
    ["a colon (the PATCH route's FAT form is not accepted here)", "abcd:1234"],
    ["shell metacharacters", "abcd1234;rm"],
    ["a path traversal", "..%2F..%2Fetc%2Fpasswd"],
    ["65 chars", "a".repeat(65)],
  ])("rejects a uuid that is %s with 400 — no token, no audit row, no bridge call", async (_why, uuid) => {
    const { prisma, calls } = recordingPrisma();
    const bridge = stubBridge(async () => reply({}));
    const res = await request(buildApp(prisma)).post(`/api/storage/drives/${uuid}/recovery-key/${op}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/uuid/i);
    expect(res.body.confirmationToken).toBeUndefined();
    expect(calls).toEqual([]);
    expect(bridge).not.toHaveBeenCalled();
  });

  it.each([
    ["a filesystem uuid", FS_UUID],
    ["the 8-char minimum, upper case", "ABCDEF12"],
    ["a 64-char hex string", "a".repeat(64)],
  ])("accepts %s", async (_why, uuid) => {
    const res = await request(buildApp(recordingPrisma().prisma)).post(mintPath(op, uuid));
    expect(res.status).toBe(202);
    expect(res.body.resourceId).toBe(uuid);
  });
});

describe.each(OPS)("%s — step 1: mint a token, do NOTHING else", (op) => {
  it("answers 202 with the exact confirmation envelope and the operation's own tier", async () => {
    const res = await request(buildApp(recordingPrisma().prisma)).post(mintPath(op, FS_UUID));
    expect(res.status).toBe(202);
    expect(res.body).toEqual({
      status: "confirmation_required",
      service: SERVICE_OF[op],
      resourceId: FS_UUID,
      tier: TIER_OF[op],
      reason: expect.any(String),
      confirmationToken: expect.stringMatching(/^[0-9a-f]{64}$/),
      expiresIn: 60,
    });
    expect(res.body.reason.length).toBeGreaterThan(20);
  });

  it("is not cacheable", async () => {
    const res = await request(buildApp(recordingPrisma().prisma)).post(mintPath(op, FS_UUID));
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("never touches the bridge, and writes exactly one audit row at the right tier with empty params", async () => {
    const { prisma, calls } = recordingPrisma();
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await request(buildApp(prisma)).post(mintPath(op, FS_UUID));

    expect(bridge, "nothing is revealed, replaced or consumed by the first call").not.toHaveBeenCalled();
    const rows = auditRows(calls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: "owner-1",
      entityId: `storage.${FS_UUID}`,
      domain: "storage",
      service: SERVICE_OF[op],
      tier: TIER_OF[op],
      confirmed: false,
      blocked: false,
    });
    expect(rows[0].data).toEqual({});
  });

  it("takes the drive from the URL only: a request body cannot redirect or parameterise it", async () => {
    const { prisma, calls } = recordingPrisma();
    const res = await request(buildApp(prisma))
      .post(mintPath(op, FS_UUID))
      .send({ uuid: OTHER_UUID, resourceId: OTHER_UUID, device: "sda", confirmPhrase: "ERASE sda", recoveryKey: "x" });
    expect(res.status).toBe(202);
    expect(res.body.resourceId).toBe(FS_UUID);
    expect(auditRows(calls)[0].data).toEqual({});
  });

  it("each call mints a different single-use token", async () => {
    const app = buildApp(recordingPrisma().prisma);
    const a = await mint(app, op);
    const b = await mint(app, op);
    expect(a).not.toBe(b);
  });

  it("is refused 403 when too many confirmations are pending (like every storage mint route), minting nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { prisma } = recordingPrisma();
    try {
      for (let i = 0; i < STORAGE_MAX_PENDING_CONFIRMATIONS; i++) {
        await evaluateStorageCommand(prisma as never, "pool_create", `md${i}`, {}, "owner-1", "api");
      }
      const res = await request(buildApp(prisma)).post(mintPath(op, FS_UUID));
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: expect.stringMatching(/too many pending/i), tier: TIER_OF[op], blocked: true });
      expect(res.body.confirmationToken).toBeUndefined();
    } finally {
      vi.advanceTimersByTime(STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS + 1_000);
      cleanupExpiredStorageTokens();
    }
  });
});

describe("reveal — step 2: confirm, and the key arrives ONCE", () => {
  it("returns the key as { recoveryKey } with Cache-Control: no-store", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const res = await revealKey(buildApp(recordingPrisma().prisma));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recoveryKey: FAKE_RECOVERY_KEY });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(commandCalls(bridge)).toHaveLength(1);
  });

  it("calls POST /pools/command with the reveal op, params {uuid} only, and the bridge auth header", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await revealKey(buildApp(recordingPrisma().prisma));

    const [call] = commandCalls(bridge);
    expect(call.url).toBe(BRIDGE_COMMAND_URL);
    expect(call.init.method).toBe("POST");
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Droplet-Auth": "test-bridge-token",
    });
    // Exactly {uuid}: no `device` key (the erase ops send one; the reveal has none).
    expect(call.body).toEqual({ operation: REVEAL, params: { uuid: FS_UUID } });
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("works whether the client echoes service + resourceId, only one of them, or neither", async () => {
    const app = buildApp(recordingPrisma().prisma);
    const echoes = [{ service: REVEAL, resourceId: FS_UUID }, { service: REVEAL }, { resourceId: FS_UUID }, {}];
    for (const echo of echoes) {
      escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY }); // fresh escrow each time: the reveal is one-time
      const res = await confirm(app, await mint(app, "reveal"), echo);
      expect(res.status, JSON.stringify(echo)).toBe(200);
      expect(res.body).toEqual({ recoveryKey: FAKE_RECOVERY_KEY });
    }
  });

  it("gives the host call a 60 s timeout, not the 10-minute one the erase ops need", async () => {
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "reveal");
    const timers = vi.spyOn(globalThis, "setTimeout");
    await confirm(app, token);

    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).toContain(60_000);
    expect(delays).not.toContain(600_000);
  });

  it("trims whitespace around the key the host returned", async () => {
    stubBridge(async (_u, init) => {
      const { params } = JSON.parse(init?.body ?? "{}") as { params: { uuid: string } };
      return reply(hostReveal("revealed", params.uuid, `  ${FAKE_RECOVERY_KEY}\n`));
    });
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ recoveryKey: FAKE_RECOVERY_KEY });
  });

  it("is ONE TIME: the second handshake against the same drive is 410 recovery_key_already_retrieved", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);

    const first = await revealKey(app);
    expect(first.status).toBe(200);
    expect(first.body.recoveryKey).toBe(FAKE_RECOVERY_KEY);

    const second = await revealKey(app);
    expect(second.status).toBe(410);
    expect(second.body).toEqual({ error: "recovery_key_already_retrieved" });
    expect(second.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(second.headers["cache-control"]).toBe("no-store");

    // The route asked the host both times; the host is the one-time authority.
    expect(commandCalls(bridge)).toHaveLength(2);
  });

  it("a key left unrevealed for 7 days is 410 recovery_key_expired (regenerate is the way forward)", async () => {
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY }, { expired: [FS_UUID] });
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: "recovery_key_expired" });
    expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
  });

  it("a drive with no escrowed key is 404 recovery_key_not_found", async () => {
    escrowBridge({});
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "recovery_key_not_found" });
  });

  it("escrow is per drive: revealing one uuid leaves another's key retrievable", async () => {
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY, [OTHER_UUID]: FAKE_OTHER_KEY });
    const app = buildApp(recordingPrisma().prisma);
    expect((await revealKey(app, FS_UUID)).status).toBe(200);
    const other = await revealKey(app, OTHER_UUID);
    expect(other.status).toBe(200);
    expect(other.body.recoveryKey).toBe(FAKE_OTHER_KEY);
  });

  it("audits the confirmation at Tier 2 and puts no key in any audit params", async () => {
    const { prisma, calls } = recordingPrisma();
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await revealKey(buildApp(prisma));

    const rows = auditRows(calls);
    expect(rows.map((r) => [r.service, r.confirmed, r.tier])).toEqual([
      [REVEAL, false, 2],
      [REVEAL, true, 2],
    ]);
    expect(inspect(calls, { depth: null })).not.toContain(FAKE_RECOVERY_KEY);
  });

  it("persists nothing but the two audit rows — the key is never written anywhere", async () => {
    const { prisma, calls } = recordingPrisma();
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await revealKey(buildApp(prisma));
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "commandAuditLog.create",
      "commandAuditLog.create",
    ]);
  });

  it("two CONCURRENT confirms of one token: exactly one runs, the host is asked once", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "reveal");

    const [a, b] = await Promise.all([confirm(app, token), confirm(app, token)]);
    expect([a.status, b.status].sort()).toEqual([200, 400]);
    expect(commandCalls(bridge)).toHaveLength(1);
    const refused = a.status === 400 ? a : b;
    expect(refused.body.code).toBe("TOKEN_MISSING");
    expect(refused.text).not.toContain(FAKE_RECOVERY_KEY);
  });
});

describe("reveal — step 2: the host's answer, mapped", () => {
  async function reveal1(hostBody: unknown, status = 200) {
    const bridge = stubBridge(async () => reply(hostBody, status));
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    return { res, bridge };
  }

  it.each([
    { name: "already_retrieved", hostBody: hostReveal("already_retrieved", FS_UUID), status: 410, body: { error: "recovery_key_already_retrieved" } },
    { name: "expired", hostBody: hostReveal("expired", FS_UUID), status: 410, body: { error: "recovery_key_expired" } },
    { name: "not_found", hostBody: hostReveal("not_found", FS_UUID), status: 404, body: { error: "recovery_key_not_found" } },
  ])("host status $name -> $status", async ({ hostBody, status, body }) => {
    const { res } = await reveal1(hostBody);
    expect(res.status).toBe(status);
    expect(res.body).toEqual(body);
  });

  it("never relays a key the host attached to a NON-revealed status", async () => {
    for (const status of ["already_retrieved", "expired", "not_found"] as const) {
      const { res } = await reveal1(hostReveal(status, FS_UUID, FAKE_RECOVERY_KEY));
      expect([404, 410], status).toContain(res.status);
      expect(res.text, status).not.toContain(FAKE_RECOVERY_KEY);
    }
  });

  it.each([
    ["revealed with no key", hostReveal("revealed", FS_UUID)],
    ["revealed with an empty key", { ...hostReveal("revealed", FS_UUID), recovery_key: "" }],
    ["revealed with a whitespace-only key", { ...hostReveal("revealed", FS_UUID), recovery_key: "  \n" }],
    ["revealed with a non-string key", { ...hostReveal("revealed", FS_UUID), recovery_key: 12345 }],
    ["revealed with an object key", { ...hostReveal("revealed", FS_UUID), recovery_key: { k: FAKE_RECOVERY_KEY } }],
    ["revealed without the drive UUID", { ok: true, status: "revealed", recovery_key: FAKE_RECOVERY_KEY }],
    ["revealed for a DIFFERENT drive", hostReveal("revealed", OTHER_UUID, FAKE_RECOVERY_KEY)],
    ["an unknown status", { ok: true, operation: REVEAL, status: "frobnicated", uuid: FS_UUID }],
    ["no status at all", { ok: true, operation: REVEAL, uuid: FS_UUID }],
    ["ok:false in a 200 body", { ok: false, error: BRIDGE_INTERNALS }],
    ["an empty body", {}],
  ])("a malformed host reply (%s) is 502 with a generic message and no key", async (_name, hostBody) => {
    const { res } = await reveal1(hostBody);
    expect(res.status).toBe(502);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(typeof res.body.error).toBe("string");
    expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(res.text).not.toContain("BRIDGE-INTERNAL");
  });

  it("compares the host's uuid case-insensitively (the route accepts upper-case input)", async () => {
    const upper = "1A2B3C4D-5E6F-4A1B-9C2D-3E4F5A6B7C8D";
    const bridge = stubBridge(async () => reply(hostReveal("revealed", FS_UUID, FAKE_RECOVERY_KEY)));
    const res = await revealKey(buildApp(recordingPrisma().prisma), upper);
    expect(bridge).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it.each([400, 401, 403, 404, 409, 500, 502, 503])(
    "a bridge HTTP %i is 502 with a generic message — the bridge body is never echoed",
    async (status) => {
      const { res } = await reveal1({ ok: false, error: BRIDGE_INTERNALS, recovery_key: FAKE_RECOVERY_KEY }, status);
      expect(res.status).toBe(502);
      expect(Object.keys(res.body)).toEqual(["error"]);
      expect(res.text).not.toContain("BRIDGE-INTERNAL");
      expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
    },
  );

  it("a precondition code on the reveal is NOT surfaced: the reveal has no precondition refusals", async () => {
    const { res } = await reveal1({ ok: false, error: "no tpm", code: "tpm_required" }, 409);
    expect(res.status).toBe(502);
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("a non-JSON bridge body is 502, not a crash", async () => {
    stubBridge(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }));
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(502);
  });

  it("503 when the device-bridge auth token is not configured — and the host is never asked", async () => {
    vi.stubEnv("BRIDGE_AUTH_TOKEN", "");
    vi.stubEnv("SERVICE_TOKEN_DISPLAY", "");
    const bridge = stubBridge(async () => reply({}));
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/auth token is not configured/i);
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("503 reason bridge_unavailable when the bridge cannot be reached", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), { code: "ECONNREFUSED" }),
    });
    stubBridge(async () => {
      throw connErr;
    });
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("bridge_unavailable");
    expect(res.text).not.toMatch(/ECONNREFUSED|fetch failed/);
  });

  it.each([
    ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ["an unexpected failure", new Error(`internal detail ${BRIDGE_INTERNALS}`)],
  ])("%s is 502 with a generic message that never echoes the error", async (_name, failure) => {
    stubBridge(async () => {
      throw failure;
    });
    const res = await revealKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(502);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(res.text).not.toMatch(/aborted|BRIDGE-INTERNAL|internal detail/);
  });
});

describe("regenerate — step 2: confirm, the old key stops working, the reply carries NO key", () => {
  it("answers 200 { ok, status, operation, uuid, recoveryKeyPending: true } with Cache-Control: no-store", async () => {
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const res = await regenerateKey(buildApp(recordingPrisma().prisma));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      status: "ok",
      operation: REGENERATE,
      uuid: FS_UUID,
      recoveryKeyPending: true,
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(res.text).not.toContain(FAKE_REGENERATED_KEY);
  });

  it("calls POST /pools/command with the regenerate op, params {uuid} only, a 60 s timeout", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "regenerate");
    const timers = vi.spyOn(globalThis, "setTimeout");
    await confirm(app, token);

    const [call] = commandCalls(bridge);
    expect(call.url).toBe(BRIDGE_COMMAND_URL);
    expect(call.init.headers).toEqual({
      "Content-Type": "application/json",
      "X-Droplet-Auth": "test-bridge-token",
    });
    expect(call.body).toEqual({ operation: REGENERATE, params: { uuid: FS_UUID } });
    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).toContain(60_000);
    expect(delays).not.toContain(600_000);
  });

  it("works whether the client echoes service + resourceId or neither", async () => {
    const app = buildApp(recordingPrisma().prisma);
    for (const echo of [{ service: REGENERATE, resourceId: FS_UUID }, {}]) {
      escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
      const res = await confirm(app, await mint(app, "regenerate"), echo);
      expect(res.status, JSON.stringify(echo)).toBe(200);
    }
  });

  it("audits the confirmation at Tier 3 and persists nothing but the two audit rows", async () => {
    const { prisma, calls } = recordingPrisma();
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await regenerateKey(buildApp(prisma));

    expect(auditRows(calls).map((r) => [r.service, r.confirmed, r.tier])).toEqual([
      [REGENERATE, false, 3],
      [REGENERATE, true, 3],
    ]);
    expect(calls.map((c) => `${c.model}.${c.method}`)).toEqual([
      "commandAuditLog.create",
      "commandAuditLog.create",
    ]);
  });

  it("the full story: reveal, reveal again (410), regenerate, then the NEW key is revealable once", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);

    const first = await revealKey(app);
    expect(first.body).toEqual({ recoveryKey: FAKE_RECOVERY_KEY });
    expect((await revealKey(app)).status).toBe(410);

    const regen = await regenerateKey(app);
    expect(regen.status).toBe(200);
    expect(regen.body.recoveryKeyPending).toBe(true);

    const fresh = await revealKey(app);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ recoveryKey: FAKE_REGENERATED_KEY });
    expect(fresh.body.recoveryKey).not.toBe(first.body.recoveryKey);
    expect((await revealKey(app)).status, "and that one is one-time too").toBe(410);

    expect(commandCalls(bridge).map((c) => c.body.operation)).toEqual([REVEAL, REVEAL, REGENERATE, REVEAL, REVEAL]);
  });

  it("recovers a drive whose key expired unrevealed: regenerate, then reveal works", async () => {
    escrowBridge({}, { expired: [FS_UUID] });
    const app = buildApp(recordingPrisma().prisma);
    expect((await revealKey(app)).status).toBe(410);
    expect((await regenerateKey(app)).status).toBe(200);
    const fresh = await revealKey(app);
    expect(fresh.status).toBe(200);
    expect(fresh.body).toEqual({ recoveryKey: FAKE_REGENERATED_KEY });
  });

  it("a regenerate token cannot be reused, and a replay never asks the host twice", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "regenerate");
    expect((await confirm(app, token)).status).toBe(200);
    const replay = await confirm(app, token);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("TOKEN_MISSING");
    expect(commandCalls(bridge)).toHaveLength(1);
  });
});

describe("regenerate — step 2: the host's answer, mapped", () => {
  async function regenerate1(hostBody: unknown, status = 200) {
    const bridge = stubBridge(async () => reply(hostBody, status));
    const res = await regenerateKey(buildApp(recordingPrisma().prisma));
    return { res, bridge };
  }

  it("host status not_found -> 404 recovery_key_not_found (no record of that drive)", async () => {
    const { res } = await regenerate1(hostRegenerate("not_found", FS_UUID));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "recovery_key_not_found" });
  });

  it("host status drive_absent -> 409 drive_not_present, and the old key is untouched", async () => {
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY }, { absent: [FS_UUID] });
    const app = buildApp(recordingPrisma().prisma);
    const res = await regenerateKey(app);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      ok: false,
      code: "drive_not_present",
      error: expect.stringMatching(/isn't connected.*plug it in/i),
    });
    // The key was not replaced: the original is still the one that reveals.
    expect((await revealKey(app)).body).toEqual({ recoveryKey: FAKE_RECOVERY_KEY });
  });

  it.each([
    ["tpm_required", /no usable TPM2 chip/],
    ["encrypted_data_required", /not encrypted yet/],
  ])("a host precondition refusal (%s) is a 409 with that code and a fixed message", async (code, message) => {
    const { res } = await regenerate1(
      { ok: false, error: "droplet-storage-pool: refusing: /sys/class/tpm/tpm0 is missing", code },
      409,
    );
    expect(res.status).toBe(409);
    expect(Object.keys(res.body).sort()).toEqual(["code", "error", "ok"]);
    expect(res.body.code).toBe(code);
    expect(res.body.error).toMatch(message);
    expect(res.text).not.toContain("/sys/class/tpm");
  });

  it("a host refusal is a 422 carrying the host's actionable message (it never holds a key)", async () => {
    const message =
      "the new recovery key is escrowed, but the old recovery keyslot could not be wiped — run Regenerate again to retry";
    const { res } = await regenerate1({ ok: false, error: message, recovery_key: FAKE_RECOVERY_KEY }, 422);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ ok: false, error: message });
    expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
  });

  it("a refusal with no message is a 422 with a generic one", async () => {
    const { res } = await regenerate1({ ok: false }, 500);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ ok: false, error: expect.stringMatching(/could not complete this request/i) });
  });

  it("never relays a key the host attached to a regenerate reply", async () => {
    for (const hostBody of [
      { ...hostRegenerate("regenerated", FS_UUID), recovery_key: FAKE_REGENERATED_KEY, recoveryKey: FAKE_REGENERATED_KEY },
      { ...hostRegenerate("not_found", FS_UUID), recovery_key: FAKE_RECOVERY_KEY },
      { ...hostRegenerate("drive_absent", FS_UUID), recovery_key: FAKE_RECOVERY_KEY },
    ]) {
      const { res } = await regenerate1(hostBody);
      expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
      expect(res.text).not.toContain(FAKE_REGENERATED_KEY);
    }
  });

  it.each([
    ["an unknown status", { ok: true, operation: REGENERATE, status: "frobnicated", uuid: FS_UUID }],
    ["no status at all", { ok: true, operation: REGENERATE, uuid: FS_UUID }],
    ["an empty body", {}],
  ])("a malformed host reply (%s) is 502 with a generic message", async (_name, hostBody) => {
    const { res } = await regenerate1(hostBody);
    expect(res.status).toBe(502);
    expect(Object.keys(res.body)).toEqual(["error"]);
  });

  it("503 when the device-bridge auth token is not configured — and the host is never asked", async () => {
    vi.stubEnv("BRIDGE_AUTH_TOKEN", "");
    vi.stubEnv("SERVICE_TOKEN_DISPLAY", "");
    const bridge = stubBridge(async () => reply({}));
    const res = await regenerateKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/auth token is not configured/i);
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("503 reason bridge_unavailable when the bridge cannot be reached", async () => {
    const connErr = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 172.17.0.1:9090"), { code: "ECONNREFUSED" }),
    });
    stubBridge(async () => {
      throw connErr;
    });
    const res = await regenerateKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(503);
    expect(res.body.reason).toBe("bridge_unavailable");
    expect(res.text).not.toMatch(/ECONNREFUSED|fetch failed/);
  });

  it.each([
    ["a timeout", Object.assign(new Error("The operation was aborted"), { name: "AbortError" })],
    ["an unexpected failure", new Error(`internal detail ${BRIDGE_INTERNALS}`)],
  ])("%s is 502 with a generic message that never echoes the error", async (_name, failure) => {
    stubBridge(async () => {
      throw failure;
    });
    const res = await regenerateKey(buildApp(recordingPrisma().prisma));
    expect(res.status).toBe(502);
    expect(Object.keys(res.body)).toEqual(["error"]);
    expect(res.text).not.toMatch(/aborted|BRIDGE-INTERNAL|internal detail/);
  });
});

describe("confirm — the token is bound to {operation, drive, user} and single-use", () => {
  it("a missing confirmationToken is 400 and the host is never asked", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const res = await request(buildApp(recordingPrisma().prisma)).post(CONFIRM_PATH).send({});
    expect(res.status).toBe(400);
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a garbage token is 400 TOKEN_MISSING and the host is never asked", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const res = await confirm(buildApp(recordingPrisma().prisma), "f".repeat(64));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: expect.any(String), code: "TOKEN_MISSING" });
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a token is single-use: replaying it is 400 and the host is asked only once", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "reveal");
    expect((await confirm(app, token)).status).toBe(200);

    const replay = await confirm(app, token);
    expect(replay.status).toBe(400);
    expect(replay.body.code).toBe("TOKEN_MISSING");
    expect(replay.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(commandCalls(bridge)).toHaveLength(1);
  });

  it("a token minted for one drive cannot reveal another's key (TOKEN_OPERATION_MISMATCH)", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY, [OTHER_UUID]: FAKE_OTHER_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const tokenForOther = await mint(app, "reveal", OTHER_UUID);
    const res = await confirm(app, tokenForOther, { service: REVEAL, resourceId: FS_UUID });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_OPERATION_MISMATCH");
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a reveal token cannot run a regenerate, nor a regenerate token a reveal", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);

    const asRegenerate = await confirm(app, await mint(app, "reveal"), { service: REGENERATE, resourceId: FS_UUID });
    expect(asRegenerate.status).toBe(400);
    expect(asRegenerate.body.code).toBe("TOKEN_OPERATION_MISMATCH");

    const asReveal = await confirm(app, await mint(app, "regenerate"), { service: REVEAL, resourceId: FS_UUID });
    expect(asReveal.status).toBe(400);
    expect(asReveal.body.code).toBe("TOKEN_OPERATION_MISMATCH");

    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a recovery-key token cannot be repurposed into an erase op (and the reverse)", async () => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);

    const reveal = await confirm(app, await mint(app, "reveal"), { service: "drive_adopt", resourceId: FS_UUID });
    expect(reveal.status).toBe(400);
    expect(reveal.body.code).toBe("TOKEN_OPERATION_MISMATCH");

    const adopt = await request(app).post("/api/storage/drives/adopt").send({ device: "sdb", confirmPhrase: "ERASE sdb" });
    expect(adopt.status).toBe(202);
    const erase = await confirm(app, adopt.body.confirmationToken as string, { service: REVEAL, resourceId: FS_UUID });
    expect(erase.status).toBe(400);
    expect(erase.body.code).toBe("TOKEN_OPERATION_MISMATCH");

    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a token is bound to the user who minted it, and a stranger cannot burn it (TOKEN_USER_MISMATCH)", async () => {
    const { prisma } = recordingPrisma();
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const token = await mint(buildApp(prisma, OWNER), "reveal");

    const other = await confirm(buildApp(prisma, { id: "owner-2", role: "owner" }), token);
    expect(other.status).toBe(400);
    expect(other.body.code).toBe("TOKEN_USER_MISMATCH");
    expect(commandCalls(bridge)).toHaveLength(0);

    // Still alive for the user it was minted for.
    expect((await confirm(buildApp(prisma, OWNER), token)).status).toBe(200);
  });

  it("an expired token (60 s) is 400 TOKEN_EXPIRED", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const app = buildApp(recordingPrisma().prisma);
    const token = await mint(app, "reveal");
    vi.advanceTimersByTime(STORAGE_CONFIRMATION_TOKEN_EXPIRY_MS + 1_000);

    const res = await confirm(app, token);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_EXPIRED");
    expect(commandCalls(bridge)).toHaveLength(0);
  });

  it("a token for an operation that is not executable here is never executed", async () => {
    const { prisma } = recordingPrisma();
    const bridge = stubBridge(async () => reply({ ok: true }));
    // Mint straight through the service: no route mints this, which is the point.
    const minted = await evaluateStorageCommand(prisma as never, "totally_unknown_op", "sdb", {}, "owner-1", "api");
    if (!("confirmationToken" in minted)) throw new Error("no token minted");

    const res = await confirm(buildApp(prisma), minted.confirmationToken, { service: "totally_unknown_op", resourceId: "sdb" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("TOKEN_ENDPOINT_MISMATCH");
    expect(commandCalls(bridge)).toHaveLength(0);
  });
});

describe("confirm — the owner-only second lock (the shared route admits admins for the erase ops)", () => {
  it.each(OPS)("an ADMIN holding the OWNER's %s token cannot spend it (user binding), and it survives", async (op) => {
    const { prisma } = recordingPrisma();
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const token = await mint(buildApp(prisma, OWNER), op);

    const adminTry = await confirm(buildApp(prisma, ADMIN), token);
    expect(adminTry.status).toBe(400);
    expect(adminTry.body.code).toBe("TOKEN_USER_MISMATCH");
    expect(adminTry.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(commandCalls(bridge)).toHaveLength(0);

    expect((await confirm(buildApp(prisma, OWNER), token)).status, "not consumed by the refused attempt").toBe(200);
  });

  it.each(OPS)("an ADMIN session is refused 403 on a %s token minted for it directly — the host is never asked", async (op) => {
    const { prisma } = recordingPrisma();
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    // No route mints this for an admin; mint straight through the service, which is the point.
    const minted = await evaluateStorageCommand(prisma as never, SERVICE_OF[op], FS_UUID, {}, ADMIN.id, "api");
    if (!("confirmationToken" in minted)) throw new Error("no token minted");

    const res = await confirm(buildApp(prisma, ADMIN), minted.confirmationToken);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Owner access required" });
    expect(res.text).not.toContain(FAKE_RECOVERY_KEY);
    expect(commandCalls(bridge)).toHaveLength(0);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "Access denied",
        refs: expect.objectContaining({ role: "admin", reason: "role-not-permitted", method: "POST" }),
      }),
    );
  });

  it("an admin can still confirm an ERASE op (no regression)", async () => {
    const bridge = stubBridge(async () => reply({ ok: true, device: "sdb" }));
    const app = buildApp(recordingPrisma().prisma, ADMIN);
    const adopt = await request(app).post("/api/storage/drives/adopt").send({ device: "sdb", confirmPhrase: "ERASE sdb" });
    const res = await confirm(app, adopt.body.confirmationToken as string);
    expect(res.status).toBe(200);
    expect(commandCalls(bridge).map((c) => c.body.operation)).toEqual(["drive_adopt"]);
  });

  it.each(["family", "guest"])("a %s session is refused 403 at the shared confirm route", async (role) => {
    const bridge = escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const res = await confirm(buildApp(recordingPrisma().prisma, { id: `${role}-1`, role }), "f".repeat(64));
    expect(res.status).toBe(403);
    expect(commandCalls(bridge)).toHaveLength(0);
  });
});

describe("the erase ops are untouched by the new handshake", () => {
  it("still executes an ERASE token, with or without the service echo (no regression)", async () => {
    const bridge = stubBridge(async () => reply({ ok: true, device: "sdb" }));
    const app = buildApp(recordingPrisma().prisma);
    for (const echo of [{ service: "drive_adopt", resourceId: "sdb" }, {}]) {
      const adopt = await request(app).post("/api/storage/drives/adopt").send({ device: "sdb", confirmPhrase: "ERASE sdb" });
      const res = await confirm(app, adopt.body.confirmationToken as string, echo);
      expect(res.status, JSON.stringify(echo)).toBe(200);
    }
    expect(commandCalls(bridge).map((c) => c.body.operation)).toEqual(["drive_adopt", "drive_adopt"]);
  });

  it("keeps the 10-minute host timeout for the erase ops (only the recovery-key ops get 60 s)", async () => {
    stubBridge(async () => reply({ ok: true, device: "sdb" }));
    const app = buildApp(recordingPrisma().prisma);
    const adopt = await request(app).post("/api/storage/drives/adopt").send({ device: "sdb", confirmPhrase: "ERASE sdb" });
    const timers = vi.spyOn(globalThis, "setTimeout");
    await confirm(app, adopt.body.confirmationToken as string);
    const delays = timers.mock.calls.map((c) => c[1]);
    expect(delays).toContain(600_000);
    expect(delays).not.toContain(60_000);
  });
});

describe("the recovery key never reaches a log, the console, the activity feed or a database write", () => {
  /** Drive every outcome the routes have, with the key (and bridge internals) in play. */
  async function runEveryOutcome(prisma: unknown): Promise<void> {
    const app = buildApp(prisma);

    // 200 then 410 against a stateful bridge that holds the key, then a
    // regenerate and a reveal of the new key.
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await revealKey(app);
    await revealKey(app);
    await regenerateKey(app);
    await revealKey(app);

    // Bridge errors whose BODY carries the key and internals.
    for (const status of [500, 403]) {
      stubBridge(async () => reply({ ok: false, error: BRIDGE_INTERNALS, recovery_key: FAKE_RECOVERY_KEY }, status));
      await revealKey(app);
      await regenerateKey(app);
    }
    // A malformed 200 that still carries the key.
    stubBridge(async () => reply({ ok: true, status: "mystery", uuid: FS_UUID, recovery_key: FAKE_RECOVERY_KEY }));
    await revealKey(app);
    await regenerateKey(app);
    // A regenerate that (wrongly) carries a key.
    stubBridge(async () => reply({ ...hostRegenerate("regenerated", FS_UUID), recovery_key: FAKE_REGENERATED_KEY }));
    await regenerateKey(app);
    // Revealed for the wrong drive.
    stubBridge(async () => reply(hostReveal("revealed", OTHER_UUID, FAKE_RECOVERY_KEY)));
    await revealKey(app);
    // An exception whose message embeds the key.
    stubBridge(async () => {
      throw new Error(`socket reset while carrying ${FAKE_RECOVERY_KEY} ${BRIDGE_INTERNALS}`);
    });
    await revealKey(app);
    await regenerateKey(app);
    // Refusals the confirm route logs: a stale token and an admin session.
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    await confirm(app, await mint(app, "reveal"), { service: "drive_adopt", resourceId: FS_UUID });
    // The shared confirm route running an ERASE op whose REFUSAL body (wrongly)
    // carries a key: the route logs that refusal, and must not log the key.
    stubBridge(async () => reply({ ok: false, error: "refusing to erase the OS disk", recovery_key: FAKE_RECOVERY_KEY }, 409));
    const adopt = await request(app).post("/api/storage/drives/adopt").send({ device: "sdb", confirmPhrase: "ERASE sdb" });
    await confirm(app, adopt.body.confirmationToken as string);
  }

  it("neither the logger (any level, any module) nor console ever sees the key or the bridge internals", async () => {
    const consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    const { prisma } = recordingPrisma();
    await runEveryOutcome(prisma);

    expect(logged.length, "the route and the safety service do log").toBeGreaterThan(0);
    const everythingLogged = inspect(logged, { depth: null });
    for (const secret of [FAKE_RECOVERY_KEY, FAKE_REGENERATED_KEY, "BRIDGE-INTERNAL"]) {
      expect(everythingLogged).not.toContain(secret);
    }
    for (const spy of consoleSpies) {
      expect(inspect(spy.mock.calls, { depth: null })).not.toContain(FAKE_RECOVERY_KEY);
    }
  });

  it("neither the activity feed nor any database write ever sees the key or the bridge internals", async () => {
    const { prisma, calls } = recordingPrisma();
    await runEveryOutcome(prisma);

    const written = inspect(calls, { depth: null });
    const activity = inspect(recordActivityMock.mock.calls, { depth: null });
    for (const sink of [written, activity]) {
      for (const secret of [FAKE_RECOVERY_KEY, FAKE_REGENERATED_KEY, "BRIDGE-INTERNAL"]) {
        expect(sink).not.toContain(secret);
      }
    }
    // The only thing persisted is the audit trail.
    expect(new Set(calls.map((c) => `${c.model}.${c.method}`))).toEqual(new Set(["commandAuditLog.create"]));
  });

  it("every response of the two mint routes and their confirms is Cache-Control: no-store", async () => {
    const app = buildApp(recordingPrisma().prisma);
    escrowBridge({ [FS_UUID]: FAKE_RECOVERY_KEY });
    const responses = [
      await request(app).post(mintPath("reveal", FS_UUID)), // 202
      await revealKey(app), // 200
      await revealKey(app), // 410
      await request(app).post(mintPath("reveal", "nope")), // 400
      await request(app).post(mintPath("regenerate", FS_UUID)), // 202
      await regenerateKey(app), // 200
      await request(app).post(mintPath("regenerate", "nope")), // 400
    ];
    expect(responses.map((r) => r.status)).toEqual([202, 200, 410, 400, 202, 200, 400]);
    for (const r of responses) expect(r.headers["cache-control"], `${r.status}`).toBe("no-store");
  });
});

describe("the recovery key stays out of the request logger and the log bundle", () => {
  it.each([
    "req.body.recoveryKey",
    "req.body.recovery_key",
    "res.body.recoveryKey",
    "res.body.recovery_key",
  ])("the request logger's redact list carries %s", (path) => {
    expect(REQUEST_LOG_REDACT_PATHS).toContain(path);
  });

  it("those paths really censor a recovery key — and without them it would leak (control)", () => {
    // pino-http's own req/res serializers drop `body` before redaction runs, so
    // the paths are defence in depth for a future serializer. Prove they work
    // on a bare pino with NO serializer in the way.
    const leaky = { res: { body: { recoveryKey: FAKE_RECOVERY_KEY } }, req: { body: { recovery_key: FAKE_RECOVERY_KEY } } };

    const control: string[] = [];
    pino({}, { write: (s: string) => control.push(s) }).info(leaky, "no redaction");
    expect(control.join("")).toContain(FAKE_RECOVERY_KEY);

    const lines: string[] = [];
    pino({ redact: { paths: [...REQUEST_LOG_REDACT_PATHS] } }, { write: (s: string) => lines.push(s) }).info(leaky, "redacted");
    expect(lines.join("")).not.toContain(FAKE_RECOVERY_KEY);
    expect(lines.join("")).toContain("[Redacted]");
  });

  it("the log-bundle scrub already covers both key names by suffix, so no key list needed changing there", () => {
    // lib/log-redaction.ts has no explicit key list: it matches secret-bearing
    // WORDS (...KEY...), so recoveryKey / recovery_key are caught by construction.
    // Pinned so a future tightening of that heuristic cannot silently drop them.
    expect(redactSecretParams({ recoveryKey: FAKE_RECOVERY_KEY, uuid: FS_UUID })).toEqual({
      recoveryKey: "[REDACTED]",
      uuid: FS_UUID,
    });
    expect(redactSecretParams({ recovery_key: FAKE_RECOVERY_KEY })).toEqual({ recovery_key: "[REDACTED]" });
    expect(redactSecrets(`{"recoveryKey":"${FAKE_RECOVERY_KEY}"}`)).not.toContain(FAKE_RECOVERY_KEY);
    expect(redactSecrets(`recovery_key=${FAKE_RECOVERY_KEY}`)).not.toContain(FAKE_RECOVERY_KEY);
  });
});
