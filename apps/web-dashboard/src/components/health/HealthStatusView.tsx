"use client";

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
 * Tokens only: dp-card / dp-tile / type-* / text-label-* / bg-system-* /
 * text-accent. No raw hex.
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
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      <header className="mb-6">
        <h1 className="type-large-title text-label-primary mb-2">Health</h1>
        <p className="type-body text-label-secondary">
          Live status of every service running on this Droplet. Checked every
          15 seconds — nothing here leaves the box.
        </p>
      </header>

      {error && !health ? (
        <div className="dp-card p-8 text-center">
          <AlertCircle
            size={28}
            className="text-system-orange mx-auto mb-3"
            aria-hidden="true"
          />
          <p className="type-headline text-label-primary mb-1">
            Couldn&rsquo;t reach the health service
          </p>
          <p className="type-subheadline text-label-secondary">
            The orchestrator didn&rsquo;t answer. It may be restarting — this
            page refreshes on its own once it&rsquo;s back.
          </p>
        </div>
      ) : !health ? (
        <div className="dp-card p-8 flex items-center justify-center gap-3">
          <Loader2
            size={18}
            className="text-label-tertiary animate-spin"
            aria-hidden="true"
          />
          <p className="type-subheadline text-label-tertiary">
            {isLoading ? "Checking services…" : "Loading…"}
          </p>
        </div>
      ) : (
        <HealthBody health={health} />
      )}
    </div>
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
        className="dp-tile p-5 mb-6 flex items-start gap-3"
      >
        <span
          className={`mt-0.5 w-2.5 h-2.5 rounded-full flex-shrink-0 ${banner.dot}`}
          aria-hidden="true"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <BannerIcon size={18} className={banner.tint} aria-hidden="true" />
            <p className="type-headline text-label-primary">{banner.label}</p>
          </div>
          <p className="type-subheadline text-label-secondary mt-1">
            {banner.sub}
          </p>
        </div>
      </section>

      {/* Per-service rows. */}
      {components.length === 0 ? (
        <p className="type-footnote text-label-tertiary italic">
          Health check pending. The orchestrator probes each service every 15
          seconds — give it a moment.
        </p>
      ) : (
        <ul
          aria-label="Service health"
          className="dp-card divide-y divide-separator overflow-hidden"
        >
          {components.map((c) => {
            const up = c.status === "ok";
            return (
              <li
                key={c.name}
                className="flex items-center gap-3 px-4 py-3 min-h-[44px]"
              >
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    up ? "bg-system-green" : "bg-system-red"
                  }`}
                  aria-hidden="true"
                />
                <span className="type-subheadline text-label-primary flex-1 truncate">
                  {serviceLabel(c.name)}
                </span>
                {up && c.latencyMs > 0 && (
                  <span className="type-caption-1 text-label-tertiary font-mono">
                    {c.latencyMs}ms
                  </span>
                )}
                <span
                  className={`type-caption-1 capitalize ${
                    up ? "text-label-tertiary" : "text-system-red"
                  }`}
                >
                  {up ? "Up" : "Down"}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Uptime + version footer. */}
      <div className="flex items-center justify-between mt-5 type-footnote text-label-tertiary">
        <span>Uptime {formatUptime(health.uptime)}</span>
        <span className="font-mono">v{health.version}</span>
      </div>
    </>
  );
}
