/**
 * ADR-055 (P4a) — the doors control-plane API.
 *
 *    1  GET   /api/doors                  list doors          owner, admin
 *    2  GET   /api/doors/events           recent events       owner, admin
 *    3  POST  /api/doors                  create a door       owner ONLY
 *    4  PATCH /api/doors/:id              update a door       owner ONLY
 *    5  POST  /api/doors/:id/retire       retire a door       owner ONLY
 *
 * Mounted at "/api" in app.ts, behind the `doors` module gates that
 * `mountModuleGates` derives from the registry prefix `/api/doors`: the
 * box-wide toggle (which is DOORS_ENABLED — off means these routes do not
 * exist, 404 `module_disabled`) and the per-person `doors` grant at `view`
 * (the module is in FEATURE_GATED_MODULES). Every route below adds a role
 * guard of its own, so no route is reachable on the module gate alone.
 *
 * WHO. Reads floor at `admin`: with no per-door-group grants yet (§11.4 — they
 * depend on AC-017) the module's own grant is the only narrowing, and access
 * logs identify people entering places at times, so this is default-deny.
 * Writes are `owner` alone (§11.4: "Not admin"). No route admits the MCP
 * service principal: the assistant has no doors tool in P4a, and §11.5 says
 * it may never change a door. The read tools arrive in P4b, when the module
 * goes live, and will need their own admission and acting-user gate then.
 *
 * Literal paths come before `:id` paths. Errors are `{error: {code, message,
 * issues?}}` (the dashboard's apiFetch shape), and a failed read is a 503,
 * never an empty 200 that reads as "no doors".
 */
import { Router, type Request, type Response } from "express";
import type { PrismaClient } from "@prisma/client";
import { z } from "zod";
import { requireRole } from "../middleware/auth.js";
import { sensitiveRateLimit } from "../middleware/rate-limit.js";
import {
  DOOR_EVENTS_DEFAULT_LIMIT,
  DOOR_EVENTS_MAX_LIMIT,
  DoorWriteError,
  HELD_OPEN_MAX_SECONDS,
  HELD_OPEN_MIN_SECONDS,
  createDoor,
  listDoorEvents,
  listDoors,
  parseEventCursor,
  retireDoor,
  updateDoor,
} from "../services/doors.service.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("doors-routes");

/**
 * Reads floor at admin: with no per-door-group grants yet (§11.4 — they depend
 * on AC-017) the module's own grant is the only narrowing, and access logs
 * identify people entering places at times. Default-deny; widening to `family`
 * is this list and the access catalog's `view` floor. Writes are the owner
 * alone (§11.4: "Not admin").
 */
const READ_ROLES = ["owner", "admin"] as const;
const WRITE_ROLES = ["owner"] as const;

const source = z.enum(["lock", "dp1", "none"]);
/** Raw cap before normalising — the real rule (1–80 characters, nothing that reorders text) is normaliseDoorName's. */
const rawName = z.string().max(240);
const heldOpenSeconds = z.number().int().min(HELD_OPEN_MIN_SECONDS).max(HELD_OPEN_MAX_SECONDS);

const listQuery = z.object({ include: z.literal("retired").optional() }).strict();
const eventsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(DOOR_EVENTS_MAX_LIMIT).default(DOOR_EVENTS_DEFAULT_LIMIT),
    cursor: z.string().max(40).optional(),
    door: z.string().uuid().optional(),
  })
  .strict();
const createBody = z.object({ name: rawName, doorPositionSource: source, heldOpenSeconds: heldOpenSeconds.optional() }).strict();
const patchBody = z
  .object({ name: rawName.optional(), doorPositionSource: source.optional(), heldOpenSeconds: heldOpenSeconds.optional() })
  .strict()
  .refine((b) => b.name !== undefined || b.doorPositionSource !== undefined || b.heldOpenSeconds !== undefined, {
    message: "name, doorPositionSource or heldOpenSeconds is required",
  });
const idParam = z.string().uuid();

