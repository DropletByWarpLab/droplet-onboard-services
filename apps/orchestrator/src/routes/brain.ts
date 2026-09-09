/**
 * WARP-2749 / WARP-2752 (ADR-051) — reading the brain.
 *
 *   GET   /api/brain/findings         open findings, biggest money first
 *   GET   /api/brain/digests          the standing understanding
 *   GET   /api/brain/coverage         how much has actually been read
 *   PATCH /api/brain/findings/:id     acknowledge / action / dismiss / assign
 *   GET   /api/brain/settings         is the brain on, and can this box say
 *   PUT   /api/brain/settings         turn it on or off, recording who and when
 *
 * WHO. `requireRoleOrMcpService("owner", "admin")`, the agent-runs posture, so
 * the `_service:mcp` principal can reach here on behalf of a chat user whose
 * own role is checked exactly as a browser caller's is — see `resolveCaller`,
 * which is the half that makes that true. The middleware admits the principal;
 * it does not turn it into a person, and until WARP-2810 nothing else did. The brain is an
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
import { requireRole, requireRoleOrMcpService, type AuthUser } from "../middleware/auth.js";
import type { BrainPassTrigger } from "../services/brain/brain-pass-runner.js";
import { config } from "../config.js";
import { actorFromRequest } from "../services/activity.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import {
  listDigests,
  listFindings,
  setFindingStatus,
} from "../services/brain/brain-digest.service.js";
import { DETECTOR_PASS_KEY } from "../services/brain/brain-pass.service.js";
import { CORPUS_PASS_KEY } from "../services/brain/brain-corpus.service.js";
import {
  BRAIN_SWITCH_PINNED,
  readBrainSwitch,
  setBrainEnabled,
} from "../services/brain/brain-switch.service.js";

/** Maps the service's stable error codes to HTTP, mirroring crm.ts. */
const STATUS_BY_CODE: Record<string, number> = {
  finding_not_found: 404,
  dismissal_needs_reason: 400,
  evidence_required: 400,
  confidence_out_of_range: 400,
  impact_needs_currency: 400,
  scope_department_mismatch: 400,
  invalid_detector_key: 400,
  // WARP-2838. A 409, not a 403: the caller has the role, the request is
  // well-formed, and the answer is that this box's answer is not ours to give.
  [BRAIN_SWITCH_PINNED]: 409,
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

/** No resolvable human = 403. Never a wider identity, never an empty 200: an
 *  empty list is indistinguishable from a healthy brain with nothing to say. */
function noActor(res: Response): void {
  res.status(403).json({ error: "actor_unresolved" });
}

/** The mcp-server's orchestrator client, which is not a person. */
const MCP_PRINCIPAL_ID = "_service:mcp";

/**
 * The acting human. The mcp service principal names the person it acts for;
 * everything downstream scopes on THAT id, never on `_service:mcp`.
 *
 * That sentence has been this function's docstring since WARP-2752, and until
 * WARP-2810 nothing implemented it: the principal was handed straight to
 * `visibleScopeFilter`, whose `service` role is not privileged and whose
 * `ownerId` arm then matched a user id that cannot exist. The filter collapsed
 * to a predicate false for every row, so `business_find` — the model's only
 * pull path into the brain — answered an empty list on every box.
 *
 * `SpaceAccessCaller.id` states the contract this broke: a LOCAL `User.id`
 * UUID, "never an NC username or a service-principal string. Callers resolving
 * a service-asserted user MUST swap this in before calling."
 *
 * Resolution mirrors `resolveActor` in routes/agent-runs.ts — the same
 * principal, the same header, the same fail-closed rule: `null` when nobody can
 * be established, and the caller answers 403 rather than widening to an
 * identity that sees more.
 */
async function resolveCaller(
  prisma: PrismaClient,
  req: Request,
): Promise<{ id: string; role: string } | null> {
  const user = req.user as AuthUser | undefined;
  if (!user) return null;
  if (user.id === MCP_PRINCIPAL_ID && user.role === "service") {
    // The mcp-server stamps `X-Nextcloud-User` with the acting user on every
    // call (context.ts `withActingUser`), so a handler need not ask for it.
    const named = (req.header("x-nextcloud-user") ?? "").trim();
    if (!named) return null;
    const row = await prisma.user.findUnique({
      where: { username: named },
      select: { id: true, role: true },
    });
    return row;
  }
  return { id: user.id, role: user.role };
}

// One declaration of each vocabulary, reused by the GET validators and the
// PATCH body. The GETs used to cast `req.query.status` straight into a Prisma
// `where`, so `?status=bogus` reached the driver, threw a
// PrismaClientValidationError that nothing maps, and came back a 500 — while
// the PATCH in this same file validated properly. Same file, two standards.
const FINDING_STATUS = ["new", "acknowledged", "actioned", "dismissed", "stale"] as const;
const DIGEST_KIND = [
  "entity",
  "project",
  "obligation",
  "theme",
  "metric",
  "relationship",
] as const;
const FINDING_KIND = [
  "loss",
  "risk",
  "inefficiency",
  "opportunity",
  "inconsistency",
] as const;

const findingQuerySchema = z.object({
  status: z.enum(FINDING_STATUS).optional(),
  kind: z.enum(FINDING_KIND).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});
const digestQuerySchema = z.object({
  kind: z.enum(DIGEST_KIND).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** WARP-2838. `.strict()` so a body that also names `enabledById` is a 400
 *  rather than a silently ignored attempt to attribute the consent elsewhere. */
const settingsSchema = z.object({ enabled: z.boolean() }).strict();

const patchSchema = z.object({
  status: z.enum(FINDING_STATUS),
  dismissedReason: z.string().max(500).optional(),
  assigneeId: z.string().uuid().nullable().optional(),
});

export function createBrainRouter(
  prisma: PrismaClient,
  passTrigger?: BrainPassTrigger,
): Router {
  const router = Router();
  const gate = requireRoleOrMcpService("owner", "admin");

  /**
   * WARP-2850 — POST /api/brain/passes/:passKey/run. "Check now."
   *
   * 🔴 `requireRole`, NOT the `gate` const every read on this router shares.
   * That is a security decision, not an inconsistency, and it is the one thing
   * about this route that must not be "tidied".
   *
   * `requireRoleOrMcpService` calls `next()` for `_service:mcp` BEFORE it
   * evaluates any role (middleware/auth.ts). The READS survive that because
   * `visibleScopeFilter` re-checks the resolved human inside the query — a ROW
   * protection. An ACTION route has no rows, therefore no filter, therefore
   * nothing at all: a `family` or `guest` chat user whose `X-Nextcloud-User`
   * resolves would pass the gate, and `if (!caller)` is not a role check.
   * `requireRole` reads `req.user.role`, and the principal carries `service`,
   * which is in no allowed set — so the tool path 403s here, on purpose.
   *
   * Consequence, accepted deliberately: the LLM cannot start a pass. A chat
   * turn queueing ten inferences ahead of the user's own next question is its
   * own decision, and this is not it.
   */
  router.post(
    "/brain/passes/:passKey/run",
    requireRole("owner", "admin"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        // The brain read surface is mounted unconditionally, so this route
        // exists on a box where no pass was ever registered. It must refuse
        // rather than 404 (which would read as "wrong URL") or mark a row
        // running that nothing will ever execute.
        if (!passTrigger) {
          res.status(503).json({ error: "brain_disabled" });
          return;
        }
        // Validated against the runner registry, never forwarded raw. A future
        // caller cannot reach another job by shaping the path.
        const passKey = req.params.passKey ?? "";
        if (!passTrigger.knownPasses().includes(passKey)) {
          res.status(400).json({ error: "unknown_pass" });
          return;
        }

        const out = await passTrigger.trigger(passKey, { manual: true });
        if (out.ok) {
          // 202, never 200-with-a-result: the corpus pass takes minutes and an
          // HTTP handler must not block for them. The outcome already has a
          // home — GET /api/brain/coverage, which /brief polls.
          res.status(202).json({ passKey, status: "started" });
          return;
        }

        if (out.reason === "too_soon") {
          // Retry-After is in SECONDS and is the HTTP spelling of the same
          // number, so a client does not have to guess.
          const secs = Math.max(1, Math.ceil((out.retryAfterMs ?? 0) / 1000));
          res.setHeader("Retry-After", String(secs));
          res.status(429).json({ error: "too_soon", retryAfterSeconds: secs });
          return;
        }
        // `busy` and `disabled` are DIFFERENT answers and a UI must be able to
        // say which: one is "hold on", the other is "somebody switched this
        // off on purpose".
        const status = out.reason === "unknown_pass" ? 400 : 409;
        res.status(status).json({ error: out.reason });
      } catch (err) {
        fail(res, err, next);
      }
    },
  );

  router.get("/brain/findings", gate, async (req: Request, res: Response, next: NextFunction) => {
    const q = findingQuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      const caller = await resolveCaller(prisma, req);
      if (!caller) {
        noActor(res);
        return;
      }
      const { rows, total } = await listFindings(prisma, caller, {
        status: q.data.status,
        kind: q.data.kind,
        limit: q.data.limit,
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
    const q = digestQuerySchema.safeParse(req.query);
    if (!q.success) {
      res.status(400).json({ error: "invalid_query" });
      return;
    }
    try {
      const caller = await resolveCaller(prisma, req);
      if (!caller) {
        noActor(res);
        return;
      }
      const { rows, total } = await listDigests(prisma, caller, {
        kind: q.data.kind,
        limit: q.data.limit,
      });
      res.json({ digests: rows, total });
    } catch (err) {
      fail(res, err, next);
    }
  });

  router.get("/brain/coverage", gate, async (_req: Request, res: Response, next: NextFunction) => {
    try {
      // Neither read depends on the other, and `brain-digest.service.ts`
      // already uses Promise.all for the equivalent rows/count pair.
      const [passes, totalIndexed, brain] = await Promise.all([
        prisma.brainPass.findMany({
          where: { passKey: { in: [DETECTOR_PASS_KEY, CORPUS_PASS_KEY] } },
        }),
        // How much there is to read, so "digested" has a denominator. Without
        // it the number is a count with no scale and reads as completeness.
        prisma.fileIndexStatus.count({ where: { status: "ready" } }),
        readBrainSwitch(prisma),
      ]);
      res.json({
        // WARP-2812 — whether the brain is scheduled AT ALL. Without this the
        // page could only ask "did the fetch succeed", and this endpoint
        // succeeds on a box where nothing is running: it reads BrainPass rows
        // that were never seeded and counts files nothing will ever digest.
        // A truthy body then read as a healthy brain with nothing to say.
        //
        // WARP-2838 — the EFFECTIVE value, resolved from the environment and
        // the consent row together. It was `config.brain.enabled`, which is the
        // boot-time env value: after the owner switched the brain on, the page
        // that told them to do it went on saying it was off.
        enabled: brain.enabled,
        // Whether this box's answer is the owner's to give. False on a box
        // pinned by `BRAIN_ENABLED`, so the page states the position instead of
        // rendering a control that 409s.
        canToggle: !brain.pinnedByOperator,
        passes: passes.map((p) => ({
          passKey: p.passKey,
          enabled: p.enabled,
          // WARP-2850 — the lease, made observable. Without it a UI cannot
          // tell "the box is working on it" from "nothing is happening", and
          // WARP-2837's AC asks for a reclaimable run to be observable rather
          // than merely bounded. `claimedBy` is deliberately NOT here: it is a
          // process id, it identifies nothing a human needs, and this route
          // has no row filter to justify putting an identifier on it.
          runState: p.runState,
          runningSince: p.claimedAt,
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
        const caller = await resolveCaller(prisma, req);
        if (!caller) {
          noActor(res);
          return;
        }
        await setFindingStatus(prisma, caller, req.params.id!, parsed.data);
        res.status(204).end();
      } catch (err) {
        fail(res, err, next);
      }
    },
  );

  /**
   * WARP-2838 — the switch `/brief` sends people to.
   *
   * 🔴 `requireRole`, NOT `requireRoleOrMcpService`, and the difference is the
   * whole gate. `requireRoleOrMcpService` admits `_service:mcp` BEFORE any role
   * check; on the read routes above that is safe only because
   * `visibleScopeFilter` re-checks the resolved human inside the query. A route
   * with no rows has no filter, so on the tool path it would have nothing at
   * all — a `family` or `guest` chat user passes as the service principal,
   * `resolveCaller` resolves them to a real `User` row, and `if (!caller)` is
   * not a role check. `requireRole` reads `req.user.role`, and the principal
   * carries `"service"`, which is in no allowed set.
   *
   * owner + admin, matching every other brain surface and ADR-051 §9: findings
   * and digests can be derived from the whole-company corpus, and the decision
   * to let the model read it belongs to the same people who can read the
   * output.
   */
  const settingsGate = requireRole("owner", "admin");

  router.get(
    "/brain/settings",
    settingsGate,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const brain = await readBrainSwitch(prisma);
        res.json({
          enabled: brain.enabled,
          canToggle: !brain.pinnedByOperator,
          enabledById: brain.enabledById,
          enabledAt: brain.enabledAt,
        });
      } catch (err) {
        fail(res, err, next);
      }
    },
  );

  router.put(
    "/brain/settings",
    settingsGate,
    async (req: Request, res: Response, next: NextFunction) => {
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_body" });
        return;
      }
      // The session, never the body. A consent record an HTTP client can
      // address to somebody else is not a consent record — and the service
      // principal is not a person who can consent to anything.
      const actorId = req.user?.id;
      if (!actorId || actorId.startsWith("_service:")) {
        noActor(res);
        return;
      }
      try {
        const brain = await setBrainEnabled(prisma, {
          enabled: parsed.data.enabled,
          actorId,
        });
        // Audited like every other consent write. IDS AND CODES ONLY — the
        // audit stream is exported wholesale and retained longer than what it
        // describes, so this says THAT the brain was switched, never anything
        // it went on to read.
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "sparkles",
          what: brain.enabled ? "Company brain turned on" : "Company brain turned off",
          sub: null,
          refs: { enabled: brain.enabled },
          actor: actorFromRequest(req),
        });
        res.json({
          enabled: brain.enabled,
          canToggle: !brain.pinnedByOperator,
          enabledById: brain.enabledById,
          enabledAt: brain.enabledAt,
        });
      } catch (err) {
        fail(res, err, next);
      }
    },
  );

  return router;
}
