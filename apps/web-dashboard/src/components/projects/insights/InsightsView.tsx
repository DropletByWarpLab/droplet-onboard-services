"use client";

// Insights (WARP-3524): what the work is doing, for one project (the project's
// Insights tab) or for every project (`/projects?view=insights`).
//
// Seven cards, each with one plain-language reading and its numbers as a table;
// a range picker; and the same loading / empty / error states every other view
// has (brief §3.10). The orchestrator does the counting and caches an answer for
// five minutes; this file only draws it.

import { useState, type JSX } from "react";
import "./insights.css";
import { PmIcon } from "../icons";
import { EmptyBlock, Skel, usePerson } from "../bits";
import { ChartCard, type DataTable } from "./ChartCard";
import {
  BAND_META,
  BAND_STACK_ORDER,
  BarTable,
  CumulativeFlowChart,
  DurationChart,
  FlowChart,
  ThroughputChart,
  type BarRow,
} from "./charts";
import {
  agingReading,
  bucketTitle,
  cumulativeFlowReading,
  durationBucketLabels,
  durationBucketShortLabels,
  durationReading,
  flowReading,
  formatAge,
  formatDays,
  throughputReading,
  workloadReading,
  ymdLabel,
} from "./readings";
import {
  DEFAULT_INSIGHTS_RANGE,
  INSIGHTS_RANGES,
  useInsights,
  type InsightsRangeId,
} from "./useInsights";
import type { InsightsDuration, PmInsights } from "./types";

// ── Pieces ───────────────────────────────────────────────────────────────────

function RangePicker({ value, onChange }: { value: InsightsRangeId; onChange: (id: InsightsRangeId) => void }): JSX.Element {
  return (
    <div className="pm-pills" role="group" aria-label="Date range">
      {INSIGHTS_RANGES.map((r) => (
        <button
          key={r.id}
          type="button"
          className={value === r.id ? "on" : ""}
          aria-pressed={value === r.id}
          onClick={() => onChange(r.id)}
        >
          {r.label}
        </button>
      ))}
    </div>
  );
}

function Tile({
  eyebrow,
  value,
  note,
  dotColor,
}: {
  eyebrow: string;
  value: string | number;
  note: string;
  dotColor?: string;
}): JSX.Element {
  return (
    <div className="pm-kpi">
      <div className="lbl">{eyebrow}</div>
      <div>
        <div className="val">{value}</div>
        <div className="meta">
          {dotColor && <span className="pm-dot" style={{ background: dotColor }} />}
          <span>{note}</span>
        </div>
      </div>
    </div>
  );
}

const NoData = ({ children }: { children: string }): JSX.Element => <div className="pm-empty-inline">{children}</div>;

/** "Half / most / nearly all finish within …": the three percentiles, in words, with the jargon as a quiet tag. */
function DurationStats({ d, unit }: { d: InsightsDuration; unit: string }): JSX.Element | null {
  if (d.count === 0 || d.p50 === null || d.p85 === null || d.p95 === null) return null;
  return (
    <>
      <dl className="pm-stats">
        <div>
          <dt>
            Half finish within <span className="pm-mono">p50</span>
          </dt>
          <dd>{formatDays(d.p50)}</dd>
        </div>
        <div>
          <dt>
            Most finish within <span className="pm-mono">p85</span>
          </dt>
          <dd>{formatDays(d.p85)}</dd>
        </div>
        <div>
          <dt>
            Nearly all within <span className="pm-mono">p95</span>
          </dt>
          <dd>{formatDays(d.p95)}</dd>
        </div>
      </dl>
      <p className="pm-caption">
        {unit} · {d.count} {d.count === 1 ? "item" : "items"} measured
      </p>
    </>
  );
}

function DurationCard({ kind, d }: { kind: "cycle" | "lead"; d: InsightsDuration }): JSX.Element {
  const labels = durationBucketLabels(d.edgesDays);
  const table: DataTable = {
    columns: ["Time taken", "Items"],
    rows: d.counts.map((n, i) => [labels[i], n]),
  };
  return (
    <ChartCard
      title={kind === "cycle" ? "Cycle time" : "Lead time"}
      reading={durationReading(kind, d)}
      table={table}
      footer={
        <DurationStats
          d={d}
          unit={kind === "cycle" ? "Days from starting to finished" : "Days from being added to finished"}
        />
      }
    >
      {d.count === 0 ? (
        <NoData>Nothing to chart yet.</NoData>
      ) : (
        <DurationChart labels={labels} shortLabels={durationBucketShortLabels(d.edgesDays)} counts={d.counts} />
      )}
    </ChartCard>
  );
}

