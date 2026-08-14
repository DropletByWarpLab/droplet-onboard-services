/**
 * WARP-1447 — `remove_device` LLM tool.
 *
 * Unpairs (decommissions) a Matter device from the home fabric via the
 * orchestrator's `DELETE /api/matter/devices/:nodeId`. Tier 2 (write +
 * requires confirmation), enforced BY THE HANDLER: neither the MCP
 * server nor the agent loop enforces the `requiresConfirmation` flag
 * generically, so the first call resolves the device and returns
 * `confirmation_required` (no side effects) with the device named in
 * the message. WARP-2002: the second call must carry a SERVER-MINTED
 * single-use token bound to this tool and this node id — the model
 * cannot self-approve, and never sees the token.
 *
 * The `device` argument accepts either the household name
 * (`friendlyName` from the DeviceAlias overlay, or the Matter-reported
 * product name — both case-insensitive) or the exact node id, mirroring
 * how `list_smart_home_devices` tells the model to resolve devices.
 */
import {
  confirmationFingerprint,
  confirmationRequired,
  consumeToolConfirmation,
} from "../../confirmation.js";
import type { Tool, ToolContext, ToolResult } from "../../types.js";

const TOOL_NAME = "remove_device";

/** The slice of the orchestrator's grouped-devices entries we match on
 *  (`MatterCommissionedDevice` in the orchestrator's smart-home types —
 *  tools-core cannot import orchestrator code, and treats the rest of
 *  the entry as opaque). */
interface ListedDevice {
  nodeId: string;
  name?: string;
  friendlyName?: string | null;
  roomName?: string | null;
}

const inputSchema = {
  type: "object",
  properties: {
    device: {
      type: "string",
      description:
        "The device to remove — its household name (e.g. \"kitchen strip\"), its Matter product name, or its exact node id. Name matching is case-insensitive; use list_smart_home_devices to see names and node ids.",
    },
    confirmation_token: {
      type: "string",
      description:
        "Omit this. It is issued to the user for approval, not to you — you cannot read it, and a guessed or fabricated value is refused. Call without it; the tool replies confirmation_required naming the device, and the user approves from that prompt.",
    },
  },
  required: ["device"],
  additionalProperties: false,
} as const;

/** Flatten the grouped `{ lights: [...], switches: [...], ... }` body
 *  into one device list, skipping non-array envelope fields such as
 *  `_status: "disconnected"`. */
function flattenDevices(grouped: unknown): ListedDevice[] {
  if (!grouped || typeof grouped !== "object") return [];
  const out: ListedDevice[] = [];
  for (const value of Object.values(grouped)) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { nodeId?: unknown }).nodeId === "string"
      ) {
        out.push(entry as ListedDevice);
      }
    }
  }
  return out;
}

/** What we call the device when talking to the user: the household
 *  alias when set, else the Matter-reported name, else the bare id. */
function label(d: ListedDevice): string {
  return d.friendlyName || d.name || `node ${d.nodeId}`;
}

function candidate(d: ListedDevice) {
  return {
    nodeId: d.nodeId,
    name: d.name ?? null,
    friendlyName: d.friendlyName ?? null,
    roomName: d.roomName ?? null,
  };
}

async function handler(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const raw = typeof args.device === "string" ? args.device.trim() : "";
  if (raw.length === 0) {
    return {
      ok: false,
      status: "error",
      error: { code: "INVALID_ARGS", message: "device is required" },
    };
  }

  let devices: ListedDevice[];
  try {
    devices = flattenDevices(await ctx.matter.listDevices());
  } catch (err) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "REMOVE_FAILED",
        message: `could not list devices to resolve "${raw}": ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }

  // Exact node id wins outright — ids are unique, so no ambiguity.
  let target = devices.find((d) => d.nodeId === raw);
  if (!target) {
    const needle = raw.toLowerCase();
    const matches = devices.filter(
      (d) =>
        (d.friendlyName ?? "").trim().toLowerCase() === needle ||
        (d.name ?? "").trim().toLowerCase() === needle,
    );
    if (matches.length > 1) {
      return {
        ok: false,
        status: "error",
        error: {
          code: "AMBIGUOUS_DEVICE",
          message: `${matches.length} devices match "${raw}" — ask the user which one, then retry with its node id`,
          details: { candidates: matches.map(candidate) },
        },
      };
    }
    target = matches[0];
  }
  if (!target) {
    return {
      ok: false,
      status: "error",
      error: {
        code: "DEVICE_NOT_FOUND",
        message: `No device matches "${raw}" by name or node id`,
      },
    };
  }

  // Confirmation gate — AFTER resolution (so the prompt names the real device,
  // and so the token is bound to the device we actually resolved) and BEFORE
  // any side effect.
  const fingerprint = confirmationFingerprint([TOOL_NAME, target.nodeId]);
  if (!consumeToolConfirmation(args.confirmation_token, TOOL_NAME, fingerprint)) {
    return confirmationRequired(
      `I'd like to remove "${label(target)}" (node ${target.nodeId}) from the home. ` +
        "It will be unpaired from the Droplet fabric and stop responding until it is commissioned again. " +
        "Ask the user to approve — they will get an approval prompt for this exact device.",
      { type: TOOL_NAME, nodeId: target.nodeId, name: label(target) },
      { toolName: TOOL_NAME, fingerprint },
    );
  }

  try {
    await ctx.matter.decommission(target.nodeId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // The proxy throws "no device with node ID ..." on the
    // orchestrator's 404 (already gone / never commissioned).
    if (/not.?found|no device/i.test(message)) {
      return {
        ok: false,
        status: "error",
        error: { code: "DEVICE_NOT_FOUND", message },
      };
    }
    return {
      ok: false,
      status: "error",
      error: { code: "REMOVE_FAILED", message },
    };
  }

  return {
    ok: true,
    data: {
      type: "remove_device",
      nodeId: target.nodeId,
      name: label(target),
      removed: true,
    },
  };
}

const tool: Tool = {
  name: "remove_device",
  description:
    "Unpair (remove) a Matter device from the home — factory-unlinks it from the Droplet fabric, after which it stops responding until it is commissioned again (use commission_device to re-add it later). Accepts the device's name or node id. Two-step: the first call returns confirmation_required naming the device — relay that to the user. Approval is handled outside this conversation; you cannot approve on the user's behalf.",
  inputSchema,
  requiresWrite: true,
  requiresConfirmation: true,
  handler,
};

export default tool;
