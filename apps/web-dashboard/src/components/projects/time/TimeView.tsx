"use client";

// The time view (WARP-3526) — `/projects?view=time`: a weekly timesheet per
// person and a time report with CSV export. Not a new nav row (the sidebar is at
// its row cap); it is a view of the Projects page, reached from the header.
//
// Weeks start on Monday in the BROWSER's zone, which is sent with every request
// (`tz`), and an entry sits in the day it started on — the same rules the
// orchestrator applies, so the grid a person sees is the grid the CSV sums.

import { useMemo, useState, type JSX } from "react";
import { Download } from "lucide-react";
import { useToast } from "@/components/Toast";
import { PmIcon } from "../icons";
import { EmptyBlock, Skel, usePerson } from "../bits";
import type { PmProject } from "../types";
import { usePeople } from "../usePm";
import { useTimeAccess } from "./access";
import { timeErrorCopy } from "./copy";
import {
  addDays,
  browserTimeZone,
  fmtYmd,
  formatMinutes,
  formatWeekRange,
  mondayOf,
  weekdayShort,
  ymdInZone,
} from "./format";
import { EntryList } from "./TimeSection";
import type { ReportGroupBy } from "./types";
import { useTimeActions, useTimeReport, useTimesheet } from "./useTime";
import "./time.css";

const LOAD_ERROR = "Couldn't load time. Check the appliance connection and try again.";

function Cell({ minutes }: { minutes: number }): JSX.Element {
  return minutes === 0 ? (
    <td className="zero">
      <span aria-hidden="true">–</span>
      <span className="sr-only">0m</span>
    </td>
  ) : (
    <td>{formatMinutes(minutes)}</td>
  );
}

function TableSkeleton(): JSX.Element {
  return (
    <div className="pm-surface" style={{ padding: 16, display: "flex", flexDirection: "column", gap: 12 }} aria-hidden>
      <Skel h={14} w="30%" />
      <Skel h={14} w="80%" />
      <Skel h={14} w="70%" />
      <Skel h={14} w="75%" />
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }): JSX.Element {
  return (
    <div className="pm-surface">
      <EmptyBlock
        icon="alert"
        tone="error"
        heading={LOAD_ERROR}
        cta={
          <button className="pm-btn ghost" type="button" onClick={onRetry}>
            Try again
          </button>
        }
      />
    </div>
  );
}

// ── Timesheet ───────────────────────────────────────────────────────────────

function PersonSelect({ value, onChange }: { value: string; onChange: (id: string) => void }): JSX.Element {
  const { users } = usePeople();
  const access = useTimeAccess();
  const listed = (users ?? []).filter((u) => typeof u.userId === "string" && u.userId.length > 0);
  const hasSelf = listed.some((u) => u.userId === access.userId);
  return (
    <select
      className="pm-input"
      style={{ width: "auto", minWidth: 180, height: 34 }}
      aria-label="Person"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {!hasSelf && access.userId && <option value={access.userId}>Me</option>}
      {listed.map((u) => (
        <option key={u.userId as string} value={u.userId as string}>
          {u.displayName}
          {u.userId === access.userId ? " (you)" : ""}
        </option>
      ))}
    </select>
  );
}

