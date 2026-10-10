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
 *
 * WARP-3205 — an `ext-*` row in the GET also carries what the owner's review
 * of that tool is shown (services/extension-tool-review.service.ts): the
 * input schema and signed description its review hash names, read from the
 * extension's current signed manifest (both null when that manifest does not
 * produce the row's hash), and what dispatch does with a call. The dashboard
 * sends the hash back with the decision.
 */
import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import {
  classifyRemoteTool,
  gradeFromDb,
  listRemoteToolClassifications,
  permissionOf,
  remoteToolClassificationCache,
  setRemoteToolAllowlisted,
  setRemoteToolGroupPermission,
  setRemoteToolPermission,
  type ClassificationPrisma,
  type RemoteToolClassificationCache,
  type RemoteToolClassificationRow,
} from "../services/remote-tool-classification.service.js";
import {
  withExtensionToolReview,
  type ExtensionToolReviewPrisma,
  type ReviewedClassificationRow,
} from "../services/extension-tool-review.service.js";

const classifySchema = z.object({
  requiresWrite: z.boolean(),
  requiresConfirmation: z.boolean(),
  denied: z.boolean(),
  // WARP-2900 — the input-schema hash of the tool the owner was shown
  // (sha256 hex, from the GET). A reset in between → 409 STALE_REVIEW.
  inputSchemaHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});

const allowlistSchema = z.object({ allowlisted: z.boolean() }).strict();

/** Same bounds the multiplexer applies to what it will namespace. */
const SERVER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface RemoteToolClassificationsRouterDeps {
  /** Injectable so the route test refreshes a private cache, not the process-wide one. */
  cache?: RemoteToolClassificationCache;
  /** WARP-3205 — the review fields on `ext-*` rows. Defaults to the signed manifests in `prisma`. */
  toolReview?: (rows: RemoteToolClassificationRow[]) => Promise<ReviewedClassificationRow[]>;
}

