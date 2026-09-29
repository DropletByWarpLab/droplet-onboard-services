"use client";

/**
 * WARP-2976 (ADR-059 §2.4) — the one figure a Business overview tile shows,
 * chosen by the department's template.
 *
 * Every figure comes from an endpoint the dashboard already reads; none is
 * invented, and none is ever a zero it did not read:
 *
 *   cameras_online       GET /api/cameras               (module: cameras)
 *   open_incidents       GET /api/security/incidents/summary (module: security; WARP-2978)
 *   open_deals           GET /api/crm/pipelines + summary (module: crm)
 *   overdue_invoices     GET /api/money                 (module: money)
 *   open_work            GET /api/pm/work-items?department= (module: projects)
 *   services_unhealthy   GET /api/orchestrator/health
 *   todays_appointments  — no source yet; renders nothing (see below)
 *   members              — the tile's member count is the whole figure
 *
 * A figure whose module is off says so ("Money is off on this box") instead
 * of rendering a zero. Each figure is its own component so its hooks only
 * mount when that figure is actually on the page.
 */
import type { JSX } from "react";

import { usePipelines, useCrmSummary } from "@/components/crm/useCrm";
import type { HeadlineFigureId } from "@/lib/departments/templates";

import {
  OPEN_INCIDENTS_COPY,
  openIncidentsFigure,
  salesFigure,
  useCameraFleet,
  useDepartmentWork,
  useMoneyOverdue,
  useOpenIncidents,
  useServiceHealth,
} from "./department-sources";

/** The module a figure reads, and the name the "off" sentence uses for it
 *  (the nav label of the surface, so the words match the sidebar). */
const FIGURE_MODULE: Partial<Record<HeadlineFigureId, { id: string; label: string }>> = {
  cameras_online: { id: "cameras", label: "Cameras" },
  open_incidents: { id: "security", label: "Security" },
  open_deals: { id: "crm", label: "Customers" },
  overdue_invoices: { id: "money", label: "Money" },
  open_work: { id: "projects", label: "Projects" },
};

function Figure({ n, label }: { n: string; label: string }): JSX.Element {
  return (
    // The space reads "2 open alerts" to a screen reader; the flex column ignores it.
    <p className="dept-figure">
      <span className="dept-figure-n">{n}</span> <span className="dept-figure-l">{label}</span>
    </p>
  );
}

function Quiet({ children }: { children: string }): JSX.Element {
  return (
    <p className="dept-note" role="status">
      {children}
    </p>
  );
}

