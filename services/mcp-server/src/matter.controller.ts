/**
 * MatterController implementation that proxies to the orchestrator's
 * `/matter/*` REST API.
 *
 * Background (WARP-102)
 * ---------------------
 * The Matter fabric (paired-node state, ACL, persistent storage) lives
 * inside the orchestrator process — `apps/orchestrator/src/services/
 * matter.service.ts` embeds `@project-chip/matter.js` and mounts the
 * `matter-data` volume at `/data/matter-storage`. Two controllers
 * reading the same storage from different processes is fragile — the
 * fabric crypto is single-writer by design.
 *
 * So the mcp-server (which is the trust boundary for the LLM tool
 * path) does NOT host its own controller. It speaks HTTP to the
 * orchestrator, which owns the device state.
 *
 * What this means for tool handlers
 * ---------------------------------
 * The 6 tools in `packages/tools-core/src/handlers/smart-home/`
 * call `ctx.matter.X` and treat the return value as opaque data.
 * Those handlers already deal with the orchestrator's response
 * shapes (e.g. `confirmation_required` from `control-device.ts:51-61`)
 * — we just need to pass the orchestrator's JSON bodies through
 * unchanged.
 *
 * Auth posture
 * ------------
 * The orchestrator's `/matter/*` routes do not enforce per-user auth
 * today — anything that can reach `orchestrator:3000` inside the
 * compose network can issue commands. The trust boundary is the
 * mcp-server's tools/call dispatch (RBAC + JWT). When the orchestrator
 * adds proper auth, this client gets a `Authorization` header from
 * `userId` / `role` context (which already flows through via
 * `ToolContext`).
 */
import type { HttpClient, MatterController } from "@droplet/tools-core";

/**
 * Translate a non-2xx orchestrator response into a thrown Error
 * carrying the body text. Tool handlers catch this in their try/catch
 * and return a `MATTER_COMMAND_FAILED` ToolResult — see
 * `control-device.ts:36-42`.
 *
 * Exception: HTTP 202 is the canonical "confirmation_required" status
 * from the orchestrator's safety-tier middleware. We DON'T throw on
 * 202 — we return the parsed body so the handler sees
 * `{status: "confirmation_required", ...}` and surfaces it through
 * the `confirmationRequired()` helper.
 */
async function readJsonOrThrow(resp: Response, opName: string): Promise<unknown> {
  if (resp.status === 202) {
    // Tier 2 confirmation flow — flows through the handler's
    // confirmation_required branch. NOT an error.
    return resp.json();
  }
  if (resp.ok) {
    // 200/204. Some endpoints (delete) return no body; coerce to {}.
    const text = await resp.text();
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      // Should never happen for orchestrator routes — but if it does,
      // surface the raw text so the operator can diagnose.
      throw new Error(`${opName}: orchestrator returned non-JSON 2xx body: ${text.slice(0, 200)}`);
    }
  }
  // 4xx/5xx — try to extract an error.message from the JSON body for
  // the human-readable surface in tool results.
  let detail = "";
  try {
    const body = await resp.json() as { error?: string; message?: string };
    detail = body.error ?? body.message ?? JSON.stringify(body);
  } catch {
    detail = await resp.text().catch(() => "");
  }
  throw new Error(`${opName}: orchestrator returned HTTP ${resp.status}: ${detail.slice(0, 200)}`);
}

/**
 * Build a MatterController that wraps the supplied HttpClient. The
 * client should be configured to talk to the orchestrator
 * (`http://orchestrator:3000` by default — see `index.ts` baseUrlFor).
 *
 * Method signatures match `MatterController` in `tools-core/src/types.ts`;
 * each one is a thin wrapper around a single orchestrator route.
 */
export function createMatterController(http: HttpClient): MatterController {
  return {
    /** GET /matter/devices — grouped list. */
    async listDevices() {
      const resp = await http.get("/matter/devices");
      return readJsonOrThrow(resp, "listDevices");
    },

    /** GET /matter/devices/:nodeId — single device detail. */
    async getDevice(nodeId: string) {
      // Path-safe: matter route validates the format via isValidNodeId
      // (digits only, max 20), so we don't need to encode beyond what
      // joinUrl already does.
      const resp = await http.get(`/matter/devices/${encodeURIComponent(nodeId)}`);
      if (resp.status === 404) {
        // Tool handlers expect getDevice to either return the device or
        // throw; 404 is a real condition, not a transient error.
        throw new Error(`getDevice: no device with node ID ${nodeId}`);
      }
      return readJsonOrThrow(resp, "getDevice");
    },

    /**
     * POST /matter/devices/:nodeId/command — send a command.
     * Orchestrator's safety-tier middleware decides:
     *   - 200 + result body  → executed (Tier 1)
     *   - 202 + confirmation_required → handler surfaces the prompt
     *   - 429 → blocked (rate-limit or Tier 2/3 violation)
     */
    async sendCommand(nodeId: string, command: string, data?: unknown) {
      const resp = await http.post(
        `/matter/devices/${encodeURIComponent(nodeId)}/command`,
        { command, data },
      );
      return readJsonOrThrow(resp, "sendCommand");
    },

    /**
     * GET /matter/discover — uncommissioned devices on the LAN.
     * Default timeout matches orchestrator's default (15s); the
     * MatterController interface doesn't take a timeout arg so we
     * accept the orchestrator's default. Future enhancement: extend
     * the interface with an optional `timeoutMs` param.
     */
    async discover() {
      const resp = await http.get("/matter/discover");
      return readJsonOrThrow(resp, "discover");
    },

    /**
     * POST /matter/commission — commission a new device using a pairing
     * code (either the 11-digit short or 21-digit long Matter manual
     * code, or the QR-encoded payload). The orchestrator's
     * matter.service.ts auto-detects the format via
     * `ManualPairingCodeCodec` / `QrPairingCodeCodec`.
     */
    async commission(pairingCode: string) {
      const resp = await http.post("/matter/commission", {
        pairing_code: pairingCode,
      });
      return readJsonOrThrow(resp, "commission");
    },

    /**
     * GET /matter/audit?entityId=...&limit=... — audit log slice.
     * The orchestrator wraps results as `{ logs: [...] }`; we pass
     * the object through so handlers see the same shape they would
     * for an in-process implementation.
     */
    async getAuditLog(opts: { entityId?: string; limit?: number }) {
      const params: Record<string, unknown> = {};
      if (opts.entityId) params.entityId = opts.entityId;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const resp = await http.get("/matter/audit", { params });
      return readJsonOrThrow(resp, "getAuditLog");
    },
  };
}
