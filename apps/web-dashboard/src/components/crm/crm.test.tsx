/**
 * WARP-2545 — the CRM surface's load-bearing behaviour: money that must not
 * pass through a JS number, a board that reads outcome rather than position,
 * and a tablist that behaves like one.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { CrmTabs } from "./CrmTabs";
import { DealBoard, CustomersView, Timeline } from "./views";
import { formatMinor, type CrmCompany, type CrmDeal, type CrmStage } from "./types";
import { toMinorUnits } from "./modals";

const stage = (over: Partial<CrmStage> = {}): CrmStage => ({
  id: "s1",
  pipelineId: "p1",
  name: "Lead",
  kind: "OPEN",
  sortOrder: 0,
  probability: null,
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

const company = (over: Partial<CrmCompany> = {}): CrmCompany => ({
  id: "c1",
  name: "Acme",
  domain: "example.com",
  industry: null,
  phone: null,
  website: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  region: null,
  postalCode: null,
  country: null,
  note: null,
  ownerId: null,
  origin: "LOCAL",
  externalSystem: null,
  archived: false,
  openDealCount: 2,
  contactCount: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("money never becomes a JS number", () => {
  it("formats a value past 2^53 exactly", () => {
    // 90071992547409.93 in USD. Number("9007199254740993") / 100 loses the
    // last digit, and a customer's largest deal is exactly the one they check.
    const out = formatMinor("9007199254740993", "USD");
    expect(out).toContain("90,071,992,547,409.93");
  });

  it("keeps the cents on ordinary values and handles a credit", () => {
    expect(formatMinor("250000", "USD")).toContain("2,500.00");
    expect(formatMinor("5", "USD")).toContain("0.05");
    expect(formatMinor("-250000", "USD")).toContain("2,500.00");
    expect(formatMinor("-250000", "USD")).toMatch(/-|\(/);
  });

  it("renders nothing when there is no amount", () => {
    // The column pair is a CHECK constraint, so a half-populated amount cannot
    // arrive; null means "no value yet", which is not zero.
    expect(formatMinor(null, "USD")).toBeNull();
    expect(formatMinor("250000", null)).toBeNull();
  });

  it("formats an unfamiliar but well-formed ISO code without special-casing it", () => {
    // Intl handles any three-letter code, so a currency we have never seen
    // still renders as money rather than falling through to the raw string.
    expect(formatMinor("250000", "ZZZ")).toContain("2,500.00");
  });

  it("falls back to a readable string rather than throwing on a malformed code", () => {
    // Intl throws a RangeError on anything that is not three letters. The
    // route rejects those, but a connector-written row is not route-validated,
    // and a throw here would blank the whole board.
    expect(formatMinor("250000", "US")).toBe("2500.00 US");
  });
});

describe("toMinorUnits", () => {
  it("converts what a human types without multiplying by 100", () => {
    expect(toMinorUnits("2500")).toBe("250000");
    expect(toMinorUnits("2500.5")).toBe("250050");
    expect(toMinorUnits("2500.55")).toBe("250055");
    expect(toMinorUnits("0.07")).toBe("007");
    expect(toMinorUnits("2,500.55")).toBe("250055");
    expect(toMinorUnits("-40")).toBe("-4000");
  });

  it("returns null for an empty box and for anything it cannot read", () => {
    // Null means "no amount", which the caller sends as null. A silent 0 would
    // create a deal worth nothing that looks deliberate.
    expect(toMinorUnits("")).toBeNull();
    expect(toMinorUnits("   ")).toBeNull();
    expect(toMinorUnits("lots")).toBeNull();
    expect(toMinorUnits("2500.555")).toBeNull();
    expect(toMinorUnits("1.2.3")).toBeNull();
  });
});

describe("DealBoard", () => {
  const stages = [
    stage({ id: "s2", name: "Qualified", sortOrder: 1 }),
    stage({ id: "s1", name: "Lead", sortOrder: 0 }),
    stage({ id: "s9", name: "Closed — signed", kind: "WON", sortOrder: 2 }),
  ];

  it("renders columns in sortOrder, not wire order", () => {
    // The API returns stages sorted, but a board that depends on that is one
    // upstream change from silently reordering someone's pipeline.
    const { container } = render(
      <DealBoard
        stages={stages}
        deals={[deal()]}
        summary={undefined}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onMove={() => {}}
        onNew={() => {}}
      />,
    );
    // The wire order here is Qualified(1), Lead(0), Won(2) — deliberately not
    // sorted, so a board that trusted array order would render it wrong.
    const headings = Array.from(container.querySelectorAll(".pm-col .pm-sect")).map((el) =>
      (el.firstChild?.nextSibling?.textContent ?? el.textContent ?? "").trim(),
    );
    expect(headings).toEqual(["Lead", "Qualified", "Closed — signed"]);
  });

  it("moves a deal by stage id when it is dropped on another column", () => {
    const onMove = vi.fn();
    const { container } = render(
      <DealBoard
        stages={stages}
        deals={[deal({ stageId: "s1" })]}
        summary={undefined}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onMove={onMove}
        onNew={() => {}}
      />,
    );
    const cols = container.querySelectorAll(".pm-col");
    const card = screen.getByRole("button", { name: /Annual contract/ });
    fireEvent.dragStart(card);
    fireEvent.dragOver(cols[1]);
    fireEvent.drop(cols[1]);
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove.mock.calls[0][1]).toBe("s2");
  });

  it("does not fire a move when a card is dropped on its own column", () => {
    const onMove = vi.fn();
    const { container } = render(
      <DealBoard
        stages={stages}
        deals={[deal({ stageId: "s1" })]}
        summary={undefined}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onMove={onMove}
        onNew={() => {}}
      />,
    );
    const cols = container.querySelectorAll(".pm-col");
    fireEvent.dragStart(screen.getByRole("button", { name: /Annual contract/ }));
    fireEvent.drop(cols[0]);
    // A no-op POST would still write a STAGE_CHANGE to the timeline, so the
    // guard has to be here and not only in the service.
    expect(onMove).not.toHaveBeenCalled();
  });

  it("hides the column total when the stage holds mixed currencies", () => {
    // The server reports currency: null and amountMinor "0" for a mixed stage.
    // Rendering "0" there would be a lie about the column's value.
    render(
      <DealBoard
        stages={[stage({ id: "s1", name: "Lead", sortOrder: 0 })]}
        deals={[deal()]}
        summary={[
          { stageId: "s1", stageName: "Lead", kind: "OPEN", sortOrder: 0, dealCount: 2, amountMinor: "0", currency: null },
        ]}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onMove={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.queryByText(/0\.00/)).toBeNull();
    // The count still renders — it is true and useful; only the total is withheld.
    expect(screen.getByText("1")).toBeTruthy();
  });

  it("offers no drag handle and no add button in read-only", () => {
    render(
      <DealBoard
        stages={[stage()]}
        deals={[deal()]}
        summary={undefined}
        domain="populated"
        readOnly
        onOpen={() => {}}
        onMove={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.queryByRole("button", { name: /New deal in/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Annual contract/ })).toHaveProperty(
      "draggable",
      false,
    );
  });
});

describe("CustomersView", () => {
  it("distinguishes an empty list from a search that matched nothing", () => {
    // "No customers yet" with a CTA is right on day one and wrong when a
    // search is active — the customer would think their data had gone.
    const { rerender } = render(
      <CustomersView companies={[]} domain="empty" readOnly={false} onOpen={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText(/No customers yet/)).toBeTruthy();

    rerender(
      <CustomersView companies={[]} domain="filtered" readOnly={false} onOpen={() => {}} onNew={() => {}} />,
    );
    expect(screen.getByText(/No customers match that search/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New customer/ })).toBeNull();
  });

  it("shows where a synced customer came from", () => {
    // Provenance on the row is what explains a field being overwritten by the
    // next sync; without it that reads as the box losing an edit.
    render(
      <CustomersView
        companies={[company({ origin: "EXTERNAL", externalSystem: "hubspot" })]}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByTitle("Synced from hubspot")).toBeTruthy();
  });

  it("pluralises the deal count", () => {
    render(
      <CustomersView
        companies={[company({ openDealCount: 1 })]}
        domain="populated"
        readOnly={false}
        onOpen={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByTitle("Open deals").textContent).toBe("1 deal");
  });
});

describe("CrmTabs", () => {
  it("is one tab stop with arrow-key movement", () => {
    // Roving tabindex per the WAI-ARIA tabs pattern: three tabbable buttons
    // would put three stops between the customer and the content.
    const onTab = vi.fn();
    render(<CrmTabs tab="projects" onTab={onTab} />);
    const list = screen.getByRole("tablist", { name: "CRM section" });
    const tabs = within(list).getAllByRole("tab");
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "-1", "0"]);

    fireEvent.keyDown(tabs[2], { key: "ArrowRight" });
    // Wraps to the first tab rather than stopping dead at the end.
    expect(onTab).toHaveBeenCalledWith("customers");

    fireEvent.keyDown(tabs[2], { key: "Home" });
    expect(onTab).toHaveBeenLastCalledWith("customers");
    fireEvent.keyDown(tabs[0], { key: "End" });
    expect(onTab).toHaveBeenLastCalledWith("projects");
  });

  it("marks exactly one tab selected", () => {
    render(<CrmTabs tab="deals" onTab={() => {}} />);
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain("Deals");
  });
});

describe("Timeline", () => {
  it("dates an entry by when it happened, not when the row was written", () => {
    // A backfilled email from March is not something that happened today.
    render(
      <Timeline
        isLoading={false}
        activities={[
          {
            id: "a1",
            subjectType: "DEAL",
            companyId: null,
            contactId: null,
            dealId: "d1",
            kind: "EMAIL",
            summary: "Re: proposal",
            actorId: null,
            occurredAt: "2026-03-04T10:00:00.000Z",
            noteId: null,
            emailMessageId: "m1",
            calendarEventId: null,
            workItemId: null,
            fromStageId: null,
            toStageId: null,
            createdAt: "2026-08-29T10:00:00.000Z",
          },
        ]}
      />,
    );
    const time = screen.getByText(/Mar/);
    expect(time.getAttribute("datetime")).toBe("2026-03-04T10:00:00.000Z");
  });

  it("says the timeline is empty rather than rendering an empty list", () => {
    render(<Timeline isLoading={false} activities={[]} />);
    expect(screen.getByText(/Nothing has happened here yet/)).toBeTruthy();
  });
});
