/**
 * `/api/crm/filing/*` — ADR-048's review surface (WARP-2730).
 *
 * ── Why this prefix ────────────────────────────────────────────────────────
 *
 * Mounted on `/api/crm`, so it inherits the `crm` module gate through
 * `mountModuleGates` and its `routePrefixes: ["/api/crm"]` entry. No registry
 * edit, no second gate vocabulary, and the same reasoning `crm-entity-links.ts`
 * records: nothing in `routes/crm.ts` takes a path parameter in the first
 * segment after `/crm`, so `/crm/filing/...` cannot be shadowed.
 *
 * ── Why the roles are narrower than the rest of the CRM ────────────────────
 *
 * 🔴 `owner` and `admin` only, on READS as well as writes, and never
 * `requireRoleOrMcpService`.
 *
 * The rest of the CRM admits `family` for writes because a household member
 * adding a customer is ordinary. This surface is different in two ways. First,
 * a proposal card carries VERBATIM QUOTES from a stored document, which is a
 * document-content read wearing a CRM read's clothes — the `family` role is not
 * granted document access on this box. Second, applying is the act that turns
 * a machine's reading into a record other people will rely on, and the
 * consent for that was given by the owner who enabled filing.
 *
 * The MCP service principal is refused outright. There is no confirmation-gated
 * tool behind this and there is not going to be one: a model deciding which of
 * its own extractions to apply is the loop this whole design exists to keep a
 * human inside of.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";

import { requireRole } from "../middleware/auth.js";
import { assertSafeNcPath } from "../services/clips.service.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";
import { ncGetFileId } from "../services/nextcloud.client.js";
import {
  applyProposal,
  FILING_ERRORS,
  markNotSame,
  rejectProposal,
} from "../services/filing/apply.service.js";
import { parsePayload } from "../services/filing/payloads.js";
import { readFilingSettings, SETTING_ID } from "../services/filing/settings.js";

const REVIEWER = ["owner", "admin"] as const;

/** How many cards one page carries. The needs-a-look list is meant to be
 *  finished, not scrolled. */
const PAGE_SIZE = 50;

const listQuery = z.object({
  status: z.enum(["pending", "decided"]).default("pending"),
  cursor: z.string().uuid().optional(),
});

const applyBody = z
  .object({ chooseCompanyId: z.string().uuid().optional() })
  .strict();

const notSameBody = z.object({ companyId: z.string().uuid() }).strict();

/**
 * Turning filing on.
 *
 * `mode: "auto"` is accepted here and REFUSED BY THE DATABASE until an
 * extraction-eval canary has passed on this box's own model (WARP-2732's
 * `AutoFilingSetting_auto_requires_canary` CHECK). That is deliberate: the
 * refusal is an invariant, not a branch in a route that a later route could
 * forget to copy. The 422 below is the readable half of the same rule.
 *
 * `enabledById` and `enabledAt` are SERVER-STAMPED. A consent record whose
 * "who" and "when" came from the request body is not a consent record.
 */
