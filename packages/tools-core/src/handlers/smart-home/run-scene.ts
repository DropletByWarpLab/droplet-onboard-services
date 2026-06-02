/**
 * WARP-474 (G2) — `run_scene` LLM tool.
 *
 * Wraps the orchestrator's `POST /api/scenes/:id/run` so the agent
 * loop can press a scene by name or id from a chat turn. Write tier
 * + requires confirmation — same posture as `control_device`.
 *
 * Looks up the scene by `id` if it matches uuid shape, otherwise
 * resolves by `name` (first match wins; operators don't typically
 * create duplicate scene names but the response surfaces the
 * resolved id so a follow-up call can disambiguate).
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { confirmationRequired } from "../../confirmation.js";

interface SceneRunResult {
  sceneId: string;
  successCount: number;
  actionCount: number;
  results: Array<{
    idx: number;
    deviceNodeId: string;
    command: string;
    ok: boolean;
    status?: string;
    error?: string;
  }>;
}

interface SceneListItem {
  id: string;
  name: string;
  icon: string | null;
  actionCount: number;
}

const inputSchema = {
  type: "object",
  properties: {
    scene: {
      type: "string",
      description:
        "Scene id (uuid) OR human-readable name (e.g. 'Movie night'). Name lookup is case-insensitive; first match wins.",
    },
  },
  required: ["scene"],
  additionalProperties: false,
} as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The scenes route signals "needs confirmation" with HTTP 409 +
 * `{ error: "confirmation_required", … }` (see `routes/scenes.ts`),
 * NOT the 202 shape the shared `isConfirmationResponse` keys on. Detect
 * that specific response without consuming the body of any other
 * response (success/other-error paths still read `res.json()` below).
 */
async function isSceneConfirmationRequired(res: Response): Promise<boolean> {
  if (res.status !== 409) return false;
  const body = (await res.clone().json().catch(() => null)) as
    | { error?: string }
    | null;
  return body?.error === "confirmation_required";
}

async function resolveSceneId(
  ctx: ToolContext,
  raw: string,
): Promise<string | null> {
  if (UUID_RE.test(raw)) return raw;
  const listRes = await ctx.http.orchestrator.get("/api/scenes", {
    headers: { Accept: "application/json" },
  });
  if (!listRes.ok) return null;
  const body = (await listRes.json()) as { scenes?: SceneListItem[] };
  const target = raw.trim().toLowerCase();
  const match = (body.scenes ?? []).find(
    (s) => s.name.trim().toLowerCase() === target,
  );
  return match?.id ?? null;
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = typeof args.scene === "string" ? args.scene.trim() : "";
  if (!raw) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "scene is required" },
    };
  }

  const sceneId = await resolveSceneId(ctx, raw);
  if (!sceneId) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "SCENE_NOT_FOUND",
        message: `No scene matches "${raw}" by id or name`,
      },
    };
  }

  // Do NOT hard-code `?confirm=true`. A scene can batch Tier-2 device
  // actions (locks, thermostat), so it must honor the orchestrator's
  // server-side confirmation gate the same way every other write tool
  // does — never pre-satisfy it from inside the handler (TOOLS-01).
  // The scenes route (`routes/scenes.ts`) replies 409
  // `{ error: "confirmation_required", … }` on the unconfirmed call;
  // relay that as a `confirmation_required` ToolResult so the agent
  // loop renders a "needs approval" chip (identical posture to
  // `control_device` / `add_port_forward`). The agent loop re-issues
  // with the user's approval; the tool itself never forges it.
  const res = await ctx.http.orchestrator.post(
    `/api/scenes/${sceneId}/run`,
    {},
    { headers: { Accept: "application/json" } },
  );
  if (await isSceneConfirmationRequired(res)) {
    return confirmationRequired(
      "Running this scene requires user confirmation in the Droplet dashboard.",
      { type: "scene_run", sceneId },
    );
  }
  if (!res.ok) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "SCENE_RUN_FAILED",
        message: `orchestrator returned ${res.status}`,
      },
    };
  }
  const data = (await res.json()) as SceneRunResult;
  // Partial failure (some actions threw) must not return ok: true —
  // the LLM agent would otherwise report full success when only some
  // bulbs answered. Surface SCENE_PARTIAL_FAILURE with the per-action
  // breakdown in `details` so the agent communicates the actual state.
  const allSucceeded = data.successCount === data.actionCount;
  if (!allSucceeded) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "SCENE_PARTIAL_FAILURE",
        message: `Ran ${data.successCount} of ${data.actionCount} action(s) — ${data.actionCount - data.successCount} failed.`,
        details: {
          type: "scene_run",
          sceneId: data.sceneId,
          successCount: data.successCount,
          actionCount: data.actionCount,
          results: data.results,
        },
      },
    };
  }
  return {
    ok: true,
    data: {
      type: "scene_run",
      sceneId: data.sceneId,
      successCount: data.successCount,
      actionCount: data.actionCount,
      summary: `Ran all ${data.actionCount} action(s).`,
      results: data.results,
    },
  };
}

const tool: Tool = {
  name: "run_scene",
  description:
    "Run a smart-home scene by id or name. Batch-executes every action in the scene (lights on, thermostat set, locks, etc.) and returns per-action results. Write tier — requires user confirmation in the dashboard. Use when the user asks for a household-routine outcome like 'movie night' or 'goodnight'.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
