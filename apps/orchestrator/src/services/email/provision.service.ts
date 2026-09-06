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
 * that one process, to save one hop.
 *
 * ⚠ An earlier version of this paragraph justified that hop by saying the mesh
 * "already has mTLS". THAT WAS NOT TRUE OF THIS CALL, and an adversarial
 * review of this file caught it: the code took `internalBaseUrl` without
 * `internalFetch`, so it never presented the client cert — the only
 * `internalBaseUrl` caller in the whole tree that did not. Two consequences,
 * both now fixed: on a `DROPLET_INTERNAL_TLS=1` box the handshake died and
 * every mailbox connect returned 503 blaming a healthy container, and the
 * security argument rested on a property this call did not have.
 *
 * The honest statement is narrower. `DROPLET_INTERNAL_TLS` ships OFF, so by
 * default this hop is plain HTTP on the shared compose bridge — exactly like
 * every other internal call on this box, which is WARP-1061's posture and not
 * this feature's to change. What this file now guarantees is that when
 * internal TLS is ON, this call takes it.
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
import { internalBaseUrl, internalFetch } from "../../lib/internal-tls.js";
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
async function assertMailHostAllowed(host: string, port: number): Promise<string> {
  // The guard speaks URLs. A mail host is not one, so it is wrapped — `https`
  // rather than `imaps` because the scheme allow-list is about the URL parser,
  // not about the protocol we will actually speak.
  const url = await assertOutboundDestinationAllowed(`https://${host}:${port}`);

  // 🔴 RETURNS THE VETTED HOSTNAME, and every caller stores THAT.
  //
  // Found by an adversarial review: the guard resolved one string and the IMAP
  // client dialled another. Node's WHATWG URL parser normalises a hostname
  // with UTS-46 IDNA; CPython's `encodings.idna` implements the older
  // IDNA2003, and the two disagree on characters such as `ß` — so
  // `faß.example` could be vetted as one name and dialled as a different one.
  // The same gap swallows a userinfo section, a trailing dot and mixed-case
  // unicode.
  //
  // Handing the parser's own answer downstream removes the divergence rather
  // than trying to anticipate it: there is only ever one hostname, and it is
  // the one that passed.
  return stripBrackets(url.hostname);
}

/** An IPv6 literal comes back from the URL parser in brackets; a socket wants
 *  it without them. */
function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
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
    // 🔴 `internalFetch`, never the global. It presents this orchestrator's
    // client cert when internal TLS is on, and returns the plain global
    // `fetch` when it is off — correct in both postures. The peer's uvicorn
    // listener runs `ssl.CERT_REQUIRED`, so the global fetch cannot complete
    // the handshake at all.
    resp = await internalFetch(`${base}/accounts/provision`, {
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

  // 🔴 A 401 or 503 from the indexer is OUR fault, not the mailbox's.
  //
  // Collapsing it into "the mailbox refused your password" would have an owner
  // retyping a correct credential forever while the real fault is a rotated
  // SERVICE_TOKEN_EMAIL, or a service that failed closed with no token at all.
  // Telling somebody their password is wrong when it is not is the worst
  // message this surface could produce.
  if (resp.status === 401 || resp.status === 503) {
    logger.error(
      { status: resp.status },
      "email-indexer rejected the orchestrator's service token — SERVICE_TOKEN_EMAIL drift",
    );
    throw new Error(PROVISION_ERRORS.INDEXER_UNAVAILABLE);
  }

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
  let imapHost: string;
  let smtpHost: string;
  try {
    imapHost = await assertMailHostAllowed(input.imapHost, input.imapPort);
    smtpHost = await assertMailHostAllowed(input.smtpHost, input.smtpPort);
  } catch (err) {
    if (isOutboundUrlBlocked(err)) throw new Error(PROVISION_ERRORS.BLOCKED_HOST);
    throw err;
  }
  // Everything downstream — the probe, and the row the pollers re-read forever
  // — uses the VETTED names, never the typed ones.
  const vetted = { ...input, imapHost, smtpHost };

  const existing = await prisma.emailAccount.findUnique({
    where: { address: input.address },
    select: { id: true },
  });
  // Checked before the probe, so a duplicate does not cost an IMAP login — and
  // so the owner is told the real reason rather than watching a working
  // mailbox fail on a unique constraint.
  if (existing) throw new Error(PROVISION_ERRORS.DUPLICATE_ADDRESS);

  const passwordEnc = await verifyAndEncrypt(vetted);

  const account = await prisma.emailAccount.create({
    data: {
      // 🔴 ALWAYS set. `userId` is `String?` in the schema and was written by
      // nothing, because nothing wrote these rows at all — and it is the
      // identity every downstream read attributes to (`assertAccountAccessible`
      // scopes by it). An account with a null owner is one every user can see.
      userId,
      displayName: input.displayName,
      address: input.address,
      // 🔴 The VETTED hostnames, not the typed ones. `idle.py` and
      // `outbound.py` re-read this row and dial it on a schedule forever, so
      // storing the raw input would make the guard a one-time check on a
      // string nothing afterwards uses.
      imapHost,
      imapPort: input.imapPort,
      imapTls: input.imapTls,
      smtpHost,
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
): Promise<{ removed: boolean; address: string | null }> {
  // 🔴 Read the address BEFORE the delete, so the audit row can name the
  // mailbox. After the cascade there is nothing left to look it up from, and
  // an audit entry carrying a bare uuid for a row that no longer exists tells
  // somebody investigating a missing archive precisely nothing.
  const existing = await prisma.emailAccount.findUnique({
    where: { id: accountId },
    select: { address: true },
  });
  if (!existing) return { removed: false, address: null };

  const removed = await prisma.emailAccount.deleteMany({ where: { id: accountId } });
  return { removed: removed.count === 1, address: existing.address };
}