const settingsBody = z
  .object({
    mode: z.enum(["off", "propose", "auto"]).optional(),
    level: z.enum(["links_only", "also_create"]).optional(),
    vertical: z.enum(["general", "healthcare"]).optional(),
    /** Path prefixes in scope. `[]` means "everywhere I can see". */
    folders: z.array(z.string().trim().min(1).max(4096)).max(50).optional(),
    /** Owner-editable, and an empty list restores the defaults rather than
     *  disabling the layer — see `readFilingSettings`. */
    pathDenylist: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .strict();

/** The deciding owner's real `User.id`. Null is not attribution-less here, it
 *  is a refusal: every filing decision has a person behind it. */
function actorOf(req: Request): string | null {
  const id = req.user?.id;
  if (!id || id.startsWith("_service:")) return null;
  return id;
}

function mapError(err: unknown, res: Response): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  switch (msg) {
    case FILING_ERRORS.PROPOSAL_NOT_FOUND:
      res.status(404).json({ error: msg });
      return true;
    case FILING_ERRORS.NOT_PENDING:
      // 409, not 404: the row is there and the caller's view of it is stale —
      // usually a second tab. The dashboard refreshes the list on a 409.
      res.status(409).json({ error: msg });
      return true;
    case FILING_ERRORS.NEVER_APPLIABLE:
    case FILING_ERRORS.PAYLOAD_UNREADABLE:
    case FILING_ERRORS.SOURCE_CHANGED:
    case FILING_ERRORS.CHOICE_REQUIRED:
    case FILING_ERRORS.CHOICE_NOT_OFFERED:
      // Well-formed request, refused on its merits. 422 rather than 400 so it
      // does not read as a malformed body the client could fix by retrying.
      res.status(422).json({ error: msg });
      return true;
    default:
      return false;
  }
}

/**
 * The card the dashboard renders.
 *
 * 🔴 `payload` is re-parsed through its kind's allow-list before it leaves the
 * box. A row that no longer validates is returned as `readable: false` with no
 * payload at all rather than being omitted — an owner who cannot see a card
 * cannot reject it, and a queue with an invisible permanent member is a queue
 * that stops being finishable.
 */
function toCard(row: {
  id: string;
  kind: Parameters<typeof parsePayload>[0];
  status: string;
  policyClass: string;
  policyReason: string | null;
  confidence: number;
  phiVerdict: string;
  matchKind: string;
  payload: unknown;
  evidence: unknown;
  sourceKind: string;
  ncFileId: number | null;
  createdAt: Date;
  decidedAt: Date | null;
}) {
  const payload = parsePayload(row.kind, row.payload);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    policyClass: row.policyClass,
    policyReason: row.policyReason,
    confidence: row.confidence,
    phiVerdict: row.phiVerdict,
    matchKind: row.matchKind,
    sourceKind: row.sourceKind,
    ncFileId: row.ncFileId,
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    readable: payload !== null,
    payload,
    // Quotes only reach a reviewer. They are nulled on reject/not-same, and on
    // a MENTIONS document they are already locator-only by the time they were
    // stored.
    evidence: row.status === "PENDING" ? (row.evidence ?? []) : [],
  };
}

/** Postgres surfaces a CHECK violation by NAME (unlike a unique violation,
 *  which names the FIELDS) — so matching on the constraint name is sound here
 *  in a way `P2002` matching never is. */
function isCheckViolation(err: unknown, needle: string): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes(needle);
}

