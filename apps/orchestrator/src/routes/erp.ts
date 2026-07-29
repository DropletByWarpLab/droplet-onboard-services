/**
 * WARP-1137 — the ERP data + write-request API (brief §13).
 *
 *   GET  /api/erp/schedule?date=YYYY-MM-DD   Today's (or a day's) schedule.
 *   GET  /api/erp/patients?query=…           Patient search (name prefix).
 *   GET  /api/erp/patient/:id                One patient summary.
 *   GET  /api/erp/ar-summary                 Accounts-receivable totals.
 *   GET  /api/erp/recall-due                 Recall/recare due list.
 *   POST /api/erp/write-requests             Stage a write (outbox).
 *   GET  /api/erp/write-requests/:id         Read a write request's status.
 *   POST /api/erp/write-requests/:id/confirm Human-confirm → apply.
 *
 * PHI floors (WARP-1530 / ADR-032 §8 decision O-2 — this replaced the flat
 * owner/admin gate this file shipped with, and settles the long-standing
 * header-says-family / code-says-owner-admin discrepancy in favour of the
 * header, gated THROUGH a grant):
 *
 *   reads  = family-and-up WITH an `AccessRoleConnectorGrant` for the
 *            provider. That is what makes a "Reception" role useful.
 *   writes = admin-tier, AND — WARP-1579 — not narrowed to `read` by the
 *            role's own connector grant, which is what makes a "read-only
 *            Admin" role a real thing instead of a label the enforcement
 *            ignores. `IntegrationConnection.writeEnabled`, the staged
 *            `ErpWriteRequest` outbox and the human confirm all still apply
 *            ABOVE that; no role grant has ever widened them.
 *
 * In this DB-independent slice the connector is stubbed, so reads return honest
 * not-connected/empty and a confirmed write records FAILED (never fake APPLIED).
 * The service audits every read + write transition; this layer maps ErpError to
 * its HTTP status.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import { requireRole, recordAccessDenied } from "../middleware/auth.js";
import { createErpService, type ErpUser } from "../services/erp.service.js";
import { ErpError } from "../services/erp-error.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";
import { EAGLESOFT_PROVIDER } from "../services/erp-provider.js";
import type { ConnectorLevel } from "../services/access-catalog.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("erp-routes");

type AuthedRequest = {
  user?: { id?: string; role?: string };
  /** Resolved by `erpConnectorReadGate` and threaded to the service. */
  erpConnectorLevel?: ConnectorLevel | null;
  /** The RAW role grant, resolved by `erpConnectorWriteGate` (WARP-1579). */
  erpConnectorGrantLevel?: ConnectorLevel | null;
};

function erpUser(req: Request): ErpUser {
  const u = (req as AuthedRequest).user;
  return {
    id: u?.id ?? "unknown",
    role: u?.role ?? "guest",
    connectorLevel: (req as AuthedRequest).erpConnectorLevel ?? null,
    connectorGrantLevel: (req as AuthedRequest).erpConnectorGrantLevel ?? null,
  };
}

