/**
 * WARP-2563 (ADR-044) — how the customer record is assembled.
 *
 * The assertion that matters most is the first one, and it is about a query
 * that is easy to write the wrong way and impossible to notice afterwards:
 * projects are read by `PmProject.companyId`, NOT derived from
 * `CrmDeal.projectId`. Deriving them looks correct on every customer who
 * arrived through a deal, and silently omits every one who did not.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getCompany = vi.fn();
const listDeals = vi.fn();
const listActivities = vi.fn();
const listPartyLinksForCompany = vi.fn();

vi.mock("./crm.service.js", () => ({
  CRM_ERRORS: { COMPANY_NOT_FOUND: "company_not_found" },
  getCompany: (...a: unknown[]) => getCompany(...a),
  listDeals: (...a: unknown[]) => listDeals(...a),
  listActivities: (...a: unknown[]) => listActivities(...a),
}));

vi.mock("./party-link.service.js", () => ({
  listPartyLinksForCompany: (...a: unknown[]) => listPartyLinksForCompany(...a),
}));

import { getCustomerRecord } from "./customer-record.service.js";

const COMPANY = { id: "co1", name: "Northgate Dental" };

const stage = (kind: string) => ({ id: "s1", name: "Lead", kind, sortOrder: 0 });
const deal = (over: Record<string, unknown> = {}) => ({
  id: "d1",
  title: "Chair upgrade",
  amountMinor: "4800000",
  currency: "USD",
  projectId: null,
  stage: stage("OPEN"),
  ...over,
});

function prismaWith(projects: unknown[], people: unknown[]) {
  return {
    pmProject: { findMany: vi.fn().mockResolvedValue(projects) },
    crmCompanyContact: { findMany: vi.fn().mockResolvedValue(people) },
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  getCompany.mockResolvedValue(COMPANY);
  listDeals.mockResolvedValue({ deals: [], total: 0 });
  listActivities.mockResolvedValue({ activities: [], total: 0 });
  listPartyLinksForCompany.mockResolvedValue([]);
});

describe("projects come from the customer, not from the deals", () => {
  it("includes a project that has no deal behind it", async () => {
    // A warranty callout, a second phase, anything begun before the CRM was
    // switched on. Deriving projects from CrmDeal.projectId drops all of them,
    // and they are the ones a customer is most likely to ask about.
    const prisma = prismaWith(
      [{ id: "p1", name: "Rollout Q3", identifier: "ROLL", isArchived: false, crmDeals: [] }],
      [],
    );
    const record = await getCustomerRecord(prisma, "co1");
    expect(record.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(record.projects[0].dealIds).toEqual([]);
  });

  it("queries pmProject by companyId, excluding archived", async () => {
    const prisma = prismaWith([], []);
    await getCustomerRecord(prisma, "co1");
    const where = (
      prisma as never as { pmProject: { findMany: ReturnType<typeof vi.fn> } }
    ).pmProject.findMany.mock.calls[0][0].where;
    // Mutation: drop isArchived → an archived project reappears on the record
    // the owner archived it off.
    expect(where).toEqual({ companyId: "co1", isArchived: false });
  });

  it("carries the deals that named a project, so the edge can be walked back", async () => {
    const prisma = prismaWith(
      [
        {
          id: "p1",
          name: "Rollout Q3",
          identifier: "ROLL",
          isArchived: false,
          crmDeals: [{ id: "d1" }, { id: "d2" }],
        },
      ],
      [],
    );
    const record = await getCustomerRecord(prisma, "co1");
    expect(record.projects[0].dealIds).toEqual(["d1", "d2"]);
  });
});

describe("deals split by outcome, not by stage name", () => {
  it("puts OPEN in open and everything else in closed", async () => {
    // Stage names are owner-configurable, so "Closed — signed" is not a
    // reliable string. The kind is.
    listDeals.mockResolvedValue({
      deals: [
        deal({ id: "open", stage: stage("OPEN") }),
        deal({ id: "won", stage: stage("WON") }),
        deal({ id: "lost", stage: stage("LOST") }),
      ],
      total: 3,
    });
    const record = await getCustomerRecord(prismaWith([], []), "co1");
    expect(record.openDeals.map((d) => d.id)).toEqual(["open"]);
    expect(record.closedDeals.map((d) => d.id)).toEqual(["won", "lost"]);
  });

  it("asks for this company's deals and lets the service exclude archived", async () => {
    await getCustomerRecord(prismaWith([], []), "co1");
    expect(listDeals.mock.calls[0][1]).toMatchObject({ companyId: "co1" });
    // Mutation: pass includeArchived: true → an archived deal returns to the
    // record, and this assertion goes red.
    expect(listDeals.mock.calls[0][1].includeArchived).toBeUndefined();
  });
});

describe("people", () => {
  it("drops an archived person — they are off the address book already", async () => {
    const prisma = prismaWith(
      [],
      [
        {
          contactId: "c1",
          title: "Owner",
          isPrimary: true,
          contact: { displayName: "Dr. Chen", isArchived: false },
        },
        {
          contactId: "c2",
          title: null,
          isPrimary: false,
          contact: { displayName: "Left The Practice", isArchived: true },
        },
      ],
    );
    const record = await getCustomerRecord(prisma, "co1");
    // Mutation: drop the filter → the person the owner archived reappears here.
    expect(record.people.map((p) => p.contactId)).toEqual(["c1"]);
    expect(record.people[0].isPrimary).toBe(true);
  });

  it("orders the primary contact first", async () => {
    const prisma = prismaWith([], []);
    await getCustomerRecord(prisma, "co1");
    const orderBy = (
      prisma as never as { crmCompanyContact: { findMany: ReturnType<typeof vi.fn> } }
    ).crmCompanyContact.findMany.mock.calls[0][0].orderBy;
    expect(orderBy[0]).toEqual({ isPrimary: "desc" });
  });
});

describe("the record is one read", () => {
  it("resolves the company FIRST, so a missing one costs one query", async () => {
    getCompany.mockRejectedValue(new Error("company_not_found"));
    const prisma = prismaWith([], []);
    await expect(getCustomerRecord(prisma, "nope")).rejects.toThrow("company_not_found");
    // Mutation: fold getCompany into the Promise.all → five queries run
    // against an id that does not exist.
    expect(
      (prisma as never as { pmProject: { findMany: ReturnType<typeof vi.fn> } }).pmProject.findMany,
    ).not.toHaveBeenCalled();
  });

  it("reads the timeline for the COMPANY subject", async () => {
    await getCustomerRecord(prismaWith([], []), "co1");
    expect(listActivities.mock.calls[0][1]).toEqual({ subjectType: "COMPANY", id: "co1" });
  });

  it("returns every section, so the page has one loading state", async () => {
    const record = await getCustomerRecord(prismaWith([], []), "co1");
    expect(Object.keys(record).sort()).toEqual(
      ["closedDeals", "company", "links", "openDeals", "people", "projects", "timeline"].sort(),
    );
  });
});
