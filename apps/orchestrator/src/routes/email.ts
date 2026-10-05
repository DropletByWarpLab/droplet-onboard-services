/**
 * WARP-465 (D1) — email backbone CRUD.
 *
 * Routes owned by this file:
 *   GET    /api/email/accounts                       — list accounts
 *   GET    /api/email/:accountId/threads?filter=     — threads paged
 *   GET    /api/email/:accountId/threads/:threadId   — full thread
 *   GET    /api/email/contacts?query=&limit=         — WARP-3102: senders
 *                                                      of the mail you read
 *   POST   /api/email/:accountId/drafts              — create draft
 *   GET    /api/email/:accountId/drafts              — saved drafts/outbox, paged
 *   GET    /api/email/:accountId/drafts/:draftId     — scoped saved draft
 *   PATCH  /api/email/drafts/:id                     — edit draft
 *   POST   /api/email/drafts/:id/send                — queue send
 *   PATCH  /api/email/accounts/:id/status            — WARP-2957: the indexer
 *                                                      reports a sync cycle
 *                                                      (service principal)
 *   GET    /api/email/:accountId/messages/:messageId/attachments
 *   GET    /api/email/:accountId/messages/:messageId/attachments/:attachmentId
 *                                                    — WARP-3267: list and
 *                                                      download (never inline)
 *
 * WARP-1453 — the five email LLM tools (email_search / email_read /
 * email_summarize_thread / email_draft_reply / email_send) reach the
 * threads, analysis, draft-create, and send routes as the trusted
 * `_service:mcp` principal. Those five routes admit it via
 * `requireRoleOrMcpService` (human role sets unchanged) and scope
 * accounts by the forwarded `X-Droplet-User` identity — see
 * `effectiveUser()` / `assertAccountAccessible()` below. All other
 * routes here (accounts list, draft patch, ingest, claim/status)
 * keep their original guards.
 *
 * WARP-3102 — the forwarded identity is `ctx.userId`, which is
 * `User.username` on the mcp-server's stdio transport (chat) and `User.id`
 * on its HTTP one. It is resolved by `resolveAssertedUser`
 * (`resolveEmailActor()`), never by username alone: that lookup answered
 * 404 to every HTTP-transport call. `search_contacts`, the sixth email
 * tool, reads `GET /email/contacts` the same way.
 *
 * Send-tier (POST .../drafts/:id/send) is gated by the WARP-467/468
 * `outbound_email` off-LAN channel. When the channel is disabled
 * (sovereignty default for off-LAN escape; outbound email is ON by
 * default per §8) we 451 instead of dispatching. Bringing the actual
 * SMTP send up is a Phase D1 follow-up — the route currently writes
 * `status=queued` and waits for the email-indexer service (see PR
 * description) to pick it up via the indexer's outbound poller.
 */
