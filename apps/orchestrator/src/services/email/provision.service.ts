/**
 * WARP-2734 — connecting a mailbox.
 *
 * Until this existed, **nothing anywhere created an `EmailAccount` row.**
 * `git grep emailAccount.create` over every branch returned nothing: no route,
 * no form, no seed, no script. `services/email-indexer/README.md` told the
 * operator to "add an EmailAccount via the dashboard", and that had never been
 * true. The only account that has ever existed anywhere was a hand-written SQL
 * INSERT carrying a Fernet ciphertext somebody produced out of band — and they
 * could only have done that by hand, because `creds.py` could DECRYPT and
 * nothing in the repo could encrypt.
 *
 * So every downstream email feature was dead on every customer box: the five
 * `email_*` tools returned nothing, `/email` had no data, and ADR-048's email
 * arm had no substrate.
 *
 * ── Who holds what ─────────────────────────────────────────────────────────
 *
 * The `email-indexer` service owns the Fernet key (`/data/secrets/email.key`)
 * and the IMAP client. This orchestrator owns the `EmailAccount` row.
 *
 * 🔴 The key is deliberately NOT mounted here. `test-security.sh` would permit
 * it — its Test 19 bans the bare `../data/secrets:` root and explicitly allows
 * single-file key binds — so this is a design call rather than a rule: putting
 * a new secret and a hand-rolled Fernet encoder into the process that already
 * holds the Prisma pool and every other credential widens the blast radius of
 * that one process to save a hop inside a mesh that already has mTLS.
 *
 * ── The password's whole life ──────────────────────────────────────────────
 *
 * It is typed by the owner, arrives in one request body, crosses one internal
 * hop, and is gone. It is never logged (the route's zod failure path emits
 * FIELD PATHS only), never returned in any response, never stored in plaintext,
 * and never read back — there is no endpoint that reveals it, by construction
 * rather than by omission.
 */
import type { PrismaClient } from "@prisma/client";

import { config } from "../../config.js";
import { createLogger } from "../../lib/logger.js";
import { internalBaseUrl } from "../../lib/internal-tls.js";
import {
  assertOutboundDestinationAllowed,
  isOutboundUrlBlocked,
} from "../../lib/outbound-url-guard.js";

const logger = createLogger("email-provision");

export const PROVISION_ERRORS = {
  /** The host resolves somewhere this box must not dial. */
  BLOCKED_HOST: "email_host_not_allowed",
  /** The mailbox refused the credential, or could not be reached. */
  MAILBOX_REFUSED: "email_mailbox_refused",
  /** The email-indexer is not running — the box has no `email` profile. */
  INDEXER_UNAVAILABLE: "email_indexer_unavailable",
  /** An account already exists for this address. */
  DUPLICATE_ADDRESS: "email_address_already_connected",
} as const;

export interface ConnectMailboxInput {
  displayName: string;
  address: string;
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  username: string;
  password: string;
}

/**
 * 🔴 SSRF. This is the first surface on this box where a signed-in admin types
 * a hostname that a container inside the trust boundary then dials.
 *
 * `docs/security/allowed-egress.yaml` carries `user-mail-servers` as
 * `kind: dynamic` with no code guard, unlike its sibling
 * `user-calendar-servers`, whose entry says outright "THE ENFORCEMENT IS IN
 * CODE (WARP-2022)". This closes that gap for mail, using the same module and
 * the same failure vocabulary the calendar path uses.
 *
 * Both hosts are checked, not just IMAP: SMTP is dialled by the outbound
 * poller on a schedule, so a hostile smtpHost is a slower version of the same
 * hole. `assertOutboundDestinationAllowed` RESOLVES the name and rejects a
 * private answer, which is what stops `evil.example.com A 169.254.169.254`.
 */
async function assertMailHostAllowed(host: string, port: number): Promise<void> {
  // The guard speaks URLs. A mail host is not one, so it is wrapped — `https`
  // rather than `imaps` because the scheme allow-list is about the URL parser,
  // not about the protocol we will actually speak.
  await assertOutboundDestinationAllowed(`https://${host}:${port}`);
}

interface ProvisionResponse {
  ok?: unknown;
  passwordEnc?: unknown;
  reason?: unknown;
}

/**
 * Verify the mailbox and get its ciphertext back.
 *
 * 🔴 Returns the CIPHERTEXT, never the plaintext, and the failure carries a
 * closed-set reason rather than the IMAP server's own words. A server's
 * rejection string is attacker-influenced and routinely echoes the credential
 * back at you — "LOGIN failed for user@example.com" is the common shape.
 */
