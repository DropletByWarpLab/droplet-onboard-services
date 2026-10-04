import { Router, Request } from "express";
import { randomInt, timingSafeEqual } from "node:crypto";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { PrismaClient, type DeviceClient } from "@prisma/client";
import { config } from "../config.js";
import {
  ncGenerateAppPassword,
  ncDeleteAppPassword,
} from "../services/nextcloud.client.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { encryptSecret, decryptSecret } from "../services/encryption.service.js";
import { cacheGet, cacheSet, cacheDel } from "../services/cache.service.js";
import {
  revokeDeviceClient,
  safePublish,
} from "../services/device-client-revoke.service.js";
import {
  dispatchToUser,
  getPublicVapidKey,
} from "../services/push-dispatch.service.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { buildPairUrl, servedCertPin } from "../lib/served-cert-pin.js";
import { SESSION_COOKIE_NAME, requireRole } from "../middleware/auth.js";
import { createLogger } from "../lib/logger.js";
import { PushEndpointRejected, vetPushEndpoint } from "../lib/push-endpoint.js";
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
const MAX_PERSONAL_DRIVE_PER_USER_PER_HOUR = 10;
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


function getUser(req: Request): string {
  return req.user?.username || "dev";
}

/**
 * One client row on the wire, for the caller's own list and the owner/admin
 * list alike. NEVER the encrypted app password. `kind` says which flow minted
 * the row — a paired app or a Finder / File Explorer drive login (WARP-3384).
 */
