/**
 * WARP-540 — `/api/updates/*`: the operator surface over the OTA update
 * agent (WARP-537 verify chain, WARP-538 poller + settings, WARP-539
 * apply/rollback). Consumers: the dashboard's /settings/updates page,
 * plus (WARP-1450) the get_update_status / apply_update LLM tools on
 * exactly two of the routes — see the RBAC paragraph below.
 *
 *   GET  /api/updates/status     — current committed release, the pending/
 *                                  in-flight row, the last terminal verdict
 *                                  (incl. the degraded_health signal), the
 *                                  persisted settings, whether apply is
 *                                  provisioned on this box, and whether the
 *                                  release source has a credential.
 *   GET  /api/updates/history    — newest-first DeviceUpdate rows (no
 *                                  manifestJson — the snapshot is apply
 *                                  material, not dashboard material).
 *   POST /api/updates/check-now  — run one poll tick inline and relay its
 *                                  typed outcome verbatim (fetch/verify
 *                                  failures are DATA here, not 5xx).
 *   POST /api/updates/apply-now  — dispatch the WARP-539 apply for the
 *                                  newest pending row; 202 + row id, the
 *                                  DeviceUpdate status IS the progress
 *                                  cursor the dashboard polls.
 *   POST /api/updates/skip       — retire the newest pending row without
 *                                  applying it (status `superseded`,
 *                                  failureReason `skipped_by_operator` so
 *                                  history distinguishes an operator skip
 *                                  from a newer-release supersede).
 *   GET  /api/updates/settings   — the persisted WARP-538 operator knobs.
 *   PUT  /api/updates/settings   — strict partial update of same.
 *
 * RBAC: owner+admin across the WHOLE surface, reads included — same
 * posture as the voice proxy (ADR-004): release SHAs + failure history
 * are operator material. Service principals are denied everywhere
 * EXCEPT two routes that additionally admit the MCP server's pinned
 * `_service:mcp` principal (WARP-1450, requireRoleOrMcpService) so the
 * get_update_status / apply_update LLM tools can dispatch:
 * GET /updates/status and POST /updates/apply-now. The route only ever
 * sees the service principal there, so the TOOL enforces the human's
 * forwarded role (owner/admin only) before dispatching — the
 * list_threat_events precedent from WARP-1443; human behavior on every
 * route is byte-identical. Mutations additionally write a WARP-237
 * activity row (who forced a check, who applied, who skipped, who
 * moved the window).
 *
 * Delegation only: this file never touches the update-agent internals —
 * it calls checkForUpdate / applyPendingUpdate / the settings module
 * exactly like index.ts's cron ticks do (WARP-541 is reworking those
 * internals in parallel; keep this boundary clean). Tests inject `deps`
 * so no compose socket, GitHub endpoint, or cosign binary is ever hit.
 *
 * Apply-now honesty: on a box without the host compose socket
 * (DROPLET_OTA_APPLY_SCRIPT empty — dev laptops, CI) apply is DISABLED,
 * so the route answers 503 `apply_unavailable` instead of pretending to
 * start one. Double-fire is guarded twice: an in-process single-flight
 * flag plus a 409 when a row is already `applying`. Known narrow race:
 * an apply-now landing exactly on the 03:00 window tick of ANOTHER
 * replica isn't cross-instance locked (the cron's advisory lock is
 * transaction-scoped inside cron-runtime); apply itself is state-machine
 * idempotent per row, and single-box deploys — every appliance today —
 * can't hit it.
 */
import { Router, type Request, type Response, type NextFunction } from "express";
import type { PrismaClient } from "@prisma/client";
import { requireRole, requireRoleOrMcpService } from "../middleware/auth.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import {
  checkForUpdate,
  type CheckForUpdateOptions,
  type CheckForUpdateResult,
} from "../services/update-agent/poller.js";
import {
  applyPendingUpdate,
  type ApplyRunner,
  type ApplyUpdateOptions,
  type ApplyUpdateResult,
} from "../services/update-agent/apply.js";
import { createHostComposeRunner } from "../services/update-agent/host-compose-runner.js";
import {
  getUpdateAgentSettings,
  saveUpdateAgentSettings,
  type UpdateAgentSettings,
} from "../services/update-agent/settings.js";

const logger = createLogger("updates-route");

/** History page size bounds — the table is operator UI, not an export. */
const HISTORY_DEFAULT_LIMIT = 50;
const HISTORY_MAX_LIMIT = 200;

/** Statuses that mean "a release is on deck / an apply is in motion". */
const IN_FLIGHT_STATUSES = ["pending", "verifying", "applying"] as const;
/** Statuses that mean "this row reached a verdict". */
const TERMINAL_STATUSES = ["committed", "rolled_back", "failed", "rejected"] as const;

