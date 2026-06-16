/**
 * BUG-11 — outbound SMTP invite-email channel.
 *
 * The appliance is a self-hosted box: it never runs its own MTA. The owner
 * supplies their mail provider's SMTP relay (a Gmail app-password, Fastmail, a
 * corporate Postfix, …) and this service drives it. Config is persisted in the
 * `EmailChannelSetting` singleton row; the SMTP password is encrypted at rest
 * with aes-256-gcm via `encryption.service` (the same DEVICE_SECRET_KEY-backed
 * primitive that protects per-device Nextcloud app passwords) and is NEVER
 * returned by the settings API nor logged (CLAUDE.md rule 19).
 *
 * Issuing an invite WRITES the `UserInvite` row; delivering the accept-link
 * email is a SEPARATE, fallible step. Per the no-guessing rule the delivery
 * outcome is an explicit `InviteSendStatus` enum column — `pending → sent` on
 * success, `pending → failed` on any transport error. A send failure NEVER
 * throws out of the request path and NEVER rolls back the invite (the row is
 * still valid; the dashboard surfaces `failed` with a Retry affordance).
 *
 * The transport is INJECTABLE (`SendOptions.transportFactory`) so unit tests
 * drive a nodemailer stub transport and never dial a real relay.
 */
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import type { PrismaClient } from "@prisma/client";
import pino from "pino";
import { decryptSecret } from "./encryption.service.js";

const logger = pino({ name: "email-channel" });

/** The single config row's pinned primary key (this is a singleton table). */
export const EMAIL_CHANNEL_SINGLETON_ID = "singleton";

/** SMTP transport security mode. Mirrors the Prisma `EmailChannelSecurity`. */
export type EmailChannelSecurity = "starttls" | "tls" | "none";

/** The persisted SMTP channel config (shape of the EmailChannelSetting row). */
export interface EmailChannelConfig {
  id: string;
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  /** aes-256-gcm blob; empty string = no password set. NEVER returned by API. */
  passwordEnc: string;
  fromAddress: string;
  fromName: string;
  security: EmailChannelSecurity;
  lastError: string | null;
  lastTestedAt: Date | null;
  updatedAt: Date;
  updatedBy: string | null;
}

/**
 * The API-safe projection of the config — what GET /api/settings/email returns.
 * The password is reduced to a boolean; no secret material is present.
 */
export interface RedactedEmailChannelConfig {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  fromAddress: string;
  fromName: string;
  security: EmailChannelSecurity;
  hasPassword: boolean;
  lastError: string | null;
  lastTestedAt: Date | null;
  updatedAt: Date | null;
  updatedBy: string | null;
}

/** Thrown when a send is requested but no usable SMTP channel is configured. */
export class EmailChannelNotConfiguredError extends Error {
  public readonly code = "EMAIL_CHANNEL_NOT_CONFIGURED";
  constructor(message = "Outbound email channel is not configured or is disabled.") {
    super(message);
    this.name = "EmailChannelNotConfiguredError";
  }
}

/**
 * Project the stored config into the API-safe view. The password is reduced to
 * a `hasPassword` boolean and the encrypted blob is dropped entirely — there is
 * no code path that emits `passwordEnc` to a client or a log line.
 */
export function redactChannelConfig(
  cfg: EmailChannelConfig,
): RedactedEmailChannelConfig {
  return {
    enabled: cfg.enabled,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    fromAddress: cfg.fromAddress,
    fromName: cfg.fromName,
    security: cfg.security,
    hasPassword: cfg.passwordEnc.length > 0,
    lastError: cfg.lastError,
    lastTestedAt: cfg.lastTestedAt,
    updatedAt: cfg.updatedAt ?? null,
    updatedBy: cfg.updatedBy,
  };
}