export function createCrmFilingRouter(prisma: PrismaClient): Router {
  const router = Router();

  /** The banner on `/customers`: how many things are waiting. */
  router.get("/crm/filing/summary", requireRole(...REVIEWER), async (_req, res, next) => {
    try {
      const [settings, pending] = await Promise.all([
        readFilingSettings(prisma),
        prisma.ingestProposal.count({ where: { status: "PENDING" } }),
      ]);
      res.json({
        mode: settings.mode,
        level: settings.level,
        vertical: settings.vertical,
        enabled: settings.mode !== "off",
        pending,
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch("/crm/filing/settings", requireRole(...REVIEWER), async (req, res, next) => {
    const actorId = actorOf(req);
    if (!actorId) {
      res.status(403).json({ error: "human_reviewer_required" });
      return;
    }
    const parsed = settingsBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    const body = parsed.data;
    const turningOn = body.mode !== undefined && body.mode !== "off";

    try {
      await prisma.autoFilingSetting.upsert({
        where: { id: SETTING_ID },
        create: {
          id: SETTING_ID,
          mode: body.mode ?? "off",
          level: body.level ?? "links_only",
          vertical: body.vertical ?? "general",
          folders: body.folders ?? undefined,
          pathDenylist: body.pathDenylist ?? undefined,
          // Stamped on the way in, from the session — never from the body.
          enabledById: turningOn ? actorId : null,
          enabledAt: turningOn ? new Date() : null,
        },
        update: {
          ...(body.mode !== undefined ? { mode: body.mode } : {}),
          ...(body.level !== undefined ? { level: body.level } : {}),
          ...(body.vertical !== undefined ? { vertical: body.vertical } : {}),
          ...(body.folders !== undefined ? { folders: body.folders } : {}),
          ...(body.pathDenylist !== undefined ? { pathDenylist: body.pathDenylist } : {}),
          // 🔴 `enabledAt` is the BACKLOG BOUNDARY as well as the consent
          // stamp: the worker will not claim a source whose `updatedAt`
          // predates it. So it is set when filing is switched ON and left
          // alone otherwise — refreshing it on an unrelated settings edit
          // would silently retire everything that arrived in between.
          ...(turningOn ? { enabledById: actorId, enabledAt: new Date() } : {}),
          ...(body.mode === "off" ? { mode: "off" as const } : {}),
        },
      });
      res.json(await readFilingSettings(prisma));
    } catch (err) {
      // The canary CHECK. A 422 rather than a 500: the request is well-formed
      // and the answer is "not until this box has been measured".
      if (isCheckViolation(err, "AutoFilingSetting_auto_requires_canary")) {
        res.status(422).json({ error: "auto_needs_canary" });
        return;
      }
      next(err);
    }
  });

  router.get("/crm/filing/proposals", requireRole(...REVIEWER), async (req, res, next) => {
    const parsed = listQuery.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
      return;
    }
    try {
      const where =
        parsed.data.status === "pending"
          ? { status: "PENDING" as const }
          : { status: { not: "PENDING" as const } };
      const rows = await prisma.ingestProposal.findMany({
        where,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PAGE_SIZE + 1,
        ...(parsed.data.cursor ? { cursor: { id: parsed.data.cursor }, skip: 1 } : {}),
      });
      const page = rows.slice(0, PAGE_SIZE);
      res.json({
        proposals: page.map(toCard),
        nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1].id : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post(
    "/crm/filing/proposals/:id/apply",
    requireRole(...REVIEWER),
    async (req, res, next) => {
      const actorId = actorOf(req);
      if (!actorId) {
        res.status(403).json({ error: "human_reviewer_required" });
        return;
      }
      const parsed = applyBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }

      // The caller's OWN Nextcloud token, so the re-check is an authorization
      // check and not a lookup — the same split `crm-entity-links.ts` makes.
      // Fail closed: acting as admin by default would be a privilege
      // escalation dressed as a convenience.
      const token = await resolveNcToken(req);
      const ncUser = req.user?.username;
      if (!token || !ncUser) {
        res.status(401).json({ error: "nextcloud_session_required" });
        return;
      }

      try {
        const result = await applyProposal(
          prisma,
          req.params.id,
          {
            actorId,
            resolveFileId: async (filePath) => {
              // The stored path came from the file-indexer rather than from a
              // caller, but it is still a string being turned into a URL.
              // `webdavUrl()` percent-encodes each segment and does NOT reject
              // `..`, so the traversal defence every other Nextcloud path
              // caller applies is applied here too.
              let safe: string;
              try {
                safe = assertSafeNcPath(filePath).replace(/\/+/g, "/");
              } catch {
                return null;
              }
              return ncGetFileId(token, ncUser, safe);
            },
          },
          parsed.data,
        );
        res.status(200).json(result);
      } catch (err) {
        if (mapError(err, res)) return;
        next(err);
      }
    },
  );

  router.post(
    "/crm/filing/proposals/:id/reject",
    requireRole(...REVIEWER),
    async (req, res, next) => {
      const actorId = actorOf(req);
      if (!actorId) {
        res.status(403).json({ error: "human_reviewer_required" });
        return;
      }
      try {
        await rejectProposal(prisma, req.params.id, actorId);
        res.status(204).end();
      } catch (err) {
        if (mapError(err, res)) return;
        next(err);
      }
    },
  );

  router.post(
    "/crm/filing/proposals/:id/not-same",
    requireRole(...REVIEWER),
    async (req, res, next) => {
      const actorId = actorOf(req);
      if (!actorId) {
        res.status(403).json({ error: "human_reviewer_required" });
        return;
      }
      const parsed = notSameBody.safeParse(req.body ?? {});
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      try {
        await markNotSame(prisma, req.params.id, parsed.data.companyId, actorId);
        res.status(204).end();
      } catch (err) {
        if (mapError(err, res)) return;
        next(err);
      }
    },
  );

  return router;
}