/**
 * WARP-540 addition to the failureReason vocabulary (rides `superseded`,
 * mirroring how `degraded_health` rides `failed` per the WARP-538
 * convention): the operator explicitly declined this release.
 */
export const SKIPPED_BY_OPERATOR = "skipped_by_operator";

/** The DeviceUpdate slice every read endpoint returns — never manifestJson. */
const ROW_SELECT = {
  id: true,
  status: true,
  channel: true,
  releaseTag: true,
  gitSha: true,
  builtAt: true,
  failureReason: true,
  createdAt: true,
  updatedAt: true,
} as const;

interface UpdateRowView {
  id: string;
  status: string;
  channel: string;
  releaseTag: string | null;
  gitSha: string;
  builtAt: Date;
  failureReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Injectable seams — production defaults call the real update-agent
 * modules with the deployment config, exactly like index.ts's cron
 * wiring; tests replace them so no network/cosign/compose is touched.
 */
export interface UpdatesRouterDeps {
  checkForUpdate: (opts: CheckForUpdateOptions) => Promise<CheckForUpdateResult>;
  applyPendingUpdate: (opts: ApplyUpdateOptions) => Promise<ApplyUpdateResult>;
  getUpdateAgentSettings: (prisma: PrismaClient) => Promise<UpdateAgentSettings>;
  saveUpdateAgentSettings: (
    prisma: PrismaClient,
    patch: Partial<UpdateAgentSettings>,
  ) => Promise<UpdateAgentSettings>;
  /**
   * Null ⇢ apply is not provisioned on this box (no compose socket /
   * DROPLET_OTA_APPLY_SCRIPT empty) and apply-now must 503 honestly.
   */
  getApplyRunner: () => ApplyRunner | null;
}

function defaultDeps(): UpdatesRouterDeps {
  return {
    checkForUpdate,
    applyPendingUpdate,
    getUpdateAgentSettings,
    saveUpdateAgentSettings,
    getApplyRunner: () =>
      config.DROPLET_OTA_APPLY_SCRIPT
        ? createHostComposeRunner({
            scriptPath: config.DROPLET_OTA_APPLY_SCRIPT,
            composeFile: config.DROPLET_OTA_COMPOSE_FILE,
            updatesDir: config.DROPLET_OTA_UPDATES_DIR,
          })
        : null,
  };
}

export function createUpdatesRouter(
  prisma: PrismaClient,
  deps: UpdatesRouterDeps = defaultDeps(),
): Router {
  const router = Router();

  // Owner/admin across reads AND mutations (see the header comment);
  // `service` is never in the allowlist, so service principals are denied
  // on every route that uses this guard.
  const guard = requireRole("owner", "admin");

  // WARP-1450: the two routes the get_update_status / apply_update LLM
  // tools dispatch through additionally admit the MCP server's pinned
  // `_service:mcp` principal. This route layer only ever sees that
  // service principal, so the tool handler enforces the human's
  // forwarded role (owner/admin only) BEFORE dispatching — same defense
  // split as list_threat_events (WARP-1443). Human RBAC through this
  // guard is byte-identical to `guard` above.
  const mcpToolGuard = requireRoleOrMcpService("owner", "admin");

  // In-process single-flight for apply-now — one dispatch at a time per
  // orchestrator process. The DB-side `applying`-row check below covers
  // restarts (the flag dies with the process, the row does not).
  let applyNowInFlight = false;

  // ── GET /api/updates/status ─────────────────────────────────
  // WARP-1450: mcpToolGuard (not `guard`) — the get_update_status LLM
  // tool reads this route as `_service:mcp`.
  router.get(
    "/updates/status",
    mcpToolGuard,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        const [current, pending, lastVerdict, settings] = await Promise.all([
          // "Currently running" = the newest committed OTA row. Null on a
          // box that has never OTA'd — it runs its factory image; the
          // dashboard says exactly that instead of inventing a version.
          prisma.deviceUpdate.findFirst({
            where: { status: "committed" },
            orderBy: { updatedAt: "desc" },
            select: ROW_SELECT,
          }) as Promise<UpdateRowView | null>,
          prisma.deviceUpdate.findFirst({
            where: { status: { in: [...IN_FLIGHT_STATUSES] } },
            orderBy: { createdAt: "desc" },
            select: ROW_SELECT,
          }) as Promise<UpdateRowView | null>,
          // Most recently *touched* terminal row — a later successful
          // apply outranks an old degraded verdict, so the red banner
          // clears itself the moment a commit lands.
          prisma.deviceUpdate.findFirst({
            where: { status: { in: [...TERMINAL_STATUSES] } },
            orderBy: { updatedAt: "desc" },
            select: ROW_SELECT,
          }) as Promise<UpdateRowView | null>,
          deps.getUpdateAgentSettings(prisma),
        ]);

        res.json({
          current,
          pending,
          lastVerdict,
          // WARP-539's rollback-also-failed verdict: rollback did not
          // restore a healthy previous state. The dashboard renders this
          // as the red banner; everything else is business as usual.
          degraded:
            lastVerdict?.status === "failed" &&
            lastVerdict.failureReason === "degraded_health",
          settings,
          applyAvailable: deps.getApplyRunner() !== null,
          // WARP-2133: the releases repo is private, so an unauthenticated
          // poll 404s and the poller read that as "no release" — the page
          // swore a box was up to date when it had simply never been given
          // a credential. Surfacing the credential lets the operator UI say
          // "update source not provisioned" instead of "up to date".
          updateSourceAuthenticated: config.DROPLET_OTA_GITHUB_TOKEN !== "",
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/updates/history ────────────────────────────────
  router.get(
    "/updates/history",
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const rawLimit = Number(req.query.limit);
        const limit = Number.isInteger(rawLimit)
          ? Math.min(Math.max(rawLimit, 1), HISTORY_MAX_LIMIT)
          : HISTORY_DEFAULT_LIMIT;
        const rows = (await prisma.deviceUpdate.findMany({
          orderBy: { createdAt: "desc" },
          take: limit,
          select: ROW_SELECT,
        })) as UpdateRowView[];
        res.json({ updates: rows });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/updates/check-now ─────────────────────────────
  // One poll tick, inline (discover → download → cosign verify → track;
  // seconds, not minutes). checkForUpdate never throws for expected
  // failure shapes, so the typed outcome is relayed verbatim with a 200 —
  // "the check ran and found the endpoint unreachable" is a RESULT the
  // operator asked for, not a server error.
  router.post(
    "/updates/check-now",
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const result = await deps.checkForUpdate({
          prisma,
          releasesLatestUrl: config.DROPLET_OTA_RELEASES_URL,
          githubToken: config.DROPLET_OTA_GITHUB_TOKEN || undefined,
        });
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "download",
          what: "OTA update check forced",
          sub: result.outcome,
          actor: actorFromRequest(req),
          refs: {
            actor: req.user?.username ?? null,
            outcome: result.outcome,
            ...("gitSha" in result ? { gitSha: result.gitSha } : {}),
          },
        });
        res.json(result);
      } catch (err) {
        next(err);
      }
    },
  );

  // ── POST /api/updates/apply-now ─────────────────────────────
  // WARP-1450: mcpToolGuard (not `guard`) — the apply_update LLM tool
  // dispatches through this route as `_service:mcp`; the tool side
  // gates on the human's forwarded owner/admin role before dispatching.
  router.post(
    "/updates/apply-now",
    mcpToolGuard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const runner = deps.getApplyRunner();
        if (!runner) {
          // No compose socket on this box — say so, never fake a start.
          return res.status(503).json({ error: "apply_unavailable" });
        }

        const applying = await prisma.deviceUpdate.findFirst({
          where: { status: "applying" },
          select: { id: true },
        });
        if (applying || applyNowInFlight) {
          return res.status(409).json({ error: "apply_in_progress" });
        }

        // Same row selection as applyPendingUpdate — `verifying` rows are
        // retry cursors from an interrupted/transiently-failed attempt.
        const row = (await prisma.deviceUpdate.findFirst({
          where: { status: { in: ["pending", "verifying"] } },
          orderBy: { createdAt: "desc" },
          select: ROW_SELECT,
        })) as UpdateRowView | null;
        if (!row) {
          return res.status(409).json({ error: "nothing_pending" });
        }

        applyNowInFlight = true;
        await recordActivity({
          kind: "system",
          severity: "warn", // service containers are about to be recreated
          sourceIcon: "download",
          what: "OTA apply forced",
          sub: row.releaseTag ?? row.gitSha.slice(0, 10),
          actor: actorFromRequest(req),
          refs: {
            actor: req.user?.username ?? null,
            deviceUpdateId: row.id,
            gitSha: row.gitSha,
            releaseTag: row.releaseTag,
          },
        });

        // Dispatch detached: apply runs minutes (image pulls + health
        // gates) and may end by swapping THIS orchestrator, so the row's
        // status is the progress cursor — the dashboard polls /status.
        void deps
          .applyPendingUpdate({
            prisma,
            runner,
            releasesLatestUrl: config.DROPLET_OTA_RELEASES_URL,
            githubToken: config.DROPLET_OTA_GITHUB_TOKEN || undefined,
          })
          .then((result) => {
            logger.info(
              { event: "update.apply_now_finished", outcome: result.outcome, deviceUpdateId: row.id },
              "operator-forced OTA apply finished",
            );
          })
          .catch((err) => {
            // Same posture as the cron window: unexpected throws are bugs;
            // the row's status stays an exact restart cursor either way.
            logger.error(
              { err, event: "update.apply_now_failed", deviceUpdateId: row.id },
              "operator-forced OTA apply threw",
            );
          })
          .finally(() => {
            applyNowInFlight = false;
          });

        return res.status(202).json({ started: true, deviceUpdateId: row.id });
      } catch (err) {
        applyNowInFlight = false;
        return next(err);
      }
    },
  );

  // ── POST /api/updates/skip ──────────────────────────────────
  // Retire the newest pending row without applying it. The poller's
  // one-row-per-gitSha invariant then keeps the skipped release skipped
  // until a NEWER release is published — exactly the semantics the
  // banner's "Skip this release" promises.
  router.post(
    "/updates/skip",
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const row = (await prisma.deviceUpdate.findFirst({
          where: { status: "pending" },
          orderBy: { createdAt: "desc" },
          select: ROW_SELECT,
        })) as UpdateRowView | null;
        if (!row) {
          const inFlight = await prisma.deviceUpdate.findFirst({
            where: { status: { in: ["verifying", "applying"] } },
            select: { id: true },
          });
          // A verifying/applying row can't be skipped — the state machine
          // is advance-only once an apply owns it.
          return res
            .status(409)
            .json({ error: inFlight ? "apply_in_progress" : "nothing_pending" });
        }

        // Status-guarded write: if the apply window grabbed the row between
        // our read and this write (row no longer `pending`), touch nothing.
        const updated = await prisma.deviceUpdate.updateMany({
          where: { id: row.id, status: "pending" },
          data: { status: "superseded", failureReason: SKIPPED_BY_OPERATOR },
        });
        if (updated.count === 0) {
          return res.status(409).json({ error: "apply_in_progress" });
        }

        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "download",
          what: "OTA release skipped",
          sub: row.releaseTag ?? row.gitSha.slice(0, 10),
          actor: actorFromRequest(req),
          refs: {
            actor: req.user?.username ?? null,
            deviceUpdateId: row.id,
            gitSha: row.gitSha,
            releaseTag: row.releaseTag,
          },
        });
        res.json({ skipped: true, deviceUpdateId: row.id });
      } catch (err) {
        next(err);
      }
    },
  );

  // ── GET /api/updates/settings ───────────────────────────────
  router.get(
    "/updates/settings",
    guard,
    async (_req: Request, res: Response, next: NextFunction) => {
      try {
        res.json(await deps.getUpdateAgentSettings(prisma));
      } catch (err) {
        next(err);
      }
    },
  );

  // ── PUT /api/updates/settings ───────────────────────────────
  // Strict partial update — saveUpdateAgentSettings (WARP-538) throws on
  // any invalid field and that becomes the 400; nothing invalid is ever
  // persisted. NOTE the apply-window cron is (re)read at orchestrator
  // boot (index.ts), so a changed window takes effect on the next
  // restart — the dashboard copy says so out loud.
  router.put(
    "/updates/settings",
    guard,
    async (req: Request, res: Response, next: NextFunction) => {
      const body: unknown = req.body;
      if (typeof body !== "object" || body === null || Array.isArray(body)) {
        return res.status(400).json({ error: "invalid_settings" });
      }
      const patch = body as Partial<UpdateAgentSettings>;
      try {
        const saved = await deps.saveUpdateAgentSettings(prisma, {
          ...(patch.channel !== undefined ? { channel: patch.channel } : {}),
          ...(patch.applyWindowCron !== undefined
            ? { applyWindowCron: patch.applyWindowCron }
            : {}),
          ...(patch.autoApply !== undefined ? { autoApply: patch.autoApply } : {}),
        });
        await recordActivity({
          kind: "system",
          severity: "info",
          sourceIcon: "settings",
          what: "OTA update settings changed",
          sub: `window ${saved.applyWindowCron} · auto-apply ${saved.autoApply ? "on" : "off"}`,
          actor: actorFromRequest(req),
          refs: {
            actor: req.user?.username ?? null,
            channel: saved.channel,
            applyWindowCron: saved.applyWindowCron,
            autoApply: saved.autoApply,
          },
        });
        res.json(saved);
      } catch (err) {
        // The settings module's validation errors are operator-safe
        // one-liners ("applyWindowCron is not a valid cron expression: …").
        if (err instanceof Error && err.message.startsWith("update-agent settings:")) {
          return res.status(400).json({ error: err.message });
        }
        next(err);
      }
    },
  );

  return router;
}