/** nodemailer transport options we derive from the config. */
export interface TransportOptions {
  host: string;
  port: number;
  /** Implicit TLS from connect (port 465). starttls/none → false. */
  secure: boolean;
  /**
   * Enforce STARTTLS upgrade before AUTH for `starttls` mode. When true,
   * nodemailer fails the send if the server does not offer STARTTLS instead of
   * silently falling back to plaintext — so a configured "STARTTLS" relay can
   * never leak SMTP-AUTH credentials in cleartext (incl. against a STARTTLS-strip
   * MITM). Omitted for `tls` (already implicit-TLS) and `none` (explicit plaintext).
   */
  requireTLS?: boolean;
  auth?: { user: string; pass: string };
}

/**
 * Derive nodemailer transport options from the config + the already-decrypted
 * password. `tls` mode is implicit-TLS (secure:true); `starttls` connects on the
 * submission port and is upgraded via an ENFORCED STARTTLS (requireTLS:true) so
 * AUTH is never sent in cleartext; `none` is explicit plaintext (LAN relay only).
 * Auth is omitted entirely for an unauthenticated relay (no username) so we don't
 * send an empty AUTH command a LAN Postfix may reject.
 */
export function buildTransportOptions(
  cfg: EmailChannelConfig,
  password: string,
): TransportOptions {
  const opts: TransportOptions = {
    host: cfg.host,
    port: cfg.port,
    secure: cfg.security === "tls",
  };
  // Enforce STARTTLS for `starttls` mode so SMTP-AUTH is never sent in cleartext
  // if the server doesn't advertise STARTTLS (or a MITM strips it). `none` stays
  // explicit-plaintext; `tls` is already implicit-TLS.
  if (cfg.security === "starttls") {
    opts.requireTLS = true;
  }
  if (cfg.username.length > 0) {
    opts.auth = { user: cfg.username, pass: password };
  }
  return opts;
}

/** Input to {@link buildInviteEmail}. */
export interface InviteEmailInput {
  to: string;
  fromAddress: string;
  fromName: string;
  acceptUrl: string;
  role: string;
}

