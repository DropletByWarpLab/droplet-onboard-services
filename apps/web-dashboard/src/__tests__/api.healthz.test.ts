/**
 * WARP-535 — machine liveness probe for the web-dashboard container.
 *
 * Every compose service must answer a health probe (OTA foundations).
 * The dashboard's `/health` path is already taken by the human-facing
 * status PAGE (src/app/health/page.tsx), and `/api/health` is the
 * orchestrator's aggregate (the dev-mode rewrite in next.config.js sends
 * `/api/*` to the orchestrator, and src/lib/api.ts + useDevice.ts fetch
 * `/api/health` expecting the orchestrator shape — an app route there
 * would shadow it in dev). So the dashboard's own probe lives at
 * `/healthz`, the conventional liveness path, served by a route handler.
 *
 * The probe is dependency-free: a 200 means the Next.js server process
 * is up. It deliberately returns no version/uptime — it is a liveness
 * signal, not an info endpoint.
 */
import { describe, it, expect } from "vitest";
import { GET } from "../app/healthz/route";

describe("GET /healthz (WARP-535)", () => {
  it("returns 200 with the ok + service shape", async () => {
    const res = GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: "ok", service: "web-dashboard" });
  });

  it("is marked force-dynamic so the probe is never statically cached", async () => {
    const route = await import("../app/healthz/route");
    expect(route.dynamic).toBe("force-dynamic");
  });
});