function Skeleton(): JSX.Element {
  return <div className="dept-skel dept-skel-sm" aria-hidden="true" />;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

function CamerasOnline(): JSX.Element {
  const { online, total, error, isLoading } = useCameraFleet(true);
  if (error) return <Quiet>Couldn&rsquo;t read the cameras just now.</Quiet>;
  if (isLoading || online === undefined || total === undefined) return <Skeleton />;
  if (total === 0) return <Quiet>No cameras yet.</Quiet>;
  return <Figure n={`${online} of ${total}`} label={`${plural(total, "camera", "cameras")} online`} />;
}

/** WARP-2978 — open alerts (and notices); `Nothing needs attention`, or what alerts still need. Never a 0. */
function OpenIncidents(): JSX.Element {
  const { summary, off, error, isLoading } = useOpenIncidents(true);
  if (off) return <Quiet>{OPEN_INCIDENTS_COPY.off}</Quiet>;
  if (error) return <Quiet>{OPEN_INCIDENTS_COPY.loadFailed}</Quiet>;
  if (isLoading || !summary) return <Skeleton />;
  const fig = openIncidentsFigure(summary.openAlerts, summary.openNotices);
  if (fig) return <Figure n={fig.n} label={fig.label} />;
  return <Quiet>{summary.alertsReady ? OPEN_INCIDENTS_COPY.nothing : OPEN_INCIDENTS_COPY.notReady}</Quiet>;
}

function OpenDeals(): JSX.Element {
  const { pipelines, error: pipeErr, isLoading: pipeLoading } = usePipelines();
  const pipeline = pipelines?.find((p) => p.isDefault) ?? pipelines?.[0] ?? null;
  const { stages, error: sumErr, isLoading: sumLoading } = useCrmSummary(pipeline?.id ?? null);
  if (pipeErr || sumErr) return <Quiet>Couldn&rsquo;t read the pipeline just now.</Quiet>;
  if (pipelines && pipelines.length === 0) return <Quiet>No pipeline yet.</Quiet>;
  if (pipeLoading || sumLoading || !stages) return <Skeleton />;
  const fig = salesFigure(stages);
  const label = `open ${plural(fig.openDeals, "deal", "deals")}`;
  const tail = fig.value ? ` · ${fig.value}` : fig.note ? ` · ${fig.note}` : "";
  return <Figure n={String(fig.openDeals)} label={label + tail} />;
}

function OverdueInvoices(): JSX.Element {
  const { overdueInvoices, error, isLoading } = useMoneyOverdue(true);
  if (error) return <Quiet>Couldn&rsquo;t read Money just now.</Quiet>;
  if (isLoading || overdueInvoices === undefined) return <Skeleton />;
  return (
    <Figure n={String(overdueInvoices)} label={`overdue ${plural(overdueInvoices, "invoice", "invoices")}`} />
  );
}

function OpenWork({ departmentId }: { departmentId: string }): JSX.Element {
  const { open, capped, error, isLoading } = useDepartmentWork(departmentId, true);
  if (error) return <Quiet>Couldn&rsquo;t read this department&rsquo;s work just now.</Quiet>;
  if (isLoading || !open) return <Skeleton />;
  return (
    <Figure
      n={`${open.length}${capped ? "+" : ""}`}
      label={`open work ${plural(open.length, "item", "items")}`}
    />
  );
}

function ServicesUnhealthy(): JSX.Element {
  const { total, unhealthy, error, isLoading } = useServiceHealth();
  if (error) return <Quiet>Couldn&rsquo;t read the box&rsquo;s health just now.</Quiet>;
  if (isLoading || total === undefined || unhealthy === undefined) return <Skeleton />;
  if (unhealthy === 0) {
    return <Figure n={String(total)} label={`${plural(total, "service", "services")}, all healthy`} />;
  }
  return <Figure n={`${unhealthy} of ${total}`} label="services not healthy" />;
}

export function HeadlineFigure({
  figure,
  departmentId,
  isModuleOn,
}: {
  figure: HeadlineFigureId;
  departmentId: string;
  isModuleOn: (moduleId: string) => boolean;
}): JSX.Element | null {
  const mod = FIGURE_MODULE[figure];
  if (mod && !isModuleOn(mod.id)) return <Quiet>{`${mod.label} is off on this box`}</Quiet>;
  switch (figure) {
    case "cameras_online":
      return <CamerasOnline />;
    case "open_incidents":
      return <OpenIncidents />;
    case "open_deals":
      return <OpenDeals />;
    case "overdue_invoices":
      return <OverdueInvoices />;
    case "open_work":
      return <OpenWork departmentId={departmentId} />;
    case "services_unhealthy":
      return <ServicesUnhealthy />;
    case "todays_appointments":
      // MISSING SOURCE: there is no shared or department calendar to count.
      // GET /api/calendar/events is scoped to the CALLER's own username
      // (orchestrator routes/calendar.ts → listEvents(prisma, user)), so on
      // this tile it would count the owner's own day, not the front desk's.
      // Until a department/shared calendar exists the tile shows the member
      // count only — never a borrowed or fabricated number.
      return null;
    case "members":
      // Custom has no template figure by design (ADR-059 §2.4): the member
      // count the tile already shows IS its figure.
      return null;
  }
}
