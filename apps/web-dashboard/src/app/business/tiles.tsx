"use client";

/**
 * WARP-2561 (ADR-044 slice 3) — the Planning tile bodies.
 *
 * Every body here renders exactly one of four states, and the discipline is
 * the point:
 *
 *   loading    a skeleton. Never a zero, never an empty list.
 *   failed     says it could not read. NEVER a zero — "0 deals" and "we could
 *              not reach the pipeline" look identical as a number and mean
 *              opposite things, and the operator acts on them differently.
 *   empty      says so in words, with the reason if there is one.
 *   populated  the real figure.
 *
 * A tile whose module is off is not rendered at all; the page owns that, not
 * these bodies. That is what keeps `/business` alive when any one source is.
 */

import type { JSX, ReactNode } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";

import { formatMinor, type CrmDeal, type CrmStageSummary } from "@/components/crm/types";
import type { PmSummary } from "@/components/projects/types";
import type { ScheduleEntry } from "@/lib/erp-types";

/* ── shared states ───────────────────────────────────────── */

export function TileSkeleton(): JSX.Element {
  return <div className="bz-skel" aria-hidden="true" />;
}

export function TileFailed({ what }: { what: string }): JSX.Element {
  return (
    <p className="bz-fail" role="status">
      Couldn&rsquo;t read {what} just now.
    </p>
  );
}

export function TileEmpty({ children }: { children: ReactNode }): JSX.Element {
  return <p className="bz-empty">{children}</p>;
}

function Stat({ n, label }: { n: number; label: string }): JSX.Element {
  return (
    <div className="bz-stat">
      <span className="bz-stat-n">{n}</span>
      <span className="bz-stat-l">{label}</span>
    </div>
  );
}

/* ── Pipeline by stage ───────────────────────────────────── */

/**
 * The stage total, or the reason there isn't one.
 *
 * ONE helper, and it now reads WARP-2556's explicit `valuation` rather than
 * inferring from `currency === null`. That null meant two different things —
 * "several currencies, cannot sum" and "nothing here is priced yet" — and the
 * second is the common case on a new box, so a reader branching on the null
 * was wrong most of the time.
 *
 * The two cases get the two different sentences they deserve, and neither
 * gets `amountMinor`: the server sends "0" there, and "0" in a money column
 * reads as "these deals are worth nothing".
 */
export function stageTotal(row: CrmStageSummary): { total: string | null; note: string | null } {
  if (row.valuation === "priced") {
    return { total: formatMinor(row.amountMinor, row.currency), note: null };
  }
  return {
    total: null,
    note: row.valuation === "mixed_currencies" ? "mixed currencies" : "nothing priced yet",
  };
}