// ── Cards from the response ──────────────────────────────────────────────────

function Cards({ i }: { i: PmInsights }): JSX.Element {
  const person = usePerson();
  const nameOf = (id: string) => person(id).name;
  const { groupBy } = i.meta;

  const throughputTable: DataTable = {
    columns: ["Period", "Finished"],
    rows: i.throughput.buckets.map((b) => [bucketTitle(b.start, groupBy), b.completed]),
  };
  const flowTable: DataTable = {
    columns: ["Period", "Added", "Finished"],
    rows: i.createdVsCompleted.buckets.map((b) => [bucketTitle(b.start, groupBy), b.created, b.completed]),
  };

  const bands = BAND_STACK_ORDER.filter((b) => i.cumulativeFlow.groups.includes(b));
  const cfdTable: DataTable = {
    // Top of the stack first, as in the legend.
    columns: ["Day", ...[...bands].reverse().map((b) => BAND_META[b].label)],
    rows: i.cumulativeFlow.days.map((d) => [d.date, ...[...bands].reverse().map((b) => d[b])]),
  };
  const lastDay = i.cumulativeFlow.days[i.cumulativeFlow.days.length - 1];

  const workloadMax = Math.max(1, ...i.workload.assignees.map((a) => a.openItems));
  const workloadRows: BarRow[] = i.workload.assignees.map((a) => ({
    key: a.userId ?? "unassigned",
    header: a.userId ? nameOf(a.userId) : "Unassigned",
    value: a.openItems,
    valueLabel: String(a.openItems),
    // Unowned work is grey, not alarming: it is a fact about the work, not a fault.
    color: a.userId ? "var(--accent)" : "var(--text-4)",
    extra: String(a.openEstimate),
  }));

  const p85 = i.cycleTime.p85;
  const agingMax = Math.max(1, p85 ?? 0, ...i.agingWip.items.map((a) => a.ageDays));
  const agingRows: BarRow[] = i.agingWip.items.map((a) => ({
    key: a.id,
    header: (
      <>
        <span className="key">{a.key}</span>
        {a.name}
        <span className="pm-sub">{a.stateName}</span>
      </>
    ),
    value: a.ageDays,
    valueLabel: formatAge(a.ageDays),
    color: p85 !== null && a.ageDays > p85 ? "var(--warn)" : "var(--accent)",
  }));

  return (
    <div className="pm-insights-grid">
      <ChartCard
        title="Work finished"
        reading={throughputReading(i.throughput, i.meta)}
        table={throughputTable}
      >
        {i.throughput.total === 0 ? (
          <NoData>No finished work in this period yet.</NoData>
        ) : (
          <ThroughputChart buckets={i.throughput.buckets} groupBy={groupBy} />
        )}
      </ChartCard>

      <ChartCard title="Added and finished" reading={flowReading(i.createdVsCompleted)} table={flowTable}>
        {i.createdVsCompleted.created === 0 && i.createdVsCompleted.completed === 0 ? (
          <NoData>No work was added or finished in this period.</NoData>
        ) : (
          <FlowChart buckets={i.createdVsCompleted.buckets} groupBy={groupBy} />
        )}
      </ChartCard>

      <DurationCard kind="cycle" d={i.cycleTime} />
      <DurationCard kind="lead" d={i.leadTime} />

      <ChartCard
        wide
        title="Cumulative flow"
        reading={cumulativeFlowReading(i.cumulativeFlow.days)}
        table={cfdTable}
        footer={
          lastDay && lastDay.unknown > 0 ? (
            <p className="pm-caption">
              {lastDay.unknown} {lastDay.unknown === 1 ? "item sits" : "items sit"} in a state that was removed, so{" "}
              {lastDay.unknown === 1 ? "it isn't" : "they aren't"} placed until {lastDay.unknown === 1 ? "it moves" : "they move"}.
            </p>
          ) : undefined
        }
      >
        <CumulativeFlowChart days={i.cumulativeFlow.days} groups={i.cumulativeFlow.groups} />
      </ChartCard>

      <ChartCard title="Workload" reading={workloadReading(i.workload, nameOf)}>
        {i.workload.assignees.length === 0 ? (
          <NoData>Nothing is open right now.</NoData>
        ) : (
          <BarTable
            caption="Open items by person"
            headers={{
              row: "Person",
              value: "Open items",
              extra: i.workload.estimateAvailable ? "Open estimate" : undefined,
            }}
            rows={workloadRows}
            max={workloadMax}
          />
        )}
      </ChartCard>

      <ChartCard
        title="Aging work in progress"
        reading={agingReading(i.agingWip, p85)}
        footer={
          i.agingWip.total > i.agingWip.items.length ? (
            <p className="pm-caption">
              The {i.agingWip.items.length} oldest of {i.agingWip.total} items in progress.
            </p>
          ) : undefined
        }
      >
        {i.agingWip.total === 0 ? (
          <NoData>Nothing is in progress right now.</NoData>
        ) : (
          <BarTable
            caption="Items in progress, oldest first"
            headers={{ row: "Item", value: "In progress for" }}
            rows={agingRows}
            max={agingMax}
            mark={p85}
            markTitle={p85 !== null ? `Most finished work took up to ${formatDays(p85)}` : undefined}
          />
        )}
      </ChartCard>
    </div>
  );
}

