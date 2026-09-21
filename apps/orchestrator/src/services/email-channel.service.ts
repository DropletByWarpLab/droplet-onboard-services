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
import { decryptSecret } from "./encryption.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("email-channel");

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
  /**
   * WARP-2957 — bounded dials. nodemailer's defaults are two minutes each,
   * which is how long a relay that silently drops SYNs could hold a request
   * path open (the invite resend route and the settings test both await the
   * dial). A relay that has not greeted in ten seconds is not one an owner
   * should be left waiting on behind a button.
   */
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

/** Milliseconds. See `TransportOptions` — bounded, not nodemailer's 120 s. */
export const TRANSPORT_TIMEOUTS = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

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
    ...TRANSPORT_TIMEOUTS,
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
export interface OutboundEmailMessage {
  to: string;
  from: string;
  subject: string;
  text: string;
  html: string;
}

/** Alias kept for the invite call sites that predate WARP-941. */
export type InviteEmailMessage = OutboundEmailMessage;

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

/** Input to {@link buildShareNotificationEmail}. */
export interface ShareNotificationEmailInput {
  to: string;
  fromAddress: string;
  fromName: string;
  /** Display name of the household member who created the share. */
  sharerDisplayName: string;
  /** Base name of the shared file/folder (no path segments). */
  fileName: string;
}

/**
 * Build the person-share notification email (WARP-941). Deliberately mirrors
 * {@link buildInviteEmail}'s posture: the subject is generic — no file name
 * (content PII) transits relay subject logs — while the body names the sharer
 * and the file so the email is actionable. No link is embedded: the appliance
 * has no single canonical public origin to bake into an email, so the copy
 * directs the recipient to their dashboard's Files → Shared surface instead
 * of risking a dead or wrong-host URL.
 */