import { createHash } from "node:crypto";
import express, { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { Prisma, PrismaClient } from "@prisma/client";
import { recordAccessDenied, requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import { reconcileStaleSending } from "../services/email-reconcile.service.js";
import { deriveContacts } from "../services/email/contacts.service.js";
import { EMAIL_HEADERS_SCHEMA } from "../services/support/email-headers.js";
import { intakeEmailMessage } from "../services/support/email-intake.service.js";
import {
  connectMailbox,
  disconnectMailbox,
  MAILBOX_STATUS_REASONS,
  PROVISION_ERRORS,
  recordMailboxStatus,
} from "../services/email/provision.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("email-route");

// Owner/admin see every household account; family-and-below are scoped to
// the accounts they personally own (`EmailAccount.userId`). Matches the
// vpn.ts ownership pattern.
function isPrivilegedRole(req: Request): boolean {
  return req.user?.role === "owner" || req.user?.role === "admin";
}

// WARP-1453 — the five email LLM tools dispatch through the mcp-server,
// which calls back into these routes presenting the WARP-339 service
// bearer (`_service:mcp`). Same trusted-principal check as files.ts.
function isMcpService(req: Request): boolean {
  return req.user?.id === "_service:mcp" && req.user.role === "service";
}

/**
 * WARP-1453 — thrown when a request reaches an email tool route without a
 * resolvable human identity. The router-level error handler below maps it
 * to 401 (fail closed — the service principal must never default to acting
 * as anyone, same posture as files.ts getUser()).
 */
class MissingDropletUserError extends Error {
  constructor() {
    super("X-Droplet-User header required for service-principal email calls");
    this.name = "MissingDropletUserError";
  }
}

/**
 * WARP-1453 — the effective human identity a request acts as. For the
 * trusted mcp service principal ONLY, it is taken from the `X-Droplet-User`
 * header the tool handlers forward (`ctx.userId`): the username on the
 * mcp-server's stdio transport, the `User.id` on its HTTP one (WARP-3102) —
 * so it is only ever an assertion to resolve (`resolveEmailActor`), never a
 * key in its own right. Missing/blank header → MissingDropletUserError → 401,
 * never a fallback. For every other caller the header is IGNORED and the
 * session's own username rules — a human session cannot spoof another user
 * this way.
 */
function effectiveUser(req: Request): string {
  if (isMcpService(req)) {
    const forwarded = (req.header("x-droplet-user") ?? "").trim();
    if (!forwarded) throw new MissingDropletUserError();
    return forwarded;
  }
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username
  // is an invariant break — refuse rather than act as anyone (files.ts
  // MissingAuthUserError posture).
  if (!username) throw new MissingDropletUserError();
  return username;
}

/** The person an email route acts for, and whether they read every mailbox. */
interface EmailActor {
  /** `User.id` — what `EmailAccount.userId` holds. */
  id: string | null;
  /** The username, for audit rows. */
  username: string;
  /** Owner/admin read every mailbox; everyone else reads their own. */
  privileged: boolean;
}

// WARP-1453 / WARP-3102: for the mcp service principal the route runs AS the
// forwarded `X-Droplet-User`. It is resolved against the User directory by
// `resolveAssertedUser` — username, nextcloudUsername or id, because the
// header is a username over stdio and a `User.id` over HTTP — and fails
// closed: nobody, more than one person, or a deactivated one → null; missing
// header → 401. The resolved row's canonical role/id drive the exact same
// privileged/ownership decision the human would get calling the route
// directly. `forwardedRoles` is the route's HUMAN role set: a forwarded
// identity whose canonical role falls outside it is refused so the service
// path can never widen a route's human RBAC (e.g. a forwarded family user on
// the owner/admin-only send route).
async function resolveEmailActor(
  prisma: PrismaClient,
  req: Request,
  forwardedRoles: readonly string[] = ["owner", "admin", "family"],
): Promise<EmailActor | null> {
  if (isMcpService(req)) {
    const asserted = effectiveUser(req); // throws → 401 when the header is absent
    const resolved = await resolveAssertedUser(prisma, asserted);
    if (!resolved.ok) return null; // fail closed
    const { id, username, role } = resolved.user;
    if (!forwardedRoles.includes(role)) return null; // human set mirror
    return { id, username, privileged: role === "owner" || role === "admin" };
  }
  return {
    id: req.user?.id ?? null,
    username: effectiveUser(req),
    privileged: isPrivilegedRole(req),
  };
}

// IDOR guard: confirm the requester is allowed to touch the named account.
// Returns the account row (id-only) and the actor on success, or null on
// 404/403 — the caller writes the response. Owner/admin pass regardless of
// ownership; family-and-below must own the account. Returns 404 (not 403) on
// a foreign account to avoid leaking the existence of other households' rows.
// Identity is resolved BEFORE the account read so a header-less service call
// 401s without leaking account existence.
async function assertAccountAccessible(
  prisma: PrismaClient,
  req: Request,
  accountId: string,
  forwardedRoles: readonly string[] = ["owner", "admin", "family"],
): Promise<{ id: string; userId: string | null; actor: EmailActor } | null> {
  const actor = await resolveEmailActor(prisma, req, forwardedRoles);
  if (!actor) return null;
  const account = (await prisma.emailAccount.findUnique({
    where: { id: accountId },
    select: { id: true, userId: true },
  })) as { id: string; userId: string | null } | null;
  if (!account) return null;
  if (actor.privileged) return { ...account, actor };
  if (account.userId && actor.id && account.userId === actor.id)
    return { ...account, actor };
  return null;
}

const FILTERS = ["inbox", "triaged", "archived", "droplet"] as const;
type Filter = (typeof FILTERS)[number];

// Keyset pages bind their cursor to the mailbox and bucket. IDs break ties so
// threads with the same timestamp never disappear between pages. The cursor
// carries no message content and never replaces assertAccountAccessible.
const emailCursorSchema = z.object({
  version: z.literal(1), kind: z.enum(["threads", "drafts"]),
  accountId: z.string().min(1).max(160), bucket: z.string().min(1).max(32),
  at: z.string().datetime(), id: z.string().min(1).max(160),
}).strict();
type EmailCursor = z.infer<typeof emailCursorSchema>;
function readEmailCursor(raw: unknown, accountId: string, kind: EmailCursor["kind"], bucket: string): EmailCursor | null {
  if (raw === undefined) return null;
  if (typeof raw !== "string" || raw.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error("invalid_email_cursor");
  try {
    const cursor = emailCursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    if (cursor.accountId !== accountId || cursor.kind !== kind || cursor.bucket !== bucket) throw new Error("invalid_email_cursor");
    return cursor;
  } catch { throw new Error("invalid_email_cursor"); }
}
function writeEmailCursor(accountId: string, kind: EmailCursor["kind"], bucket: string, at: Date, id: string): string {
  return Buffer.from(JSON.stringify({ version: 1, kind, accountId, bucket, at: at.toISOString(), id })).toString("base64url");
}

// Lists omit the body; detail adds it. Explicit projection keeps future schema
// fields out of the wire contract and never includes mailbox credentials or bytes.
const DRAFT_READ_FIELDS = {
  id: true, accountId: true, threadId: true, toAddrs: true, ccAddrs: true, bccAddrs: true,
  subject: true, draftedByDroplet: true, attachmentIds: true, status: true,
  sentAt: true, claimedAt: true, error: true, createdAt: true, updatedAt: true,
} as const;
const draftsQuerySchema = z.object({
  status: z.enum(["draft", "queued", "sending", "sent", "failed", "all"]).default("draft"),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(1024).optional(),
});

const addressSchema = z.string().email().max(254);

/**
 * WARP-3267 — attachment limits. The email-indexer applies the same numbers
 * (`services/email-indexer/parser.py`) and lists anything over them without
 * its bytes; this side refuses a payload that breaks them anyway.
 */
export const EMAIL_ATTACHMENT_LIMITS = {
  /** One attachment, decoded. */
  maxBytes: 10 * 1024 * 1024,
  /** All the stored attachments of one message (or of one forward), decoded. */
  maxTotalBytes: 20 * 1024 * 1024,
  /** Attachments stored per message; more are listed as `over_limit`. */
  maxStored: 20,
  /** Attachments listed per message at all. */
  maxListed: 50,
} as const;

/**
 * WARP-3267 — the ingest route carries attachments as base64, far past the
 * global 100 kb JSON limit. app.ts skips its global parser for this path and
 * the route parses with a larger limit AFTER `requireRole("service")`, so an
 * unauthenticated caller can never make the box buffer a large body.
 *
 * 48 MB sits well above the indexer's 30 MiB payload budget
 * (`MAX_INGEST_PAYLOAD_BYTES` in services/email-indexer/parser.py): the
 * indexer demotes any part that would cross the budget to `too_large`, so no
 * message it sends is refused here. A 413 would hold the indexer's watermark.
 */
// Case-insensitive and trailing-slash tolerant, as Express routing is, so a
// variant spelling can't slip past the skip and be parsed before auth.
export const EMAIL_INGEST_PATH = /^\/api\/email\/[^/]+\/messages-ingest\/?$/i;
const ingestJson = express.json({ limit: "48mb" });

/** What a list or thread read says about an attachment. Never `data`. */
const ATTACHMENT_META = {
  id: true,
  partIndex: true,
  filename: true,
  contentType: true,
  size: true,
  sha256: true,
  contentId: true,
  status: true,
} as const;

/**
 * WARP-3267 — a sender-chosen file name, made safe to put in a
 * Content-Disposition header and on someone's disk: no directory part, no
 * control or bidi-override characters (`invoice\u202Efdp.exe`), no leading
 * dots, bounded length (200 UTF-16 units, never ending in half a surrogate
 * pair, and no lone surrogates at all: Postgres can't store one).
 * `res.attachment` then quotes it and adds the RFC 5987 `filename*` form.
 */
export function sanitizeAttachmentFilename(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069"<>:|?*]/g, "_")
    .replace(/^[.\s]+/, "")
    .trim()
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "_");
  return cleaned || "attachment";
}

const attachmentIdsSchema = z.array(z.string().uuid()).max(EMAIL_ATTACHMENT_LIMITS.maxStored);

/**
 * WARP-3267 — a forward may carry only stored attachments of its OWN mailbox,
 * within the total limit. Returns an error code, or null when the ids are fine.
 */
async function checkForwardAttachments(
  prisma: PrismaClient,
  accountId: string,
  ids: readonly string[],
): Promise<string | null> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return null;
  const rows = (await prisma.emailAttachment.findMany({
    where: { id: { in: unique }, accountId, status: "stored" },
    select: { id: true, size: true },
  })) as Array<{ id: string; size: number }>;
  if (rows.length !== unique.length) return "attachment_not_found";
  const total = rows.reduce((n, r) => n + r.size, 0);
  if (total > EMAIL_ATTACHMENT_LIMITS.maxTotalBytes) return "attachments_too_large";
  return null;
}

const createDraftSchema = z.object({
  threadId: z.string().uuid().nullable().optional(),
  toAddrs: z.array(addressSchema).min(1).max(50),
  ccAddrs: z.array(addressSchema).max(50).optional(),
  bccAddrs: z.array(addressSchema).max(50).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().max(64_000).optional(),
  draftedByDroplet: z.boolean().optional(),
  attachmentIds: attachmentIdsSchema.optional(),
});

const patchDraftSchema = z.object({
  toAddrs: z.array(addressSchema).min(1).max(50).optional(),
  ccAddrs: z.array(addressSchema).max(50).nullable().optional(),
  bccAddrs: z.array(addressSchema).max(50).nullable().optional(),
  subject: z.string().min(1).max(998).optional(),
  body: z.string().max(64_000).optional(),
  attachmentIds: attachmentIdsSchema.optional(),
});

// WARP-3102 — `search_contacts`: the bounds its input schema declares.
const contactsQuerySchema = z.object({
  query: z.string().trim().min(1).max(120),
  limit: z.coerce.number().int().min(1).max(25).default(10),
});

interface AccountRow {
  id: string;
  userId: string | null;
  displayName: string;
  address: string;
  imapStatus: "idle" | "reconnecting" | "error" | "paused";
  lastIdleAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
}
interface ThreadRow {
  id: string;
  accountId: string;
  threadKey: string;
  subject: string;
  lastSender: string | null;
  snippet: string | null;
  messageCount: number;
  triageStatus: "inbox" | "triaged" | "archived";
  draftedByDroplet: boolean;
  lastMessageAt: Date;
}
interface MessageRow {
  id: string;
  threadId: string;
  messageId: string;
  fromAddr: string;
  fromName: string | null;
  toAddrs: unknown;
  ccAddrs: unknown;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  receivedAt: Date;
}
interface DraftRow {
  id: string;
  accountId: string;
  threadId: string | null;
  toAddrs: unknown;
  ccAddrs: unknown;
  bccAddrs: unknown;
  subject: string;
  body: string;
  draftedByDroplet: boolean;
  attachmentIds: string[];
  status: "draft" | "queued" | "sending" | "sent" | "failed";
  sentAt: Date | null;
  claimedAt: Date | null;
  error: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Pluggable off-LAN gate. Production wiring (app.ts) injects a
 * function that reads `OffLanAllowlistChannel.outbound_email` (from
 * WARP-467). Returning `false` raises a 451 in POST /drafts/:id/send.
 * Tests pass a stub that always returns `true` unless they exercise
 * the refusal path.
 */
export interface EmailGate {
  outboundEmailEnabled(): Promise<boolean>;
}


/**
 * WARP-2734 — the shape of "connect a mailbox".
 *
 * 🔴 `.strict()`, and that is not decoration. This is the only body on the box
 * that carries a third-party plaintext password, so an unknown key is refused
 * rather than ignored: a caller must not be able to smuggle a field past the
 * allow-list and have it reach a create.
 *
 * The hostnames are deliberately NOT validated against a pattern here. A
 * regex would be a second, weaker opinion about what a safe destination is —
 * `assertOutboundDestinationAllowed` in the service RESOLVES the name and
 * rejects a private answer, which is the check that actually matters and the
 * one a pattern cannot make.
 */
const connectAccountBody = z
  .object({
    displayName: z.string().trim().min(1).max(200),
    address: z.string().trim().email().max(320),
    imapHost: z.string().trim().min(1).max(255),
    imapPort: z.number().int().min(1).max(65535).default(993),
    smtpHost: z.string().trim().min(1).max(255),
    smtpPort: z.number().int().min(1).max(65535).default(465),

    // 🔴 `z.literal(true)`, not `z.boolean()`. TLS is not optional here.
    //
    // A security review asked what `imapTls: false` actually does, and the
    // answer is: the probe sends `LOGIN <user> <password>` in cleartext to a
    // host the caller named, and then `idle.py` re-sends it on every
    // reconnect, forever. The form hardcodes `true`, so the only way to reach
    // that is a hand-crafted body — exactly the shape an API should refuse
    // rather than accept quietly.
    //
    // A literal rather than a `.refine()` so the refusal lives in the SCHEMA
    // and lands in `flatten()` as a field error the form can point at. If a
    // LAN mail server without TLS ever has to be supported, that is a
    // deliberate decision with its own opt-in, not a default nobody notices.
    imapTls: z.literal(true).default(true),
    smtpTls: z.literal(true).default(true),
    username: z.string().trim().min(1).max(320),
    password: z.string().min(1).max(1024),
  })
  .strict();

/**
 * Which HTTP answer each provisioning refusal earns.
 *
 * Separated from the route so the mapping is readable as a table. Every one of
 * these is a state the owner can do something about, and the dashboard turns
 * each code into one sentence naming the thing to do.
 */
function provisionStatusFor(code: string): number {
  switch (code) {
    case PROVISION_ERRORS.DUPLICATE_ADDRESS:
      return 409;
    case PROVISION_ERRORS.BLOCKED_HOST:
    case PROVISION_ERRORS.MAILBOX_REFUSED:
      // 422, not 400: the request was well formed. The mailbox refused it, or
      // the destination is one this box will not dial.
      return 422;
    case PROVISION_ERRORS.INDEXER_UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

export function createEmailRouter(
  prisma: PrismaClient,
  gate: EmailGate,
): Router {
  const router = Router();

  router.get(
    "/email/accounts",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // family / guest see only their own accounts; owner/admin see all.
        const where = isPrivilegedRole(req)
          ? undefined
          : { userId: req.user?.id ?? "__none__" };
        const rows = (await prisma.emailAccount.findMany({
          where,
          orderBy: { address: "asc" },
          select: {
            id: true,
            userId: true,
            displayName: true,
            address: true,
            imapStatus: true,
            lastIdleAt: true,
            lastErrorAt: true,
            lastError: true,
          },
        })) as unknown as AccountRow[];
        res.json({ accounts: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * Connect a mailbox. The first writer `EmailAccount` has ever had.
   *
   * 🔴 `requireRole` is passed AT REGISTRATION, never as an inline check. An
   * inline `if (role !== "admin") return 403` returns the same status and
   * skips `recordAccessDenied`, so the attempt leaves no policy-violation row
   * — the ADR-042 rule, and there is a test that fails only on that
   * difference.
   *
   * owner/admin only, and NOT `family`: connecting a mailbox hands this box a
   * credential to a third-party account and starts an outbound connection on a
   * schedule. That is an administrative act even when the mailbox is personal.
   */
  router.post(
    "/email/accounts",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = connectAccountBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        // `flatten()` is the ADR-042 house shape for a rejected body — the
        // same `{error, details}` every credential route answers with.
        //
        // ⚠ It is NOT the reason the password stays out: zod v3 carries no
        // input value in `issues` either (`invalid_string` reports a
        // validation name, `unrecognized_keys` reports KEY names). Verified,
        // because the comment that used to be here claimed otherwise and a
        // mutation proved it wrong. The password stays out because nothing on
        // this path ever writes `req.body` — asserted by
        // `email.accounts.test.ts`, which is a claim about THIS code rather
        // than about a library's current behaviour.
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const actorId = req.user?.id;
      if (!actorId) {
        res.status(403).json({ error: "human_required" });
        return;
      }
      try {
        const account = await connectMailbox(prisma, parsed.data, actorId);
        await recordActivity({
          kind: "email",
          severity: "info",
          sourceIcon: "mail",
          what: "Mailbox connected",
          sub: account.address,
          // 🔴 The address and the id. NEVER the username and never the
          // password — the address is what the owner typed into a field
          // labelled with it; the other two are credentials, and this row is
          // read by more people than the mailbox is.
          refs: { accountId: account.id, address: account.address },
          actor: actorFromRequest(req),
        });
        // 🔴 The response carries no credential material — not the password,
        // not the ciphertext, not the username. There is no endpoint anywhere
        // that reveals a stored password, by construction.
        res.status(201).json({ account });
      } catch (err) {
        const code = err instanceof Error ? err.message : "";
        if ((Object.values(PROVISION_ERRORS) as string[]).includes(code)) {
          res.status(provisionStatusFor(code)).json({ error: code });
          return;
        }
        next(err);
      }
    },
  );

  /**
   * Disconnect a mailbox.
   *
   * ⚠ `EmailThread`, `EmailMessage` and `EmailDraft` cascade on `accountId`,
   * so this takes the stored mail with it. That is the shipped schema's
   * decision; the route states it rather than discovering it.
   */
  router.delete(
    "/email/accounts/:id",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { removed, address } = await disconnectMailbox(prisma, req.params.id);
        if (!removed) {
          res.status(404).json({ error: "account_not_found" });
          return;
        }
        await recordActivity({
          kind: "email",
          severity: "warn",
          sourceIcon: "mail",
          // `warn`, not `info`: the cascade takes every stored thread,
          // message and draft with the account. That is worth a row somebody
          // can find later when the mail is gone.
          what: "Mailbox disconnected",
          // 🔴 The ADDRESS, read before the delete. An audit row carrying a
          // bare uuid for a row that no longer exists tells somebody
          // investigating a missing mail archive nothing at all.
          sub: address ?? undefined,
          refs: { accountId: req.params.id, ...(address ? { address } : {}) },
          actor: actorFromRequest(req),
        });
        res.status(204).end();
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * WARP-2957 — the indexer reports how a sync cycle went.
   *
   * `requireRole("service")` exactly like `PATCH /email/drafts/:id/status`:
   * the email-indexer presents the WARP-339 service bearer. A human session
   * cannot mark a mailbox healthy, and the body is a closed set — an
   * `imapStatus` outside the three cycle outcomes or a `reason` outside
   * `MAILBOX_STATUS_REASONS` is a 400, so a server's own words can never be
   * smuggled onto the row through this hop.
   *
   * This route, and `connectMailbox`, are the only writers of the health
   * columns. `paused` is deliberately not reachable here — it is a schema
   * default nothing sets, not a cycle outcome.
   */
  const accountStatusSchema = z
    .object({
      imapStatus: z.enum(["idle", "reconnecting", "error"]),
      reason: z.enum(MAILBOX_STATUS_REASONS).optional(),
    })
    .strict();

  router.patch(
    "/email/accounts/:id/status",
    requireRole("service"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = accountStatusSchema.safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
          return;
        }
        const { updated } = await recordMailboxStatus(prisma, req.params.id, parsed.data);
        if (!updated) {
          res.status(404).json({ error: "account_not_found" });
          return;
        }
        res.json({ ok: true });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/email/:accountId/threads",
    // WARP-1453: `email_search` dispatches here as `_service:mcp` — admit
    // the trusted mcp principal (identity via X-Droplet-User, resolved in
    // assertAccountAccessible). Human role set unchanged.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(
          prisma,
          req,
          req.params.accountId,
        );
        if (!account) {
          res.status(404).json({ error: "Account not found" });
          return;
        }
        const filterRaw = String(req.query.filter ?? "inbox");
        if (!(FILTERS as readonly string[]).includes(filterRaw)) {
          res.status(400).json({ error: "Invalid filter", allowed: FILTERS });
          return;
        }
        const filter = filterRaw as Filter;
        const limit = Math.max(
          1,
          Math.min(100, Number.parseInt(String(req.query.limit ?? "20"), 10) || 20),
        );

        let cursor: EmailCursor | null;
        try { cursor = readEmailCursor(req.query.cursor, req.params.accountId, "threads", filter); }
        catch { res.status(400).json({ error: "invalid_email_cursor" }); return; }

        const where: {
          accountId: string;
          triageStatus?: "inbox" | "triaged" | "archived";
          draftedByDroplet?: boolean;
          OR?: Array<Record<string, unknown>>;
        } = { accountId: req.params.accountId };
        if (filter === "droplet") {
          where.draftedByDroplet = true;
        } else {
          where.triageStatus = filter;
        }
        if (cursor) {
          where.OR = [
            { lastMessageAt: { lt: new Date(cursor.at) } },
            { lastMessageAt: new Date(cursor.at), id: { lt: cursor.id } },
          ];
        }

        const rows = (await prisma.emailThread.findMany({
          where: where as any,
          orderBy: [{ lastMessageAt: "desc" }, { id: "desc" }],
          take: limit + 1,
        })) as unknown as ThreadRow[];
        const page = rows.slice(0, limit);
        const last = page[page.length - 1];
        res.json({ filter, threads: page, nextCursor: rows.length > limit && last
          ? writeEmailCursor(req.params.accountId, "threads", filter, last.lastMessageAt, last.id) : null });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/email/:accountId/threads/:threadId",
    // WARP-1453: `email_read` dispatches here as `_service:mcp`.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(
          prisma,
          req,
          req.params.accountId,
        );
        if (!account) {
          res.status(404).json({ error: "Thread not found" });
          return;
        }
        const thread = (await prisma.emailThread.findUnique({
          where: { id: req.params.threadId },
          include: {
            messages: {
              orderBy: { receivedAt: "asc" },
              include: {
                attachments: { select: ATTACHMENT_META, orderBy: { partIndex: "asc" } },
              },
            },
          },
        })) as unknown as
          | (ThreadRow & { messages: MessageRow[] })
          | null;
        if (!thread || thread.accountId !== req.params.accountId) {
          res.status(404).json({ error: "Thread not found" });
          return;
        }
        res.json(thread);
      } catch (err) {
        next(err);
      }
    },
  );

  /**
   * WARP-3102 — `search_contacts`: the people the acting person corresponds
   * with, derived from the senders of the mail they may read
   * (services/email/contacts.service.ts).
   *
   * The tool used to read `EmailAccount` itself through `ctx.prisma`, by
   * `userId: ctx.userId`. That column holds a `User.id`, and in chat (the
   * stdio transport) `ctx.userId` is the username, so every chat user was
   * told no mailbox was connected. Here the person is resolved like every
   * other email tool route (`resolveEmailActor`).
   *
   * Which mailboxes: the ones that person can already read here — every
   * account for owner/admin, their own for family — the rule of
   * `GET /email/accounts` and `assertAccountAccessible`. Only owner/admin can
   * connect a mailbox (`POST /email/accounts`), so an own-only rule would hide
   * from an owner the company mailbox an admin connected, which `email_search`
   * shows them.
   *
   * A forwarded identity that resolves to nobody, to more than one person, to
   * a deactivated one or to a role outside the human set is refused with 403
   * and an access-denied row: there is no account here whose existence a 404
   * would hide.
   */
  router.get(
    "/email/contacts",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = contactsQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid query", details: parsed.error.flatten() });
          return;
        }
        const actor = await resolveEmailActor(prisma, req);
        if (!actor) {
          recordAccessDenied(req, "email-contacts-acting-user-unresolved");
          res.status(403).json({ error: "Forbidden" });
          return;
        }
        const accounts = (await prisma.emailAccount.findMany({
          where: actor.privileged ? undefined : { userId: actor.id ?? "__none__" },
          select: { id: true },
        })) as Array<{ id: string }>;
        const contacts = await deriveContacts(
          prisma,
          accounts.map((a) => a.id),
          parsed.data.query,
          parsed.data.limit,
        );
        res.json({ query: parsed.data.query, accountCount: accounts.length, contacts });
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/email/:accountId/drafts",
    // WARP-1453: `email_draft_reply` dispatches here as `_service:mcp`.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = createDraftSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid draft", details: parsed.error.flatten() });
          return;
        }
        // Ownership + existence check: family-and-below must own the
        // account; owner/admin pass regardless. 404 (not 403) on a
        // foreign account so we don't leak the existence of another
        // household's account.
        const account = await assertAccountAccessible(
          prisma,
          req,
          req.params.accountId,
        );
        if (!account) {
          res.status(404).json({ error: "Account not found" });
          return;
        }
        const attachmentError = await checkForwardAttachments(
          prisma,
          req.params.accountId,
          parsed.data.attachmentIds ?? [],
        );
        if (attachmentError) {
          res.status(400).json({ error: attachmentError });
          return;
        }

        const draft = (await prisma.emailDraft.create({
          data: {
            accountId: req.params.accountId,
            threadId: parsed.data.threadId ?? null,
            toAddrs: parsed.data.toAddrs as any,
            ccAddrs: (parsed.data.ccAddrs ?? null) as any,
            bccAddrs: (parsed.data.bccAddrs ?? null) as any,
            subject: parsed.data.subject,
            body: parsed.data.body ?? "",
            draftedByDroplet: parsed.data.draftedByDroplet ?? false,
            attachmentIds: [...new Set(parsed.data.attachmentIds ?? [])],
          },
        })) as unknown as DraftRow;
        res.status(201).json(draft);
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/email/:accountId/drafts",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(prisma, req, req.params.accountId);
        if (!account) { res.status(404).json({ error: "Account not found" }); return; }
        const parsed = draftsQuerySchema.safeParse(req.query);
        if (!parsed.success) { res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() }); return; }
        const { status, limit } = parsed.data;
        let cursor: EmailCursor | null;
        try { cursor = readEmailCursor(parsed.data.cursor, req.params.accountId, "drafts", status); }
        catch { res.status(400).json({ error: "invalid_email_cursor" }); return; }
        const rows = await prisma.emailDraft.findMany({
          where: {
            accountId: req.params.accountId,
            ...(status === "all" ? {} : { status }),
            ...(cursor ? { OR: [
              { updatedAt: { lt: new Date(cursor.at) } },
              { updatedAt: new Date(cursor.at), id: { lt: cursor.id } },
            ] } : {}),
          },
          select: DRAFT_READ_FIELDS,
          orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: limit + 1,
        });
        const page = rows.slice(0, limit); const last = page[page.length - 1];
        res.json({ status, drafts: page, nextCursor: rows.length > limit && last
          ? writeEmailCursor(req.params.accountId, "drafts", status, last.updatedAt, last.id) : null });
      } catch (err) { next(err); }
    },
  );

  router.get(
    "/email/:accountId/drafts/:draftId",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(prisma, req, req.params.accountId);
        if (!account) { res.status(404).json({ error: "Draft not found" }); return; }
        const draft = await prisma.emailDraft.findFirst({
          where: { id: req.params.draftId, accountId: req.params.accountId },
          select: { ...DRAFT_READ_FIELDS, body: true },
        });
        if (!draft) { res.status(404).json({ error: "Draft not found" }); return; }
        const attachments = draft.attachmentIds.length === 0 ? [] : await prisma.emailAttachment.findMany({
          where: { accountId: req.params.accountId, id: { in: draft.attachmentIds } },
          select: { ...ATTACHMENT_META, emailMessageId: true }, orderBy: { partIndex: "asc" },
        });
        res.json({ ...draft, attachments });
      } catch (err) { next(err); }
    },
  );

  router.patch(
    "/email/drafts/:id",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = patchDraftSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid patch", details: parsed.error.flatten() });
          return;
        }
        const existing = (await prisma.emailDraft.findUnique({
          where: { id: req.params.id },
        })) as unknown as DraftRow | null;
        if (!existing) {
          res.status(404).json({ error: "Draft not found" });
          return;
        }
        // IDOR: family-and-below can only patch drafts against accounts they own.
        const account = await assertAccountAccessible(
          prisma,
          req,
          existing.accountId,
        );
        if (!account) {
          res.status(404).json({ error: "Draft not found" });
          return;
        }
        if (existing.status !== "draft") {
          // Once queued / sent / failed the row is immutable — editing
          // a queued draft mid-flight would be a race with the indexer.
          res.status(409).json({ error: "Draft is no longer editable", status: existing.status });
          return;
        }
        if (parsed.data.attachmentIds) {
          const attachmentError = await checkForwardAttachments(
            prisma,
            existing.accountId,
            parsed.data.attachmentIds,
          );
          if (attachmentError) {
            res.status(400).json({ error: attachmentError });
            return;
          }
        }
        // ORCH-003 (P1): push the status guard INTO the write so a concurrent
        // /send (draft→queued) or the indexer's claim can't be overwritten
        // between the check above and here. Branch on count to disambiguate.
        const upd = await prisma.emailDraft.updateMany({
          where: { id: req.params.id, status: "draft" },
          data: {
            toAddrs: (parsed.data.toAddrs ?? undefined) as any,
            ccAddrs: parsed.data.ccAddrs === undefined ? undefined : (parsed.data.ccAddrs as any),
            bccAddrs: parsed.data.bccAddrs === undefined ? undefined : (parsed.data.bccAddrs as any),
            subject: parsed.data.subject,
            body: parsed.data.body,
            attachmentIds: parsed.data.attachmentIds
              ? [...new Set(parsed.data.attachmentIds)]
              : undefined,
          },
        });
        if (upd.count === 0) {
          const cur = (await prisma.emailDraft.findUnique({
            where: { id: req.params.id },
          })) as unknown as DraftRow | null;
          if (!cur) {
            res.status(404).json({ error: "Draft not found" });
            return;
          }
          res.status(409).json({ error: "Draft is no longer editable", status: cur.status });
          return;
        }
        const updated = (await prisma.emailDraft.findUniqueOrThrow({
          where: { id: req.params.id },
        })) as unknown as DraftRow;
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/email/drafts/:id/send",
    // WARP-1453: `email_send` dispatches here as `_service:mcp`. Send keeps
    // the narrower owner/admin human set; the forwarded identity's canonical
    // role is re-checked in assertAccountAccessible.
    requireRoleOrMcpService("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const draft = (await prisma.emailDraft.findUnique({
          where: { id: req.params.id },
        })) as unknown as DraftRow | null;
        if (!draft) {
          res.status(404).json({ error: "Draft not found" });
          return;
        }
        // Belt-and-braces: send-tier is already gated to owner/admin
        // (per route guard), but apply the same account-access check so
        // a future role widening doesn't silently re-open IDOR.
        // WARP-1453: the mcp path mirrors the owner/admin human set for
        // the forwarded identity — a forwarded family user cannot send.
        const account = await assertAccountAccessible(
          prisma,
          req,
          draft.accountId,
          ["owner", "admin"],
        );
        if (!account) {
          res.status(404).json({ error: "Draft not found" });
          return;
        }
        if (draft.status !== "draft") {
          res.status(409).json({ error: "Draft already dispatched", status: draft.status });
          return;
        }

        // WARP-467/468 off-LAN gate. When `outbound_email` is
        // disabled the operator has explicitly opted out of letting
        // mail leave the LAN; 451 (Unavailable For Legal Reasons) is
        // the sovereignty signal — same posture as the ai-gateway
        // cloud_model_escape refusal. The gate throws on DB errors
        // (as opposed to returning false for a deliberate disable) so
        // we can return 503 rather than the misleading 451.
        let allowed: boolean;
        try {
          allowed = await gate.outboundEmailEnabled();
        } catch {
          res.status(503).json({
            error: "off_lan_gate_unavailable",
            channel: "outbound_email",
            message: "Off-LAN egress gate temporarily unavailable; try again shortly.",
          });
          return;
        }
        if (!allowed) {
          res.status(451).json({
            error: "off_lan_blocked",
            channel: "outbound_email",
            message:
              "Outbound email is disabled by the off-LAN allowlist. An admin can enable outbound_email from Settings → Off-LAN allowlist with a reason.",
          });
          return;
        }

        // Flip to `queued` — the email-indexer service's outbound
        // poller (separate Python service, follow-up PR) picks rows
        // up from here and drives the SMTP transaction. We track the
        // transition with one ActivityRow regardless of eventual
        // SMTP outcome so the audit feed has a clean enqueue record.
        // ORCH-003 (P1): conditional flip so two racing sends can't both
        // enqueue (double "queued" ActivityRow). Only one observes count===1.
        const flip = await prisma.emailDraft.updateMany({
          where: { id: req.params.id, status: "draft" },
          data: { status: "queued" },
        });
        if (flip.count === 0) {
          res.status(409).json({ error: "Draft already dispatched" });
          return;
        }
        const queued = (await prisma.emailDraft.findUniqueOrThrow({
          where: { id: req.params.id },
        })) as unknown as DraftRow;

        await recordActivity({
          kind: "email",
          severity: "info",
          sourceIcon: "send",
          what: "Email draft queued for send",
          sub: queued.subject,
          refs: {
            draftId: queued.id,
            accountId: queued.accountId,
            // WARP-1453: attribute the EFFECTIVE human — for the mcp
            // service principal this is the person the forwarded
            // X-Droplet-User resolved to, not "_service:mcp". WARP-3102: by
            // their username, never the raw header, which is a User.id over
            // the mcp-server's HTTP transport.
            actor: account.actor.username,
          },
          actor: actorFromRequest(req),
        });

        res.status(202).json({
          id: queued.id,
          status: queued.status,
          message: "Queued for SMTP send by the email-indexer service",
        });
      } catch (err) {
        logger.warn(
          { err, id: req.params.id },
          "draft send dispatch failed",
        );
        next(err);
      }
    },
  );

  // ── D1 follow-up — service-principal draft status PATCH ──────
  // PATCH /api/email/drafts/:id/status
  // Body: { status: "sent" | "failed", error?: string }
  //
  // The email-indexer's outbound poller flips a queued draft to sent
  // (with sentAt=now) or failed (with the SMTP error). Status is the
  // only mutable surface here — operator content edits go through
  // PATCH /api/email/drafts/:id which 409s once status != draft.
  const draftStatusSchema = z.object({
    status: z.enum(["sent", "failed"]),
    error: z.string().max(1024).optional(),
  });

  router.patch(
    "/email/drafts/:id/status",
    requireRole("service"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = draftStatusSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid status patch", details: parsed.error.flatten() });
          return;
        }
        const draft = (await prisma.emailDraft.findUnique({
          where: { id: req.params.id },
        })) as unknown as DraftRow | null;
        if (!draft) {
          res.status(404).json({ error: "Draft not found" });
          return;
        }
        // The terminal status callback may arrive from `queued` (legacy direct
        // send) or `sending` (WARP-890: the indexer claims queued→sending before
        // the SMTP send). Both are valid sources for sent/failed.
        if (draft.status !== "queued" && draft.status !== "sending") {
          // Idempotent: re-asserting a status the row already holds
          // is a 200 no-op (the indexer may redeliver a callback on
          // reconnect). Anything else is a contract violation.
          if (draft.status === parsed.data.status) {
            res.json({ id: draft.id, status: draft.status });
            return;
          }
          res.status(409).json({
            error: "Draft not in queued or sending state",
            currentStatus: draft.status,
          });
          return;
        }
        const updated = await prisma.$transaction(async (tx) => {
          const saved = await tx.emailDraft.update({
            where: { id: req.params.id },
            data: {
              status: parsed.data.status,
              sentAt: parsed.data.status === "sent" ? new Date() : undefined,
              error: parsed.data.status === "failed" ? (parsed.data.error ?? null) : null,
            },
          });
          const ticketLink = await tx.pmTicketEmailLink.findUnique({
            where: { emailDraftId: saved.id },
            select: { commentId: true },
          });
          if (ticketLink?.commentId) {
            await tx.pmComment.updateMany({
              where: { id: ticketLink.commentId, visibility: "PUBLIC" },
              data: parsed.data.status === "sent"
                ? { deliveryStatus: "SENT", deliveryFailure: null }
                : { deliveryStatus: "FAILED", deliveryFailure: "SEND_FAILED" },
            });
          }
          return saved;
        });
        res.json({ id: updated.id, status: updated.status });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/email/drafts/:id/claim  (service principal)
  // Atomically transition a queued draft to `sending` so the email-indexer's
  // outbound poller SMTP-sends it exactly once. A conditional updateMany
  // (WARP-564 pairing-claim pattern) means a re-tick — or a second poller —
  // that loses the race gets { claimed: false } and skips, so a lost terminal
  // status callback can never cause a duplicate re-send (WARP-890).
  router.post(
    "/email/drafts/:id/claim",
    requireRole("service"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await prisma.emailDraft.updateMany({
          where: { id: req.params.id, status: "queued" },
          // claimedAt is the tamper-proof reconcile clock (NOT updatedAt, which
          // @updatedAt resets on any later row write). Set it at the moment of
          // the claim so the stale-sending sweep measures the grace window from
          // here. (WARP-890)
          data: { status: "sending", claimedAt: new Date() },
        });
        res.json({ id: req.params.id, claimed: result.count === 1 });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/email/drafts/reconcile-stale-sending  (service principal)
  // A draft claimed (queued→sending) whose terminal status callback never
  // landed (indexer crash / lost PATCH) would otherwise strand in `sending`.
  // Sweep rows stuck in `sending` past a grace window to `failed`. We do NOT
  // re-queue them: the SMTP send may have completed, and re-queuing would risk
  // the duplicate this change exists to prevent. The indexer calls this once
  // per outbound tick (belt-and-suspenders); the orchestrator ALSO runs the
  // same sweep on a cron (see index.ts) so recovery is independent of the
  // indexer being up. The cutoff keys off the explicit `claimedAt` column, not
  // `updatedAt`. Grace window default 10 min (EMAIL_SENDING_STALE_MS). The
  // sweep logic lives in email-reconcile.service so the route and the cron
  // share exactly one implementation.
  router.post(
    "/email/drafts/reconcile-stale-sending",
    requireRole("service"),
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const reconciled = await reconcileStaleSending(prisma);
        res.json({ reconciled });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── D1 follow-up — service-principal ingest from email-indexer ─
  // POST /api/email/:accountId/messages-ingest
  // Body: { messageId, inReplyTo?, fromAddr, fromName?, toAddrs[],
  //          ccAddrs[]?, subject, bodyText?, bodyHtml?, receivedAt,
  //          threadKey, headers? }
  //
  // The email-indexer service parses MIME, computes the threadKey
  // (root Message-ID or References chain), and POSTs each new
  // message here. The orchestrator owns the upsert into EmailThread
  // (one row per accountId/threadKey) and the create into
  // EmailMessage. Conflict on (accountId, messageId) → 200 no-op so
  // a re-delivery doesn't error the IDLE loop.
  //
  // Service-principal gated — same posture as /network/throughput-sample
  // and /network/off-lan-sample-batch.
  const ingestSchema = z.object({
    messageId: z.string().min(1).max(998),
    inReplyTo: z.string().max(998).nullable().optional(),
    fromAddr: z.string().email().max(254),
    fromName: z.string().max(254).nullable().optional(),
    toAddrs: z.array(z.string().email().max(254)).min(1).max(100),
    ccAddrs: z.array(z.string().email().max(254)).max(100).nullable().optional(),
    subject: z.string().max(998),
    bodyText: z.string().max(1_000_000).nullable().optional(),
    bodyHtml: z.string().max(2_000_000).nullable().optional(),
    receivedAt: z.string().datetime(),
    threadKey: z.string().min(1).max(998),
    // WARP-3529 — authenticated service payload facts used for threading and
    // loop protection. Optional only for an older indexer; absent means the
    // desk cannot claim that automatic-mail headers were checked.
    headers: EMAIL_HEADERS_SCHEMA.optional(),
    // WARP-3267 — `data` (base64) only when `status` is `stored`.
    attachments: z
      .array(
        z.object({
          filename: z.string().min(1).max(255),
          contentType: z.string().min(1).max(255),
          size: z.number().int().min(0),
          sha256: z.string().regex(/^[0-9a-f]{64}$/),
          contentId: z.string().max(998).nullable().optional(),
          status: z.enum(["stored", "too_large", "over_limit"]),
          data: z
            .string()
            .max(Math.ceil(EMAIL_ATTACHMENT_LIMITS.maxBytes / 3) * 4)
            .optional(),
        }),
      )
      .max(EMAIL_ATTACHMENT_LIMITS.maxListed)
      .optional(),
  });

  type IngestAttachment = NonNullable<z.infer<typeof ingestSchema>["attachments"]>[number];

  /**
   * WARP-3267 — turn the payload's attachments into rows, or name the limit
   * they break. The size and hash of a stored part are measured here, never
   * taken from the payload.
   */
  function attachmentRows(accountId: string, list: IngestAttachment[]) {
    let stored = 0;
    let total = 0;
    const rows = [];
    for (const [partIndex, a] of list.entries()) {
      const base = {
        accountId,
        partIndex,
        // Sanitised once, here, so every surface that lists it (web, Mac,
        // iOS) shows and saves the clean name. The download sanitises again.
        filename: sanitizeAttachmentFilename(a.filename),
        contentType: a.contentType,
        contentId: a.contentId ?? null,
        status: a.status,
      };
      if (a.status !== "stored") {
        if (a.data !== undefined) return { error: "attachment_data_not_stored" as const };
        rows.push({ ...base, size: a.size, sha256: a.sha256, data: null });
        continue;
      }
      if (a.data === undefined) return { error: "attachment_data_missing" as const };
      const bytes = Buffer.from(a.data, "base64");
      stored += 1;
      total += bytes.length;
      if (
        bytes.length > EMAIL_ATTACHMENT_LIMITS.maxBytes ||
        total > EMAIL_ATTACHMENT_LIMITS.maxTotalBytes ||
        stored > EMAIL_ATTACHMENT_LIMITS.maxStored
      ) {
        return { error: "attachment_limit_exceeded" as const };
      }
      rows.push({
        ...base,
        size: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        data: bytes,
      });
    }
    return { rows };
  }

  router.post(
    "/email/:accountId/messages-ingest",
    requireRole("service"),
    ingestJson,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = ingestSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid ingest payload", details: parsed.error.flatten() });
          return;
        }
        const attachments = attachmentRows(
          req.params.accountId,
          parsed.data.attachments ?? [],
        );
        if ("error" in attachments) {
          // Only a broken LIMIT is a 413 (it holds the indexer's watermark
          // for a few cycles); a malformed entry is a 400 the indexer skips.
          const status = attachments.error === "attachment_limit_exceeded" ? 413 : 400;
          res.status(status).json({ error: attachments.error });
          return;
        }
        const account = (await prisma.emailAccount.findUnique({
          where: { id: req.params.accountId },
          select: { id: true },
        })) as { id: string } | null;
        if (!account) {
          res.status(404).json({ error: "Account not provisioned" });
          return;
        }

        // A re-delivery (indexer restart backfill, a held UID's neighbours)
        // answers before the thread upsert, so it can't rewind the thread's
        // lastMessageAt or snippet. The P2002 catch below still covers a race.
        const existing = (await prisma.emailMessage.findUnique({
          where: {
            accountId_messageId: { accountId: account.id, messageId: parsed.data.messageId },
          },
          select: { threadId: true },
        })) as { threadId: string } | null;
        if (existing) {
          // Covers a process crash after the mail row committed but before
          // service-desk intake finished. The per-message ledger makes this a
          // cheap no-op after a successful first pass.
          try { await intakeEmailMessage(prisma, account.id, parsed.data.messageId); }
          catch (err) { logger.warn({ err, accountId: account.id }, "service-desk email intake will need retry"); }
          res.json({ ok: true, threadId: existing.threadId, duplicate: true });
          return;
        }

        const receivedAt = new Date(parsed.data.receivedAt);
        const snippet = (parsed.data.bodyText ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 280);

        // Upsert the thread first so the FK on EmailMessage resolves.
        const thread = (await prisma.emailThread.upsert({
          where: {
            accountId_threadKey: {
              accountId: account.id,
              threadKey: parsed.data.threadKey,
            },
          },
          update: {
            // Re-running on the same threadKey updates only the
            // mutable fields. messageCount is bumped after the create
            // below so an idempotent re-delivery doesn't double-count.
            subject: parsed.data.subject,
            lastSender: parsed.data.fromName ?? parsed.data.fromAddr,
            snippet: snippet.length > 0 ? snippet : undefined,
            lastMessageAt: receivedAt,
          },
          create: {
            accountId: account.id,
            threadKey: parsed.data.threadKey,
            subject: parsed.data.subject,
            lastSender: parsed.data.fromName ?? parsed.data.fromAddr,
            snippet,
            messageCount: 0,
            lastMessageAt: receivedAt,
          },
        })) as unknown as ThreadRow;

        // EmailMessage_accountId_messageId_key dedupes redelivery.
        try {
          await prisma.emailMessage.create({
            data: {
              accountId: account.id,
              threadId: thread.id,
              messageId: parsed.data.messageId,
              inReplyTo: parsed.data.inReplyTo ?? null,
              fromAddr: parsed.data.fromAddr,
              fromName: parsed.data.fromName ?? null,
              toAddrs: parsed.data.toAddrs as any,
              ccAddrs: (parsed.data.ccAddrs ?? null) as any,
              subject: parsed.data.subject,
              bodyText: parsed.data.bodyText ?? null,
              bodyHtml: parsed.data.bodyHtml ?? null,
              receivedAt,
              ...(parsed.data.headers
                ? { headers: parsed.data.headers as Prisma.InputJsonValue }
                : {}),
              // Created with the message, so a message is never stored
              // without the attachments it arrived with.
              ...(attachments.rows.length > 0
                ? { attachments: { create: attachments.rows } }
                : {}),
            },
          });
          await prisma.emailThread.update({
            where: { id: thread.id },
            data: { messageCount: { increment: 1 } },
          });
          // Intake is downstream of the committed EmailMessage. Failures are
          // recorded in the desk ledger; they must not make the indexer replay
          // a message that the mailbox already stored successfully.
          try { await intakeEmailMessage(prisma, account.id, parsed.data.messageId); }
          catch (err) { logger.warn({ err, accountId: account.id }, "service-desk email intake will need retry"); }
        } catch (err) {
          if ((err as { code?: string }).code === "P2002") {
            // Re-delivery of a message we've already stored. Idempotent
            // success — return the thread id so the indexer can decide
            // whether to surface the duplicate or move on.
            res.json({
              ok: true,
              threadId: thread.id,
              duplicate: true,
            });
            return;
          }
          throw err;
        }

        res.status(201).json({
          ok: true,
          threadId: thread.id,
          duplicate: false,
        });
      } catch (err) {
        logger.warn(
          { err, accountId: req.params.accountId },
          "messages-ingest failed",
        );
        next(err);
      }
    },
  );

  // ── WARP-3267 — attachments: list and download ─────────────────
  // Gated exactly like the thread read: the mailbox's owner, or owner/admin.
  // A foreign mailbox, a message of another mailbox, or an attachment of
  // another message is a 404 — never a hint that it exists. Human sessions
  // only: no LLM tool reads attachment bytes.
  router.get(
    "/email/:accountId/messages/:messageId/attachments",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(prisma, req, req.params.accountId);
        if (!account) {
          res.status(404).json({ error: "Message not found" });
          return;
        }
        const message = await prisma.emailMessage.findFirst({
          where: { id: req.params.messageId, accountId: req.params.accountId },
          select: {
            id: true,
            attachments: { select: ATTACHMENT_META, orderBy: { partIndex: "asc" } },
          },
        });
        if (!message) {
          res.status(404).json({ error: "Message not found" });
          return;
        }
        res.json({ attachments: message.attachments });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/email/:accountId/messages/:messageId/attachments/:attachmentId",
    requireRole("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(prisma, req, req.params.accountId);
        if (!account) {
          res.status(404).json({ error: "Attachment not found" });
          return;
        }
        const att = (await prisma.emailAttachment.findFirst({
          where: {
            id: req.params.attachmentId,
            emailMessageId: req.params.messageId,
            accountId: req.params.accountId,
          },
          select: { id: true, filename: true, size: true, status: true, data: true },
        })) as {
          id: string;
          filename: string;
          size: number;
          status: string;
          data: Uint8Array | null;
        } | null;
        if (!att) {
          res.status(404).json({ error: "Attachment not found" });
          return;
        }
        if (att.status !== "stored" || !att.data) {
          res.status(409).json({ error: "attachment_not_stored", status: att.status });
          return;
        }
        await recordActivity({
          kind: "email",
          severity: "info",
          sourceIcon: "mail",
          what: "Email attachment downloaded",
          sub: sanitizeAttachmentFilename(att.filename),
          refs: {
            accountId: req.params.accountId,
            messageId: req.params.messageId,
            attachmentId: att.id,
            actor: account.actor.username,
          },
          actor: actorFromRequest(req),
        });
        // Always a download, never rendered: the declared type is the
        // sender's claim, so the bytes go out as octet-stream, with nosniff
        // and a sandbox CSP in case anything opens them in place anyway.
        res.attachment(sanitizeAttachmentFilename(att.filename));
        res.setHeader("Content-Type", "application/octet-stream");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("Cache-Control", "private, no-store");
        res.send(Buffer.from(att.data));
      } catch (err) {
        next(err);
      }
    },
  );

  // ── WARP-466 (D2) — §2.4 AI side-panel analysis endpoint ──────
  // GET /api/email/:accountId/threads/:threadId/analysis
  //
  // Returns `{summary, callouts, suggestedActions, related}` shaped
  // for the dashboard's §2.4 AI side panel. The orchestrator drives
  // the agent loop internally so the LLM sees the same tool registry
  // as a chat turn — retrieval is NOT duplicated here.
  //
  // Pluggable `EmailAnalysisService` so tests can inject a stub
  // without standing up the MCP child / ai-gateway / Ollama. Prod
  // wiring (app.ts) injects an implementation backed by `runAgent`
  // (see services/email-analysis.service.ts).
  router.get(
    "/email/:accountId/threads/:threadId/analysis",
    // WARP-1453: `email_summarize_thread` dispatches here as `_service:mcp`.
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const account = await assertAccountAccessible(
          prisma,
          req,
          req.params.accountId,
        );
        if (!account) {
          res.status(404).json({ error: "Thread not found" });
          return;
        }
        const thread = (await prisma.emailThread.findUnique({
          where: { id: req.params.threadId },
          include: { messages: { orderBy: { receivedAt: "asc" } } },
        })) as unknown as
          | (ThreadRow & { messages: MessageRow[] })
          | null;
        if (!thread || thread.accountId !== req.params.accountId) {
          res.status(404).json({ error: "Thread not found" });
          return;
        }
        const analysisFn = analysisOverride;
        if (!analysisFn) {
          // Module-init ordering can leave the override undefined in
          // narrow test setups. Return a 503 rather than a 500 so
          // dashboard retry logic kicks in correctly.
          res.status(503).json({ error: "Analysis service not wired" });
          return;
        }
        const analysis = await analysisFn({
          accountId: thread.accountId,
          threadId: thread.id,
          subject: thread.subject,
          messages: thread.messages.map((m) => ({
            from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr,
            receivedAt: m.receivedAt.toISOString(),
            bodyText: (m.bodyText ?? "").slice(0, 8_000),
          })),
        });
        res.json(analysis);
      } catch (err) {
        logger.warn(
          { err, threadId: req.params.threadId },
          "email analysis failed",
        );
        next(err);
      }
    },
  );

  // WARP-1453 — map the fail-closed identity sentinel to 401. Every tool
  // route funnels errors through next(err); a service-principal call
  // without X-Droplet-User must re-present with an identity, not 500.
  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction): void => {
      if (err instanceof MissingDropletUserError) {
        res.status(401).json({ error: err.message });
        return;
      }
      next(err);
    },
  );

  return router;
}

/**
 * WARP-466 — analysis function injected per-router.
 *
 * Module-level state lets `createEmailRouter` continue to accept its
 * historical (prisma, gate) signature without a breaking change for
 * existing callers / tests. `wireEmailAnalysis(fn)` is called once at
 * boot from `app.ts`; tests can also call it directly to inject a
 * stub.
 */
let analysisOverride: EmailAnalysisFn | null = null;

export interface EmailAnalysisInput {
  accountId: string;
  threadId: string;
  subject: string;
  messages: Array<{ from: string; receivedAt: string; bodyText: string }>;
}

export interface EmailAnalysis {
  summary: string;
  callouts: Array<{ label: string }>;
  suggestedActions: Array<{ label: string; safety: "Read" | "Write · confirm" }>;
  related: {
    files: string[];
    threads: string[];
    cameras: string[];
    tools: string[];
  };
}

export type EmailAnalysisFn = (
  input: EmailAnalysisInput,
) => Promise<EmailAnalysis>;

export function wireEmailAnalysis(fn: EmailAnalysisFn | null): void {
  analysisOverride = fn;
}