async function verifyAndEncrypt(input: ConnectMailboxInput): Promise<string> {
  const base = internalBaseUrl(config.EMAIL_INDEXER_URL);
  let resp: Response;
  try {
    resp = await fetch(`${base}/accounts/provision`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.SERVICE_TOKEN_EMAIL}`,
      },
      body: JSON.stringify({
        host: input.imapHost,
        port: input.imapPort,
        useTls: input.imapTls,
        username: input.username,
        password: input.password,
      }),
    });
  } catch (err) {
    // A box without the `email` compose profile has no such service. Named,
    // because "connect failed" would send an owner looking at their mailbox.
    logger.warn({ err }, "email-indexer unreachable");
    throw new Error(PROVISION_ERRORS.INDEXER_UNAVAILABLE);
  }

  const body = (await resp.json().catch(() => ({}))) as ProvisionResponse;
  if (!resp.ok || body.ok !== true || typeof body.passwordEnc !== "string") {
    // 🔴 `body.reason` is a member of the indexer's closed REASONS set. It is
    // deliberately NOT forwarded to the owner as-is; the route turns the
    // failure into one sentence. Logged, because an operator debugging a
    // mailbox needs to know whether it was auth or TLS.
    logger.info({ status: resp.status, reason: body.reason }, "mailbox probe failed");
    throw new Error(PROVISION_ERRORS.MAILBOX_REFUSED);
  }
  return body.passwordEnc;
}

export interface ConnectedMailbox {
  id: string;
  address: string;
  displayName: string;
  imapStatus: string;
}

/**
 * Connect one mailbox: guard the hosts, verify the credential, store the row.
 *
 * The order is the point. A row written before the probe would leave the owner
 * told their mailbox is connected while nothing is being read — which is
 * exactly the state this whole ticket exists to end.
 */
export async function connectMailbox(
  prisma: PrismaClient,
  input: ConnectMailboxInput,
  userId: string,
): Promise<ConnectedMailbox> {
  try {
    await assertMailHostAllowed(input.imapHost, input.imapPort);
    await assertMailHostAllowed(input.smtpHost, input.smtpPort);
  } catch (err) {
    if (isOutboundUrlBlocked(err)) throw new Error(PROVISION_ERRORS.BLOCKED_HOST);
    throw err;
  }

  const existing = await prisma.emailAccount.findUnique({
    where: { address: input.address },
    select: { id: true },
  });
  // Checked before the probe, so a duplicate does not cost an IMAP login — and
  // so the owner is told the real reason rather than watching a working
  // mailbox fail on a unique constraint.
  if (existing) throw new Error(PROVISION_ERRORS.DUPLICATE_ADDRESS);

  const passwordEnc = await verifyAndEncrypt(input);

  const account = await prisma.emailAccount.create({
    data: {
      // 🔴 ALWAYS set. `userId` is `String?` in the schema and was written by
      // nothing, because nothing wrote these rows at all — and it is the
      // identity every downstream read attributes to (`assertAccountAccessible`
      // scopes by it). An account with a null owner is one every user can see.
      userId,
      displayName: input.displayName,
      address: input.address,
      imapHost: input.imapHost,
      imapPort: input.imapPort,
      imapTls: input.imapTls,
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpTls: input.smtpTls,
      username: input.username,
      passwordEnc,
      // `idle` rather than the schema default `paused`: the probe above is the
      // connectivity check the ticket asks for, and it has already passed. A
      // row that reached here with `paused` would be waiting for a check that
      // already happened.
      imapStatus: "idle",
    },
    select: { id: true, address: true, displayName: true, imapStatus: true },
  });

  logger.info(
    // The address, never the username and never the password. An address is
    // what the owner typed into a field labelled with it; the other two are
    // credentials.
    { accountId: account.id, address: account.address },
    "mailbox connected",
  );
  return account;
}

/**
 * Disconnect a mailbox.
 *
 * ⚠ `EmailThread`, `EmailMessage` and `EmailDraft` all carry
 * `onDelete: Cascade` on `accountId`, so this takes the mail with the account.
 * That is the shipped schema's decision and this function does not second-guess
 * it — but it IS the reason ADR-048's email proposals must reference an
 * `EmailMessage` with `Restrict` and an explicit offboarding hop rather than
 * `SetNull` under a CHECK, which would make this delete fail permanently once
 * one proposal existed.
 */
export async function disconnectMailbox(
  prisma: PrismaClient,
  accountId: string,
): Promise<boolean> {
  const removed = await prisma.emailAccount.deleteMany({ where: { id: accountId } });
  return removed.count === 1;
}