export function buildShareNotificationEmail(
  input: ShareNotificationEmailInput,
): OutboundEmailMessage {
  const fromName = input.fromName?.trim() || "Droplet";
  const from = `"${fromName}" <${input.fromAddress}>`;
  const sharer = input.sharerDisplayName?.trim() || "Someone";
  const subject = "A file was shared with you on Droplet";

  const text = [
    `${sharer} shared "${input.fileName}" with you on your household Droplet.`,
    "",
    "Sign in to your Droplet dashboard and open Files → Shared to view it.",
    "",
    "If you weren't expecting this, you can ignore this email.",
  ].join("\n");

  const html = [
    `<p>${escapeHtml(sharer)} shared <strong>&quot;${escapeHtml(input.fileName)}&quot;</strong> with you on your household Droplet.</p>`,
    "<p>Sign in to your Droplet dashboard and open <strong>Files &rarr; Shared</strong> to view it.</p>",
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

/**
 * The slice of a nodemailer transport this service drives. `verify` is what
 * `verifyChannel` calls — it connects, greets, upgrades to TLS and AUTHs, and
 * sends no mail — so a test transport that only stubs `sendMail` is still
 * usable for the send paths.
 */
export type ChannelTransport = Pick<Transporter, "sendMail"> &
  Partial<Pick<Transporter, "verify">>;

/** Overridable seams so tests never dial a real relay. */
export interface SendOptions {
  /** Builds the transport. Defaults to a real nodemailer SMTP transport. */
  transportFactory?: (opts: TransportOptions) => ChannelTransport;
}

/** Outcome of an invite send attempt. */
export interface SendResult {
  status: "sent" | "failed";
  error?: string;
}

function defaultTransportFactory(opts: TransportOptions): ChannelTransport {
  return nodemailer.createTransport(opts);
}

// ── WARP-2957 — verifying the relay ──────────────────────────────────────────
//
// Until this existed the relay was save-only. `EmailChannelSetting.lastTestedAt`
// and `lastError` were in the schema, rendered by the dashboard, and written by
// NOTHING — so an owner who pasted a Gmail App Password was told "Saved" and
// never "connected", and the first evidence the relay was wrong was a failed
// invite days later.

/**
 * Why a relay test failed, as a closed set.
 *
 * 🔴 Closed on purpose. An SMTP server's rejection line is attacker-influenced
 * and routinely names the account ("535 5.7.8 Username and Password not
 * accepted for user@…"), so the server's own words never reach the row or the
 * dashboard. The nodemailer error `code` and the SMTP reply code decide the
 * member; the raw message goes to the log at debug and nowhere else.
 */
export type ChannelVerifyReason =
  | "not_configured"
  | "auth_failed"
  | "unreachable"
  | "tls_failed"
  | "timeout"
  | "unknown";

/** One operator-facing sentence per reason — what `lastError` stores. */
export const CHANNEL_VERIFY_MESSAGES: Record<ChannelVerifyReason, string> = {
  not_configured: "No mail server is configured yet.",
  auth_failed:
    "The mail server rejected the username or password. Gmail and Microsoft 365 need an app password here, not your sign-in password.",
  unreachable: "Couldn't reach the mail server. Check the host name and port.",
  tls_failed:
    "Couldn't start a secure connection. Try TLS on port 465 or STARTTLS on port 587.",
  timeout: "The mail server didn't answer in time.",
  unknown: "The mail server refused the connection.",
};

interface TransportErrorShape {
  code?: unknown;
  responseCode?: unknown;
  message?: unknown;
}

/**
 * Map a nodemailer / socket error onto {@link ChannelVerifyReason}.
 *
 * nodemailer sets `code` to EAUTH for a rejected AUTH, ECONNECTION for a dial
 * that failed (sometimes with the underlying ENOTFOUND / ECONNREFUSED in its
 * place), ETIMEDOUT / ESOCKET for timeouts and socket drops, and leaves
 * `responseCode` carrying the SMTP reply when there was one. A TLS handshake
 * failure arrives as ESOCKET with an OpenSSL message, or as a 5xx to STARTTLS
 * when `requireTLS` found no STARTTLS to require. Order matters: the reply
 * code and EAUTH are checked before the message-sniffing branches, because a
 * 535 line can mention "TLS" in passing.
 */
export function classifyTransportError(err: unknown): ChannelVerifyReason {
  const e = (err ?? {}) as TransportErrorShape;
  const code = typeof e.code === "string" ? e.code : "";
  const reply = typeof e.responseCode === "number" ? e.responseCode : 0;
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";

  if (code === "EAUTH" || reply === 535 || reply === 534) return "auth_failed";
  if (code === "ETIMEDOUT" || message.includes("timeout") || message.includes("timed out")) {
    return "timeout";
  }
  if (
    message.includes("starttls") ||
    message.includes("certificate") ||
    message.includes("ssl") ||
    message.includes("tls") ||
    message.includes("wrong version number")
  ) {
    return "tls_failed";
  }
  if (
    code === "ECONNECTION" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED" ||
    code === "EDNS" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH" ||
    code === "ECONNRESET" ||
    code === "ESOCKET"
  ) {
    return "unreachable";
  }
  return "unknown";
}

/** Outcome of {@link verifyChannel}. Never carries server text. */
export interface ChannelVerifyResult {
  ok: boolean;
  reason?: ChannelVerifyReason;
  /** The sentence written to `lastError` (null on success). */
  error: string | null;
  testedAt: Date;
}

/**
 * Dial the configured relay, greet, upgrade, AUTH — and record the outcome on
 * the singleton row. Sends nothing.
 *
 * Runs regardless of `enabled`: an owner tests a relay BEFORE switching it on,
 * and a disabled-but-broken relay is still worth knowing about. What it does
 * need is a host; without one there is nothing to dial and the row is left
 * alone rather than stamped with a failure for a form nobody has filled in.
 *
 * The password is decrypted in memory for the dial and discarded. Like the
 * send paths, this never throws — the outcome IS the result.
 */
export async function verifyChannel(
  prisma: PrismaClient,
  options: SendOptions = {},
): Promise<ChannelVerifyResult> {
  const factory = options.transportFactory ?? defaultTransportFactory;
  const testedAt = new Date();

  const cfg = await loadChannelConfig(prisma);
  if (!cfg || cfg.host.trim().length === 0) {
    return {
      ok: false,
      reason: "not_configured",
      error: CHANNEL_VERIFY_MESSAGES.not_configured,
      testedAt,
    };
  }

  let reason: ChannelVerifyReason | null = null;
  try {
    let password = "";
    if (cfg.passwordEnc.length > 0) {
      password = decryptSecret(cfg.passwordEnc);
    }
    const transport = factory(buildTransportOptions(cfg, password));
    if (typeof transport.verify !== "function") {
      // A transport with no verify (a send-only stub) cannot be probed. Say
      // so rather than claim success for a dial that never happened.
      throw Object.assign(new Error("transport has no verify()"), { code: "EVERIFY" });
    }
    await transport.verify();
  } catch (err) {
    reason = classifyTransportError(err);
    // The nodemailer code at debug only: an operator tracing a relay wants
    // it; the row and the dashboard get the closed-set sentence.
    logger.debug(
      { reason, code: (err as TransportErrorShape)?.code },
      "outbound email channel verify failed",
    );
  }

  const error = reason ? CHANNEL_VERIFY_MESSAGES[reason] : null;
  await prisma.emailChannelSetting.update({
    where: { id: EMAIL_CHANNEL_SINGLETON_ID },
    data: { lastTestedAt: testedAt, lastError: error },
  });
  logger.info({ ok: reason === null, reason }, "outbound email channel verified");

  return reason ? { ok: false, reason, error, testedAt } : { ok: true, error: null, testedAt };
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

/** Input to {@link sendShareNotificationEmail}. */
export interface SendShareNotificationInput {
  to: string;
  sharerDisplayName: string;
  fileName: string;
}

/**
 * Outcome of a share-notification send attempt. Unlike invites there is no
 * persisted delivery state (WARP-941 keeps the schema untouched), so the
 * outcome is explicit in the return value instead of a row column:
 * `skipped` = channel not configured/enabled (the expected state until the
 * operator wires SMTP — not an error), `failed` = a real attempted-but-errored
 * send.
 */
export type ShareNotificationResult =
  | { status: "sent" }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string };

/**
 * Send a person-share notification email over the operator's SMTP channel
 * (WARP-941). Decoupled from `UserInvite` — no rows are written.
 *
 * Contract (same never-throw posture as {@link sendInviteEmail}):
 *   - channel unconfigured/disabled → `skipped`, no dial. Delivery only
 *     happens when the operator configured AND enabled SMTP
 *     ({@link isChannelReady}) — identical gating to user invites.
 *   - transport/decrypt/config-read failure → `failed`, logged, swallowed.
 *   - NEVER throws: the caller's share already succeeded in Nextcloud and
 *     must not be failed or delayed by mail problems.
 *
 * The SMTP password is decrypted in-memory immediately before the dial and
 * is never persisted in plaintext, returned, or logged. The recipient email
 * is deliberately kept out of log lines.
 */
export async function sendShareNotificationEmail(
  prisma: PrismaClient,
  input: SendShareNotificationInput,
  options: SendOptions = {},
): Promise<ShareNotificationResult> {
  const factory = options.transportFactory ?? defaultTransportFactory;

  try {
    const cfg = await loadChannelConfig(prisma);
    if (!isChannelReady(cfg)) {
      logger.info(
        "Share notification skipped — outbound email channel not configured or disabled",
      );
      return {
        status: "skipped",
        reason: "Outbound email channel is not configured or is disabled.",
      };
    }
    // isChannelReady guarantees cfg is non-null here.
    const config = cfg as EmailChannelConfig;

    // Decrypt the password only if one is set (unauthenticated relays allowed).
    let password = "";
    if (config.passwordEnc.length > 0) {
      password = decryptSecret(config.passwordEnc);
    }

    const transport = factory(buildTransportOptions(config, password));
    const message = buildShareNotificationEmail({
      to: input.to,
      fromAddress: config.fromAddress,
      fromName: config.fromName,
      sharerDisplayName: input.sharerDisplayName,
      fileName: input.fileName,
    });

    await transport.sendMail(message);
    logger.info("Share notification email sent");
    return { status: "sent" };
  } catch (err) {
    // Transport errors AND decrypt/config-read failures land here. The message
    // is operator-facing; it never contains the password (the catch is
    // upstream of any plaintext) nor the recipient address.
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.warn({ err: errMessage }, "Share notification email failed");
    return { status: "failed", error: errMessage };
  }
}