function TimesheetTab(): JSX.Element {
  const access = useTimeAccess();
  const tz = browserTimeZone();
  const thisWeek = mondayOf(ymdInZone(new Date(), tz));
  const [weekStart, setWeekStart] = useState(thisWeek);
  const [chosen, setChosen] = useState<string | null>(null);
  const subject = chosen ?? access.userId ?? null;
  const { timesheet, error, isLoading, mutate } = useTimesheet(subject, weekStart, tz);

  return (
    <div role="tabpanel" aria-label="Timesheet" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="pm-time-bar">
        <span className="pm-row" style={{ gap: 8, flexWrap: "wrap" }}>
          <button
            className="pm-iconbtn"
            type="button"
            aria-label="Previous week"
            onClick={() => setWeekStart(addDays(weekStart, -7))}
          >
            <PmIcon name="chevL" size={16} />
          </button>
          <button
            className="pm-iconbtn"
            type="button"
            aria-label="Next week"
            onClick={() => setWeekStart(addDays(weekStart, 7))}
          >
            <PmIcon name="chevL" size={16} style={{ transform: "rotate(180deg)" }} />
          </button>
          <span
            className="pm-mono"
            style={{ fontSize: 13, fontWeight: 600, color: "var(--text)" }}
            aria-live="polite"
            data-testid="week-range"
          >
            {formatWeekRange(weekStart)}
          </span>
          <button
            className="pm-btn ghost sm"
            type="button"
            disabled={weekStart === thisWeek}
            onClick={() => setWeekStart(thisWeek)}
          >
            This week
          </button>
        </span>
        {subject && <PersonSelect value={subject} onChange={setChosen} />}
      </div>

      {isLoading && !timesheet ? (
        <TableSkeleton />
      ) : error && !timesheet ? (
        <LoadError onRetry={() => void mutate()} />
      ) : timesheet && timesheet.rows.length === 0 ? (
        <div className="pm-surface">
          <EmptyBlock
            icon="clock"
            heading="No time logged this week."
            body="Time logged on a work item shows up here."
          />
        </div>
      ) : timesheet ? (
        <>
          <div className="pm-ts-wrap" role="region" aria-label="Timesheet grid" tabIndex={0}>
            <table className="pm-ts">
              <caption className="sr-only">
                Time logged per work item, {formatWeekRange(timesheet.weekStart)}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Work item</th>
                  {timesheet.days.map((d) => (
                    <th scope="col" key={d}>
                      <span className="day">{weekdayShort(d)}</span>
                      {fmtYmd(d)}
                    </th>
                  ))}
                  <th scope="col">Total</th>
                </tr>
              </thead>
              <tbody>
                {timesheet.rows.map((r) => (
                  <tr key={r.workItem.id}>
                    <th scope="row" style={{ fontWeight: 500 }}>
                      <span className="pm-mono" style={{ fontSize: 11.5, color: "var(--text-3)", marginRight: 8 }}>
                        {r.workItem.key}
                      </span>
                      {r.workItem.name}
                    </th>
                    {r.minutes.map((m, i) => (
                      <Cell key={timesheet.days[i]} minutes={m} />
                    ))}
                    <td className="num">{formatMinutes(r.totalMinutes)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Total</td>
                  {timesheet.dayTotals.map((m, i) => (
                    <Cell key={timesheet.days[i]} minutes={m} />
                  ))}
                  <td>{formatMinutes(timesheet.totalMinutes)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div>
            <div className="pm-sect" style={{ marginBottom: 6 }}>
              Entries <span className="sx">{timesheet.entries.length}</span>
            </div>
            <EntryList entries={timesheet.entries} showItem />
          </div>
        </>
      ) : null}
    </div>
  );
}

// ── Report ──────────────────────────────────────────────────────────────────

const GROUPS: Array<[ReportGroupBy, string]> = [
  ["user", "person"],
  ["item", "item"],
  ["day", "day"],
];

function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 8)}01`;
}

function ReportTab({ projects, projectId }: { projects: PmProject[] | undefined; projectId: string | null }): JSX.Element {
  const person = usePerson();
  const { toast } = useToast();
  const actions = useTimeActions();
  const tz = browserTimeZone();
  const today = ymdInZone(new Date(), tz);
  const [project, setProject] = useState<string | null>(projectId);
  const [from, setFrom] = useState(firstOfMonth(today));
  const [to, setTo] = useState(today);
  const [groupBy, setGroupBy] = useState<ReportGroupBy>("user");
  const [exporting, setExporting] = useState(false);

  const valid = from !== "" && to !== "" && from <= to;
  const query = useMemo(
    () => (valid ? { projectId: project, from, to, groupBy, tz } : null),
    [valid, project, from, to, groupBy, tz],
  );
  const { report, error, isLoading, mutate } = useTimeReport(query);

  const exportCsv = async (): Promise<void> => {
    if (!query) return;
    setExporting(true);
    try {
      await actions.downloadReportCsv(query);
    } catch (e) {
      toast(timeErrorCopy(e), "error");
    } finally {
      setExporting(false);
    }
  };

  const labelOf = (row: { key: string; label: string; itemKey: string | null }): JSX.Element | string => {
    if (groupBy === "item") {
      return (
        <>
          <span className="pm-mono" style={{ fontSize: 11.5, color: "var(--text-3)", marginRight: 8 }}>
            {row.itemKey}
          </span>
          {row.label}
        </>
      );
    }
    if (groupBy === "day") return `${weekdayShort(row.key)} ${fmtYmd(row.key)}`;
    // The server names a person it knows; an id it does not know comes back as
    // itself, and the directory the page already holds is the better fallback.
    return row.label !== row.key ? row.label : person(row.key).name;
  };

  const firstColumn = groupBy === "item" ? "Work item" : groupBy === "day" ? "Day" : "Person";

  return (
    <div role="tabpanel" aria-label="Report" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="pm-time-bar">
        <span className="pm-row" style={{ gap: 10, flexWrap: "wrap" }}>
          <select
            className="pm-input"
            style={{ width: "auto", minWidth: 180, height: 34 }}
            aria-label="Project"
            value={project ?? ""}
            onChange={(e) => setProject(e.target.value === "" ? null : e.target.value)}
          >
            <option value="">All projects</option>
            {(projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <input
            className="pm-input"
            style={{ width: "auto", height: 34 }}
            type="date"
            aria-label="From"
            value={from}
            max={to || undefined}
            onChange={(e) => setFrom(e.target.value)}
          />
          <input
            className="pm-input"
            style={{ width: "auto", height: 34 }}
            type="date"
            aria-label="To"
            value={to}
            min={from || undefined}
            onChange={(e) => setTo(e.target.value)}
          />
          <span className="pm-pills" role="group" aria-label="Group by">
            {GROUPS.map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={groupBy === id ? "on" : ""}
                aria-pressed={groupBy === id}
                onClick={() => setGroupBy(id)}
              >
                {label}
              </button>
            ))}
          </span>
        </span>
        <button
          className="pm-btn sm"
          type="button"
          onClick={exportCsv}
          disabled={!report || report.rows.length === 0 || exporting}
        >
          <Download size={13} aria-hidden />
          {exporting ? "Exporting…" : "Export CSV"}
        </button>
      </div>

      {!valid ? (
        <div className="pm-surface">
          <EmptyBlock
            icon="cal"
            heading="Pick a start date no later than the end date."
            body="The report covers whole days, up to a year."
          />
        </div>
      ) : isLoading && !report ? (
        <TableSkeleton />
      ) : error && !report ? (
        <LoadError onRetry={() => void mutate()} />
      ) : report && report.rows.length === 0 ? (
        <div className="pm-surface">
          <EmptyBlock
            icon="clock"
            heading="No time logged in this range."
            body="Try a wider range or another project."
          />
        </div>
      ) : report ? (
        <div className="pm-ts-wrap" role="region" aria-label="Time report" tabIndex={0}>
          <table className="pm-ts" style={{ minWidth: 420 }}>
            <caption className="sr-only">
              Time by {GROUPS.find(([id]) => id === groupBy)?.[1]}, {fmtYmd(report.from)} to {fmtYmd(report.to)}
            </caption>
            <thead>
              <tr>
                <th scope="col">{firstColumn}</th>
                <th scope="col">Time</th>
                <th scope="col">Entries</th>
              </tr>
            </thead>
            <tbody>
              {report.rows.map((r) => (
                <tr key={r.key}>
                  <th scope="row" style={{ fontWeight: 500 }}>
                    {labelOf(r)}
                  </th>
                  <td className="num">{formatMinutes(r.minutes)}</td>
                  <td>{r.entries}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td>{formatMinutes(report.total.minutes)}</td>
                <td>{report.total.entries}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ── The view ────────────────────────────────────────────────────────────────

export function TimeView({
  projects,
  projectId,
}: {
  projects: PmProject[] | undefined;
  /** The project the page has open, if any — the report starts filtered to it. */
  projectId: string | null;
}): JSX.Element {
  const [tab, setTab] = useState<"timesheet" | "report">("timesheet");
  return (
    <div>
      <div className="pm-pills" role="tablist" aria-label="Time" style={{ marginBottom: 16 }}>
        {(
          [
            ["timesheet", "Timesheet", "cal"],
            ["report", "Report", "list"],
          ] as const
        ).map(([id, label, icon]) => (
          <button
            key={id}
            className={tab === id ? "on" : ""}
            role="tab"
            aria-selected={tab === id}
            type="button"
            onClick={() => setTab(id)}
          >
            <PmIcon name={icon} size={13} sw={tab === id ? 2 : 1.6} />
            {label}
          </button>
        ))}
      </div>
      {tab === "timesheet" ? <TimesheetTab /> : <ReportTab projects={projects} projectId={projectId} />}
    </div>
  );
}