function clientJson(c: DeviceClient) {
  return {
    id: c.id,
    deviceName: c.deviceName,
    deviceType: c.deviceType,
    platform: c.platform,
    appVersion: c.appVersion,
    kind: c.kind,
    lastSeen: c.lastSeen.toISOString(),
    status: c.status,
    createdAt: c.createdAt.toISOString(),
  };
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
 * Mint a dedicated Nextcloud app password for a new device and encrypt it for
 * storage. Shared by pairing claim and the per-user drive login so both mint
 * the same way. `no_session` = the caller's session carries no Nextcloud token
 * (SSO/passkey logins never receive one); `nc_failed` = Nextcloud refused.
 */
async function mintDeviceCredential(
  req: Request,
): Promise<
  | { ok: true; appPassword: string; encrypted: string }
  | { ok: false; reason: "no_session" | "nc_failed" }
> {
  const ncToken = await resolveNcToken(req);
  if (!ncToken) return { ok: false, reason: "no_session" };
  const appPassword = await ncGenerateAppPassword(ncToken);
  if (!appPassword) return { ok: false, reason: "nc_failed" };
  return { ok: true, appPassword, encrypted: encryptSecret(appPassword) };
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
      // WARP-2954 / ADR-058: the link carries the served certificate's key
      // fingerprint (`spki=`), so a native client can pair to THIS box with
      // no public CA and no HQ — the box's own dashboard, shown to a logged-in
      // owner, is the channel that makes the pin an anchor (a LAN host cannot
      // rewrite it). Omitted (same link as before) when the leaf is unreadable.
      // The unauthenticated /api/tls/status deliberately does not carry it.
      const pairUrl = buildPairUrl(server, code, servedCertPin());

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
      const minted = await mintDeviceCredential(req);
      if (!minted.ok) {
        if (minted.reason === "no_session") {
          res.status(401).json({
            error: "File Store session unavailable — please log in again",
          });
        } else {
          res.status(502).json({
            error: "Failed to generate device credentials from the File Store",
          });
        }
        return;
      }
      const { appPassword, encrypted } = minted;

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
              kind: "app_pairing",
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

  // ── POST /api/storage/network-drive/personal ──
  // Per-user Finder / File Explorer drive: mints a Nextcloud app password for
  // THIS user and returns the WebDAV address to map. Nextcloud enforces the
  // user's own My Files / Household / department ACLs, unlike the device-wide
  // SMB share. Owner/admin/family only — guests and `service` principals get
  // no drive — and only while the owner has turned personal drives on
  // (`Workspace.personalDriveEnabled`, default OFF; 403 personal_drive_disabled).
  // The mount talks to Nextcloud directly, so orchestrator-only controls
  // (download audit, per-file upload cap) do not apply — WARP-3318 tracks that
  // unaudited-read trade-off and the credential surface — and the gateway blocks
  // Nextcloud's OCS sharing API on /nextcloud/ so the app password cannot mint
  // shares (docker/nginx/nginx.conf, WARP-3053) — see docs/network-drive.md
  // "Per-user drive (WebDAV)".
  router.post(
    "/storage/network-drive/personal",
    requireRole("owner", "admin", "family"),
    async (req, res, next) => {
      try {
        // Fail closed: no singleton row, or a DB error (-> 500), is "off".
        const workspace = await prisma.workspace.findUnique({
          where: { id: 1 },
          select: { personalDriveEnabled: true },
        });
        if (!workspace?.personalDriveEnabled) {
          res.status(403).json({ error: "personal_drive_disabled" });
          return;
        }

        const parsed = z
          .object({
            platform: z.enum(["macos", "windows"]),
            computerName: z.string().trim().min(1).max(60).optional(),
          })
          .safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid drive request" });
          return;
        }
        const { platform } = parsed.data;

        const user = getUser(req);
        const rl = await rateLimit(
          `drive:personal:${user}`,
          MAX_PERSONAL_DRIVE_PER_USER_PER_HOUR,
        );
        if (!rl.allowed) {
          res.status(429).json({
            error: "Too many drive logins created. Try again in an hour.",
          });
          return;
        }

        const minted = await mintDeviceCredential(req);
        if (!minted.ok) {
          if (minted.reason === "no_session") {
            // SSO/passkey sessions never held a Nextcloud token; only a
            // password sign-in can mint one.
            res.status(409).json({ error: "nc_credential_unavailable" });
          } else {
            res.status(502).json({
              error: "Failed to generate drive credentials from the File Store",
            });
          }
          return;
        }
        const { appPassword, encrypted } = minted;

        const deviceName = `${platform === "macos" ? "Finder" : "File Explorer"} on ${
          parsed.data.computerName ?? (platform === "macos" ? "My Mac" : "My PC")
        }`;
        let client: { id: string };
        try {
          client = await prisma.deviceClient.create({
            data: {
              userId: user,
              deviceName,
              deviceType: "desktop",
              platform,
              ncAppPassword: encrypted,
              status: "active",
              // Explicit discriminator: turning personal drives off revokes
              // exactly these rows (PUT /settings/workspace/personal-drive).
              kind: "personal_drive",
            },
          });
        } catch (err) {
          // Compensate: don't leak a live credential nobody can revoke.
          try {
            await ncDeleteAppPassword(appPassword);
          } catch (compErr) {
            logger.warn(
              { err: compErr },
              "Failed to compensate (delete) Nextcloud app password after drive login persist failure",
            );
          }
          throw err;
        }

        // The owner's switch-off can land between the check above and this row
        // (the mint is a Nextcloud round-trip), after its revoke sweep has
        // already run — leaving a live login while drives read off. Re-read the
        // flag now the row exists; if it is off, revoke this login and never
        // hand back its password. A switch-off after this read is covered by
        // the sweep, which sees the row.
        const stillOn = await prisma.workspace.findUnique({
          where: { id: 1 },
          select: { personalDriveEnabled: true },
        });
        if (!stillOn?.personalDriveEnabled) {
          await revokeDeviceClient(prisma, {
            id: client.id,
            userId: user,
            ncAppPassword: encrypted,
            status: "active",
          });
          res.status(403).json({ error: "personal_drive_disabled" });
          return;
        }

        safePublish(`droplet/devices/${user}/paired`, {
          deviceId: client.id,
          deviceName,
          platform,
        });
        await recordActivity({
          kind: "auth",
          severity: "ok",
          sourceIcon: "hard-drive",
          what: "Personal drive login created",
          sub: deviceName,
          refs: { clientId: client.id },
          actor: actorFromRequest(req),
        });

        const base = new URL(await webdavBaseUrl(req));
        const url = `${base.origin}${base.pathname}/remote.php/dav/files/${encodeURIComponent(user)}/`;
        // Windows WebClient UNC form: \\host@SSL[@port]\path. The uid stays RAW here
        // while webdavUrl percent-encodes it: WebClient URL-encodes UNC components
        // itself, so a pre-encoded `%20` would arrive double-encoded. Safe because
        // Nextcloud uids are limited to [A-Za-z0-9 _.@'-] — never `\`, `/` or `%`.
        const winHost =
          base.port && base.port !== "443"
            ? `${base.hostname}@SSL@${base.port}`
            : `${base.hostname}@SSL`;
        const winPath = `${base.pathname}/remote.php/dav/files/${user}`.replace(/\//g, "\\");
        res.json({
          deviceId: client.id,
          username: user,
          // Plaintext is returned ONCE; revoke via DELETE /api/devices/clients/:id.
          appPassword,
          webdavUrl: url,
          macosUrl: url,
          windowsPath: `\\\\${winHost}${winPath}`,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/devices/clients ──
  // List the caller's own devices. Never returns the encrypted app password.
  router.get("/devices/clients", async (req, res, next) => {
    try {
      const user = getUser(req);
      const rows = await prisma.deviceClient.findMany({
        where: { userId: user },
        orderBy: { createdAt: "desc" },
      });
      res.json({ clients: rows.map(clientJson) });
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

  // ── GET /api/admin/devices/clients?userId= ──
  // WARP-3384: the owner/admin view of a person's paired devices — "which
  // computers hold our files, and did the person who left take one?". One row
  // per client, every status, with the owner's name and whether that person is
  // `active`, `deactivated` or `removed` (a deleted person's rows are kept, so
  // the leaver case still answers). `userId` is the row's owner as the rows name
  // them (the directory username); omitted, it lists every person's clients.
  // Members, external guests and service principals are refused.
  router.get(
    "/admin/devices/clients",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const query = z
          .object({ userId: z.string().min(1).max(256).optional() })
          .safeParse(req.query);
        if (!query.success) {
          res.status(400).json({ error: "Invalid userId" });
          return;
        }
        const rows = await prisma.deviceClient.findMany({
          where: query.data.userId ? { userId: query.data.userId } : {},
          orderBy: { createdAt: "desc" },
        });
        const owners = await prisma.user.findMany({
          where: { username: { in: [...new Set(rows.map((c) => c.userId))] } },
          select: { username: true, displayName: true, directoryStatus: true },
        });
        const byUsername = new Map(owners.map((o) => [o.username, o]));
        res.json({
          clients: rows.map((c) => {
            const owner = byUsername.get(c.userId);
            return {
              ...clientJson(c),
              userId: c.userId,
              displayName: owner?.displayName ?? c.userId,
              personStatus: !owner
                ? "removed"
                : owner.directoryStatus === "ACTIVE"
                  ? "active"
                  : "deactivated",
            };
          }),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── DELETE /api/admin/devices/clients/:id ──
  // WARP-3384: an owner/admin revokes ANOTHER person's client. Same revoke path
  // as the person's own DELETE, but the audit row names the actor AND the
  // person, and the answer says whether Nextcloud confirmed deleting the app
  // password (WARP-3383): `appPasswordDeleted: false` means the row is marked
  // revoked but the device may still sync — never reported as a clean success.
  // `null` = it was already revoked, nothing was attempted. Idempotent.
  router.delete(
    "/admin/devices/clients/:id",
    requireRole("owner", "admin"),
    async (req, res, next) => {
      try {
        const row = await prisma.deviceClient.findUnique({
          where: { id: req.params.id },
        });
        if (!row) {
          res.status(404).json({ error: "Device not found" });
          return;
        }

        const outcome = await revokeDeviceClient(prisma, row);
        if (outcome === "already_revoked") {
          res.json({ revoked: row.id, appPasswordDeleted: null });
          return;
        }

        const deleted = outcome === "deleted";
        // WARP-237: credential revocation — mandatory-emit key operation.
        await recordActivity({
          kind: "auth",
          severity: deleted ? "warn" : "err",
          sourceIcon: "smartphone",
          what: deleted
            ? "Device client revoked by an admin"
            : "Device client revoked by an admin, but its app password may still work",
          sub: `${row.deviceName} · ${row.userId}`,
          refs: {
            clientId: row.id,
            kind: row.kind,
            targetUsername: row.userId,
            actor: req.user?.username ?? null,
            appPasswordDeleted: deleted,
            via: "admin",
          },
          actor: actorFromRequest(req),
        });

        res.json({
          revoked: row.id,
          appPasswordDeleted: deleted,
          ...(deleted
            ? {}
            : {
                warning:
                  "The device is marked revoked, but Nextcloud did not confirm deleting its file-sync password, so it may still be able to sync.",
              }),
        });
      } catch (err) {
        next(err);
      }
    },
  );

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
      // WARP-2904: the orchestrator will POST to this URL, so it is an SSRF
      // primitive before it is egress. vetPushEndpoint requires https on the
      // default port with no userinfo, a plain host that both URL parsers
      // agree on (web-push dials the LEGACY parser's host), and a real push
      // service host. dispatchToUser re-runs the check at dial time and adds
      // a DNS check. The error names the rule, never the endpoint.
      try {
        vetPushEndpoint(parsed.data.endpoint);
      } catch (err) {
        if (err instanceof PushEndpointRejected) {
          // `blocked_destination` is the WARP-2022 registration error for a
          // refused destination; https_required keeps its own self-describing
          // code. `reason` names which rule refused it.
          return res.status(400).json({
            error: err.reason === "https_required" ? "https_required" : "blocked_destination",
            reason: err.reason,
          });
        }
        throw err;
      }
      // WARP-2911 — PushSubscription is keyed by USERNAME, the key
      // sendNotification dispatches on.
      const username = getUser(req);

      // Upsert by endpoint so re-subscribing doesn't create duplicates.
      // We trust the keys to be fresh on every subscribe (browsers
      // sometimes rotate them when permission is re-granted).
      const row = await prisma.pushSubscription.upsert({
        where: { endpoint: parsed.data.endpoint },
        create: {
          username,
          endpoint: parsed.data.endpoint,
          p256dhKey: parsed.data.keys.p256dh,
          authKey: parsed.data.keys.auth,
          deviceClientId: parsed.data.deviceClientId,
        },
        update: {
          username,
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
      const username = getUser(req);
      // Defensive: only delete the operator's own subscriptions, even
      // if they happened to send someone else's endpoint.
      await prisma.pushSubscription.deleteMany({
        where: { endpoint, username },
      });
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post("/devices/push/test", async (req, res, next) => {
    try {
      const username = getUser(req);
      const result = await dispatchToUser(prisma, username, {
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
