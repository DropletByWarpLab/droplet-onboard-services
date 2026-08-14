/**
 * WARP-1447 — `create_scene` LLM tool.
 *
 * Creates a named scene ("movie night") from a list of device actions
 * via the orchestrator's `POST /api/scenes` route, so it can be run
 * later with `run_scene` or scheduled from the dashboard. Creating a
 * scene never fires any device action.
 *
 * Tier 2 (write + requires confirmation), enforced BY THE HANDLER —
 * same two-phase contract as `set_detection_zones`: the first call
 * returns `confirmation_required` (no HTTP write) echoing the scene
 * name and a plain-language action summary; the model relays it and
 * re-issues with `confirmed: true` only after an explicit user yes.
 *
 * Device references are resolved BEFORE the confirmation echo (via
 * `ctx.matter.listDevices()` — exact nodeId first, then case-
 * insensitive friendlyName / product-name match) so the user approves
 * the real device list, not raw strings.
 *
 * Wire shape: the POST body mirrors the route's `createSceneSchema`
 * (apps/orchestrator/src/routes/scenes.ts) exactly — `{ name, icon?,
 * actions: [{ deviceNodeId, command, args? }] }` — with the same
 * limits validated client-side so the model gets a precise error
 * without a round-trip.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";

const TOOL_NAME = "create_scene";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

// Mirror of the route's createSceneSchema limits (scenes.ts:43-47).
const NAME_MAX = 120;
const ICON_MAX = 64;
const ACTIONS_MAX = 64;

const inputSchema = {
  type: "object",
  properties: {
    name: {
      type: "string",
      minLength: 1,
      maxLength: NAME_MAX,
      description: 'Scene name, e.g. "Movie night" (max 120 chars).',
    },
    icon: {
      type: "string",
      maxLength: ICON_MAX,
      description:
        'Optional icon identifier shown in the dashboard, e.g. "film" (max 64 chars).',
    },
    actions: {
      type: "array",
      minItems: 1,
      maxItems: ACTIONS_MAX,
      description:
        "Device actions the scene runs, in order (1-64). Creating the scene does NOT run them.",
      items: {
        type: "object",
        properties: {
          device: {
            type: "string",
            description:
              'Device nodeId OR household name (friendlyName / product name) from list_smart_home_devices, e.g. "living-room lamp". Name lookup is case-insensitive.',
          },
          command: {
            type: "string",
            description:
              "Command to send when the scene runs, e.g. turn_off, set_brightness, lock.",
          },
          args: {
            type: "object",
            description: "Optional command parameters, e.g. {level: 20}.",
          },
        },
        required: ["device", "command"],
        additionalProperties: false,
      },
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required describing the action, and the user approves from that prompt.",
    },
  },
  required: ["name", "actions"],
  additionalProperties: false,
} as const;

function invalidArgs(message: string): ToolResult {
  return { ok: false, status: "error", error: { code: "INVALID_ARGS", message } };
}

/** The 8 category arrays of the orchestrator's grouped device list. */
const DEVICE_GROUPS = [
  "lights",
  "switches",
  "sensors",
  "climate",
  "media",
  "covers",
  "locks",
  "other",
] as const;

interface KnownDevice {
  nodeId: string;
  /** Best human label for the confirmation echo (friendlyName > name > nodeId). */
  label: string;
  /** All matchable names, lowercased. */
  names: string[];
}

/**
 * Flatten `ctx.matter.listDevices()`'s grouped payload (see
 * MatterGrouped in the orchestrator's types/smart-home.ts) into a flat
 * lookup list. Tolerant of the `_status: "disconnected"` empty shape.
 */
async function listKnownDevices(ctx: ToolContext): Promise<KnownDevice[]> {
  const grouped = (await ctx.matter.listDevices()) as Record<string, unknown> | null;
  const known: KnownDevice[] = [];
  if (!grouped || typeof grouped !== "object") return known;
  for (const group of DEVICE_GROUPS) {
    const list = grouped[group];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (!raw || typeof raw !== "object") continue;
      const d = raw as { nodeId?: unknown; name?: unknown; friendlyName?: unknown };
      if (typeof d.nodeId !== "string" || d.nodeId.length === 0) continue;
      const friendly =
        typeof d.friendlyName === "string" && d.friendlyName.trim().length > 0
          ? d.friendlyName.trim()
          : null;
      const product =
        typeof d.name === "string" && d.name.trim().length > 0 ? d.name.trim() : null;
      known.push({
        nodeId: d.nodeId,
        label: friendly ?? product ?? d.nodeId,
        names: [friendly, product]
          .filter((n): n is string => n !== null)
          .map((n) => n.toLowerCase()),
      });
    }
  }
  return known;
}

interface ResolvedAction {
  deviceNodeId: string;
  /** Human label echoed in the confirmation summary. */
  label: string;
  command: string;
  args?: Record<string, unknown>;
}

