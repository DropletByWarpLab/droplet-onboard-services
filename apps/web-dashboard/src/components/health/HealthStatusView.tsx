"use client";

import Link from "next/link";
import { AlertCircle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { SystemHealth, SystemHealthStatus } from "@/lib/api";

/**
 * Presentational health view (PR #382). Pure — takes the SystemHealth
 * snapshot + the SWR loading/error flags and renders. The page wrapper owns
 * the `useSWR(fetchSystemHealth)` call; keeping this pure makes the
 * "green only when ALL up" contract directly testable without SWR in jsdom.
 *
 * Data is the EXISTING WARP-43 aggregate (`GET /api/orchestrator/health`):
 * the orchestrator's background health-monitor probes each service every 15s
 * and caches the snapshot; `status` is "ok" only when every HARD dependency
 * is up, so the green banner is faithful to the spec without us re-deriving
 * health here.
 *
 * Tokens only: the indigo shell primitives (.card / .lrow / .sect / .badge)
 * + var(--text) / var(--text-muted) / var(--brand) / bg-system-*. No raw hex.
 */

const BANNER_COPY: Record<
  SystemHealthStatus,
  { label: string; sub: string; dot: string; Icon: typeof CheckCircle2; tint: string }
> = {
  ok: {
    label: "All systems operational",
    sub: "Every service on this Droplet is up.",
    dot: "bg-system-green",
    Icon: CheckCircle2,
    tint: "text-system-green",
  },
  degraded: {
    label: "Degraded",
    sub: "One or more services need a look. Core features may still work.",
    dot: "bg-system-orange",
    Icon: AlertCircle,
    tint: "text-system-orange",
  },
  down: {
    label: "Needs attention",
    sub: "A core service is down. Some features won't work until it recovers.",
    dot: "bg-system-red",
    Icon: XCircle,
    tint: "text-system-red",
  },
};

/** Friendly service labels — the aggregate keys are terse (db, aiGateway). */
const SERVICE_LABELS: Record<string, string> = {
  db: "Database",
  redis: "Cache",
  aiGateway: "AI gateway",
  matter: "Smart home (Matter)",
  router: "Router",
  frigate: "Cameras (Frigate)",
  switch: "Network switch",
  display: "Front display",
  // WARP-1146 — degraded/failed RAID pools surface through the monitor.
  storage: "Storage pools",
};

function serviceLabel(name: string): string {
  return SERVICE_LABELS[name] ?? name;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

export interface HealthStatusViewProps {
  health: SystemHealth | undefined;
  isLoading: boolean;
  error: Error | undefined;
}

export function HealthStatusView({ health, isLoading, error }: HealthStatusViewProps) {
  return (
    <>
      <div className="phead">
        <div className="ph-tx">
          <h1>Health</h1>
          <p>
            Live status of every service running on this Droplet. Checked every
            15 seconds — nothing here leaves the box.
          </p>
        </div>
      </div>

      {error && !health ? (
        <div className="card">
          <div className="empty">
            <span className="ei">
              <AlertCircle size={24} aria-hidden="true" />
            </span>
            <span className="eh">Couldn&rsquo;t reach the health service</span>
            <span>
              The orchestrator didn&rsquo;t answer. It may be restarting — this
              page refreshes on its own once it&rsquo;s back.
            </span>
          </div>
        </div>
      ) : !health ? (
        <div className="card" style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12, padding: 40 }}>
          <Loader2 size={18} className="animate-spin" style={{ color: "var(--text-muted)" }} aria-hidden="true" />
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            {isLoading ? "Checking services…" : "Loading…"}
          </p>
        </div>
      ) : (
        <HealthBody health={health} />
      )}
    </>
  );
}

function HealthBody({ health }: { health: SystemHealth }) {
  const banner = BANNER_COPY[health.status];
  const BannerIcon = banner.Icon;
  const components = health.components ?? [];

  return (
    <>
      {/* Overall banner — green only when the aggregate is "ok". */}
      <section
        role="status"
        aria-label="System health"
        className="card"
        style={{ display: "flex", alignItems: "flex-start", gap: 13 }}
      >
        <span
          className={`${banner.dot}`}
          style={{ marginTop: 4, width: 11, height: 11, borderRadius: "50%", flexShrink: 0 }}
          aria-hidden="true"
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BannerIcon size={18} className={banner.tint} aria-hidden="true" />
            <p style={{ fontSize: 16, fontWeight: 600, color: "var(--text)" }}>{banner.label}</p>
          </div>
          <p style={{ fontSize: 13.5, color: "var(--text-muted)", marginTop: 4 }}>{banner.sub}</p>
        </div>
      </section>

      {/* Per-service rows. */}
      <div className="sect" style={{ marginTop: 30 }}>
        <h2>Services</h2>
        <span className="sx">{components.length} checked</span>
      </div>
      {components.length === 0 ? (
        <p style={{ fontSize: 13, color: "var(--text-muted)", fontStyle: "italic" }}>
          Health check pending. The orchestrator probes each service every 15
          seconds — give it a moment.
        </p>
      ) : (
        <ul aria-label="Service health" className="card rows" style={{ padding: "4px 18px" }}>
          {components.map((c) => {
            const up = c.status === "ok";
            return (
              <li key={c.name} className="lrow">
                <span
                  className={up ? "bg-system-green" : "bg-system-red"}
                  style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0 }}
                  aria-hidden="true"
                />
                <span className="rt">
                  <span className="nm">{serviceLabel(c.name)}</span>
                </span>
                {/* WARP-1146 — a flagged storage pool is actionable: point the
                    owner straight at the Drives page that shows which pool
                    dropped a member and what to do about it. */}
                {c.name === "storage" && !up && (
                  <Link
                    href="/files/drives"
                    className="rmeta text-[var(--brand)]"
                    style={{ textDecoration: "none" }}
                  >
                    View drives
                  </Link>
                )}
                {up && c.latencyMs > 0 && (
                  <span className="rmeta mono">{c.latencyMs}ms</span>
                )}
                <span className={"badge " + (up ? "ok" : "danger")}>{up ? "Up" : "Down"}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Uptime + version footer. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginTop: 20,
          fontSize: 13,
          color: "var(--text-muted)",
        }}
      >
        <span>Uptime {formatUptime(health.uptime)}</span>
        <span style={{ fontFamily: "var(--font-mono)" }}>v{health.version}</span>
      </div>
    </>
  );
}
