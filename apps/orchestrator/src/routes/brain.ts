/**
 * WARP-2749 / WARP-2752 (ADR-051) — reading the brain.
 *
 *   GET   /api/brain/findings         open findings, biggest money first
 *   GET   /api/brain/digests          the standing understanding
 *   GET   /api/brain/coverage         how much has actually been read
 *   PATCH /api/brain/findings/:id     acknowledge / action / dismiss / assign
 *
 * WHO. `requireRoleOrMcpService("owner", "admin")`, the agent-runs posture, so
 * the `_service:mcp` principal can reach here on behalf of a chat user whose
 * own role is checked exactly as a browser caller's is. The brain is an
 * owner/admin capability by design (ADR-051 §9): `company`-scope rows are
 * derived from the whole business corpus, and a `family` or `guest` reader must
 * never see them.
 *
 * THE ROLE GATE HERE IS NOT THE ONLY GATE, AND MUST NOT BE. Every read composes
 * `visibleScopeFilter`, which resolves the caller's readable departments and
 * admits `company` only for owner/admin. So even if this route were later
 * opened to another role, a family member would still not see a company-scope
 * row — the filter is in the service, next to the data, rather than in the
 * middleware where a future route could forget it.
 *
 * COVERAGE IS A FIRST-CLASS RESPONSE, not a debug endpoint. An operator who
 * believes the brain has read everything stops trusting it the first time it
 * misses something. `/coverage` reports units seen, units digested, last run,
 * last error and whether each pass is even enabled — so "it has read 240 of
 * your 5,000 documents" is answerable rather than assumed.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRoleOrMcpService, type AuthUser } from "../middleware/auth.js";
import {
  listDigests,
  listFindings,
  setFindingStatus,
} from "../services/brain/brain-digest.service.js";
import { DETECTOR_PASS_KEY } from "../services/brain/brain-pass.service.js";
import { CORPUS_PASS_KEY } from "../services/brain/brain-corpus.service.js";

/** Maps the service's stable error codes to HTTP, mirroring crm.ts. */
const STATUS_BY_CODE: Record<string, number> = {
  finding_not_found: 404,
  dismissal_needs_reason: 400,
  evidence_required: 400,
  confidence_out_of_range: 400,
  impact_needs_currency: 400,
  scope_department_mismatch: 400,
  invalid_detector_key: 400,
};

function fail(res: Response, err: unknown, next: NextFunction): void {
  const code = err instanceof Error ? err.message : "";
  const status = STATUS_BY_CODE[code];
  if (status) {
    res.status(status).json({ error: code });
    return;
  }
  next(err);
}

/** The acting human. The mcp service principal names the person it acts for;
 *  everything downstream scopes on THAT id, never on `_service:mcp`. */
function callerOf(req: Request): { id: string; role: string } {
  const user = req.user as AuthUser | undefined;
  return { id: user?.id ?? "", role: user?.role ?? "" };
}

const patchSchema = z.object({
  status: z.enum(["new", "acknowledged", "actioned", "dismissed", "stale"]),
  dismissedReason: z.string().max(500).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

export function createBrainRouter(prisma: PrismaClient): Router {
  const router = Router();
  const gate = requireRoleOrMcpService("owner", "admin");

  router.get("/brain/findings", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
      const { rows, total } = await listFindings(prisma, callerOf(req), {
        status: status as "new" | undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      // BigInt is not JSON-serialisable and Express would throw on it — the
      // amount goes out as a string, the `CrmDeal.amountMinor` wire shape.
      res.json({
        findings: rows.map((f) => ({
          ...f,
          impactMinor: f.impactMinor === null ? null : String(f.impactMinor),
        })),
        total,
      });
    } catch (err) {
      fail(res, err, next);
    }
  });

  router.get("/brain/digests", gate, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
      const limit = Number.parseInt(String(req.query.limit ?? ""), 10);
      const { rows, total } = await listDigests(prisma, callerOf(req), {
        kind: kind as "entity" | undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json({ digests: rows, total });
    } catch (err) {
      fail(res, err, next);
    }
  });

  router.get("/brain/coverage", gate, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const passes = await prisma.brainPass.findMany({
        where: { passKey: { in: [DETECTOR_PASS_KEY, CORPUS_PASS_KEY] } },
      });
      // How much there is to read, so "digested" has a denominator. Without it
      // the number is a count with no scale and reads as completeness.
      const totalIndexed = await prisma.fileIndexStatus.count({ where: { status: "ready" } });
      res.json({
        passes: passes.map((p) => ({
          passKey: p.passKey,
          enabled: p.enabled,
          lastRunAt: p.lastRunAt,
          lastSucceededAt: p.lastSucceededAt,
          lastError: p.lastError,
          unitsSeen: p.unitsSeen,
          unitsDigested: p.unitsDigested,
          rowsWritten: p.rowsWritten,
        })),
        corpus: {
          documentsReady: totalIndexed,
          documentsDigested:
            passes.find((p) => p.passKey === CORPUS_PASS_KEY)?.unitsDigested ?? 0,
        },
      });
    } catch (err) {
      fail(res, err, next);
    }
  });

  router.patch(
    "/brain/findings/:id",
    gate,
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = patchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      try {
        // Visibility is re-checked inside `setFindingStatus`: a caller who
        // cannot READ a finding must not be able to dismiss it by guessing an
        // id, and the list filter is not an authorization check for this one.
        await setFindingStatus(prisma, callerOf(req), req.params.id!, parsed.data);
        res.status(204).end();
      } catch (err) {
        fail(res, err, next);
      }
    },
  );

  return router;
}
