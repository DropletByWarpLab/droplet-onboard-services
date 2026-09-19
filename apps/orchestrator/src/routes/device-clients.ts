import { Router, Request } from "express";
import { randomInt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import { config } from "../config.js";
import {
  ncGenerateAppPassword,
  ncDeleteAppPassword,
} from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { encryptSecret, decryptSecret } from "../services/encryption.service.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { publish } from "../services/mqtt.service.js";
import {
  dispatchToUser,
  getPublicVapidKey,
} from "../services/push-dispatch.service.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";

const logger = createLogger("device-clients-route");

/**
 * Thrown inside the claim transaction when the atomic conditional consume
 * (`updateMany WHERE status='active'`) flips zero rows — i.e. another request
 * already claimed the code. Throwing rolls back the transaction and signals
 * the handler to respond 409 (and compensate the pre-minted app password).
 */
class PairingCodeAlreadyClaimedError extends Error {
  constructor() {
    super("pairing code already claimed");
    this.name = "PairingCodeAlreadyClaimedError";
  }
}

// ── Tunables ──
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAIRING_CODE_LENGTH = 6;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
// WARP-1151: `PairingCode.code` is unique, so a fresh random 6-char code can
// (rarely) collide with a historical row. The WARP-1203 daily sweep purges
// terminal rows past retention, which keeps the collision probability flat —
// but rows inside the retention window can still clash. A collision is a
// retryable allocation miss, not a request failure — regenerate up to this
// many times before giving up.
const PAIRING_CODE_CREATE_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_SEC = 3600;
const MAX_PAIR_CREATE_PER_USER_PER_HOUR = 5;
const MAX_PAIR_CLAIM_PER_IP_PER_HOUR = 20;
// WARP-1030: brute-force budget for the unauthenticated Basic self-revoke
// path. A legitimate client revokes once, so both budgets are generous;
// the per-target bucket also caps a rotating-IP attacker guessing one
// device's app password.
const MAX_SELF_REVOKE_PER_IP_PER_HOUR = 20;
const MAX_SELF_REVOKE_PER_TARGET_PER_HOUR = 10;

const platformSchema = z.enum([
  "macos",
  "windows",
  "linux",
  "ios",
  "android",
  "other",
]);
const deviceTypeSchema = z.enum(["desktop", "mobile"]);

function safePublish(topic: string, payload: Record<string, unknown>): void {
  try {
    publish(topic, payload);
  } catch (err) {
    logger.warn({ err, topic }, "MQTT publish failed (non-fatal)");
  }
}


function getUser(req: Request): string {
  return req.user?.username || "dev";
}

function generatePairingCode(): string {
  // CodeQL js/biased-cryptographic-random: `randomBytes()[i] % 32` is only
  // uniform because the alphabet length happens to divide 256. randomInt
  // rejection-samples, so the code stays uniform if the alphabet changes.
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Redis-backed rate limiter. Non-fatal if Redis is unreachable — caller
 * degrades to "allow" rather than "deny" so a cache outage doesn't wedge
 * real users out of pairing.
 */
async function rateLimit(
  bucket: string,
  limit: number
): Promise<{ allowed: boolean; remaining: number }> {
  const key = `ratelimit:${bucket}`;
  try {
    const cached = await cacheGet<number>(key);
    const current = typeof cached === "number" ? cached : 0;
    if (current >= limit) {
      return { allowed: false, remaining: 0 };
    }
    await cacheSet(key, current + 1, RATE_LIMIT_WINDOW_SEC);
    return { allowed: true, remaining: limit - current - 1 };
  } catch {
    return { allowed: true, remaining: limit };
  }
}

/**
 * WARP-1138: caller IP for per-IP rate-limit bucket keys. Mirrors auth.ts
 * callerIpFromReq (WARP-579 standard) — uses Express's proxy-aware `req.ip`
 * (`trust proxy` is set in app.ts, so behind the nginx hop this resolves the
 * real client). NEVER the leftmost `X-Forwarded-For` entry: that value is
 * client-controlled, so keying the bucket on it lets an attacker mint a
 * fresh bucket per request by rotating the header (and an empty header
 * collapses everyone into one shared bucket).
 */
function callerIp(req: Request): string {
  return req.ip ?? req.socket?.remoteAddress ?? "unknown";
}

/**
 * The box's mDNS hostname. A native client reaching the appliance over Bonjour/
 * Avahi uses this host, and it is in the TLS cert SANs (see
 * scripts/trust-droplet-cert.sh), so it is a legitimate served host even though
 * it is not in the CORS allowlist. Passed to the trusted-origin resolver as an
 * extra allowed host so the WebDAV URL keeps working over mDNS.
 */
const MDNS_HOST = "droplet.local";

/**
 * Return the external URL clients should reach for WebDAV. The orchestrator
 * lives behind Nginx which proxies /nextcloud/ to the Nextcloud container,
 * so clients talk to https://<droplet>/nextcloud/ and append /remote.php/dav/.
 *
 * PR #486 review finding 2: the host is sourced from the shared trusted-origin
 * resolver (canonical origin -> allowlisted request host -> safe default)
 * instead of a blindly-trusted `x-forwarded-host`, so a forged header can't
 * poison the server URL a paired client is told to talk to. The legitimate
 * mDNS host is allowlisted so on-LAN pairing over Bonjour is unaffected.
 */
export async function webdavBaseUrl(req: Request): Promise<string> {
  return trustedOriginUrl(req, "/nextcloud", [MDNS_HOST]);
}

/**
 * Shared revoke cleanup for BOTH auth paths — the operator session-cookie
 * delete and the WARP-349 device Basic-auth self-revoke: best-effort revoke
 * the Nextcloud app password upstream, mark the row revoked, publish the
 * MQTT event. Idempotent — an already-revoked row is a no-op.
 */
async function revokeDeviceClient(
  prisma: PrismaClient,
  row: { id: string; userId: string; ncAppPassword: string; status: string },
): Promise<void> {
  if (row.status === "revoked") return;

  try {
    const plaintext = decryptSecret(row.ncAppPassword);
    await ncDeleteAppPassword(plaintext);
  } catch (err) {
    // Best-effort: still mark the row revoked even if Nextcloud can't
    // kill the token (e.g. already expired). Operators can clean up
    // stale tokens via the Nextcloud admin UI if needed.
    logger.warn({ err, deviceId: row.id }, "Failed to revoke Nextcloud app password");
  }

  await prisma.deviceClient.update({
    where: { id: row.id },
    data: { status: "revoked" },
  });

  safePublish(`droplet/devices/${row.userId}/revoked`, { deviceId: row.id });
}

export function createDeviceClientsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── POST /api/devices/pair ──
  // Dashboard calls this to generate a one-time code. The response includes
  // a droplet:// URL the dashboard renders as a QR code; a native client
  // scans it and completes pairing via /pair/claim.
  router.post("/devices/pair", async (req, res, next) => {
    try {
      const schema = z.object({
        deviceName: z.string().min(1).max(100),
        deviceType: deviceTypeSchema,
        platform: platformSchema,
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid pair request",
          details: parsed.error.flatten(),
        });
        return;
      }

      const user = getUser(req);
      const rl = await rateLimit(
        `pair:create:${user}`,
        MAX_PAIR_CREATE_PER_USER_PER_HOUR
      );
      if (!rl.allowed) {
        res.status(429).json({
          error: `Too many pairing codes generated. Try again in an hour.`,
        });
        return;
      }

      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

      // WARP-1150/1151: allocate the code with a collision retry. Without it a
      // P2002 clash with any historical code 500s the whole Generate-code step.
      let code: string | null = null;
      for (let attempt = 0; attempt < PAIRING_CODE_CREATE_ATTEMPTS; attempt++) {
        const candidate = generatePairingCode();
        try {
          await prisma.pairingCode.create({
            data: { code: candidate, userId: user, expiresAt },
          });
          code = candidate;
          break;
        } catch (err) {
          if ((err as { code?: string })?.code !== "P2002") throw err;
          logger.warn(
            { attempt },
            "pairing code collided with an existing row; regenerating"
          );
        }
      }
      if (!code) {
        // Astronomically unlikely (5 independent collisions), but answer with
        // retryable copy rather than a 500.
        res.status(503).json({
          error: "Couldn't allocate a pairing code. Try again.",
        });
        return;
      }

      const server = (await webdavBaseUrl(req)).replace(/\/nextcloud$/, "");
      const pairUrl = `droplet://pair?server=${encodeURIComponent(server)}&code=${code}`;

      // Stash pending metadata so /pair/claim knows what device the user
      // intended — the native client only sends the code + its own locally
      // captured name.
      await cacheSet(
        `pair:meta:${code}`,
        {
          deviceName: parsed.data.deviceName,
          deviceType: parsed.data.deviceType,
          platform: parsed.data.platform,
        },
        Math.ceil(PAIRING_CODE_TTL_MS / 1000)
      );

      res.json({
        code,
        expiresAt: expiresAt.toISOString(),
        pairUrl,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/devices/pair/:code/status ──
  // Polled by the dashboard until the code is claimed or expires.
  router.get("/devices/pair/:code/status", async (req, res, next) => {
    try {
      const code = req.params.code;
      const record = await prisma.pairingCode.findUnique({ where: { code } });
      if (!record) {
        res.status(404).json({ error: "Unknown pairing code" });
        return;
      }
      if (record.userId !== getUser(req)) {
        res.status(403).json({ error: "Pairing code belongs to another user" });
        return;
      }
      // WARP-1202: state keys on the explicit status enum. `expiresAt` stays
      // authoritative for the deadline — an overdue row the daily sweep hasn't
      // stamped `expired` yet must still poll as expired. Wire shape unchanged
      // (the dashboard's pair page reads `used`/`expired` booleans).
      const expired =
        record.status === "expired" ||
        record.expiresAt.getTime() < Date.now();
      res.json({
        code: record.code,
        used: record.status === "claimed",
        expired,
        expiresAt: record.expiresAt.toISOString(),
        claimedBy: record.claimedBy,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── POST /api/devices/pair/claim ──
  // Called by the native client with the scanned code + the user's current
  // session token (the one they logged in with on the device). The
  // orchestrator mints a NEW per-device Nextcloud app password, encrypts it,
  // and stores it in DeviceClient. The plaintext is returned once — clients
  // must persist it to their keychain.
  //
  // This route is mounted on the protected router, so the middleware has
  // already validated the caller's token via getUser/getToken.
  router.post("/devices/pair/claim", async (req, res, next) => {
    try {
      const ip = callerIp(req);
      const rl = await rateLimit(`pair:claim:${ip}`, MAX_PAIR_CLAIM_PER_IP_PER_HOUR);
      if (!rl.allowed) {
        res.status(429).json({ error: "Too many claim attempts from this IP" });
        return;
      }

      const schema = z.object({
        code: z.string().min(PAIRING_CODE_LENGTH).max(PAIRING_CODE_LENGTH),
        deviceName: z.string().min(1).max(100).optional(),
        appVersion: z.string().max(64).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid claim request" });
        return;
      }

      // Cheap pre-validation only. The AUTHORITATIVE single-use gate is the
      // conditional updateMany in the transaction below — a status read here is
      // just a fast-path 409/410 to avoid minting a credential for a code that
      // can no longer be claimed.
      const record = await prisma.pairingCode.findUnique({
        where: { code: parsed.data.code },
      });
      if (!record) {
        res.status(404).json({ error: "Unknown pairing code" });
        return;
      }
      if (record.status === "claimed") {
        res.status(409).json({ error: "Pairing code already used" });
        return;
      }
      // Expiry: the explicit status (stamped by the daily sweep) OR the live
      // expiresAt deadline the sweep hasn't caught up with yet.
      if (
        record.status === "expired" ||
        record.expiresAt.getTime() < Date.now()
      ) {
        res.status(410).json({ error: "Pairing code expired" });
        return;
      }
      if (record.status !== "active") {
        // `revoked` (reserved — no writer yet). Defensive: anything not
        // active is not claimable.
        res.status(410).json({ error: "Pairing code no longer valid" });
        return;
      }

      const callerUser = getUser(req);
      if (callerUser !== record.userId) {
        // The user who generated the code must be the same one claiming it.
        // This prevents an attacker who intercepts a code from claiming it
        // as a different user.
        res.status(403).json({ error: "Pairing code owner mismatch" });
        return;
      }

      // Recover the original "I want this as my MacBook" metadata or fall
      // back to whatever the client sent.
      const meta = await cacheGet<{
        deviceName: string;
        deviceType: string;
        platform: string;
      }>(`pair:meta:${parsed.data.code}`);
      const deviceName = meta?.deviceName ?? parsed.data.deviceName ?? "Device";
      const deviceType = meta?.deviceType ?? "desktop";
      const platform = meta?.platform ?? "other";

      // Mint a dedicated Nextcloud app password for this device. Done BEFORE
      // the DB transaction on purpose: it is a slow external call and must not
      // hold an interactive Postgres transaction open. The trade-off is that we
      // may mint a password for a claim that then loses the atomic consume race
      // or fails to persist — both compensated below by deleting it.
      const ncToken = await resolveNcToken(req);
      if (!ncToken) {
        res.status(401).json({
          error: "Nextcloud session unavailable — please log in again",
        });
        return;
      }
      const appPassword = await ncGenerateAppPassword(ncToken);
      if (!appPassword) {
        res.status(502).json({
          error: "Failed to generate device credentials from Nextcloud",
        });
        return;
      }

      const encrypted = encryptSecret(appPassword);

      let client: { id: string };
      try {
        // Atomic single-use consume + create in ONE transaction. The
        // conditional updateMany flips status active→claimed for exactly one
        // racer (Postgres row lock serializes concurrent claimers); the loser
        // gets count===0 and we throw PairingCodeAlreadyClaimedError → 409. The
        // `expiresAt: { gt: now }` predicate also makes expiry authoritative at
        // consume time, closing the sub-second window where a code unexpired at
        // the read above crosses expiresAt before this update runs. If the
        // create throws, the whole transaction rolls back, so the consume is
        // undone and the code stays reusable (no code burned without a
        // credential issued).
        const consumeNow = new Date();
        client = await prisma.$transaction(async (tx) => {
          const consume = await tx.pairingCode.updateMany({
            where: {
              id: record.id,
              status: "active",
              expiresAt: { gt: consumeNow },
            },
            data: { status: "claimed" },
          });
          if (consume.count === 0) {
            throw new PairingCodeAlreadyClaimedError();
          }

          const created = await tx.deviceClient.create({
            data: {
              userId: callerUser,
              deviceName,
              deviceType,
              platform,
              appVersion: parsed.data.appVersion ?? null,
              ncAppPassword: encrypted,
              status: "active",
            },
          });

          await tx.pairingCode.update({
            where: { id: record.id },
            data: { claimedBy: created.id },
          });

          return created;
        });
      } catch (err) {
        // The transaction rolled back (consume undone → code reusable). The
        // Nextcloud app password was minted before the transaction, so
        // compensate by deleting it — otherwise a lost race or a failed
        // persist leaks a live credential.
        try {
          await ncDeleteAppPassword(appPassword);
        } catch (compErr) {
          logger.warn(
            { err: compErr },
            "Failed to compensate (delete) Nextcloud app password after claim rollback",
          );
        }

        if (err instanceof PairingCodeAlreadyClaimedError) {
          res.status(409).json({ error: "Pairing code already used" });
          return;
        }
        throw err;
      }

      await cacheDel(`pair:meta:${parsed.data.code}`);

      safePublish(`droplet/devices/${callerUser}/paired`, {
        deviceId: client.id,
        deviceName,
        platform,
      });

      // WARP-237: pairing mints a Nextcloud app-password — a credential
      // issuance / key operation, mandatory-emit.
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "smartphone",
        what: "Device client paired",
        sub: deviceName ?? null,
        refs: { clientId: client.id },
        actor: actorFromRequest(req),
      });

      const webdavUrl = `${await webdavBaseUrl(req)}/remote.php/dav/files/${callerUser}/`;
      res.json({
        deviceId: client.id,
        ncUsername: callerUser,
        webdavUrl,
        // Plaintext is returned ONCE so the client can persist it to its keychain.
        // Subsequent GETs of /clients never include it.
        appPassword,
      });
    } catch (err) {
      next(err);
    }
  });

  // ── GET /api/devices/clients ──
  // List the caller's own devices. Never returns the encrypted app password.
  router.get("/devices/clients", async (req, res, next) => {
    try {
      const user = getUser(req);
      const rows = await prisma.deviceClient.findMany({
        where: { userId: user },
        orderBy: { createdAt: "desc" },
      });
      res.json({
        clients: rows.map((c) => ({
          id: c.id,
          deviceName: c.deviceName,
          deviceType: c.deviceType,
          platform: c.platform,
          appVersion: c.appVersion,
          lastSeen: c.lastSeen.toISOString(),
          status: c.status,
          createdAt: c.createdAt.toISOString(),
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  // ── DELETE /api/devices/clients/:id ──
  // Revoke a device: decrypt its stored Nextcloud app password, revoke it
  // upstream, and mark the row revoked. Idempotent — revoking an already-
  // revoked device is a no-op. The cleanup itself lives in
  // `revokeDeviceClient` so this session path and the WARP-349 Basic-auth
  // self-revoke path stay behaviorally identical after auth.
  router.delete("/devices/clients/:id", async (req, res, next) => {
    try {
      const user = getUser(req);
      const row = await prisma.deviceClient.findUnique({
        where: { id: req.params.id },
      });
      if (!row || row.userId !== user) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      await revokeDeviceClient(prisma, row);

      // WARP-237: credential revocation — mandatory-emit key operation.
      await recordActivity({
        kind: "auth",
        severity: "warn",
        sourceIcon: "smartphone",
        what: "Device client revoked",
        refs: { clientId: req.params.id },
        actor: actorFromRequest(req),
      });

      res.json({ revoked: row.id });
    } catch (err) {
      next(err);
    }
  });

  // ── Web Push (Phase 7.2 + 7.3) ────────────────────────────────────
  //
  // GET  /api/devices/push/vapid-public-key — returns the b64url
  //   public key the dashboard's serviceWorker.pushManager.subscribe()
  //   needs. Cheap; no auth-sensitive info.
  // POST /api/devices/push/subscribe — body { endpoint, keys: { p256dh,
  //   auth }, deviceClientId? }. Upserts into PushSubscription.
  // DELETE /api/devices/push/subscribe — body { endpoint }. Removes
  //   the row so a notification permission revoke doesn't leave dead
  //   subscriptions piling up.
  // POST /api/devices/push/test — fires a test notification to every
  //   subscription owned by the calling user. Useful for verifying
  //   the service worker is wired up.

  router.get("/devices/push/vapid-public-key", (_req, res) => {
    try {
      res.json({ publicKey: getPublicVapidKey() });
    } catch {
      res.status(503).json({ error: "Push not configured" });
    }
  });

  router.post("/devices/push/subscribe", async (req, res, next) => {
    try {
      const schema = z.object({
        endpoint: z.string().url().max(2048),
        keys: z.object({
          p256dh: z.string().min(20).max(200),
          auth: z.string().min(10).max(100),
        }),
        deviceClientId: z.string().uuid().optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: "Invalid subscription", details: parsed.error.flatten() });
      }
      const userId = getUser(req);

      // Upsert by endpoint so re-subscribing doesn't create duplicates.
      // We trust the keys to be fresh on every subscribe (browsers
      // sometimes rotate them when permission is re-granted).
      const row = await prisma.pushSubscription.upsert({
        where: { endpoint: parsed.data.endpoint },
        create: {
          userId,
          endpoint: parsed.data.endpoint,
          p256dhKey: parsed.data.keys.p256dh,
          authKey: parsed.data.keys.auth,
          deviceClientId: parsed.data.deviceClientId,
        },
        update: {
          userId,
          p256dhKey: parsed.data.keys.p256dh,
          authKey: parsed.data.keys.auth,
          deviceClientId: parsed.data.deviceClientId,
        },
      });
      res.status(201).json({ id: row.id });
    } catch (err) {
      next(err);
    }
  });

  router.delete("/devices/push/subscribe", async (req, res, next) => {
    try {
      const endpoint = String((req.body ?? {}).endpoint ?? "");
      if (!endpoint || endpoint.length > 2048) {
        return res.status(400).json({ error: "endpoint required" });
      }
      const userId = getUser(req);
      // Defensive: only delete the operator's own subscriptions, even
      // if they happened to send someone else's endpoint.
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, userId },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/devices/push/test", async (req, res, next) => {
    try {
      const userId = getUser(req);
      const result = await dispatchToUser(prisma, userId, {
        title: "Droplet test notification",
        body: "If you can read this, push is working.",
        url: "/",
        tag: "droplet-test",
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// ── WARP-349: device self-revoke via HTTP Basic auth ─────────────────────
//
// A mobile client's "Forget this Droplet" must be able to kill its own
// server-side credential without a dashboard session. This router mounts
// BEFORE `authMiddleware` in app.ts (same posture as the SCIM and
// calendar-publish routers: the request carries its own credential) and
// handles DELETE /api/devices/clients/:id ONLY when the request presents
// `Authorization: Basic <ncUsername:appPassword>` and no session cookie.
// Everything else falls through to the auth middleware + the protected
// session-path handler above, unchanged.
//
// The Basic credential is verified against the TARGET row itself: the
// presented username must equal the row's owner and the presented password
// must timing-safe-equal the row's decrypted stored app password. So the
// path can only ever revoke the device whose credentials were presented.
// Every failure — unknown id, revoked row, wrong owner, wrong password,
// malformed header — returns the same 401 body: no existence leak.

/** Uniform Basic-path rejection — identical for every failure mode. */
const BASIC_REVOKE_401 = { error: "Invalid device credentials" } as const;

export function createDeviceSelfRevokeRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.delete("/devices/clients/:id", async (req, res, next) => {
    try {
      // Only engage for a session-less Basic request. A session cookie means
      // an authenticated (or about-to-be-authenticated) operator — defer to
      // the session path so its behavior stays exactly as today. Scheme
      // match is case-insensitive per RFC 7235. The token must start with a
      // non-space: `\s+(.+)` overlaps on whitespace and backtracks
      // quadratically on a long space run (CodeQL js/polynomial-redos).
      const match = /^Basic\s+(\S.*)$/i.exec(req.headers.authorization ?? "");
      if (!match || req.cookies?.[SESSION_COOKIE_NAME]) {
        next();
        return;
      }

      // WARP-1030: this branch is an unauthenticated credential check —
      // in principle an app-password oracle — so brute-force protection
      // sits in front of the verify. Every engaged attempt counts against
      // BOTH buckets, success or failure: per-IP catches one host
      // spraying targets, per-target catches a rotating-IP attacker
      // hammering one device id. Same IP derivation as /pair/claim.
      const ip = callerIp(req);
      const byIp = await rateLimit(
        `revoke:ip:${ip}`,
        MAX_SELF_REVOKE_PER_IP_PER_HOUR,
      );
      const byTarget = await rateLimit(
        `revoke:target:${req.params.id}`,
        MAX_SELF_REVOKE_PER_TARGET_PER_HOUR,
      );
      if (!byIp.allowed || !byTarget.allowed) {
        res.status(429).json({ error: "Too many revoke attempts" });
        return;
      }

      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const sep = decoded.indexOf(":");
      const username = sep > 0 ? decoded.slice(0, sep) : "";
      const password = sep > 0 ? decoded.slice(sep + 1) : "";
      if (!username || !password) {
        res.status(401).json(BASIC_REVOKE_401);
        return;
      }

      const row = await prisma.deviceClient.findUnique({
        where: { id: req.params.id },
      });
      // A revoked row's credential must no longer authenticate anything —
      // including a re-revoke. Same uniform 401 as an unknown id.
      if (!row || row.status === "revoked" || row.userId !== username) {
        res.status(401).json(BASIC_REVOKE_401);
        return;
      }

      let stored: string;
      try {
        stored = decryptSecret(row.ncAppPassword);
      } catch {
        // Undecryptable ciphertext (tamper / key mismatch) — can't verify,
        // so deny like any other credential failure.
        res.status(401).json(BASIC_REVOKE_401);
        return;
      }
      const presented = Buffer.from(password, "utf8");
      const expected = Buffer.from(stored, "utf8");
      if (
        presented.length !== expected.length ||
        !timingSafeEqual(presented, expected)
      ) {
        res.status(401).json(BASIC_REVOKE_401);
        return;
      }

      await revokeDeviceClient(prisma, row);

      // WARP-237: device self-revoke over Basic auth (no operator
      // session) — still a mandatory-emit credential lifecycle event.
      // The actor is the device itself, so `system`.
      await recordActivity({
        kind: "auth",
        severity: "warn",
        sourceIcon: "smartphone",
        what: "Device client revoked",
        refs: { clientId: req.params.id, via: "device-basic-auth" },
        actor: { type: "system", id: null },
      });

      res.json({ revoked: row.id });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

// Suppress "unused" warnings for config import reserved for future guards.
void config;
