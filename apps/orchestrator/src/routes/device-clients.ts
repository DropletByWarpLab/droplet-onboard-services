import { Router, Request } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
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

const logger = pino({ name: "device-clients-route" });

/**
 * Thrown inside the claim transaction when the atomic conditional consume
 * (`updateMany WHERE used=false`) flips zero rows — i.e. another request
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
const RATE_LIMIT_WINDOW_SEC = 3600;
const MAX_PAIR_CREATE_PER_USER_PER_HOUR = 5;
const MAX_PAIR_CLAIM_PER_IP_PER_HOUR = 20;

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
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    out += PAIRING_CODE_ALPHABET[bytes[i] % PAIRING_CODE_ALPHABET.length];
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
 * Return the external URL clients should reach for WebDAV. The orchestrator
 * lives behind Nginx which proxies /nextcloud/ to the Nextcloud container,
 * so clients talk to https://<droplet>/nextcloud/ and append /remote.php/dav/.
 */
function webdavBaseUrl(req: Request): string {
  const proto = (req.headers["x-forwarded-proto"] as string) ?? "https";
  const host = (req.headers["x-forwarded-host"] as string) ?? req.headers.host ?? "droplet.local";
  return `${proto}://${host}/nextcloud`;
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

      const code = generatePairingCode();
      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);

      await prisma.pairingCode.create({
        data: { code, userId: user, expiresAt },
      });

      const server = webdavBaseUrl(req).replace(/\/nextcloud$/, "");
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
      const expired = record.expiresAt.getTime() < Date.now();
      res.json({
        code: record.code,
        used: record.used,
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
      const ip = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
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
      // conditional updateMany in the transaction below — a `used` read here is
      // just a fast-path 409 to avoid minting a credential for an already-
      // consumed code.
      const record = await prisma.pairingCode.findUnique({
        where: { code: parsed.data.code },
      });
      if (!record) {
        res.status(404).json({ error: "Unknown pairing code" });
        return;
      }
      if (record.used) {
        res.status(409).json({ error: "Pairing code already used" });
        return;
      }
      if (record.expiresAt.getTime() < Date.now()) {
        res.status(410).json({ error: "Pairing code expired" });
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
        // conditional updateMany flips used=false→true for exactly one racer
        // (Postgres row lock serializes concurrent claimers); the loser gets
        // count===0 and we throw PairingCodeAlreadyClaimedError → 409. The
        // `expiresAt: { gt: now }` predicate also makes expiry authoritative at
        // consume time, closing the sub-second window where a code unexpired at
        // the read above crosses expiresAt before this update runs. If the
        // create throws, the whole transaction rolls back, so the consume is
        // undone and the code stays reusable (no code burned without a
        // credential issued).
        const consumeNow = new Date();
        client = await prisma.$transaction(async (tx) => {
          const consume = await tx.pairingCode.updateMany({
            where: { id: record.id, used: false, expiresAt: { gt: consumeNow } },
            data: { used: true },
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

      const webdavUrl = `${webdavBaseUrl(req)}/remote.php/dav/files/${callerUser}/`;
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
  // revoked device is a no-op.
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

      if (row.status !== "revoked") {
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

        safePublish(`droplet/devices/${user}/revoked`, { deviceId: row.id });
      }

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

// Suppress "unused" warnings for config import reserved for future guards.
void config;