/** "turn_off" → "turn off" for the plain-language confirmation echo. */
function humanizeCommand(command: string): string {
  return command.replace(/_/g, " ");
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  // ── Validate — mirror the route's zod limits exactly ──
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (name.length === 0) return invalidArgs("name is required");
  if (name.length > NAME_MAX) {
    return invalidArgs(`name must be at most ${NAME_MAX} characters`);
  }

  let icon: string | undefined;
  if (args.icon !== undefined) {
    if (typeof args.icon !== "string") return invalidArgs("icon must be a string");
    if (args.icon.length > ICON_MAX) {
      return invalidArgs(`icon must be at most ${ICON_MAX} characters`);
    }
    icon = args.icon;
  }

  if (!Array.isArray(args.actions) || args.actions.length === 0) {
    return invalidArgs("actions is required and must be a non-empty array");
  }
  if (args.actions.length > ACTIONS_MAX) {
    return invalidArgs(`a scene can have at most ${ACTIONS_MAX} actions`);
  }

  const parsed: Array<{ device: string; command: string; args?: Record<string, unknown> }> = [];
  for (const raw of args.actions) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return invalidArgs("each action must be an object with device and command");
    }
    const a = raw as Record<string, unknown>;
    const device = typeof a.device === "string" ? a.device.trim() : "";
    if (device.length === 0) return invalidArgs("each action needs a device (nodeId or name)");
    const command = typeof a.command === "string" ? a.command.trim() : "";
    if (command.length === 0) return invalidArgs("each action needs a command");
    let actionArgs: Record<string, unknown> | undefined;
    if (a.args !== undefined) {
      if (!a.args || typeof a.args !== "object" || Array.isArray(a.args)) {
        return invalidArgs("action args must be an object when provided");
      }
      actionArgs = a.args as Record<string, unknown>;
    }
    parsed.push({ device, command, args: actionArgs });
  }

  // ── Resolve device names → nodeIds BEFORE the confirmation echo, so
  // the user approves the real device list ──
  let known: KnownDevice[];
  try {
    known = await listKnownDevices(ctx);
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "DEVICE_RESOLUTION_FAILED",
        message: `could not list smart-home devices to resolve the scene's actions: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    };
  }
  const byNodeId = new Map(known.map((d) => [d.nodeId, d]));

  const resolved: ResolvedAction[] = [];
  for (const action of parsed) {
    // Exact nodeId first — pass-through for callers that already hold one.
    const direct = byNodeId.get(action.device);
    if (direct) {
      resolved.push({
        deviceNodeId: direct.nodeId,
        label: direct.label,
        command: action.command,
        args: action.args,
      });
      continue;
    }
    const target = action.device.toLowerCase();
    const matches = known.filter((d) => d.names.includes(target));
    if (matches.length === 0) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "DEVICE_NOT_FOUND",
          message:
            known.length === 0
              ? `No device matches "${action.device}" — no smart-home devices are currently listed`
              : `No device matches "${action.device}" by nodeId or name`,
        },
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "AMBIGUOUS_DEVICE",
          message: `"${action.device}" matches ${matches.length} devices — use a nodeId or a more specific name`,
          details: {
            device: action.device,
            candidates: matches.map((m) => ({ nodeId: m.nodeId, label: m.label })),
          },
        },
      };
    }
    resolved.push({
      deviceNodeId: matches[0].nodeId,
      label: matches[0].label,
      command: action.command,
      args: action.args,
    });
  }

  // ── Confirmation gate — AFTER validation + resolution, BEFORE any
  // HTTP write. The echo carries the resolved device list. ──
  const fingerprint = confirmationFingerprint([TOOL_NAME, name, resolved]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    const summary = resolved
      .map((a) => `${humanizeCommand(a.command)} ${a.label}`)
      .join(", ");
    return confirmationRequired(
      `I'd like to create the scene "${name}" with ${resolved.length} action(s): ${summary}. ` +
        "Creating it does NOT run any device action now — it can be run later with run_scene or scheduled from the dashboard. " +
        "Ask the user to approve. " +
        "You cannot approve on their behalf.",
      {
        type: "create_scene",
        name,
        actions: resolved.map((a) => ({
          deviceNodeId: a.deviceNodeId,
          device: a.label,
          command: a.command,
        })),
      },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  // ── Confirmed: POST the route's exact wire shape ──
  const body: {
    name: string;
    icon?: string;
    actions: Array<{ deviceNodeId: string; command: string; args?: Record<string, unknown> }>;
  } = {
    name,
    actions: resolved.map((a) => ({
      deviceNodeId: a.deviceNodeId,
      command: a.command,
      ...(a.args !== undefined ? { args: a.args } : {}),
    })),
  };
  if (icon !== undefined) body.icon = icon;

  const res = await ctx.http.orchestrator.post("/api/scenes", body, {
    headers: { Accept: "application/json" },
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => null)) as
      | { error?: unknown; details?: unknown }
      | null;
    const serverMsg = errBody && typeof errBody.error === "string" ? errBody.error : null;
    if (res.status === 400) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "INVALID_SCENE",
          message: serverMsg ?? "orchestrator rejected the scene",
          details: errBody?.details,
        },
      };
    }
    return {
      ok: false,
      status: "error",
      error: {
        code: "CREATE_FAILED",
        message: serverMsg ?? `orchestrator returned ${res.status}`,
      },
    };
  }

  const created = (await res.json()) as { id: string; name: string; actions?: unknown[] };
  return {
    ok: true,
    data: {
      type: "create_scene",
      id: created.id,
      name: created.name,
      actionCount: Array.isArray(created.actions) ? created.actions.length : resolved.length,
    },
  };
}

const tool: Tool = {
  name: "create_scene",
  description:
    'Create a named smart-home scene (e.g. "movie night") from a list of device actions so it can be run later with run_scene or scheduled from the dashboard. Creating a scene does NOT run any device action. Each action\'s device may be a nodeId or a household name from list_smart_home_devices. Two-step: the first call returns confirmation_required echoing the scene name and the resolved device actions — relay it to the user, and only after they explicitly approve, approval is handled outside this conversation.',
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
