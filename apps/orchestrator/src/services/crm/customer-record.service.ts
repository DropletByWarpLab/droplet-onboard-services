/**
 * WARP-2563 (ADR-044) — the customer record, as ONE read.
 *
 * Everything here already existed as a column and an edge; what did not exist
 * was anything that walked them. `CrmDeal.projectId → PmProject` is commented
 * in the schema as "a won deal becomes the job that delivers it" and no UI has
 * ever shown it in either direction. `CrmActivity`'s own doc comment calls it
 * "the thing the local model reads when asked about a customer" — it was built
 * for this page. WARP-2562 added `PmProject.companyId` and `PartyLink`, which
 * without this reader would be exactly the dead columns ADR-044 criticises
 * `ErpEntityCache` for.
 *
 * ONE round trip, not six. Six would each carry their own loading and failure
 * state, and the page would flicker through them in an order nobody chose. The
 * sections are composed here, on the box, where the joins are cheap.
 *
 * 🔴 No PHI is assembled in this file. The practice block — the one section
 * that reads the ERP — is WARP-2564, and it hangs off a server-side connector
 * check on top of this route, not off the CRM's own gate. A tool or a page
 * that can read a customer must not thereby read a patient (ADR-044 §3).
 */

import type { PrismaClient } from "@prisma/client";

import {
  CRM_ERRORS,
  getCompany,
  listActivities,
  listDeals,
  type ApiCrmActivity,
  type ApiCrmCompany,
  type ApiCrmDeal,
} from "./crm.service.js";
import { listPartyLinksForCompany, type ApiPartyLink } from "./party-link.service.js";

/** A person at this company, with the role they hold HERE. */
export interface RecordPerson {
  contactId: string;
  displayName: string;
  /** Role at this company, which may differ from the contact's own jobTitle. */
  title: string | null;
  isPrimary: boolean;
}

/** A project delivered for this customer. */
export interface RecordProject {
  id: string;
  name: string;
  identifier: string;
  isArchived: boolean;
  /** The deals that named this project, so the page can walk the edge back.
   *  Usually zero or one; a phased job can have several. */
  dealIds: string[];
}

export interface CustomerRecord {
  company: ApiCrmCompany;
  people: RecordPerson[];
  /** Split by outcome rather than by stage: a record page answers "what is
   *  live and what closed", and stage names are owner-configurable. */
  openDeals: ApiCrmDeal[];
  closedDeals: ApiCrmDeal[];
  projects: RecordProject[];
  timeline: ApiCrmActivity[];
  links: ApiPartyLink[];
}

export async function getCustomerRecord(
  prisma: PrismaClient,
  companyId: string,
  opts: { timelineLimit?: number } = {},
): Promise<CustomerRecord> {
  // First, and alone: a missing company is a 404 for the whole request, and
  // running five more queries against an id that does not exist would be work
  // thrown away in the common not-found case.
  const company = await getCompany(prisma, companyId);

  const [links, deals, activities, projectRows, personRows] = await Promise.all([
    listPartyLinksForCompany(prisma, companyId),
    // `includeArchived` defaults false in listDeals — an archived deal is off
    // the customer's screen for the same reason it is off the board.
    listDeals(prisma, { companyId, perPage: 200 }),
    listActivities(
      prisma,
      { subjectType: "COMPANY", id: companyId },
      { perPage: opts.timelineLimit ?? 50 },
    ),
    // 🔴 Read by `PmProject.companyId`, NOT derived from `CrmDeal.projectId`.
    //
    // Deriving would find only work that came through a deal, and quietly drop
    // the rest: a warranty callout, a second phase, anything begun before the
    // CRM was switched on. Those are the projects a customer is most likely to
    // ask about, and they would be the ones missing.
    prisma.pmProject.findMany({
      where: { companyId, isArchived: false },
      select: {
        id: true,
        name: true,
        identifier: true,
        isArchived: true,
        crmDeals: { select: { id: true } },
      },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    prisma.crmCompanyContact.findMany({
      where: { companyId },
      select: {
        contactId: true,
        title: true,
        isPrimary: true,
        contact: { select: { displayName: true, isArchived: true } },
      },
      // The primary contact first — on a record page that is the person you
      // were looking for.
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    }),
  ]);

  const openDeals = deals.deals.filter((d) => d.stage?.kind === "OPEN");
  const closedDeals = deals.deals.filter((d) => d.stage?.kind !== "OPEN");

  return {
    company,
    people: personRows
      // An archived person is off the address book; showing them here would
      // reintroduce the row the owner just removed.
      .filter((p) => !p.contact.isArchived)
      .map((p) => ({
        contactId: p.contactId,
        displayName: p.contact.displayName,
        title: p.title,
        isPrimary: p.isPrimary,
      })),
    openDeals,
    closedDeals,
    projects: projectRows.map((p) => ({
      id: p.id,
      name: p.name,
      identifier: p.identifier,
      isArchived: p.isArchived,
      dealIds: p.crmDeals.map((d) => d.id),
    })),
    // listActivities already orders by occurredAt — when it HAPPENED, not when
    // the row was written. A backfilled email from March is not something that
    // happened today, and this page is read as a chronology.
    timeline: activities.activities,
    links,
  };
}

export { CRM_ERRORS };
