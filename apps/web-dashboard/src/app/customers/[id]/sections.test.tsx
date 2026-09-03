/**
 * WARP-2563 (ADR-044) — what the customer record actually renders.
 *
 * Two things worth pinning at this level: money never becomes a JS number on a
 * page that shows several deals at once, and the deal↔project edge is visible
 * from BOTH ends. The second is the whole reason the page exists — the edge
 * has been in the schema since WARP-2117 with nothing that walked it.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

import type {
  CrmActivity,
  CrmDeal,
  CrmStage,
  PartyLinkRow,
  RecordPerson,
  RecordProject,
} from "@/components/crm/types";

import { Deals, Links, People, Projects, Timeline } from "./sections";

const stage = (kind: CrmStage["kind"] = "OPEN"): CrmStage => ({
  id: "s1",
  pipelineId: "p1",
  name: "Lead",
  kind,
  sortOrder: 0,
  probability: null,
});

const deal = (over: Partial<CrmDeal> = {}): CrmDeal => ({
  id: "d1",
  title: "Chair upgrade",
  companyId: "co1",
  companyName: "Northgate",
  pipelineId: "p1",
  stageId: "s1",
  stage: stage(),
  amountMinor: "4800000",
  currency: "USD",
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

const project = (over: Partial<RecordProject> = {}): RecordProject => ({
  id: "p1",
  name: "Rollout Q3",
  identifier: "ROLL",
  isArchived: false,
  dealIds: [],
  ...over,
});

const person = (over: Partial<RecordPerson> = {}): RecordPerson => ({
  contactId: "c1",
  displayName: "Dr. Chen",
  title: "Owner",
  isPrimary: false,
  ...over,
});

const activity = (over: Partial<CrmActivity> = {}): CrmActivity => ({
  id: "a1",
  subjectType: "COMPANY",
  companyId: "co1",
  contactId: null,
  dealId: null,
  kind: "NOTE",
  summary: "Called about the chairs",
  actorId: null,
  occurredAt: "2026-03-14T10:00:00.000Z",
  noteId: null,
  emailMessageId: null,
  calendarEventId: null,
  workItemId: null,
  fromStageId: null,
  toStageId: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

const link = (over: Partial<PartyLinkRow> = {}): PartyLinkRow => ({
  id: "pl1",
  contactId: null,
  companyId: "co1",
  externalSystem: "eaglesoft-api",
  externalId: "4471",
  linkedBy: "MANUAL",
  confidence: null,
  isArchived: false,
  archivedAt: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("money on the record never becomes a JS number", () => {
  it("renders a deal past 2^53 exactly", () => {
    render(
      <Deals
        deals={[deal({ amountMinor: "9007199254740993", currency: "USD" })]}
        projects={[]}
        emptyText="none"
      />,
    );
    expect(screen.getByText(/90,071,992,547,409\.93/)).toBeTruthy();
  });

  it("says a deal has no amount rather than rendering zero", () => {
    render(
      <Deals
        deals={[deal({ amountMinor: null, currency: null })]}
        projects={[]}
        emptyText="none"
      />,
    );
    expect(screen.getByText(/no amount/)).toBeTruthy();
    expect(screen.queryByText(/0\.00/)).toBeNull();
  });
});

describe("the deal ↔ project edge is visible from both ends", () => {
  it("shows a deal's project on the deal row", () => {
    // WARP-2117 put `CrmDeal.projectId` in the schema commented "a won deal
    // becomes the job that delivers it", and no UI walked it.
    render(
      <Deals
        deals={[deal({ projectId: "p1" })]}
        projects={[project({ id: "p1", identifier: "ROLL" })]}
        emptyText="none"
      />,
    );
    expect(screen.getByText(/ROLL/)).toBeTruthy();
  });

  it("marks a project that came from a deal, and leaves the others plain", () => {
    render(
      <Projects
        projects={[
          project({ id: "p1", name: "Rollout Q3", dealIds: ["d1"] }),
          project({ id: "p2", name: "Warranty callout", identifier: "WAR", dealIds: [] }),
        ]}
      />,
    );
    expect(screen.getByText(/from a deal/)).toBeTruthy();
    // The project with no deal is still HERE — that is the case reading
    // projects off CrmDeal.projectId would have dropped.
    expect(screen.getByText("Warranty callout")).toBeTruthy();
    expect(screen.getByText("WAR")).toBeTruthy();
  });
});

describe("timeline", () => {
  it("dates an entry by when it happened, not when the row was written", () => {
    // occurredAt is March; createdAt is August. A backfilled email is not
    // something that happened today.
    render(<Timeline entries={[activity()]} />);
    const time = screen.getByText(/Mar/);
    expect(time.getAttribute("datetime")).toBe("2026-03-14T10:00:00.000Z");
  });

  it("says nothing is recorded rather than rendering an empty list", () => {
    render(<Timeline entries={[]} />);
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
  });
});

describe("people", () => {
  it("marks the primary contact rather than only sorting them first", () => {
    // Sort order is invisible once you are three rows down.
    render(<People people={[person({ isPrimary: true })]} />);
    expect(screen.getByText("primary")).toBeTruthy();
  });

  it("says there are no people rather than rendering an empty list", () => {
    render(<People people={[]} />);
    expect(screen.getByText(/No people yet/)).toBeTruthy();
  });
});

describe("linked systems", () => {
  it("renders nothing at all when there are no links", () => {
    // Absent, not empty: on a box with no connector a permanent "nothing
    // here" is a section about something the owner never asked for.
    const { container } = render(<Links links={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the provider key as-is and the id beside it", () => {
    render(<Links links={[link()]} />);
    expect(screen.getByText("eaglesoft-api")).toBeTruthy();
    expect(screen.getByText("4471")).toBeTruthy();
  });

  it("shows a match score only for a MATCHED link", () => {
    const { unmount } = render(<Links links={[link({ linkedBy: "MATCHED", confidence: 88 })]} />);
    expect(screen.getByText(/88% match/)).toBeTruthy();
    unmount();

    // A confidence on a hand-made link is a number nobody computed — the
    // database refuses to store one, and this must not render one either.
    render(<Links links={[link({ linkedBy: "MANUAL", confidence: null })]} />);
    expect(screen.queryByText(/% match/)).toBeNull();
  });
});