function handleErpError(res: Response, err: unknown): boolean {
  if (err instanceof ErpError) {
    res.status(err.status).json(err.toJSON());
    return true;
  }
  return false;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A syntactically-valid ISO date that is ALSO a real calendar date. Rejects
 *  2026-13-45 (which would make scheduleDayBounds throw a 500) and 2026-02-30
 *  (which would silently roll over to March). */
function isRealIsoDate(s: string): boolean {
  if (!ISO_DATE.test(s)) return false;
  const d = new Date(`${s}T00:00:00.000Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const writeRequestSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.unknown()).default({}),
});

/**
 * WARP-1530 (RBAC v2 T6) — the O-2 read gate.
 *
 * Layer 1 stays `requireRole`, exactly as this route registered it. TWO of
 * them, both real middleware, neither re-implemented here:
 *   `tierFloor`   — `requireRole("owner","admin","family")`, the O-2 read
 *                   floor, which refuses everyone below family up front;
 *   `todaysFloor` — `requireRole("owner","admin")`, the pre-O-2 gate, handed
 *                   the request whenever the widening does not reach the
 *                   caller so they see today's byte-for-byte 403 body and the
 *                   same `recordAccessDenied` audit row.
 * Layer 2 only ever runs on top of them, and only ever narrows or widens
 * within the tiers `tierFloor` already admitted.
 *
 * THE TIER FLOOR IS LOAD-BEARING, not decoration. O-2 is "family-and-UP with
 * a grant", and the "and-up" half is enforced HERE, at the consumption site.
 *
 * DO NOT "SIMPLIFY" IT AWAY on the strength of the WRITE-side clamp. When
 * this gate shipped (T6), `normalizeGrants` (routes/access.ts) clamped a
 * connector grant's LEVEL on non-admin starting points but never DROPPED the
 * grant, so a Guest-based role could hold one and the resolver faithfully
 * reported it as `read`. WARP-1578 closed that at the writer —
 * `clampConnectorLevel` now returns null for a guest starting point, so no
 * NEW guest row can be created — but that is a writer-side clamp with no
 * backfill: every row written before it is still in the database until its
 * role is next edited, and the resolver still reports those faithfully.
 * Reading `connectors[p]` on its own would hand such a role PHI TODAY.
 *
 * Two reasons the floor stays here rather than being pushed into the
 * resolver, and they survive the clamp: `connectors[p]` is a
 * provider-agnostic report of what a person was GRANTED — an honest answer to
 * a different question — while "which tiers may see PHI at all" is this
 * integration's policy and already lives beside `PHI_READ_ROLES` in
 * erp.service; and a floor enforced at the consumer survives a change to
 * whatever writes the rows, whereas one enforced only at the writer does not.
 * erp.service asserts it a second time for exactly that reason.
 *
 * The decision, case by case:
 *
 *   owner              → through. §3: owner is the ONE tier that bypasses
 *                        layer 2. Never resolved, never narrowed.
 *   below family       → today's floor. Guests and service principals are
 *                        refused before any DB read.
 *   admin / family     → the resolver's `connectors[eaglesoft]` decides:
 *                        • present → through, and the level rides down to the
 *                          service as `ErpUser.connectorLevel`;
 *                        • absent + a connection IS configured → refused. For
 *                          family that is the unchanged answer; for an
 *                          Admin-BASED custom role it is the §3 narrowing
 *                          ("admins do not bypass layer 2").
 *                        • absent + NOTHING is configured → today's floor.
 *                          With no `IntegrationConnection` row the resolver
 *                          returns {} for EVERYONE, owner included, so
 *                          treating that as a denial would turn today's honest
 *                          `NOT_CONFIGURED` read into a 403 for every admin on
 *                          every box that has not connected an ERP yet. "There
 *                          is nothing to see" is not an authorization answer —
 *                          the service's honest empty result must win.
 *
 * A resolver failure falls back to today's floor: no reach is invented (family
 * does not get the widening), and none is lost (admins keep what they have).
 * The service's own assertion is the second line either way.
 */
function erpConnectorReadGate(prisma: PrismaClient) {
  // Layer 1, registered exactly as `requireRole` always is. The O-2 tier
  // floor (family-and-up) runs FIRST, so a guest / role-less session is
  // refused by the real middleware before any of this file's logic — same
  // body, same `recordAccessDenied` row, same order as every other route.
  const tierFloor = requireRole("owner", "admin", "family");
  // Today's floor — the pre-O-2 gate, kept verbatim so anyone this widening
  // does not reach still sees the byte-for-byte response they see today.
  const todaysFloor = requireRole("owner", "admin");

  return (req: Request, res: Response, next: NextFunction): void => {
    tierFloor(req, res, () => {
      // `next` on a rejection, never a bare floating promise: an unhandled
      // rejection here would hang the request instead of 500ing through the
      // error handler, and a hung PHI request is the worst failure mode.
      layerTwo(req, res, next).catch(next);
    });
  };

  async function layerTwo(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = (req as AuthedRequest).user;
    const tier = user?.role;

    if (tier === "owner") {
      next();
      return;
    }
    if ((tier !== "admin" && tier !== "family") || !user?.id) {
      todaysFloor(req, res, next);
      return;
    }

    let level: ConnectorLevel | undefined;
    try {
      const access = await resolveEffectiveAccess(user.id);
      level = access?.connectors[EAGLESOFT_PROVIDER] as ConnectorLevel | undefined;
    } catch (err) {
      logger.warn(
        { err, userId: user.id },
        "erp read gate: effective-access read failed; falling back to the layer-1 floor",
      );
      todaysFloor(req, res, next);
      return;
    }

    if (level) {
      (req as AuthedRequest).erpConnectorLevel = level;
      next();
      return;
    }

    const configured = await prisma.integrationConnection
      .findFirst({ where: { provider: EAGLESOFT_PROVIDER }, select: { id: true } })
      .catch(() => null);
    if (!configured) {
      todaysFloor(req, res, next);
      return;
    }

    if (tier === "family") {
      // Unchanged for this person: today's floor already refuses them, and it
      // does so with the body and the audit row the rest of the API uses.
      todaysFloor(req, res, next);
      return;
    }
    recordAccessDenied(req, "erp-connector-grant-missing");
    res.status(403).json(
      ErpError.forbidden(
        "forbidden: this role has no connector grant for the ERP integration",
      ).toJSON(),
    );
  }
}

/**
 * WARP-1579 — the O-2 WRITE gate.
 *
 * T6 shipped O-2's read half and left writes authorising off the TIER alone,
 * so an Admin-based role holding a deliberately read-only ERP connector grant
 * could still stage and confirm writes. ADR-032 §3 always said otherwise
 * ("`erp.ts`'s canRead/canWrite become resolver checks per O-2"), and a grant
 * level the enforcement ignores is a false statement in the admin UI.
 *
 * Layer 1 is UNCHANGED: `requireRole("owner","admin")`, the admin-tier floor.
 * Everything above the gate is unchanged too — `IntegrationConnection.
 * writeEnabled`, the staged `ErpWriteRequest` outbox and the human confirm all
 * still apply, and no grant has ever widened them.
 *
 * IT READS THE RAW GRANT, NEVER `connectors[p]`. That field is
 * `min(grant, writeEnabled ? read_write : read)`, so a `read` there is
 * ambiguous between two states with two different remedies:
 *   • the ROLE is read-only        → 403, "ask for a read & write grant";
 *   • the CONNECTION has writes off → today's 409 `WRITE_NOT_ENABLED`,
 *                                     "turn writes on in Integrations".
 * Gating on the effective level would mask the second with the first — trading
 * this bug for a different wrong answer. `connectorGrants[p]` (WARP-1579,
 * effective-access.service) reports the role's own level, unclamped.
 *
 * The decision, case by case:
 *
 *   owner                  → through. §3's one bypass; never resolved.
 *   below admin tier       → already refused by layer 1, byte-for-byte as
 *                            today (family with a read grant included).
 *   connectorGrants null   → through. No custom role narrows this person —
 *                            every admin before RBAC v2. Today's world.
 *   grant read_write       → through, and the raw level rides down to the
 *                            service as `ErpUser.connectorGrantLevel`.
 *   grant read             → 403. THE FIX.
 *   grant absent, a
 *     connection exists    → 403. An Admin-based role with no ERP grant
 *                            cannot read either (§3) — writing would be a
 *                            strictly larger reach than reading.
 *   grant absent, NOTHING
 *     connected            → through, mirroring the read gate exactly:
 *                            "there is nothing to write to" is not an
 *                            authorization answer, and the service's honest
 *                            `NOT_CONFIGURED` must win.
 *   no such user           → the grant-absent decision, byte-for-byte. A
 *                            resolver `null` is NOT a failure: the read
 *                            SUCCEEDED and answered "this principal has no
 *                            User row" (a session that outlived it — `req.
 *                            user` is built from JWT claims alone, so an
 *                            admin token stays syntactically valid until it
 *                            expires). The read gate already refuses that
 *                            case; routing it to the outage fall-back would
 *                            make WRITES strictly more permissive than READS
 *                            for the same person, and would log a DB failure
 *                            that never happened.
 *
 * A resolver THROW — and only a throw — falls back to today's floor. That is
 * T6's stated posture for this axis, not an oversight: the widening is
 * hard-closed, the NARROWING is deliberately soft, so it is not an
 * availability-independent control and must not be relied on as one for
 * compliance. Locking the box out of its own ERP because a DB read blipped
 * would be the worse failure. "No such user" is not that failure.
 */
function erpConnectorWriteGate(prisma: PrismaClient) {
  // Layer 1, verbatim — the pre-1579 gate this route registered. Writes stay
  // admin-tier; the widening half of O-2 never reached this path.
  const adminFloor = requireRole("owner", "admin");

  return (req: Request, res: Response, next: NextFunction): void => {
    adminFloor(req, res, () => {
      // Same rule as the read gate: `next` on a rejection, never a bare
      // floating promise — a hung ERP write is the worst failure mode.
      layerTwo(req, res, next).catch(next);
    });
  };

  async function layerTwo(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const user = (req as AuthedRequest).user;
    // `adminFloor` admitted only owner|admin, so this is the §3 bypass plus
    // the id-less-session fall-through (nothing to resolve against).
    if (user?.role === "owner" || !user?.id) {
      next();
      return;
    }

    // Only a THROW is the outage fall-back. A `null` return is a successful
    // read with a negative answer and is handled below, beside the grants.
    let access: Awaited<ReturnType<typeof resolveEffectiveAccess>>;
    try {
      access = await resolveEffectiveAccess(user.id);
    } catch (err) {
      logger.warn(
        { err, userId: user.id },
        "erp write gate: effective-access read failed; falling back to the layer-1 floor",
      );
      next();
      return;
    }

    const grants = access?.connectorGrants;
    const level = access?.connectors[EAGLESOFT_PROVIDER];

    // The tri-state, tested EXPLICITLY rather than for truthiness:
    //   null      → no custom role narrows this admin ⇒ today's behaviour.
    //   {}        → a role holding no connector grants. Truthy, so it falls
    //               through to the grant-absent decision — which IS a denial.
    //   undefined → NOT "nothing narrows". Either the resolver found no such
    //               user (`access` null) or it returned a shape this gate
    //               cannot read. Neither is a statement that the person is
    //               unnarrowed, and a security gate must not invent one, so
    //               both fall through to the same grant-absent decision. A
    //               truthiness test here (`if (!grants)`) would have made
    //               this the one fail-OPEN in the change.
    if (grants === null) {
      next();
      return;
    }

    const grant = grants?.[EAGLESOFT_PROVIDER];
    if (grant === "read_write") {
      (req as AuthedRequest).erpConnectorLevel = level ?? null;
      (req as AuthedRequest).erpConnectorGrantLevel = grant;
      next();
      return;
    }

    if (!grant) {
      // Grant absent. Before refusing, the same probe the read gate runs:
      // with no `IntegrationConnection` row there is nothing to write to, and
      // that is the service's honest answer to give, not a 403.
      const configured = await prisma.integrationConnection
        .findFirst({ where: { provider: EAGLESOFT_PROVIDER }, select: { id: true } })
        .catch(() => null);
      if (!configured) {
        next();
        return;
      }
      recordAccessDenied(req, "erp-connector-grant-missing");
      res.status(403).json(
        ErpError.forbidden(
          "forbidden: this role has no connector grant for the ERP integration",
        ).toJSON(),
      );
      return;
    }

    // grant === "read" — the operator said read-only and meant it.
    recordAccessDenied(req, "erp-connector-grant-read-only");
    res.status(403).json(
      ErpError.forbidden(
        "forbidden: this role's connector grant for the ERP integration is read-only",
      ).toJSON(),
    );
  }
}

export function createErpRouter(prisma: PrismaClient): Router {
  const router = Router();
  const svc = createErpService(prisma);
  // Reads carry the O-2 gate (tier floor + the resolver's connector reach).
  const canRead = erpConnectorReadGate(prisma);
  // Writes stay admin-tier — the O-2 widening never touched this path — with
  // `writeEnabled` + the staged outbox + the human confirm unchanged above.
  // WARP-1579 adds the missing half: the grant's LEVEL is now consulted, so a
  // read-only Admin-based role is a real, enforceable thing.
  const canWrite = erpConnectorWriteGate(prisma);

  router.get("/erp/schedule", canRead, async (req, res, next) => {
    try {
      const q = req.query.date;
      const date = typeof q === "string" && isRealIsoDate(q) ? q : todayIso();
      res.json(await svc.getSchedule({ date }, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/patients", canRead, async (req, res, next) => {
    try {
      const query = typeof req.query.query === "string" ? req.query.query : "";
      res.json(await svc.searchPatients({ query }, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/patient/:id", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getPatient(req.params.id, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/ar-summary", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getArSummary(erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/recall-due", canRead, async (req, res, next) => {
    try {
      res.json(await svc.getRecallDue(erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.post("/erp/write-requests", canWrite, async (req, res, next) => {
    try {
      const parsed = writeRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json({ error: "Invalid write request", details: parsed.error.flatten() });
        return;
      }
      res.status(201).json(await svc.createWriteRequest(parsed.data, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.get("/erp/write-requests/:id", canWrite, async (req, res, next) => {
    try {
      res.json(await svc.getWriteRequest(req.params.id, erpUser(req)));
    } catch (err) {
      if (!handleErpError(res, err)) next(err);
    }
  });

  router.post(
    "/erp/write-requests/:id/confirm",
    canWrite,
    async (req, res, next) => {
      try {
        res.json(await svc.confirmWriteRequest(req.params.id, erpUser(req)));
      } catch (err) {
        if (!handleErpError(res, err)) next(err);
      }
    },
  );

  return router;
}
