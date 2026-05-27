/**
 * Autonomous-proposals inbox — WARP-399.
 *
 * Backs the ops-console "pending operator approval" surface. Lists
 * Tier-2 tool calls that an autonomous agent run (smart-port-agent
 * today, others later) staged for human review instead of dispatching.
 *
 * Roles
 * -----
 * Owner / admin only. The proposal payload includes the tool name and
 * arguments — those can carry IPs, hostnames, vendor identifiers, and
 * (after Phase 2) explicit operator-supplied passwords. Not a family /
 * guest surface.
 *
 * What approve does NOT do (v1 scope)
 * -----------------------------------
 * Approving here flips `status` to `approved` and stamps the operator's
 * userId + resolvedAt — it does NOT re-dispatch the tool automatically.
 * The intentional ship-cut: the autonomous agent stages reasoning + a
 * proposed action; the operator looks at the trace and either runs the
 * action themselves through the dashboard chat in interactive mode (where
 * the existing Tier-2 confirm-modal path handles it), or rejects it.
 *
 * A later iteration can wire approve → tool re-dispatch with a
 * `bypass_confirmation` header that the service-side honours when the
 * call carries the proposal id. That requires camera-discovery + switch
 * service changes that are out of Phase 4 scope.
 */

import { Router, type Request, type Response } from "express";
import { PrismaClient } from "@prisma/client";
import pino from "pino";

const logger = pino({ name: "autonomous-proposals" });

function isAdmin(req: Request): boolean {
  const role = req.user?.role;
  return role === "owner" || role === "admin";
}

export function createAutonomousProposalsRouter(prisma: PrismaClient): Router {
  const router = Router();

  // List proposals. Default: pending only. Query params:
  //   status=pending|approved|rejected|expired (csv ok)
  //   domain=smart_port (csv ok)
  //   limit=1..200 (default 50)
  router.get("/autonomous-proposals", async (req, res, next) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: "Admin role required" });
      }
      const status = parseCsv(req.query.status) ?? ["pending"];
      const domain = parseCsv(req.query.domain);
      const limitRaw = Number(req.query.limit ?? 50);
      const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(200, Math.floor(limitRaw))) : 50;

      const rows = await prisma.autonomousProposal.findMany({
        where: {
          status: { in: status },
          ...(domain ? { domain: { in: domain } } : {}),
        },
        orderBy: { createdAt: "desc" },
        take: limit,
      });

      // Attach the linked CommandAuditLog row for each proposal so the
      // dashboard drawer can render the agent's reasoning trace without
      // a second round-trip. Best-effort: a missing audit row (purged,
      // never written) is fine.
      const agentRunIds = [...new Set(rows.map((r) => r.agentRunId))];
      const audits = await prisma.commandAuditLog.findMany({
        where: { id: { in: agentRunIds } },
      });
      const auditById = new Map(audits.map((a) => [a.id, a]));

      return res.json({
        proposals: rows.map((r) => ({
          id: r.id,
          domain: r.domain,
          entityId: r.entityId,
          toolName: r.toolName,
          toolArgs: r.toolArgs,
          tier: r.tier,
          status: r.status,
          resolvedByUserId: r.resolvedByUserId,
          resolvedAt: r.resolvedAt?.toISOString() ?? null,
          expiresAt: r.expiresAt.toISOString(),
          createdAt: r.createdAt.toISOString(),
          agentRunId: r.agentRunId,
          agentRun: auditById.get(r.agentRunId)
            ? {
                id: auditById.get(r.agentRunId)!.id,
                domain: auditById.get(r.agentRunId)!.domain,
                createdAt: auditById.get(r.agentRunId)!.createdAt.toISOString(),
                reason: auditById.get(r.agentRunId)!.reason,
                data: auditById.get(r.agentRunId)!.data,
              }
            : null,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/autonomous-proposals/:id/approve", async (req, res, next) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: "Admin role required" });
      }
      const updated = await resolveProposal(prisma, req, res, "approved");
      if (!updated) return; // resolveProposal already sent the error
      logger.info(
        {
          id: updated.id,
          toolName: updated.toolName,
          operator: req.user?.username,
        },
        "autonomous proposal approved (action NOT auto-dispatched in v1)",
      );
      return res.json({
        proposal: serialise(updated),
        next_action:
          "Approval is staged. The autonomous agent will NOT re-run the tool. Run the action interactively from the dashboard to execute it through the standard Tier-2 confirm modal.",
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/autonomous-proposals/:id/reject", async (req, res, next) => {
    try {
      if (!isAdmin(req)) {
        return res.status(403).json({ error: "Admin role required" });
      }
      const updated = await resolveProposal(prisma, req, res, "rejected");
      if (!updated) return;
      logger.info(
        {
          id: updated.id,
          toolName: updated.toolName,
          operator: req.user?.username,
        },
        "autonomous proposal rejected",
      );
      return res.json({ proposal: serialise(updated) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

async function resolveProposal(
  prisma: PrismaClient,
  req: Request,
  res: Response,
  newStatus: "approved" | "rejected",
) {
  const id = req.params.id;
  if (!id || typeof id !== "string") {
    res.status(400).json({ error: "id required" });
    return null;
  }

  // Atomic transition: only flip the row if it's still `pending`. A
  // findUnique + update split lets two concurrent ops-console tabs
  // (or operator + expiry-sweep) both pass the guard and overwrite
  // each other silently. updateMany with the status filter pushes
  // the check into the DB statement.
  const updated = await prisma.autonomousProposal.updateMany({
    where: { id, status: "pending" },
    data: {
      status: newStatus,
      resolvedByUserId: req.user?.id ?? null,
      resolvedAt: new Date(),
    },
  });

  if (updated.count === 0) {
    // count=0 collapses two cases: the row doesn't exist at all, OR
    // it does but is no longer pending (concurrent resolve / sweep
    // expired it). One follow-up read disambiguates so the operator
    // gets a useful 404 vs 409 instead of a generic conflict.
    const existing = await prisma.autonomousProposal.findUnique({
      where: { id },
    });
    if (!existing) {
      res.status(404).json({ error: "proposal not found" });
      return null;
    }
    res.status(409).json({
      error: `proposal is already ${existing.status}; cannot transition to ${newStatus}`,
    });
    return null;
  }

  // Won the race — return the persisted row so the route can serialise it.
  return prisma.autonomousProposal.findUniqueOrThrow({ where: { id } });
}

function serialise(row: {
  id: string;
  domain: string;
  entityId: string;
  toolName: string;
  toolArgs: unknown;
  tier: number;
  status: string;
  resolvedByUserId: string | null;
  resolvedAt: Date | null;
  expiresAt: Date;
  agentRunId: string;
  createdAt: Date;
}) {
  return {
    id: row.id,
    domain: row.domain,
    entityId: row.entityId,
    toolName: row.toolName,
    toolArgs: row.toolArgs,
    tier: row.tier,
    status: row.status,
    resolvedByUserId: row.resolvedByUserId,
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt.toISOString(),
    agentRunId: row.agentRunId,
    createdAt: row.createdAt.toISOString(),
  };
}

function parseCsv(v: unknown): string[] | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
