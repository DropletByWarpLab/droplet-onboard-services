/**
 * WARP-456 — Activity feed routes.
 *
 *   GET  /api/activity          — paginated, filterable list (AC5)
 *   POST /api/activity/export   — sealed JSON-Lines bundle (AC6)
 *   GET  /api/activity/verify   — server-side hash-chain walk (WARP-246)
 *
 * All routes are gated via `requireOwnerOrAdmin`: owner/admin humans,
 * plus (WARP-1443) the MCP server's pinned `_service:mcp` principal so
 * the list_threat_events LLM tool can read the feed — the tool side
 * enforces the human's forwarded owner/admin role before dispatching
 * (see the guard's comment below). The activity log can reveal
 * cross-user metadata (other family members' file activity, smart-home
 * commands) so guests/family are kept out.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { getActivitySigner } from "../services/activity.singleton.js";
import { verifyActivityChainCoalesced } from "../services/audit-verify.service.js";
import {
  hashSignature,
  type ActivityActorTypeName,
  type ActivityKindName,
  type ActivityRowContent,
  type ActivitySeverityName,
} from "../services/audit-signing.service.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";

/**
 * WARP-456: owner/admin gate for the activity surface. Same shape as
 * the local `isAdmin(req)` helper used by `admin-claude-activity.ts`
 * and `admin-claude-activity.ts` — keeps the RBAC contract uniform without needing a
 * generic middleware that doesn't exist in the codebase today.
 */
function requireOwnerOrAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // WARP-1443: additionally admit the MCP service principal
  // (`_service:mcp`, same id+role pin as requireRoleOrMcpService in
  // middleware/auth.ts) so the list_threat_events LLM tool can read the
  // feed. Defense split: this route only ever sees the service
  // principal, so the TOOL enforces the human's role (WARP-845
  // forwarded role, owner/admin only) before dispatching — the same
  // cross-user-metadata boundary this gate enforces for direct
  // dashboard calls. Human behavior below is byte-identical.
  if (req.user?.id === "_service:mcp" && req.user.role === "service") {
    next();
    return;
  }
  const role = req.user?.role;
  if (role === "owner" || role === "admin") {
    next();
    return;
  }
  res.status(403).json({ error: "owner or admin role required" });
}

const ACTIVITY_KINDS = [
  "chat",
  "tool_call",
  "file",
  "camera",
  "network",
  "smart_home",
  "email",
  "auth",
  "tool_run",
  "system",
  "voice",
] as const;

/** WARP-181: mirrors the Prisma `ActivityActorType` enum verbatim. */
const ACTIVITY_ACTOR_TYPES = ["user", "ai", "system", "anonymous"] as const;

const listQuerySchema = z.object({
  kind: z.enum(ACTIVITY_KINDS).optional(),
  /** WARP-181: filter by who performed the action. */
  actorType: z.enum(ACTIVITY_ACTOR_TYPES).optional(),
  /** WARP-181: filter by the canonical user UUID of the actor. */
  actorId: z.string().min(1).max(200).optional(),
  /** ISO-8601 lower bound (inclusive). */
  from: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || !Number.isNaN(Date.parse(v)),
      "from must be ISO-8601",
    ),
  /** ISO-8601 upper bound (exclusive). */
  to: z
    .string()
    .optional()
    .refine(
      (v) => v === undefined || !Number.isNaN(Date.parse(v)),
      "to must be ISO-8601",
    ),
  /** Free-text substring match on `what` / `sub`. */
  q: z.string().min(1).max(200).optional(),
  /** Page size. Capped at 200 to keep response payloads bounded. */
  limit: z.coerce.number().int().min(1).max(200).optional(),
  /**
   * Cursor — the `id` of the last row from the previous page. Rows are
   * sorted by `id` descending; the next page starts at `id < cursor`.
   * We use id (not `at`) because two rows in the same millisecond
   * would otherwise be ambiguous and the chain semantics require
   * stable ordering.
   */
  cursor: z.coerce.number().int().positive().optional(),
});

