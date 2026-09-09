"use client";

/**
 * WARP-2561 (ADR-044 slice 3) — `/business`, Planning.
 *
 * `/reports` answers *how did it go*. Nine of its ten tiles are infrastructure
 * and there is no business tile on it at all, so nothing in the product
 * answered *what is coming*. This page does, and only that.
 *
 * Two rules it inherits from `/reports`, for the reason nav-config states
 * there — "a module gate here would hide the whole page because one of its ten
 * tiles is off":
 *
 *   1. ROLE-gated, never module-gated. There is no `business` module and this
 *      page must not acquire one.
 *   2. Every tile degrades on its own. A tile whose module is off is not
 *      rendered; the page renders whatever is left, and is still worth opening
 *      with only one tile alive.
 *
 * Every figure on this page comes from a source that already exists. Nothing
 * here is a placeholder, and no tile renders a number it did not read.
 */

import { useEffect, useMemo, useState, type JSX, type ReactNode } from "react";
import { Briefcase, CalendarClock, FolderKanban, Sparkles, Stethoscope } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { ShellPage } from "@/components/shell/ShellPage";
import { useAuth } from "@/lib/auth";
import { useAppCapabilities } from "@/lib/hooks/useAppCapabilities";
import { useCrmSummary, useDeals, usePipelines } from "@/components/crm/useCrm";
import { useSummary } from "@/components/projects/usePm";
import { useEaglesoft, useErpAccess } from "@/lib/hooks/useEaglesoft";

import { AskBody, ClosingBody, PipelineBody, PracticeBody, WorkBody } from "./tiles";
import "./business.css";

const SUB = "What's coming — your pipeline, your work in flight, and today's schedule.";

/** The ERP statuses that carry data. Same set the practice surface uses; a
 *  connection that is merely CONFIGURED has nothing to show yet. */
const DATA_STATUSES = new Set(["CONNECTED", "DEGRADED", "DRIFT_LOCKED"]);

type Span = "6x2" | "4x2" | "12x1";

interface TileSpec {
  id: string;
  span: Span;
  title: string;
  icon: LucideIcon;
}

export default function BusinessPage(): JSX.Element {
  const { user } = useAuth();
  const { crm: crmEnabled, projects: projectsEnabled } = useAppCapabilities();
  const erpAccess = useErpAccess();

  // One clock for the page, stamped on the client. Rendering a date during
  // SSR hydrates against a different second, and across a month boundary
  // "closing this month" would disagree with itself. /reports does the same.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
  }, []);

  // Every hook runs unconditionally — hooks cannot be called behind a
  // condition — but each is passed a null key when its module is off, which
  // is how useSWR is told not to fetch. So a CRM-off box issues no CRM
  // request, rather than issuing one and hiding the result.
  const { pipelines, error: pipeErr, isLoading: pipeLoading } = usePipelines();
  const pipeline = crmEnabled ? pipelines?.find((p) => p.isDefault) ?? pipelines?.[0] ?? null : null;
  const { stages, error: sumErr, isLoading: sumLoading } = useCrmSummary(pipeline?.id ?? null);
  const { deals, error: dealErr, isLoading: dealLoading } = useDeals(pipeline?.id ?? null);
  const { summary: pm, error: pmErr, isLoading: pmLoading } = useSummary();
  const { connection, schedule, isLoading: erpLoading } = useEaglesoft();

  // The practice tile needs BOTH: a connection that carries data, and a
  // principal allowed to see PHI. `family` reaches this page — it is the
  // front desk — and must not reach this tile.
  const showPractice = erpAccess.canViewPhi && DATA_STATUSES.has(connection.status);

  const tiles = useMemo(() => {
    const out: Array<{ spec: TileSpec; body: ReactNode }> = [];
    if (crmEnabled) {
      out.push({
        spec: { id: "pipeline", span: "6x2", title: "Pipeline", icon: Briefcase },
        body: (
          <PipelineBody
            stages={stages}
            loading={pipeLoading || sumLoading}
            failed={Boolean(pipeErr || sumErr)}
          />
        ),
      });
      out.push({
        spec: { id: "closing", span: "6x2", title: "Closing this month", icon: CalendarClock },
        body: (
          <ClosingBody
            deals={deals}
            now={now}
            loading={pipeLoading || dealLoading}
            failed={Boolean(pipeErr || dealErr)}
          />
        ),
      });
    }
    if (projectsEnabled) {
      out.push({
        spec: { id: "work", span: "4x2", title: "Work in flight", icon: FolderKanban },
        body: <WorkBody summary={pm} loading={pmLoading} failed={Boolean(pmErr)} />,
      });
    }
    if (showPractice) {
      out.push({
        spec: { id: "practice", span: "4x2", title: "Today at the practice", icon: Stethoscope },
        body: <PracticeBody schedule={schedule} loading={erpLoading} failed={false} />,
      });
    }
    // Always last, always present. It is the one tile that needs no source, and
    // on a box with every module off it is the whole page — which is honest:
    // the assistant can still answer, and nothing else can.
    out.push({
      spec: { id: "ask", span: "4x2", title: "Ask about your business", icon: Sparkles },
      body: <AskBody />,
    });
    return out;
  }, [
    crmEnabled,
    projectsEnabled,
    showPractice,
    stages,
    deals,
    pm,
    schedule,
    now,
    pipeLoading,
    sumLoading,
    dealLoading,
    pmLoading,
    erpLoading,
    pipeErr,
    sumErr,
    dealErr,
    pmErr,
  ]);

  return (
    <ShellPage
      icon={<Sparkles size={15} />}
      label="Planning"
      title="Planning"
      sub={SUB}
    >
      <div className="droplet-business">
        <div className="bz-bento">
          {tiles.map(({ spec, body }) => (
            <TileShell key={spec.id} spec={spec} body={body} />
          ))}
        </div>
        {user?.role === "family" ? (
          // Said once, plainly, rather than leaving a hole where two tiles
          // would be. The alternative — rendering locked placeholders — tells
          // someone the box is withholding without telling them why.
          <p className="bz-note">
            Some figures on this page are limited to owners and admins.
          </p>
        ) : null}
      </div>
    </ShellPage>
  );
}

function TileShell({ spec, body }: { spec: TileSpec; body: ReactNode }): JSX.Element {
  const Icon = spec.icon;
  const headingId = `bz-t-${spec.id}`;
  return (
    <section
      className="bz-tile"
      data-span={spec.span}
      data-tile={spec.id}
      aria-labelledby={headingId}
    >
      <div className="bz-tile-head">
        <Icon size={14} aria-hidden="true" />
        <h2 id={headingId} className="bz-tile-title">
          {spec.title}
        </h2>
      </div>
      <div className="bz-tile-body">{body}</div>
    </section>
  );
}