export function PipelineBody({
  stages,
  loading,
  failed,
}: {
  stages: CrmStageSummary[] | undefined;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  if (failed) return <TileFailed what="your pipeline" />;
  if (loading || !stages) return <TileSkeleton />;

  const open = stages.filter((s) => s.kind === "OPEN");
  const deals = open.reduce((n, s) => n + s.dealCount, 0);
  if (deals === 0) {
    return <TileEmpty>No open deals yet. Add one from Customers to see it here.</TileEmpty>;
  }

  return (
    <ul className="bz-list">
      {open.map((s) => {
        const { total, note } = stageTotal(s);
        return (
          <li key={s.stageId} className="bz-row">
            <span className="bz-row-k">{s.stageName}</span>
            <span className="bz-row-v">
              {s.dealCount} {s.dealCount === 1 ? "deal" : "deals"}
              {total ? <span className="bz-row-money"> · {total}</span> : null}
              {/* Why there is no total, in the stage's own words. Saying
                  nothing would read as "we forgot"; saying "0" would be a
                  claim about the money. */}
              {note ? <span className="bz-row-muted"> · {note}</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/* ── Closing this month ──────────────────────────────────── */

/**
 * Deals whose expected close date falls in the CURRENT month and which are
 * still open.
 *
 * `now` is passed in rather than read here so the page owns the one clock —
 * the same reason /reports stamps `refreshedAt` on the client and hands it
 * down. A component that calls `new Date()` during render also hydrates
 * against a different second than the server rendered with.
 *
 * Amounts are listed per deal and never summed. A month's deals routinely
 * span currencies, and adding 500 EUR to 500 USD produces a number that looks
 * authoritative and means nothing.
 */
export function closingThisMonth(deals: CrmDeal[], now: Date): CrmDeal[] {
  const y = now.getFullYear();
  const m = now.getMonth();
  return deals
    .filter((d) => {
      if (d.archived || d.stage?.kind !== "OPEN" || !d.expectedCloseOn) return false;
      const when = new Date(d.expectedCloseOn);
      return when.getFullYear() === y && when.getMonth() === m;
    })
    .sort((a, b) => (a.expectedCloseOn ?? "").localeCompare(b.expectedCloseOn ?? ""));
}

export function ClosingBody({
  deals,
  now,
  loading,
  failed,
}: {
  deals: CrmDeal[] | undefined;
  now: Date | null;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  if (failed) return <TileFailed what="your deals" />;
  // No clock yet is genuinely unknown, not empty — "closing this month" has no
  // meaning until the client has stamped which month it is.
  if (loading || !deals || !now) return <TileSkeleton />;

  const due = closingThisMonth(deals, now);
  if (due.length === 0) {
    return <TileEmpty>Nothing is expected to close this month.</TileEmpty>;
  }

  return (
    <ul className="bz-list">
      {due.slice(0, 5).map((d) => {
        const money = formatMinor(d.amountMinor, d.currency);
        return (
          <li key={d.id} className="bz-row">
            <span className="bz-row-k">{d.title}</span>
            <span className="bz-row-v">
              {money ?? <span className="bz-row-muted">no amount</span>}
            </span>
          </li>
        );
      })}
      {due.length > 5 ? (
        <li className="bz-row bz-row-more">
          <Link href="/customers">and {due.length - 5} more</Link>
        </li>
      ) : null}
    </ul>
  );
}

/* ── Work in flight ──────────────────────────────────────── */

export function WorkBody({
  summary,
  loading,
  failed,
}: {
  summary: PmSummary | undefined;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  if (failed) return <TileFailed what="your projects" />;
  if (loading || !summary) return <TileSkeleton />;

  if (summary.activeProjects === 0 && summary.itemsOpen === 0) {
    return <TileEmpty>No active projects yet.</TileEmpty>;
  }

  return (
    <div className="bz-stats">
      <Stat n={summary.itemsOpen} label="open" />
      <Stat n={summary.overdue} label="overdue" />
      <Stat n={summary.doneThisWeek} label="done this week" />
    </div>
  );
}

/* ── Today at the practice ───────────────────────────────── */

/**
 * Deliberately NO patient names, and no reasons for visit.
 *
 * The tile answers "how busy is today, and when does it start" — a count and
 * a time. Everything else on this page is business data a `family` principal
 * may see; this tile is the one carrying PHI, and the narrowest thing that
 * answers the question is a count. The page also refuses to render it at all
 * without `canViewPhi`, so this is the second of two gates, not the only one.
 */
export function PracticeBody({
  schedule,
  loading,
  failed,
}: {
  schedule: ScheduleEntry[] | undefined;
  loading: boolean;
  failed: boolean;
}): JSX.Element {
  if (failed) return <TileFailed what="today&rsquo;s schedule" />;
  if (loading || !schedule) return <TileSkeleton />;

  const upcoming = schedule
    .filter((e) => e.status !== "cancelled")
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));

  if (upcoming.length === 0) {
    return <TileEmpty>Nothing on the schedule today.</TileEmpty>;
  }

  const first = new Date(upcoming[0].startsAt);
  const at = first.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  return (
    <div className="bz-stats">
      <Stat n={upcoming.length} label={upcoming.length === 1 ? "appointment" : "appointments"} />
      <div className="bz-stat">
        <span className="bz-stat-n bz-stat-time">{at}</span>
        <span className="bz-stat-l">first in</span>
      </div>
    </div>
  );
}

/* ── Ask about your business ─────────────────────────────── */

export function AskBody(): JSX.Element {
  return (
    <div className="bz-ask">
      <p className="bz-empty">
        Your Droplet can read the pipeline, your projects and the practice, and answer in
        plain language — all on this box.
      </p>
      <Link className="btn" href="/chat">
        <Sparkles size={14} /> Ask about your business
      </Link>
    </div>
  );
}