type ErrorCode = DoorWriteError["code"] | "VALIDATION_ERROR" | "DOORS_UNAVAILABLE";

function fail(res: Response, status: number, code: ErrorCode, message: string, issues?: unknown[]): void {
  res.status(status).json({ error: { code, message, ...(issues ? { issues } : {}) } });
}

function invalid(res: Response, issues: unknown[]): void {
  fail(res, 400, "VALIDATION_ERROR", "The request is not valid", issues);
}

function answerError(res: Response, err: unknown, what: string): void {
  if (err instanceof DoorWriteError) {
    fail(res, err.status, err.code, err.message);
    return;
  }
  logger.error({ err }, `${what} failed`);
  fail(res, 503, "DOORS_UNAVAILABLE", "Doors are unavailable right now");
}

export interface DoorsRouteDeps {
  now?: () => Date;
}

export function createDoorsRouter(prisma: PrismaClient, deps: DoorsRouteDeps = {}): Router {
  const router = Router();
  const read = requireRole(...READ_ROLES);
  /** Built per route, so each write carries its own gate. */
  const write = () => [sensitiveRateLimit, requireRole(...WRITE_ROLES)];
  const ctx = (req: Request) => ({ req, now: deps.now?.() ?? new Date() });

  // ── 1. the doors ──────────────────────────────────────────────────────
  router.get("/doors", read, async (req: Request, res: Response) => {
    const q = listQuery.safeParse(req.query);
    if (!q.success) {
      invalid(res, q.error.issues);
      return;
    }
    try {
      res.json({ doors: await listDoors(prisma, { includeRetired: q.data.include === "retired" }) });
    } catch (err) {
      answerError(res, err, "list doors");
    }
  });

  // ── 2. what happened at them ──────────────────────────────────────────
  router.get("/doors/events", read, async (req: Request, res: Response) => {
    const q = eventsQuery.safeParse(req.query);
    if (!q.success) {
      invalid(res, q.error.issues);
      return;
    }
    const cursor = q.data.cursor ? parseEventCursor(q.data.cursor) : undefined;
    if (q.data.cursor && !cursor) {
      invalid(res, [{ path: ["cursor"], message: "bad cursor" }]);
      return;
    }
    try {
      res.json(
        await listDoorEvents(prisma, {
          limit: q.data.limit,
          ...(cursor ? { cursor } : {}),
          ...(q.data.door ? { doorId: q.data.door } : {}),
        }),
      );
    } catch (err) {
      answerError(res, err, "list door events");
    }
  });

  // ── 3. add a door ─────────────────────────────────────────────────────
  router.post("/doors", ...write(), async (req: Request, res: Response) => {
    const body = createBody.safeParse(req.body);
    if (!body.success) {
      invalid(res, body.error.issues);
      return;
    }
    try {
      res.status(201).json({ door: await createDoor(prisma, body.data, ctx(req)) });
    } catch (err) {
      answerError(res, err, "create door");
    }
  });

  // ── 4. change a door ──────────────────────────────────────────────────
  router.patch("/doors/:id", ...write(), async (req: Request, res: Response) => {
    const id = idParam.safeParse(req.params.id);
    const body = patchBody.safeParse(req.body);
    if (!id.success || !body.success) {
      invalid(res, [...(id.success ? [] : id.error.issues), ...(body.success ? [] : body.error.issues)]);
      return;
    }
    try {
      res.json({ door: await updateDoor(prisma, id.data, body.data, ctx(req)) });
    } catch (err) {
      answerError(res, err, "update door");
    }
  });

  // ── 5. retire a door ──────────────────────────────────────────────────
  router.post("/doors/:id/retire", ...write(), async (req: Request, res: Response) => {
    const id = idParam.safeParse(req.params.id);
    if (!id.success) {
      invalid(res, id.error.issues);
      return;
    }
    try {
      res.json({ door: await retireDoor(prisma, id.data, ctx(req)) });
    } catch (err) {
      answerError(res, err, "retire door");
    }
  });

  return router;
}
