/**
 * WARP-2561 (ADR-044 slice 3) — the Planning tile bodies.
 *
 * The tests that matter here are all the same shape: a tile must never turn a
 * question it could not answer into a confident number. "0 open deals" and
 * "the pipeline did not answer" render as the same glyph if you let them, and
 * an operator acts on them in opposite directions.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type { CrmDeal, CrmStage, CrmStageSummary } from "@/components/crm/types";
import type { PmSummary } from "@/components/projects/types";
import type { ScheduleEntry } from "@/lib/erp-types";

import { ClosingBody, PipelineBody, PracticeBody, WorkBody, closingThisMonth } from "./tiles";

const stage = (over: Partial<CrmStage> = {}): CrmStage => ({
  id: "s1",
  pipelineId: "p1",
  name: "Lead",
  kind: "OPEN",
  sortOrder: 0,
  probability: null,
  ...over,
});

const row = (over: Partial<CrmStageSummary> = {}): CrmStageSummary => ({
  stageId: "s1",
  stageName: "Lead",
  kind: "OPEN",
  sortOrder: 0,
  dealCount: 2,
  valuation: "priced",
  amountMinor: "250000",
  currency: "USD",
  ...over,
});

const deal = (over: Partial<CrmDeal> = {}): CrmDeal => ({
  id: "d1",
  title: "Annual contract",
  companyId: null,
  companyName: null,
  pipelineId: "p1",
  stageId: "s1",
  stage: stage(),
  amountMinor: null,
  currency: null,
  expectedCloseOn: null,
  closedAt: null,
  closeReason: null,
  ownerId: null,
  projectId: null,
  origin: "LOCAL",
  externalSystem: null,
  archived: false,
  contactIds: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const appt = (over: Partial<ScheduleEntry> = {}): ScheduleEntry => ({
  id: "a1",
  startsAt: "2026-08-30T16:15:00.000Z",
  patientId: "p9",
  patientName: "Dana Whitfield",
  provider: "Dr. Chen",
  operatory: "Op 2",
  status: "scheduled",
  ...over,
});

const pm = (over: Partial<PmSummary> = {}): PmSummary => ({
  activeProjects: 3,
  itemsOpen: 12,
  doneThisWeek: 4,
  overdue: 2,
  ...over,
});

describe("a tile that could not read says so, and never shows a zero", () => {
  it("Pipeline distinguishes failure from an empty pipeline", () => {
    const { unmount } = render(<PipelineBody stages={undefined} loading={false} failed />);
    expect(screen.getByRole("status").textContent).toMatch(/Couldn’t read your pipeline/);
    // The regression: `stages?.length ?? 0` renders "0 deals" on a failed read.
    expect(screen.queryByText(/0/)).toBeNull();
    unmount();

    render(<PipelineBody stages={[]} loading={false} failed={false} />);
    expect(screen.getByText(/No open deals yet/)).toBeTruthy();
  });

  it("Work in flight distinguishes failure from a box with no projects", () => {
    const { unmount } = render(<WorkBody summary={undefined} loading={false} failed />);
    expect(screen.getByRole("status").textContent).toMatch(/Couldn’t read your projects/);
    expect(screen.queryByText("0")).toBeNull();
    unmount();

    render(
      <WorkBody summary={pm({ activeProjects: 0, itemsOpen: 0 })} loading={false} failed={false} />,
    );
    expect(screen.getByText(/No active projects yet/)).toBeTruthy();
  });

  it("renders a skeleton while loading rather than a provisional number", () => {
    const { container } = render(<WorkBody summary={undefined} loading failed={false} />);
    expect(container.querySelector(".bz-skel")).toBeTruthy();
    expect(screen.queryByText("0")).toBeNull();
  });
});

describe("money on the Planning page never passes through a JS number", () => {
  it("renders a stage total past 2^53 exactly", () => {
    render(
      <PipelineBody
        stages={[row({ amountMinor: "9007199254740993", currency: "USD" })]}
        loading={false}
        failed={false}
      />,
    );
    // Number("9007199254740993") / 100 drops the last digit.
    expect(screen.getByText(/90,071,992,547,409\.93/)).toBeTruthy();
  });

  it("withholds the total for a MIXED-CURRENCY stage, and says which", () => {
    // WARP-2556 — the server sends amountMinor "0" here. Rendering it would
    // say the column is worth nothing.
    render(
      <PipelineBody
        stages={[
          row({ valuation: "mixed_currencies", amountMinor: "0", currency: null, dealCount: 4 }),
        ]}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText(/4 deals/)).toBeTruthy();
    expect(screen.getByText(/mixed currencies/)).toBeTruthy();
    expect(screen.queryByText(/0\.00/)).toBeNull();
  });

  it("says an UNPRICED stage is unpriced — not that it holds mixed currencies", () => {
    // The regression WARP-2556 fixed, pinned from the reader's end: both
    // cases arrive as `currency: null`, and branching on that null told every
    // new box its early-pipeline stages held several currencies.
    render(
      <PipelineBody
        stages={[row({ valuation: "unpriced", amountMinor: "0", currency: null, dealCount: 3 })]}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText(/nothing priced yet/)).toBeTruthy();
    expect(screen.queryByText(/mixed currencies/)).toBeNull();
  });

  it("shows a deal with no amount as such, not as zero", () => {
    render(
      <ClosingBody
        deals={[deal({ expectedCloseOn: "2026-08-20", amountMinor: null, currency: null })]}
        now={new Date("2026-08-30T12:00:00Z")}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText(/no amount/)).toBeTruthy();
  });
});

describe("closingThisMonth", () => {
  const now = new Date("2026-08-30T12:00:00Z");

  it("keeps only open deals whose expected close falls in the current month", () => {
    const kept = closingThisMonth(
      [
        deal({ id: "in", expectedCloseOn: "2026-08-14" }),
        deal({ id: "next-month", expectedCloseOn: "2026-09-02" }),
        deal({ id: "last-month", expectedCloseOn: "2026-07-30" }),
        deal({ id: "no-date", expectedCloseOn: null }),
        deal({ id: "won", expectedCloseOn: "2026-08-10", stage: stage({ kind: "WON" }) }),
        deal({ id: "archived", expectedCloseOn: "2026-08-11", archived: true }),
      ],
      now,
    );
    expect(kept.map((d) => d.id)).toEqual(["in"]);
  });

  it("does not treat the same day-of-month in another year as this month", () => {
    // The bug this pins: comparing only getMonth().
    expect(closingThisMonth([deal({ expectedCloseOn: "2025-08-14" })], now)).toEqual([]);
  });

  it("orders by when they are due, soonest first", () => {
    const kept = closingThisMonth(
      [
        deal({ id: "late", expectedCloseOn: "2026-08-28" }),
        deal({ id: "early", expectedCloseOn: "2026-08-03" }),
      ],
      now,
    );
    expect(kept.map((d) => d.id)).toEqual(["early", "late"]);
  });

  it("says nothing is closing rather than rendering an empty list", () => {
    render(<ClosingBody deals={[]} now={now} loading={false} failed={false} />);
    expect(screen.getByText(/Nothing is expected to close this month/)).toBeTruthy();
  });

  it("skeletons until the client has stamped a clock", () => {
    // "This month" has no meaning before the page knows which month it is,
    // and reading the clock during render hydrates against a different one.
    const { container } = render(
      <ClosingBody deals={[deal()]} now={null} loading={false} failed={false} />,
    );
    expect(container.querySelector(".bz-skel")).toBeTruthy();
  });
});

describe("the practice tile is PHI-minimal", () => {
  it("answers with a count and a time, and names nobody", () => {
    render(
      <PracticeBody
        schedule={[appt(), appt({ id: "a2", patientName: "Marcus Ilori" })]}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText(/appointments/)).toBeTruthy();
    // The regression this pins: listing the day's appointments would put
    // patient names on a page whose other tiles are ordinary business data.
    expect(screen.queryByText(/Dana Whitfield/)).toBeNull();
    expect(screen.queryByText(/Marcus Ilori/)).toBeNull();
    expect(screen.queryByText(/Op 2/)).toBeNull();
  });

  it("does not count a cancelled appointment as part of the day", () => {
    render(
      <PracticeBody
        schedule={[appt(), appt({ id: "a2", status: "cancelled" })]}
        loading={false}
        failed={false}
      />,
    );
    expect(screen.getByText("1")).toBeTruthy();
    expect(screen.getByText(/appointment$/)).toBeTruthy();
  });

  it("says the day is clear rather than rendering a zero", () => {
    render(<PracticeBody schedule={[]} loading={false} failed={false} />);
    expect(screen.getByText(/Nothing on the schedule today/)).toBeTruthy();
  });
});
