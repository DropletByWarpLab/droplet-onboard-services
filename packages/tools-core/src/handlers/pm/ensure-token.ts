/**
 * WARP-867 — fetch the runtime-minted Plane service token from the
 * orchestrator (GET /api/pm/service-token, mcp-service-principal guarded)
 * and inject it into pm-client before the first `/api/v1/` call.
 *
 * Plane CE only authenticates server-generated service tokens; the env
 * var the client used to read (`DROPLET_PM_ADMIN_TOKEN`) was never a
 * valid Plane credential. The orchestrator mints the real token through
 * the bootstrap admin's session and caches it; we cache the success here
 * too so each mcp-server process pays the round-trip once.
 *
 * Best-effort: on any failure the handler proceeds without a token and
 * pm-client surfaces the resulting 401 as PlaneApiError — the same error
 * path as before, now with the orchestrator's logs explaining why.
 */

import type { ToolContext } from "../../types.js";
import { setPlaneApiToken } from "./pm-client.js";

let injected = false;

export async function ensurePlaneToken(ctx: ToolContext): Promise<void> {
  if (injected) return;
  try {
    const res = await ctx.http.orchestrator.get("/api/pm/service-token", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { token?: string };
    if (typeof body.token === "string" && body.token.length > 0) {
      setPlaneApiToken(body.token);
      injected = true;
    }
  } catch {
    // Orchestrator or PM stack not ready — fall through to the 401 path.
  }
}
