/**
 * BUG-11 — SMTP outbound-channel config surface + failed-invite retry.
 *
 * Routes owned by this file:
 *   GET   /api/settings/email                 — owner+admin+family read. Returns
 *                                               the REDACTED config (the
 *                                               password is reduced to a
 *                                               `hasPassword` boolean — rule 19).
 *   PUT   /api/settings/email                 — owner+admin only. Upserts the
 *                                               EmailChannelSetting singleton.
 *                                               `password` is WRITE-ONLY: omit
 *                                               to keep the existing one, send
 *                                               "" to clear it. The plaintext is
 *                                               aes-256-gcm encrypted at rest via
 *                                               encryption.service and never
 *                                               echoed back or logged.
 *   POST  /api/people/invites/:id/resend       — owner+admin only. Re-sends a
 *                                               pending/failed invite's email.
 *                                               A transport failure surfaces as
 *                                               `sendStatus: "failed"` with HTTP
 *                                               200 — the retry never 500s.
 *
 * Dependencies (do NOT re-implement):
 *   - `requireRole(...roles)`         — src/middleware/auth.ts.
 *   - `recordActivity({ kind, ... })` — src/services/activity.singleton.ts.
 *   - `encryptSecret` / `decryptSecret` — src/services/encryption.service.ts.
 *   - the mailer                       — src/services/email-channel.service.ts.
 *
 * `.env` continues to own infra secrets (DATABASE_URL, the DEVICE_SECRET_KEY
 * that this channel's password encryption is keyed on, etc.); the operator's
 * SMTP credentials are additive runtime config the household edits here.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { encryptSecret } from "../services/encryption.service.js";
import {
  EMAIL_CHANNEL_SINGLETON_ID,
  loadChannelConfig,
  redactChannelConfig,
  sendInviteEmail,
  type EmailChannelConfig,
  type RedactedEmailChannelConfig,
  type SendOptions,
} from "../services/email-channel.service.js";
import { isExpired } from "../services/invite.service.js";
import { buildInviteUrl } from "../lib/invite-url.js";

const logger = pino({ name: "settings-email-route" });

const SECURITY_VALUES = ["starttls", "tls", "none"] as const;

// `password` is OPTIONAL on purpose — its presence/absence is meaningful:
//   - omitted  → keep the stored password (write-only field, never round-trips)
//   - ""       → clear the stored password (unauthenticated relay)
//   - "secret" → set a new password (encrypted at rest before persist)
const putSchema = z.object({
  enabled: z.boolean(),
  host: z.string().max(255).optional().default(""),
  port: z.coerce.number().int().min(1).max(65535).optional().default(587),
  username: z.string().max(320).optional().default(""),
  password: z.string().max(1024).optional(),
  // A from-address is required whenever the channel is enabled; we validate
  // shape here and the cross-field rule (enabled ⇒ non-empty) below.
  fromAddress: z.union([z.string().email().max(254), z.literal("")]).optional().default(""),
  fromName: z.string().max(128).optional().default("Droplet"),
  security: z.enum(SECURITY_VALUES).optional().default("starttls"),
});

/** The default redacted view when no row exists yet (channel never configured). */
function emptyRedacted(): RedactedEmailChannelConfig {
  return {
    enabled: false,
    host: "",
    port: 587,
    username: "",
    fromAddress: "",
    fromName: "Droplet",
    security: "starttls",
    hasPassword: false,
    lastError: null,
    lastTestedAt: null,
    updatedAt: null,
    updatedBy: null,
  };
}

