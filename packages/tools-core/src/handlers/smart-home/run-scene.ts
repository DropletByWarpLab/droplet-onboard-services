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

  const res = await ctx.http.orchestrator.post(
    `/api/scenes/${sceneId}/run`,
    {},
    { headers: { Accept: "application/json" } },
  );
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
  return {
    ok: true,
    data: {
      type: "scene_run",
      sceneId: data.sceneId,
      successCount: data.successCount,
      actionCount: data.actionCount,
      summary: `Ran ${data.successCount} of ${data.actionCount} action(s).`,
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