export function createRemoteToolClassificationsRouter(
  prisma: PrismaClient,
  deps: RemoteToolClassificationsRouterDeps = {},
): Router {
  const router = Router();
  const cache = deps.cache ?? remoteToolClassificationCache;
  const db = prisma as ClassificationPrisma;
  const toolReview =
    deps.toolReview ?? ((rows) => withExtensionToolReview(prisma as ExtensionToolReviewPrisma, rows));

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
        // WARP-3962 — `grade` (read|write|destructive) and `permission`
        // (always|ask|block) per row; the DB enum is replaced by its lowercase wire value.
        const reviewed = await toolReview(rows);
        res.json({
          classifications: reviewed.map((r) => ({ ...r, grade: gradeFromDb(r.grade), permission: permissionOf(r) })),
        });
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
            // WARP-3205 — the review hash the decision is bound to (for an
            // `ext-*` tool, its description + input schema), so the audit
            // trail names what content was reviewed. Null for a vendor row
            // recorded without one.
            inputSchemaHash: result.row.inputSchemaHash,
          },
        });
        res.json({ classification: result.row });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-3962 — tool permissions, bound to the product contract: "reads run
  // automatically, writes ask for a thumbs-up, destructive actions are
  // blocked." Owner OR admin; an admin may only tighten (always → ask →
  // block). The service validates the permission against the tool's grade.
  // `:serverId` is the registry server id (= the connector directory id).
  const permissionBody = z
    .object({
      permission: z.enum(["always", "ask", "block"]),
      inputSchemaHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    })
    .strict();
  const groupBody = z
    .object({ group: z.enum(["read", "write"]), permission: z.enum(["always", "ask", "block"]) })
    .strict();
  const failStatus: Record<string, number> = {
    NOT_FOUND: 404,
    NO_REVIEWER: 400,
    PERMISSION_NOT_ALLOWED_FOR_GRADE: 400,
    ADMIN_CAN_ONLY_TIGHTEN: 403,
    STALE_REVIEW: 409,
  };
  const failToken = (code: string): string =>
    code === "PERMISSION_NOT_ALLOWED_FOR_GRADE"
      ? "permission_not_allowed_for_grade"
      : code === "ADMIN_CAN_ONLY_TIGHTEN"
        ? "admin_can_only_tighten"
        : code === "STALE_REVIEW"
          ? "stale_review"
          : code === "NOT_FOUND"
            ? "not_found"
            : "invalid_request";
  const actorOf = (req: Request) => ({ id: req.user?.username ?? "", role: req.user?.role ?? "" });
  const label = (p: string) => (p === "always" ? "always allowed" : p === "ask" ? "asks first" : "blocked");

  router.patch(
    "/admin/remote-tools/permissions/:serverId/:toolName",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { serverId, toolName } = req.params;
        if (!SERVER_ID.test(serverId) || !TOOL_NAME.test(toolName)) {
          res.status(400).json({ error: "invalid_request", message: "Invalid serverId or toolName" });
          return;
        }
        const parsed = permissionBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
          return;
        }
        const result = await setRemoteToolPermission(db, {
          serverId,
          toolName,
          permission: parsed.data.permission,
          actor: actorOf(req),
          ...(parsed.data.inputSchemaHash !== undefined ? { inputSchemaHash: parsed.data.inputSchemaHash } : {}),
        });
        if (!result.ok) {
          res.status(failStatus[result.code] ?? 400).json({ error: failToken(result.code), message: result.message });
          return;
        }
        await cache.refresh(db);
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: `Remote tool permission: ${label(parsed.data.permission)}`,
          sub: `${serverId} · ${toolName}`,
          actor: actorFromRequest(req),
          refs: {
            serverId,
            toolName,
            grade: result.grade,
            permission: parsed.data.permission,
            previous: result.before,
            inputSchemaHash: result.row.inputSchemaHash,
          },
        });
        res.json({
          tool: {
            name: toolName,
            grade: result.grade,
            permission: permissionOf(result.row),
            changed: result.before !== parsed.data.permission,
          },
        });
      } catch (err) {
        next(err);
      }
    },
  );

  router.patch(
    "/admin/remote-tools/permissions/:serverId",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { serverId } = req.params;
        if (!SERVER_ID.test(serverId)) {
          res.status(400).json({ error: "invalid_request", message: "Invalid serverId" });
          return;
        }
        const parsed = groupBody.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
          return;
        }
        const result = await setRemoteToolGroupPermission(db, { serverId, ...parsed.data, actor: actorOf(req) });
        if (!result.ok) {
          res.status(failStatus[result.code] ?? 400).json({ error: failToken(result.code), message: result.message });
          return;
        }
        await cache.refresh(db);
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: `Remote ${parsed.data.group} tools: ${label(parsed.data.permission)}`,
          sub: serverId,
          actor: actorFromRequest(req),
          refs: { serverId, group: parsed.data.group, permission: parsed.data.permission, changed: result.changed.length },
        });
        res.json({ group: parsed.data.group, permission: parsed.data.permission, changed: result.changed, skipped: result.skipped });
      } catch (err) {
        next(err);
      }
    },
  );

  // WARP-2434 — the per-server tool allowlist. Owner OR admin (unlike the
  // classification PATCH above): which of a server's tools reach the model is an
  // operating decision, not a privilege review. A separate column and a
  // separate writer — nothing here touches `requiresWrite`/`denied`, so an
  // allowlisted tool is still subject to the classification policy behind it.
  // `requireRole`, not `requireRoleOrMcpService`: no LLM tool changes it.
  router.put(
    "/admin/remote-tools/allowlist/:serverId/:toolName",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { serverId, toolName } = req.params;
        if (!SERVER_ID.test(serverId) || !TOOL_NAME.test(toolName)) {
          res.status(400).json({ error: "Invalid serverId or toolName" });
          return;
        }
        const parsed = allowlistSchema.safeParse(req.body);
        if (!parsed.success) {
          res.status(400).json({ error: "Invalid allowlist change", details: parsed.error.flatten() });
          return;
        }
        const result = await setRemoteToolAllowlisted(db, {
          serverId,
          toolName,
          allowlisted: parsed.data.allowlisted,
        });
        if (!result.ok) {
          res.status(404).json({ error: result.code });
          return;
        }
        // Dispatch and the offered list read the cache; live from this request on.
        await cache.refresh(db);
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "shield",
          what: `Remote tool ${result.row.allowlisted ? "allowlisted" : "removed from the allowlist"}`,
          sub: `${serverId} · ${toolName}`,
          actor: actorFromRequest(req),
          refs: { serverId, toolName, allowlisted: result.row.allowlisted === true },
        });
        res.json({ classification: result.row });
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
