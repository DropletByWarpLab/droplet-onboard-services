/**
 * WARP-1440 — `set_camera_detection` LLM tool.
 *
 * Turns a camera's detection/recording on or off at RUNTIME via the
 * orchestrator's per-camera enable/disable routes — no Frigate restart,
 * takes effect immediately, fully reversible.
 *
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER —
 * same two-phase contract as `memory_forget`: neither the MCP server
 * nor the agent loop enforces `requiresConfirmation` generically, so
 * the first call returns `confirmation_required` (no HTTP) with the
 * camera + effect echoed for the model to relay. Only after the user
 * explicitly approves does the model re-issue the call with
 * `confirmed: true`.
 *
 * Route-level Tier-2 handshake (disable only): the orchestrator's
 * `POST /api/cameras/:name/disable` is itself gated by the network-
 * safety evaluator (`evaluateNetworkCommand`, op `disable_camera`) and
 * in production ALWAYS answers 202 `{ confirmationToken }` without
 * disabling anything. The dashboard's `disableCamera()`
 * (apps/web-dashboard/src/lib/api.ts) completes the handshake — the
 * user already confirmed in its dialog — by echoing the token to
 * `POST /api/cameras/command/confirm` with the WARP-41 operation echo
 * `{ confirmationToken, operation: "disable_camera" }`. This handler
 * does exactly the same after ITS user confirmation (`confirmed: true`
 * means the user approved in chat). `/enable` runs inline and needs no
 * handshake.
 */
import { confirmationRequired } from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/** Mirror of the orchestrator route's CAMERA_NAME_RE — reject junk
 *  client-side so the model gets a precise error, not a proxied 400. */
const CAMERA_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/;

const inputSchema = {
  type: "object",
  properties: {
    camera: {
      type: "string",
      description: "Camera name from list_cameras (e.g. front_door).",
    },
    enabled: {
      type: "boolean",
      description:
        "true re-enables detection and recording; false stops both until re-enabled.",
    },
    confirmed: {
      type: "boolean",
      description:
        "Set true ONLY after the user has explicitly approved this exact change in this conversation. Omit (or set false) on the first call — the tool will reply confirmation_required with the effect to relay to the user for approval.",
    },
  },
  required: ["camera", "enabled"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

/** Best-effort extraction of `{ error: "…" }` from an orchestrator reply. */
async function serverError(res: Response): Promise<string | null> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return body && typeof body.error === "string" ? body.error : null;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const camera = typeof args.camera === "string" ? args.camera.trim() : "";
  if (camera.length === 0) return invalidArgs("camera is required");
  if (!CAMERA_NAME_RE.test(camera)) {
    return invalidArgs(
      "invalid camera name — letters, digits, underscore, and hyphen only (max 64 chars)",
    );
  }
  if (typeof args.enabled !== "boolean") {
    return invalidArgs("enabled is required and must be a boolean");
  }
  const enabled = args.enabled;

  // Confirmation gate — AFTER validation (malformed args should fail
  // loudly, not ask the user to approve them) and BEFORE any HTTP.
  if (args.confirmed !== true) {
    const effect = enabled
      ? `re-enables detection and recording on "${camera}"`
      : `stops detection and recording on "${camera}" until re-enabled`;
    return confirmationRequired(
      `This ${effect}. The change is immediate and reversible (no NVR restart). ` +
        "Ask the user to approve, then re-issue this call with confirmed: true. " +
        "Do NOT set confirmed: true without an explicit yes from the user.",
      { type: "set_camera_detection", camera, enabled },
    );
  }

  const res = await ctx.http.orchestrator.post(
    `/api/cameras/${encodeURIComponent(camera)}/${enabled ? "enable" : "disable"}`,
  );

  if (res.status === 404) {
    return {
      ok: false,
      status: "error",
      error: { code: "CAMERA_NOT_FOUND", message: `camera "${camera}" not found` },
    };
  }

  // Tier-2 handshake: /disable 202s with a token instead of acting (the
  // inline branch is unreachable in production). The user already said
  // yes (confirmed: true), so complete the two-step exactly like the
  // dashboard's disableCamera(): echo the token + the operation name.
  if (!enabled && res.status === 202) {
    const body = (await res.json().catch(() => ({}))) as { confirmationToken?: unknown };
    const token = typeof body.confirmationToken === "string" ? body.confirmationToken : null;
    if (!token) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "TOGGLE_FAILED",
          message: "disable requires confirmation but no token was issued",
        },
      };
    }
    const confirmRes = await ctx.http.orchestrator.post("/api/cameras/command/confirm", {
      confirmationToken: token,
      operation: "disable_camera",
    });
    if (!confirmRes.ok) {
      const msg = await serverError(confirmRes);
      return {
        ok: false,
        status: "error",
        error: {
          code: "TOGGLE_FAILED",
          message: msg ?? `confirm endpoint returned ${confirmRes.status}`,
        },
      };
    }
    return { ok: true, data: { type: "set_camera_detection", camera, enabled } };
  }

  if (!res.ok) {
    const msg = await serverError(res);
    return {
      ok: false,
      status: "error",
      error: { code: "TOGGLE_FAILED", message: msg ?? `orchestrator returned ${res.status}` },
    };
  }

  return { ok: true, data: { type: "set_camera_detection", camera, enabled } };
}

const tool: Tool = {
  name: "set_camera_detection",
  description:
    "Turn a security camera's detection and recording on or off at runtime — no NVR restart, takes effect immediately, and is fully reversible (re-enable any time). Use to pause a camera and its alerts (e.g. while the user works in view) or to bring a disabled camera back online. Two-step: the first call returns confirmation_required with the effect — relay it to the user, and only after they explicitly approve, re-issue the SAME call with confirmed: true.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
