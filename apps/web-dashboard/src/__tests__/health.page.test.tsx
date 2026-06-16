/**
 * Health status page (PR #382) — appliance/service health.
 *
 * Data source: the EXISTING WARP-43 rolled-up endpoint
 * `GET /api/orchestrator/health` (api.ts `fetchSystemHealth` → SystemHealth
 * { status, components[], uptime, version }). No new data source invented —
 * this is the cached aggregate the dashboard pill + Docker healthcheck
 * already consume. The page renders the presentational `HealthStatusView`;
 * SWR wiring lives in the page wrapper.
 *
 * Contract under test (the spec's "green only when ALL up"):
 *   1. each service component renders with its name + status;
 *   2. the overall banner is the "all operational" (green) state ONLY when
 *      the aggregate status is "ok"; "degraded"/"down" render their own
 *      non-green states;
 *   3. loading + empty (pre-first-probe) states render, not a crash.
 *
 * Proven RED first: HealthStatusView does not exist yet (import fails).
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import React from "react";
import { HealthStatusView } from "@/components/health/HealthStatusView";
import type { SystemHealth } from "@/lib/api";

function makeHealth(overrides: Partial<SystemHealth> = {}): SystemHealth {
  return {
    status: "ok",
    uptime: 3600,
    version: "0.1.0",
    components: [
      { name: "db", status: "ok", latencyMs: 2, lastCheckedAt: "2026-05-31T00:00:00Z" },
      { name: "redis", status: "ok", latencyMs: 1, lastCheckedAt: "2026-05-31T00:00:00Z" },
      { name: "aiGateway", status: "ok", latencyMs: 12, lastCheckedAt: "2026-05-31T00:00:00Z" },
    ],
    ...overrides,
  };
}

describe("HealthStatusView (PR #382)", () => {
  it("renders the page heading and every service component with its status", () => {
    render(<HealthStatusView health={makeHealth()} isLoading={false} error={undefined} />);
    expect(
      screen.getByRole("heading", { level: 1, name: /health/i }),
    ).toBeInTheDocument();

    // Rendered with friendly labels (db → Database, aiGateway → AI gateway).
    const list = screen.getByRole("list", { name: /service health/i });
    for (const label of [/database/i, /cache/i, /ai gateway/i]) {
      expect(within(list).getByText(label)).toBeInTheDocument();
    }
  });

  it("shows the all-operational (green) banner only when aggregate status is ok", () => {
    render(<HealthStatusView health={makeHealth({ status: "ok" })} isLoading={false} error={undefined} />);
    const banner = screen.getByRole("status", { name: /system health/i });
    expect(banner).toHaveTextContent(/all systems operational/i);
    // The green state is conveyed via the system-green token, never raw hex.
    // eslint-disable-next-line testing-library/no-node-access
    expect(banner.querySelector(".bg-system-green")).not.toBeNull();
  });

  it("does NOT show the green banner when a service is down (degraded aggregate)", () => {
    const health = makeHealth({
      status: "degraded",
      components: [
        { name: "db", status: "ok", latencyMs: 2, lastCheckedAt: "2026-05-31T00:00:00Z" },
        { name: "frigate", status: "down", latencyMs: 0, lastCheckedAt: "2026-05-31T00:00:00Z", error: "unreachable" },
      ],
    });
    render(<HealthStatusView health={health} isLoading={false} error={undefined} />);
    const banner = screen.getByRole("status", { name: /system health/i });
    expect(banner).not.toHaveTextContent(/all systems operational/i);
    // eslint-disable-next-line testing-library/no-node-access
    expect(banner.querySelector(".bg-system-green")).toBeNull();
    // The failing service is surfaced (frigate → "Cameras (Frigate)").
    const list = screen.getByRole("list", { name: /service health/i });
    expect(within(list).getByText(/cameras \(frigate\)/i)).toBeInTheDocument();
    expect(within(list).getByText(/down/i)).toBeInTheDocument();
  });

  it("renders the down banner for a hard-down aggregate", () => {
    render(<HealthStatusView health={makeHealth({ status: "down" })} isLoading={false} error={undefined} />);
    const banner = screen.getByRole("status", { name: /system health/i });
    expect(banner).toHaveTextContent(/needs attention/i);
  });

  it("renders a loading state without crashing when health is undefined", () => {
    render(<HealthStatusView health={undefined} isLoading={true} error={undefined} />);
    expect(screen.getByText(/checking|loading/i)).toBeInTheDocument();
  });

  it("renders an error state when the health fetch failed", () => {
    render(
      <HealthStatusView
        health={undefined}
        isLoading={false}
        error={new Error("boom")}
      />,
    );
    expect(screen.getByText(/couldn.t|could not|unavailable|failed/i)).toBeInTheDocument();
  });
});
