/**
 * `/api/money` — what the business is owed, and what it owes (WARP-2581).
 *
 * Read-only, by design and not by omission. The vendor stays the system of
 * record: a landed document is a copy for looking at, and the place it gets
 * changed is the accounting package it came from. There is no POST, PATCH or
 * DELETE here, and adding one would mean answering how a write reconciles with
 * the next sync — a question `ErpWriteRequest`'s outbox exists to answer for
 * the ERP tracks and which this surface deliberately does not reopen.
 *
 * Gated by the `money` module (registry `routePrefixes`), so a box that does
 * not do its books here has no such surface at all rather than an empty one.
 * `requireRole("owner", "admin", "family")` on top, matching the §9 ladder's
 * `view` floor: the front desk chasing an unpaid invoice is the ordinary use of
 * this surface. `guest` is refused — a household guest has no business reading
 * the practice's receivables — and the per-person feature gate narrows from
 * there.
 *
 * `/money/documents` uses `requireRoleOrMcpService` with that SAME role tuple,
 * not a wider one: `money_list_open_documents` dispatches through it as the
 * pinned `_service:mcp` principal, and a plain `requireRole` would 403 the tool
 * on every call — the dead-tool class `TOOL_ROUTES` and
 * `tools-mcp-admission.test.ts` exist to make impossible. Human RBAC is
 * unchanged: the guard defers to `requireRole("owner", "admin", "family")` for
 * everyone who is not that one service id at the `service` role.
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";

import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import {
  createMoneyService,
  MONEY_PAGE_LIMIT,
  type MoneyKind,
} from "../services/money/money.service.js";

/** `?kind=` accepts the two words a person would type, not the enum's casing. */
function kindFrom(req: Request): MoneyKind | undefined {
  const raw = typeof req.query.kind === "string" ? req.query.kind.toLowerCase() : "";
  if (raw === "receivable" || raw === "owed_to_us") return "RECEIVABLE";
  if (raw === "payable" || raw === "owed_by_us") return "PAYABLE";
  return undefined;
}

function limitFrom(req: Request): number {
  const raw = Number.parseInt(String(req.query.limit ?? ""), 10);
  if (!Number.isFinite(raw) || raw <= 0) return MONEY_PAGE_LIMIT;
  return Math.min(raw, MONEY_PAGE_LIMIT);
}

export function createMoneyRouter(prisma: PrismaClient, now: () => Date = () => new Date()): Router {
  const router = Router();
  const money = createMoneyService(prisma);

  /**
   * The summary the `/money` page and the Reports tile read.
   *
   * 🔴 There is no total across ledgers in this response, and that absence is
   * the contract. A document's currency is usually NULL — `invoice` and `bill`
   * are exempt from the money-needs-a-currency rule because a company file has
   * one home currency — so adding two connections' figures produces a
   * confident wrong number. `ledgers[]` is per connection and per currency, and
   * a caller that wants one number has to choose which ledger it is about.
   */
  router.get("/money", requireRole("owner", "admin", "family"), async (_req: Request, res: Response, next) => {
    try {
      res.json(await money.summary(now()));
    } catch (err) {
      next(err);
    }
  });

  /**
   * The documents themselves.
   *
   * `?kind=receivable|payable`, `?overdue=1`, `?limit=` (capped). Settled
   * documents — balance zero — are never listed: this surface answers "what is
   * outstanding", and a paid invoice is history the vendor's own app keeps. A
   * document whose balance could not be read IS listed, because dropping money
   * the business may still owe is the worse of the two errors.
   */
  router.get(
    "/money/documents",
    requireRoleOrMcpService("owner", "admin", "family"),
    async (req: Request, res: Response, next) => {
      try {
        const documents = await money.documents({
          kind: kindFrom(req),
          overdueOnly: req.query.overdue === "1" || req.query.overdue === "true",
          limit: limitFrom(req),
          now: now(),
        });
        res.json({ documents });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