// ── States ───────────────────────────────────────────────────────────────────

function LoadingGrid(): JSX.Element {
  return (
    <div role="status" aria-busy="true" style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <span className="pm-sr-only">Loading insights</span>
      <div className="pm-grid-kpi">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="pm-kpi">
            <Skel w={80} h={11} />
            <Skel w={56} h={26} r={6} />
          </div>
        ))}
      </div>
      <div className="pm-insights-grid">
        {[0, 1, 2, 3].map((n) => (
          <div key={n} className="pm-chartcard">
            <Skel w="45%" h={14} />
            <Skel w="75%" h={12} />
            <Skel w="100%" h={180} r={10} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function InsightsView({ projectId }: { projectId: string | null }): JSX.Element {
  const [rangeId, setRangeId] = useState<InsightsRangeId>(DEFAULT_INSIGHTS_RANGE);
  const range = INSIGHTS_RANGES.find((r) => r.id === rangeId) ?? INSIGHTS_RANGES[1];
  const { insights, error, mutate } = useInsights(projectId, range);

  let body: JSX.Element;
  if (!insights && error) {
    // One string for a failed load (brief §6); a project that is gone is the one
    // case where trying again cannot help.
    const gone = error.status === 404;
    body = (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="alert"
          tone={gone ? undefined : "error"}
          heading={gone ? "This project isn't available." : "Couldn't load insights."}
          body={gone ? "It may have been removed." : "Check the appliance connection and try again."}
          cta={
            gone ? undefined : (
              <button className="pm-btn ghost" type="button" onClick={() => void mutate()}>
                <PmIcon name="refresh" size={14} />
                Try again
              </button>
            )
          }
        />
      </div>
    );
  } else if (!insights) {
    body = <LoadingGrid />;
  } else if (insights.meta.itemCount === 0) {
    body = (
      <div className="pm-surface" style={{ padding: 8 }}>
        <EmptyBlock
          icon="spark"
          heading="No insights yet."
          body={
            projectId
              ? "Charts appear once this project has some work in it."
              : "Charts appear once there is some work in your projects."
          }
        />
      </div>
    );
  } else {
    const unassigned = insights.workload.assignees.find((a) => a.userId === null)?.openItems ?? 0;
    body = (
      <>
        <div className="pm-grid-kpi">
          <Tile eyebrow="Finished" value={insights.throughput.total} note="in this period" dotColor="var(--ok)" />
          <Tile
            eyebrow="Typical cycle time"
            value={insights.cycleTime.p50 === null ? "—" : formatDays(insights.cycleTime.p50)}
            note="from starting to finished"
          />
          <Tile eyebrow="In progress" value={insights.agingWip.total} note="right now" />
          <Tile eyebrow="Unassigned" value={unassigned} note="open, with no owner" dotColor="var(--warn)" />
        </div>
        <Cards i={insights} />
      </>
    );
  }

  return (
    <div className="pm-insights" data-testid="pm-insights">
      <div className="pm-insights-bar">
        <RangePicker value={rangeId} onChange={setRangeId} />
        {insights && (
          <span className="pm-insights-asof">
            {ymdLabel(insights.meta.from)} – {ymdLabel(insights.meta.to)} · as of{" "}
            {new Date(insights.meta.generatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} ·
            numbers refresh every five minutes
          </span>
        )}
      </div>
      {body}
    </div>
  );
}