export function createActivityRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── GET /api/activity ──
  router.get(
    "/activity",
    requireOwnerOrAdmin,
    async (req, res, next) => {
      try {
        const parsed = listQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid query",
            details: parsed.error.flatten(),
          });
          return;
        }
        const { kind, actorType, actorId, from, to, q, limit = 50, cursor } =
          parsed.data;

        const where: Prisma.ActivityRowWhereInput = {};
        if (kind) where.kind = kind;
        if (actorType) where.actorType = actorType;
        if (actorId) where.actorId = actorId;
        // WARP-181: actor predicates only match signed rows — on v1 rows
        // the actor columns are unsigned (writable without breaking the
        // chain) and legitimately NULL, so any match would be tampered
        // data. Behavior-neutral for honest rows.
        if (actorType || actorId) where.schemaVersion = { gt: 1 };
        if (from || to) {
          where.at = {};
          if (from) where.at.gte = new Date(from);
          if (to) where.at.lt = new Date(to);
        }
        if (q) {
          // Case-insensitive substring across `what` and `sub`. Both
          // columns are TEXT — no full-text index, but the result set
          // is bounded by `limit` so a sequential scan within the
          // date+kind window is acceptable.
          where.OR = [
            { what: { contains: q, mode: "insensitive" } },
            { sub: { contains: q, mode: "insensitive" } },
          ];
        }
        if (cursor !== undefined) {
          // `id` is BigInt in Prisma; we use the raw arithmetic
          // operator. `lt` (less-than) is correct for descending
          // pagination — the cursor IS the previous page's tail row.
          where.id = { lt: BigInt(cursor) };
        }

        const rows = await prisma.activityRow.findMany({
          where,
          orderBy: { id: "desc" },
          take: limit,
        });

        // Serialize BigInt → string so JSON.stringify doesn't throw.
        // Clients parse it back to whatever numeric type they prefer;
        // the dashboard treats `id` as opaque (cursor only).
        const items = rows.map((r) => ({
          id: r.id.toString(),
          at: r.at.toISOString(),
          severity: r.severity,
          sourceIcon: r.sourceIcon,
          what: r.what,
          sub: r.sub,
          kind: r.kind,
          refs: r.refs,
          signature: r.signature,
          prevSignatureHash: r.prevSignatureHash,
          // WARP-181: on v1 rows the signature does NOT cover the actor
          // columns and the recorder never legitimately writes them
          // there — any stored value is tampering or a bug, so the
          // list API never serves it as truth. The export bundle (below)
          // stays verbatim-as-stored: rows carry schemaVersion, so an
          // offline verifier knows v1 actor fields are unsigned.
          actorType: r.schemaVersion === 1 ? null : r.actorType,
          actorId: r.schemaVersion === 1 ? null : r.actorId,
        }));

        const nextCursor =
          rows.length === limit ? rows[rows.length - 1]!.id.toString() : null;

        res.json({
          items,
          nextCursor,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/activity/verify ── (WARP-246)
  //
  // Walks the whole chain server-side and reports whether it is intact.
  // Verification CANNOT run client-side: the chain is HMAC-signed and
  // the key must never leave the box, so the dashboard's "verified"
  // badge is a rendering of THIS endpoint's result, not a client-side
  // re-derivation.
  //
  // Semantics mirror the recorder + the retention purge:
  //   - rows are read in ascending `id` order, chunked (PAGE=200, same
  //     bound as the export route) so memory stays flat at appliance
  //     scale;
  //   - the first row examined is the history origin: its stored
  //     `prevSignatureHash` is the anchor. Genesis rows carry "", and
  //     after a retention purge the surviving head references a purged
  //     signature — both are unverifiable by construction and trusted
  //     as the origin (see audit-retention-purge.service.ts);
  //   - every later row must link (`prevSignatureHash ===
  //     hashSignature(prev row's signature)`) AND its signature must
  //     verify over the canonical content + that hash.
  //
  // Walk stops at the first broken row: everything after an unverified
  // link is untrustworthy anyway, and stopping bounds the cost of
  // repeated re-verify clicks against a damaged table.
  router.get(
    "/activity/verify",
    // CodeQL js/missing-rate-limiting — the walk is O(rows) even when
    // coalesced (WARP-1027 only dedupes *concurrent* callers); a per-IP
    // ceiling stops one admin session from re-running it back to back.
    sensitiveRateLimit,
    requireOwnerOrAdmin,
    async (_req, res, next) => {
      try {
        const signer = getActivitySigner();
        if (!signer) {
          res.status(503).json({ error: "audit signer unavailable" });
          return;
        }

        // WARP-237: the chain walk now lives in audit-verify.service so
        // the nightly tamper-detection cron shares the exact same logic.
        // WARP-1027: coalesced so N concurrent admin tabs share one O(n) walk.
        // Response shape is byte-identical to the pre-extraction handler.
        const result = await verifyActivityChainCoalesced(prisma, signer);
        res.json({
          ok: result.ok,
          rowsChecked: result.rowsChecked,
          ...(result.brokenAtId === null
            ? {}
            : { brokenAtId: result.brokenAtId }),
          verifiedAt: new Date().toISOString(),
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/activity/export ──
  //
  // Returns a sealed JSON-Lines bundle of every row in scope plus the
  // public verification bytes. The client (or an offline verifier
  // tool) re-derives every row's signature using the bundled bytes
  // and the canonical-content shape from `audit-signing.service.ts`,
  // walking the chain forward. Tamper anywhere = chain breaks at
  // that row.
  //
  // The same filter shape as the list route is accepted in the body
  // so the operator can export a subset (e.g. "last 30 days of
  // auth events"). Default is the full chain.
  router.post(
    "/activity/export",
    requireOwnerOrAdmin,
    async (req, res, next) => {
      try {
        const parsed = listQuerySchema
          .omit({ limit: true, cursor: true })
          .safeParse(req.body ?? {});
        if (!parsed.success) {
          res.status(400).json({
            error: "Invalid export filter",
            details: parsed.error.flatten(),
          });
          return;
        }
        const { kind, actorType, actorId, from, to, q } = parsed.data;

        const where: Prisma.ActivityRowWhereInput = {};
        if (kind) where.kind = kind;
        if (actorType) where.actorType = actorType;
        if (actorId) where.actorId = actorId;
        // WARP-181: actor predicates only match signed rows (see the
        // list route) — a poisoned v1 row must not land in a filtered
        // export bundle either.
        if (actorType || actorId) where.schemaVersion = { gt: 1 };
        if (from || to) {
          where.at = {};
          if (from) where.at.gte = new Date(from);
          if (to) where.at.lt = new Date(to);
        }
        if (q) {
          where.OR = [
            { what: { contains: q, mode: "insensitive" } },
            { sub: { contains: q, mode: "insensitive" } },
          ];
        }

        const signer = getActivitySigner();
        const publicKey = signer
          ? signer.exportPublicBytes().toString("base64")
          : null;

        // Streaming JSON-Lines: the bundle is one row per line so a
        // verifier can process it incrementally without loading the
        // whole file into memory. First line is the manifest (algo,
        // device id, public key). Subsequent lines are rows ordered
        // by `id` ascending — same direction the chain was built —
        // so the verifier walks forward.
        res.setHeader("Content-Type", "application/x-ndjson");
        res.setHeader(
          "Content-Disposition",
          'attachment; filename="droplet-activity-bundle.jsonl"',
        );

        // WARP-181: bundle format v2 — rows are version-tagged
        // (`schemaVersion`) and carry signature-covered actor fields;
        // the offline verifier picks the canonical form PER ROW from
        // `schemaVersion` (v1 legacy 7-key, v2 actor-bearing 9-key).
        // The identifier is bumped so a v1-only verifier fails fast at
        // the manifest instead of reporting false tampering on v2 rows.
        const manifest = {
          type: "droplet.activity-bundle.v2",
          algorithm: "HMAC-SHA256",
          // The HMAC key bytes shipped here ARE symmetric — anyone
          // holding them can also forge. Documented in the spec
          // ("today: the HMAC key bytes; tomorrow: a TPM-attested
          // key"). The bundle is meant for the device owner.
          publicKey,
          exportedAt: new Date().toISOString(),
          filter: { kind, actorType, actorId, from, to, q },
        };
        res.write(JSON.stringify(manifest) + "\n");

        // Chunked read to keep memory bounded. Page size matches the
        // GET route's max so the verifier's per-batch cost is
        // predictable.
        const PAGE = 200;
        let cursor: bigint | undefined;
        for (;;) {
          const page = await prisma.activityRow.findMany({
            where: cursor
              ? { ...where, id: { gt: cursor } }
              : where,
            orderBy: { id: "asc" },
            take: PAGE,
          });
          if (page.length === 0) break;
          for (const r of page) {
            const out = {
              id: r.id.toString(),
              at: r.at.toISOString(),
              severity: r.severity,
              sourceIcon: r.sourceIcon,
              what: r.what,
              sub: r.sub,
              kind: r.kind,
              refs: r.refs,
              signature: r.signature,
              prevSignatureHash: r.prevSignatureHash,
              actorType: r.actorType,
              actorId: r.actorId,
              schemaVersion: r.schemaVersion,
            };
            res.write(JSON.stringify(out) + "\n");
          }
          cursor = page[page.length - 1]!.id;
          if (page.length < PAGE) break;
        }

        res.end();
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
