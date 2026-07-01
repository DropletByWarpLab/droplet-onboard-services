/**
 * feat/scene-schedules — shared Scene executor.
 *
 * The idx-ordered action walk + partial-failure capture + the single
 * `smart_home` activity row used to live inline in the
 * `POST /api/scenes/:id/run` handler (WARP-474). It is lifted here so the
 * run route AND the scene-schedule ticker dispatch through ONE path —
 * there must be exactly one place that decides how a routine fires its
 * Matter commands and what it audits, otherwise the interactive run and
 * the unattended scheduled run could drift.
 *
 * The route keeps owning its interactive concerns (the per-run
 * confirm-token gate, the 202/403 handshake, role checks); this function
 * only runs an already-authorised scene. The ticker reaches it after the
 * schedule itself was the owner/admin opt-in.
 *
 * Partial-failure tolerant: a dead bulb on action 2 does NOT abort
 * action 3 (the lights that work still work). Per-action status is
 * returned in `results` so the dashboard renders each row; the
 * scheduler ignores the array but relies on the same audit row.
 */
import type { PrismaClient } from "@prisma/client";
import { recordActivity } from "./activity.singleton.js";
import type { MatterDispatcher } from "../routes/scenes.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("scene-runner");

/** Minimal Scene shape the runner needs — id, name, ordered actions. */
export interface RunnableScene {
  id: string;
  name: string;
  actions: Array<{
    idx: number;
    deviceNodeId: string;
    command: string;
    args: unknown;
  }>;
}

export interface SceneActionResult {
  idx: number;
  deviceNodeId: string;
  command: string;
  ok: boolean;
  status?: string;
  error?: string;
}

export interface SceneRunResult {
  sceneId: string;
  successCount: number;
  actionCount: number;
  results: SceneActionResult[];
}

export interface ExecuteSceneOpts {
  /**
   * Provenance for the audit row. `"user"` for an interactive
   * dashboard/chat run, `"scheduler"` for an unattended ticker fire.
   */
  triggeredBy: "user" | "scheduler";
  /** Username of the actor on an interactive run; null/omitted for the scheduler. */
  actor?: string | null;
}

/**
 * Run every action of `scene` in idx order via the Matter dispatcher,
 * tolerating per-action failures, and emit one `smart_home` activity
 * row. `prisma` is accepted for parity with the rest of the service
 * layer (and so a future variant can persist a run record) — the v1
 * body doesn't touch it.
 */
export async function executeScene(
  _prisma: PrismaClient,
  matter: MatterDispatcher,
  scene: RunnableScene,
  opts: ExecuteSceneOpts,
): Promise<SceneRunResult> {
  const ordered = [...scene.actions].sort((a, b) => a.idx - b.idx);
  const results: SceneActionResult[] = [];
  let successCount = 0;

  for (const action of ordered) {
    try {
      const r = await matter.sendCommand(
        action.deviceNodeId,
        action.command,
        (action.args ?? undefined) as Record<string, unknown> | undefined,
      );
      results.push({
        idx: action.idx,
        deviceNodeId: action.deviceNodeId,
        command: action.command,
        ok: true,
        status: r.status,
      });
      successCount += 1;
    } catch (err) {
      results.push({
        idx: action.idx,
        deviceNodeId: action.deviceNodeId,
        command: action.command,
        ok: false,
        error: (err as Error).message,
      });
      logger.warn(
        { err, sceneId: scene.id, idx: action.idx, triggeredBy: opts.triggeredBy },
        "scene action failed (continuing)",
      );
    }
  }

  await recordActivity({
    kind: "smart_home",
    severity: successCount === ordered.length ? "ok" : "warn",
    sourceIcon: "home",
    what: "Scene run",
    sub: `${scene.name} (${successCount}/${ordered.length})`,
    refs: {
      sceneId: scene.id,
      sceneName: scene.name,
      successCount,
      actionCount: ordered.length,
      triggeredBy: opts.triggeredBy,
      actor: opts.actor ?? null,
    },
  });

  return {
    sceneId: scene.id,
    successCount,
    actionCount: ordered.length,
    results,
  };
}
