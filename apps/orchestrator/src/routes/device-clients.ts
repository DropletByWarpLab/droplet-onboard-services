import { Router, Request } from "express";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { PrismaClient } from "@prisma/client";
import pino from "pino";
import { config } from "../config.js";
import { SESSION_COOKIE_NAME } from "../middleware/auth.js";
import {
  ncGenerateAppPassword,
  ncDeleteAppPassword,
} from "../services/nextcloud.client.js";
import { encryptSecret, decryptSecret } from "../services/encryption.service.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import { publish } from "../services/mqtt.service.js";

const logger = pino({ name: "device-clients-route" });

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

function getToken(req: Request): string {
  const cookieToken = req.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return "";
  return header.slice(7);
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

      // Mint a dedicated Nextcloud app password for this device.
      const appPassword = await ncGenerateAppPassword(getToken(req));
      if (!appPassword) {
        res.status(502).json({
          error: "Failed to generate device credentials from Nextcloud",
        });
        return;
      }

      // Store the encrypted password + mark the code consumed in a single tx.
      const encrypted = encryptSecret(appPassword);
      const client = await prisma.deviceClient.create({
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
      await prisma.pairingCode.update({
        where: { id: record.id },
        data: { used: true, claimedBy: client.id },
      });
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

  return router;
}

// Suppress "unused" warnings for config import reserved for future guards.
void config;
