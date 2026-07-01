/**
 * WARP-465 (D1) — email backbone CRUD.
 *
 * Routes owned by this file:
 *   GET    /api/email/accounts                       — list accounts
 *   GET    /api/email/:accountId/threads?filter=     — threads paged
 *   GET    /api/email/:accountId/threads/:threadId   — full thread
 *   POST   /api/email/:accountId/drafts              — create draft
 *   PATCH  /api/email/drafts/:id                     — edit draft
 *   POST   /api/email/drafts/:id/send                — queue send
 *
 * Send-tier (POST .../drafts/:id/send) is gated by the WARP-467/468
 * `outbound_email` off-LAN channel. When the channel is disabled
 * (sovereignty default for off-LAN escape; outbound email is ON by
 * default per §8) we 451 instead of dispatching. Bringing the actual
 * SMTP send up is a Phase D1 follow-up — the route currently writes
 * `status=queued` and waits for the email-indexer service (see PR
 * description) to pick it up via the indexer's outbound poller.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { reconcileStaleSending } from "../services/email-reconcile.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("email-route");

// Owner/admin see every household account; family-and-below are scoped to
// the accounts they personally own (`EmailAccount.userId`). Matches the
// vpn.ts ownership pattern.
function isPrivilegedRole(req: Request): boolean {
  return req.user?.role === "owner" || req.user?.role === "admin";
}

// IDOR guard: confirm the requester is allowed to touch the named account.
// Returns the account row (id-only) on success, or null on 404/403 — the
// caller writes the response. Owner/admin pass regardless of ownership;
// family-and-below must own the account. Returns 404 (not 403) on a foreign
// account to avoid leaking the existence of other households' rows.
async function assertAccountAccessible(
  prisma: PrismaClient,
  req: Request,
  accountId: string,
): Promise<{ id: string; userId: string | null } | null> {
  const account = (await prisma.emailAccount.findUnique({
    where: { id: accountId },
    select: { id: true, userId: true },
  })) as { id: string; userId: string | null } | null;
  if (!account) return null;
  if (isPrivilegedRole(req)) return account;
  if (account.userId && account.userId === req.user?.id) return account;
  return null;
}

const FILTERS = ["inbox", "triaged", "archived", "droplet"] as const;
type Filter = (typeof FILTERS)[number];

const addressSchema = z.string().email().max(254);

const createDraftSchema = z.object({
  threadId: z.string().uuid().nullable().optional(),
  toAddrs: z.array(addressSchema).min(1).max(50),
  ccAddrs: z.array(addressSchema).max(50).optional(),
  bccAddrs: z.array(addressSchema).max(50).optional(),
  subject: z.string().min(1).max(998),
  body: z.string().max(64_000).optional(),
  draftedByDroplet: z.boolean().optional(),
});

const patchDraftSchema = z.object({
  toAddrs: z.array(addressSchema).min(1).max(50).optional(),
  ccAddrs: z.array(addressSchema).max(50).nullable().optional(),
  bccAddrs: z.array(addressSchema).max(50).nullable().optional(),
  subject: z.string().min(1).max(998).optional(),
  body: z.string().max(64_000).optional(),
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

  router.get(
    "/email/:accountId/threads",
    requireRole("owner", "admin", "family"),
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

        const where: {
          accountId: string;
          triageStatus?: "inbox" | "triaged" | "archived";
          draftedByDroplet?: boolean;
        } = { accountId: req.params.accountId };
        if (filter === "droplet") {
          where.draftedByDroplet = true;
        } else {
          where.triageStatus = filter;
        }

        const rows = (await prisma.emailThread.findMany({
          where: where as any,
          orderBy: { lastMessageAt: "desc" },
          take: limit,
        })) as unknown as ThreadRow[];
        res.json({ filter, threads: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  router.get(
    "/email/:accountId/threads/:threadId",
    requireRole("owner", "admin", "family"),
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
            messages: { orderBy: { receivedAt: "asc" } },
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

  router.post(
    "/email/:accountId/drafts",
    requireRole("owner", "admin", "family"),
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
          },
        })) as unknown as DraftRow;
        res.status(201).json(draft);
      } catch (err) {
        next(err);
      }
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
        const updated = (await prisma.emailDraft.update({
          where: { id: req.params.id },
          data: {
            toAddrs: (parsed.data.toAddrs ?? undefined) as any,
            ccAddrs: parsed.data.ccAddrs === undefined ? undefined : (parsed.data.ccAddrs as any),
            bccAddrs: parsed.data.bccAddrs === undefined ? undefined : (parsed.data.bccAddrs as any),
            subject: parsed.data.subject,
            body: parsed.data.body,
          },
        })) as unknown as DraftRow;
        res.json(updated);
      } catch (err) {
        next(err);
      }
    },
  );

  router.post(
    "/email/drafts/:id/send",
    requireRole("owner", "admin"),
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
        const account = await assertAccountAccessible(
          prisma,
          req,
          draft.accountId,
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
        const queued = (await prisma.emailDraft.update({
          where: { id: req.params.id },
          data: { status: "queued" },
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
            actor: req.user?.username ?? null,
          },
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
        const updated = (await prisma.emailDraft.update({
          where: { id: req.params.id },
          data: {
            status: parsed.data.status,
            sentAt: parsed.data.status === "sent" ? new Date() : undefined,
            error: parsed.data.status === "failed" ? (parsed.data.error ?? null) : null,
          },
        })) as unknown as DraftRow;
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
  //          threadKey }
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
  });

  router.post(
    "/email/:accountId/messages-ingest",
    requireRole("service"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = ingestSchema.safeParse(req.body);
        if (!parsed.success) {
          res
            .status(400)
            .json({ error: "Invalid ingest payload", details: parsed.error.flatten() });
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
            },
          });
          await prisma.emailThread.update({
            where: { id: thread.id },
            data: { messageCount: { increment: 1 } },
          });
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
    requireRole("owner", "admin", "family"),
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
