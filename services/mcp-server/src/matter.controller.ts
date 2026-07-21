/**
 * MatterController implementation that proxies to the orchestrator's
 * `/api/matter/*` REST API.
 *
 * Auth (the HTTP hop is authenticated as the `service` principal)
 * ---------------------------------------------------------------
 * The orchestrator's `/api/*` routes require an authenticated principal
 * (session cookie OR Bearer JWT — see middleware/auth.ts). The
 * mcp-server's `createHttpClient("orchestrator")` injects the static
 * `ORCHESTRATOR_TOKEN` (= `SERVICE_TOKEN_MCP`) as a Bearer, which
 * `matchServiceToken` maps to `role: "service"` (id `_service:mcp`). So
 * every request below authenticates as that read-only service principal
 * — NOT as `owner`. (A dead `mintInternalToken` helper that minted
 * `role: "owner"` was removed in TOOLS-05; service-to-service must never
 * carry owner.)
 *
 * Chat tool calls additionally have the in-process agent-loop path where
 * the real user's RBAC has already narrowed the tool list before any
 * dispatch (`routes/llm.ts` WRITE_TOOLS).
 *
 * Background (WARP-102, updated for WARP-850)
 * -------------------------------------------
 * The Matter fabric (paired-node state, ACL, persistent storage) lives
 * in the `matter-controller` host-network sidecar (ADR-022) — the
 * orchestrator fronts it via `apps/orchestrator/src/services/
 * matter.service.ts` (an HTTP client) and the `matter-data` volume is
 * mounted in the sidecar at `/data/matter-storage`. Two controllers
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
 * Auth posture (layered)
 * ----------------------
 * The orchestrator's `/api/matter/*` WRITE routes (commission, command,
 * decommission) are gated by `requireRoleOrMcpService("owner","admin",
 * "family")` — human sessions need one of those roles, and the
 * `_service:mcp` principal this file presents is explicitly admitted
 * (WARP-339 closed the earlier gap where plain `requireRole` 403'd every
 * MCP write). The effective model is three layers:
 *   1. `routes/llm.ts` narrows the LLM's tool list by the chat user's
 *      role (WRITE_TOOLS) before any dispatch;
 *   2. the mcp-server re-checks `canCallTool` at `tools/call` (RBAC + JWT);
 *   3. the orchestrator route admits the request as either a
 *      sufficiently-roled human or the MCP service principal.
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
      const resp = await http.get("/api/matter/devices");
      return readJsonOrThrow(resp, "listDevices");
    },

    /** GET /matter/devices/:nodeId — single device detail. */
    async getDevice(nodeId: string) {
      // Path-safe: matter route validates the format via isValidNodeId
      // (digits only, max 20), so we don't need to encode beyond what
      // joinUrl already does.
      const resp = await http.get(`/api/matter/devices/${encodeURIComponent(nodeId)}`);
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
        `/api/matter/devices/${encodeURIComponent(nodeId)}/command`,
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
      const resp = await http.get("/api/matter/discover");
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
      const resp = await http.post("/api/matter/commission", {
        pairing_code: pairingCode,
      });
      return readJsonOrThrow(resp, "commission");
    },

    /**
     * WARP-1447 — DELETE /matter/devices/:nodeId — unpair (decommission)
     * a device from the fabric. 200 `{ status: "decommissioned", nodeId }`
     * on success; 404 when no such node is commissioned — surfaced as a
     * throw (the remove_device handler maps it to DEVICE_NOT_FOUND).
     */
    async decommission(nodeId: string) {
      const resp = await http.delete(
        `/api/matter/devices/${encodeURIComponent(nodeId)}`,
      );
      if (resp.status === 404) {
        throw new Error(`decommission: no device with node ID ${nodeId}`);
      }
      return readJsonOrThrow(resp, "decommission");
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
      const resp = await http.get("/api/matter/audit", { params });
      return readJsonOrThrow(resp, "getAuditLog");
    },
  };
}
