/**
 * WARP-535 — dependency-free liveness probe for the web-dashboard
 * container (OTA foundations: every compose service answers a health
 * probe).
 *
 * Why `/healthz` and not the ticket's literal `/health` / `/api/health`:
 *   - `/health` is already the human-facing status PAGE
 *     (src/app/health/page.tsx); a route handler on the same path is a
 *     Next.js build conflict.
 *   - `/api/health` is the orchestrator's aggregate health. In dev,
 *     next.config.js rewrites `/api/*` to the orchestrator AFTER
 *     filesystem routes, so an app route here would shadow the
 *     orchestrator shape that src/lib/api.ts and useDevice.ts consume.
 *
 * A 200 means the Next.js server process is serving requests — that is
 * the entire contract. No auth (it is the Docker healthcheck target,
 * mirroring the auth-exempt `/health` on the Python services) and no
 * payload beyond the identifying shape (liveness, not an info leak).
 */

// The probe must execute per-request; without this Next could
// statically optimize the handler at build time.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json({ status: "ok", service: "web-dashboard" });
}