/** A fully-formed message ready to hand to a nodemailer transport. */
export interface InviteEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** Escape the five HTML-significant characters so the URL is safe in markup. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build the invite email. The accept LINK (not a bare token presented as a
 * credential) goes into both the plaintext and HTML parts; the HTML part wraps
 * it in a clickable anchor. The subject is intentionally generic ("You've been
 * invited to Droplet") — no token, no PII beyond the addressee.
 */
export function buildInviteEmail(input: InviteEmailInput): InviteEmailMessage {
  const fromName = input.fromName?.trim() || "Droplet";
  const from = `"${fromName}" <${input.fromAddress}>`;
  const subject = "You've been invited to Droplet";
  const safeUrl = escapeHtml(input.acceptUrl);

  const text = [
    "You've been invited to join a Droplet household.",
    "",
    "Open this link to accept the invitation and set up your account:",
    input.acceptUrl,
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  const html = [
    "<p>You've been invited to join a Droplet household.</p>",
    `<p><a href="${safeUrl}">Accept your invitation</a> and set up your account.</p>`,
    `<p>Or paste this link into your browser:<br><span>${safeUrl}</span></p>`,
    "<p>If you weren't expecting this, you can ignore this email.</p>",
  ].join("\n");

  return { to: input.to, from, subject, text, html };
}

/**
 * Is this config usable for a send? Requires enabled + a host + a from-address.
 * A null config (no row) is never ready. Port/username are not required (a LAN
 * relay may be unauthenticated; the port has a default).
 */
export function isChannelReady(cfg: EmailChannelConfig | null): boolean {
  if (!cfg) return false;
  return cfg.enabled && cfg.host.trim().length > 0 && cfg.fromAddress.trim().length > 0;
}

/** Load the singleton channel config, or null when the row is absent. */
export async function loadChannelConfig(
  prisma: PrismaClient,
): Promise<EmailChannelConfig | null> {
  const row = (await prisma.emailChannelSetting.findUnique({
    where: { id: EMAIL_CHANNEL_SINGLETON_ID },
  })) as unknown as EmailChannelConfig | null;
  return row;
}

/** Input to {@link sendInviteEmail}. */
export interface SendInviteInput {
  inviteId: string;
  to: string;
  acceptUrl: string;
  role: string;
}

/** Overridable seams so tests never dial a real relay. */
export interface SendOptions {
  /** Builds the transport. Defaults to a real nodemailer SMTP transport. */
  transportFactory?: (opts: TransportOptions) => Pick<Transporter, "sendMail">;
}

/** Outcome of an invite send attempt. */
export interface SendResult {
  status: "sent" | "failed";
  error?: string;
}

function defaultTransportFactory(
  opts: TransportOptions,
): Pick<Transporter, "sendMail"> {
  return nodemailer.createTransport(opts);
}

/**
 * Send the invite email and reflect the outcome on the `UserInvite` row.
 *
 * Contract:
 *   - On success: `sendStatus = sent`, `sentAt = now`, `sendError = null`,
 *     `sendAttempts += 1`.
 *   - On ANY failure (channel not ready, decrypt failure, transport error):
 *     `sendStatus = failed`, `sendError = <message>`, `sendAttempts += 1`.
 *   - NEVER throws. The caller's request path must stay alive regardless; the
 *     failed state is the durable, retryable signal.
 *
 * The SMTP password is decrypted in-memory immediately before the dial and is
 * never persisted in plaintext, returned, or logged.
 */
export async function sendInviteEmail(
  prisma: PrismaClient,
  input: SendInviteInput,
  options: SendOptions = {},
): Promise<SendResult> {
  const factory = options.transportFactory ?? defaultTransportFactory;

  try {
    const cfg = await loadChannelConfig(prisma);
    if (!isChannelReady(cfg)) {
      return await markFailed(
        prisma,
        input.inviteId,
        "Outbound email channel is not configured or is disabled.",
      );
    }
    // isChannelReady guarantees cfg is non-null here.
    const config = cfg as EmailChannelConfig;

    // Decrypt the password only if one is set (unauthenticated relays allowed).
    let password = "";
    if (config.passwordEnc.length > 0) {
      password = decryptSecret(config.passwordEnc);
    }

    const transport = factory(buildTransportOptions(config, password));
    const message = buildInviteEmail({
      to: input.to,
      fromAddress: config.fromAddress,
      fromName: config.fromName,
      acceptUrl: input.acceptUrl,
      role: input.role,
    });

    await transport.sendMail(message);

    const updated = (await prisma.userInvite.update({
      where: { id: input.inviteId },
      data: {
        sendStatus: "sent",
        sentAt: new Date(),
        sendError: null,
        sendAttempts: { increment: 1 },
      },
    })) as unknown as { sendStatus: "sent" };
    logger.info({ inviteId: input.inviteId }, "Invite email sent");
    return { status: updated.sendStatus };
  } catch (err) {
    // Includes transport errors AND decrypt failures. The message is
    // operator-facing; it never contains the password (the catch is upstream
    // of any plaintext) and never the token (we email a URL, not the token in
    // isolation, and we don't echo the URL into the error).
    const errMessage = err instanceof Error ? err.message : String(err);
    return await markFailed(prisma, input.inviteId, errMessage);
  }
}

/** Flip the invite to `failed` with the given operator-facing error string. */
async function markFailed(
  prisma: PrismaClient,
  inviteId: string,
  errMessage: string,
): Promise<SendResult> {
  try {
    await prisma.userInvite.update({
      where: { id: inviteId },
      data: {
        sendStatus: "failed",
        sendError: errMessage.slice(0, 1024),
        sendAttempts: { increment: 1 },
      },
    });
  } catch (updateErr) {
    // The row update itself failed (e.g. invite deleted mid-flight). Log and
    // swallow — we still must not throw into the request path.
    logger.warn(
      { inviteId, err: updateErr instanceof Error ? updateErr.message : updateErr },
      "could not persist invite send-failure state",
    );
  }
  logger.warn({ inviteId }, "Invite email send failed");
  return { status: "failed", error: errMessage };
}