export function createSettingsEmailRouter(
  prisma: PrismaClient,
  sendOptions: SendOptions = {},
): Router {
  const router = Router();

  // ── GET /api/settings/email ─────────────────────────────────
  // Reads open to owner+admin+family (config, not a secret — and the password
  // is redacted out). guests are 403'd, matching the settings.ts posture.
  router.get(
    "/settings/email",
    requireRole("owner", "admin", "family"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const cfg = await loadChannelConfig(prisma);
        res.json(cfg ? redactChannelConfig(cfg) : emptyRedacted());
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /api/settings/email ─────────────────────────────────
  // owner+admin only. Upserts the singleton. The password is write-only.
  router.put(
    "/settings/email",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = putSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({
            error: "Invalid email channel config",
            details: parsed.error.flatten(),
          });
        }
        const data = parsed.data;

        // Cross-field rule: an enabled channel must have a host + from-address
        // or it can never send. Reject loud rather than persisting a config
        // that silently no-ops at send time.
        if (data.enabled && (data.host.trim() === "" || data.fromAddress.trim() === "")) {
          return res.status(400).json({
            error: "An enabled channel requires both `host` and `fromAddress`.",
            code: "EMAIL_CHANNEL_INCOMPLETE",
          });
        }

        const existing = await loadChannelConfig(prisma);
        const actor = req.user?.username ?? null;

        // Resolve the at-rest password blob. Write-only semantics:
        //   - password omitted  → reuse existing blob (or "" if no row).
        //   - password === ""    → clear it.
        //   - password set       → encrypt it now (plaintext never persisted).
        let passwordEnc: string;
        if (data.password === undefined) {
          passwordEnc = existing?.passwordEnc ?? "";
        } else if (data.password === "") {
          passwordEnc = "";
        } else {
          passwordEnc = encryptSecret(data.password);
        }

        const writeFields = {
          enabled: data.enabled,
          host: data.host,
          port: data.port,
          username: data.username,
          passwordEnc,
          fromAddress: data.fromAddress,
          fromName: data.fromName,
          security: data.security,
          updatedBy: actor,
        };

        const saved = (await prisma.emailChannelSetting.upsert({
          where: { id: EMAIL_CHANNEL_SINGLETON_ID },
          create: { id: EMAIL_CHANNEL_SINGLETON_ID, ...writeFields },
          update: writeFields,
        })) as unknown as EmailChannelConfig;

        // Audit WHO changed the channel + the non-secret fields. NEVER the
        // password (it's a credential; the audit row is not where it lives).
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "mail",
          what: "Outbound email channel updated",
          sub: data.enabled ? `${data.host}:${data.port}` : "disabled",
          refs: {
            actor,
            enabled: data.enabled,
            host: data.host,
            port: data.port,
            security: data.security,
            fromAddress: data.fromAddress,
            // explicitly record only WHETHER a password is set, not the value
            hasPassword: passwordEnc.length > 0,
          },
        });

        res.json(redactChannelConfig(saved));
      } catch (err) {
        logger.warn({ err }, "PUT /settings/email failed");
        next(err);
      }
    },
  );

  // ── POST /api/people/invites/:id/resend ─────────────────────
  // owner+admin only — re-driving a delivery is an administrative action, same
  // guard as the rest of the invite surface. Re-sends the accept-link email for
  // a pending/failed invite. A transport failure is surfaced as
  // `sendStatus: "failed"` with HTTP 200 — the retry must never 500.
  router.post(
    "/people/invites/:id/resend",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const invite = (await prisma.userInvite.findUnique({
          where: { id: req.params.id },
        })) as unknown as
          | {
              id: string;
              token: string;
              email: string | null;
              role: string;
              acceptedAt: Date | null;
              revokedAt: Date | null;
              expiresAt: Date;
            }
          | null;

        if (!invite) {
          return res.status(404).json({ error: "Invite not found" });
        }
        if (invite.acceptedAt) {
          return res.status(409).json({
            error: "Invite already accepted",
            code: "INVITE_ALREADY_ACCEPTED",
          });
        }
        if (invite.revokedAt) {
          return res.status(409).json({
            error: "Invite has been revoked",
            code: "INVITE_REVOKED",
          });
        }
        // Don't re-send an accept link that will 410 the instant it's clicked —
        // mirror the accept route's expiry guard (auth.ts → isExpired). (onboard#486)
        if (isExpired(invite)) {
          return res.status(410).json({
            error: "Invite has expired",
            code: "INVITE_EXPIRED",
          });
        }
        if (!invite.email) {
          return res.status(409).json({
            error: "Invite has no email address to send to",
            code: "INVITE_NO_EMAIL",
          });
        }

        const acceptUrl = await buildInviteUrl(req, invite.token);
        const result = await sendInviteEmail(
          prisma,
          {
            inviteId: invite.id,
            to: invite.email,
            acceptUrl,
            role: invite.role,
          },
          sendOptions,
        );

        await recordActivity({
          kind: "auth",
          severity: result.status === "sent" ? "ok" : "warn",
          sourceIcon: "mail",
          what:
            result.status === "sent"
              ? "Invite email re-sent"
              : "Invite email re-send failed",
          sub: invite.email,
          refs: {
            actor: req.user?.username ?? null,
            email: invite.email,
            sendStatus: result.status,
          },
        });

        // 200 regardless of send outcome: the retry SUCCEEDED as an operation
        // (we attempted + recorded a durable state). The body carries the
        // explicit outcome so the dashboard can re-render the row.
        res.json({
          id: invite.id,
          sendStatus: result.status,
          ...(result.error ? { error: result.error } : {}),
        });
      } catch (err) {
        logger.warn({ err, id: req.params.id }, "POST invite resend failed");
        next(err);
      }
    },
  );

  return router;
}

// The invite-accept URL is built by the shared, host-validated `buildInviteUrl`
// in lib/invite-url.ts (PR #486 review finding 2). The old local
// `buildInviteAcceptUrl` trusted `x-forwarded-host` blindly, embedding an
// unvalidated host into a token-bearing email link — a token-exfiltration
// vector. All three invite-send paths now route through the one validated helper.
