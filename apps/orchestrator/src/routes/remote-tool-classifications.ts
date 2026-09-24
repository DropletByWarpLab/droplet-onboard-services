/**
 * WARP-2426 (ADR-043 §2, ADR-056 I4) — the operator's surface over the
 * remote-tool classification record.
 *
 *   GET   /api/admin/remote-tools/classifications?serverId=   owner/admin
 *   PATCH /api/admin/remote-tools/classifications/:serverId/:toolName   owner
 *
 * The PATCH is the ONLY writer of `reviewedBy` / `reviewedAt`, and it is
 * owner-only on purpose: demoting a vendor's tool to a read, or blocking it,
 * is the box owner's decision about what leaves the LAN, not an admin's.
 * `reviewedBy` is the signed-in owner's username — never a body field, so a
 * review cannot be attributed to somebody else.
 *
 * Every accepted change refreshes the policy's cache in the same request, so
 * the next dispatch sees it; and writes a signed activity row, because a tool
 * becoming callable (or ceasing to be) is exactly the kind of event the audit
 * log exists to hold. `requireRole`, not `requireRoleOrMcpService`: no LLM
 * tool reaches this surface, and none should — a model must not be able to
 * classify the tools it is about to call.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  classifyRemoteTool,
  listRemoteToolClassifications,
  remoteToolClassificationCache,
  type ClassificationPrisma,
  type RemoteToolClassificationCache,
} from "../services/remote-tool-classification.service.js";

const classifySchema = z.object({
  requiresWrite: z.boolean(),
  requiresConfirmation: z.boolean(),
  denied: z.boolean(),
  // WARP-2900 — the input-schema hash of the tool the owner was shown
  // (sha256 hex, from the GET). A reset in between → 409 STALE_REVIEW.
  inputSchemaHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

/** Same bounds the multiplexer applies to what it will namespace. */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface RemoteToolClassificationsRouterDeps {
  /** Injectable so the route test refreshes a private cache, not the process-wide one. */
  cache?: RemoteToolClassificationCache;
}

export function createRemoteToolClassificationsRouter(
  prisma: PrismaClient,
  deps: RemoteToolClassificationsRouterDeps = {},
): Router {
  const router = Router();
  const cache = deps.cache ?? remoteToolClassificationCache;
  const db = prisma as ClassificationPrisma;

  router.get(
    "/admin/remote-tools/classifications",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const serverId = typeof req.query.serverId === "string" ? req.query.serverId : undefined;
        if (serverId !== undefined && !SERVER_ID.test(serverId)) {
          res.status(400).json({ error: "Invalid serverId" });
          return;
        }
        const rows = await listRemoteToolClassifications(db, serverId);
        res.json({ classifications: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/admin/remote-tools/classifications/:serverId/:toolName",
    requireRole("owner"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { serverId, toolName } = req.params;
        if (!SERVER_ID.test(serverId) || !TOOL_NAME.test(toolName)) {
          res.status(400).json({ error: "Invalid serverId or toolName" });
          return;
        }
        const parsed = classifySchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid classification", details: parsed.error.flatten() });
          return;
        }
        const reviewedBy = req.user?.username ?? "";
        const { inputSchemaHash, ...decision } = parsed.data;
        const result = await classifyRemoteTool(db, {
          serverId,
          toolName,
          ...decision,
          reviewedBy,
          ...(inputSchemaHash !== undefined ? { expectedInputSchemaHash: inputSchemaHash } : {}),
        });
        if (!result.ok) {
          const status = result.code === "NOT_FOUND" ? 404 : result.code === "STALE_REVIEW" ? 409 : 400;
          res.status(status).json({ error: result.code, message: result.message });
          return;
        }
        // The policy reads the cache; the decision is live from this request on.
        await cache.refresh(db);
        const disposition = result.row.denied
          ? "blocked"
          : result.row.requiresWrite
            ? "write, asks first"
            : "read";
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: `Remote tool classified: ${disposition}`,
          sub: `${serverId} · ${toolName}`,
          actor: actorFromRequest(req),
          refs: {
            serverId,
            toolName,
            requiresWrite: result.row.requiresWrite,
            requiresConfirmation: result.row.requiresConfirmation,
            denied: result.row.denied,
          },
        });
        res.json({ classification: result.row });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
