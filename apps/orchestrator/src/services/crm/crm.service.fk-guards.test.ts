/**
 * WARP-2577 defect 1 — the five FK columns the CRM service wrote unchecked.
 *
 * `createDeal`/`updateDeal` verified `companyId`, and `logActivity` verified
 * the activity subject, before writing. Five more FK-bearing columns went
 * straight to Postgres:
 *
 *   CrmDeal.projectId
 *   CrmActivity.noteId / .emailMessageId / .calendarEventId / .workItemId
 *
 * A bad id there raised P2003, which the route error handler redacts into a
 * 500. The caller is told the box broke when in fact they sent an id that does
 * not exist — and the asymmetry is the tell, because the same function does
 * the right thing for `companyId` two lines up.
 *
 * Prisma is hand-stubbed in the style of `crm.service.test.ts`: these
 * assertions are about this file's logic. The constraints themselves are the
 * database's and are tested against real SQL elsewhere.
 *
 * THE MUTATION EACH BLOCK MUST CATCH is named in its own comment. Every
 * "rejects" case is paired with a "still writes when the row exists" case,
 * because a guard that always throws would pass the rejection half alone.
 */
import { describe, expect, it, vi } from "vitest";

import { CRM_ERRORS, createDeal, logActivity, updateDeal } from "./crm.service.js";

const stage = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "s-open",
  pipelineId: "p1",
  name: "Lead",
  kind: "OPEN" as const,
  sortOrder: 0,
  probability: null,
  ...over,
});

const pipeline = {
  id: "p1",
  name: "Sales",
  isDefault: true,
  sortOrder: 0,
  isArchived: false,
  stages: [stage({ id: "s1" })],
};

const dealRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "d1",
  title: "T",
  companyId: null,
  company: null,
  pipelineId: "p1",
  stageId: "s1",
  stage: stage({ id: "s1" }),
  amountMinor: null,
  currency: null,
  expectedCloseOn: null,
  closedAt: null,
  closeReason: null,
  ownerId: null,
  projectId: null,
  origin: "LOCAL",
  externalSystem: null,
  isArchived: false,
  contactLinks: [],
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

const activityRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: "a1",
  subjectType: "DEAL",
  companyId: null,
  contactId: null,
  dealId: "d1",
  kind: "NOTE",
  summary: "s",
  actorId: null,
  occurredAt: new Date(),
  noteId: null,
  emailMessageId: null,
  calendarEventId: null,
  workItemId: null,
  fromStageId: null,
  toStageId: null,
  createdAt: new Date(),
  ...over,
});

/** A delegate whose row is absent — the id the caller sent does not exist. */
const missing = { findUnique: async () => null };
/** A delegate whose row is present. */
const present = (id: string) => ({ findUnique: async () => ({ id }) });

describe("createDeal — projectId", () => {
  // MUTATION: drop the pmProject existence check in createDeal. This goes red
  // because the bad id reaches `crmDeal.create` instead of being refused.
  it("refuses a project that does not exist, and names the project", async () => {
    const create = vi.fn();
    const prisma = {
      crmPipeline: { findUnique: async () => pipeline },
      crmPipelineStage: { findUnique: async () => stage({ id: "s1" }) },
      pmProject: missing,
      crmDeal: { create },
    } as never;

    await expect(
      createDeal(prisma, { title: "T", pipelineId: "p1", projectId: "no-such-project" }, null),
    ).rejects.toThrow(CRM_ERRORS.PROJECT_NOT_FOUND);
    // The point of the guard is that the write never happens. Without this
    // the test would pass on a service that threw *after* writing the row.
    expect(create).not.toHaveBeenCalled();
  });

  // MUTATION: make the guard unconditional (`throw` regardless of the lookup).
  // This goes red — the paired case is what stops "always throw" passing.
  it("writes the deal when the project is real", async () => {
    const create = vi.fn().mockResolvedValue(dealRow({ projectId: "pr1" }));
    const prisma = {
      crmPipeline: { findUnique: async () => pipeline },
      crmPipelineStage: { findUnique: async () => stage({ id: "s1" }) },
      pmProject: present("pr1"),
      crmDeal: { create },
    } as never;

    await createDeal(prisma, { title: "T", pipelineId: "p1", projectId: "pr1" }, null);
    expect(create.mock.calls[0][0].data.projectId).toBe("pr1");
  });

  // MUTATION: check `input.projectId !== undefined` instead of truthiness. A
  // deal with no project must not cost a lookup, and must not 404 on absence.
  it("does not look a project up when the caller named none", async () => {
    const findUnique = vi.fn();
    const prisma = {
      crmPipeline: { findUnique: async () => pipeline },
      crmPipelineStage: { findUnique: async () => stage({ id: "s1" }) },
      pmProject: { findUnique },
      crmDeal: { create: async () => dealRow() },
    } as never;

    await createDeal(prisma, { title: "T", pipelineId: "p1" }, null);
    expect(findUnique).not.toHaveBeenCalled();
  });
});

describe("updateDeal — projectId", () => {
  // MUTATION: guard only `createDeal` and not `updateDeal`. PATCH is the other
  // door to the same column and was equally unchecked.
  it("refuses a project that does not exist", async () => {
    const update = vi.fn();
    const prisma = {
      crmDeal: { findUnique: async () => dealRow(), update },
      pmProject: missing,
    } as never;

    await expect(updateDeal(prisma, "d1", { projectId: "no-such-project" }, null)).rejects.toThrow(
      CRM_ERRORS.PROJECT_NOT_FOUND,
    );
    expect(update).not.toHaveBeenCalled();
  });

  // MUTATION: guard on `!== undefined` rather than on a non-null string.
  // `projectId: null` is the caller CLEARING the link — a legitimate write
  // that must not be turned into a 404 for a row that was never named.
  it("allows the link to be cleared with an explicit null", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    const findUnique = vi.fn();
    // WARP-2579 moved the field write inside an interactive `$transaction`, so
    // the stub has to hand the service a tx client. The assertion below is on
    // the write that happens ON that client, which is the point of that change:
    // the update and any stage move commit together or not at all.
    const tx = { crmDeal: { update } };
    const prisma = {
      crmDeal: { findUnique: async () => dealRow({ projectId: "pr1" }) },
      pmProject: { findUnique },
      $transaction: vi.fn(async (fn: (c: typeof tx) => Promise<unknown>) => fn(tx)),
    } as never;

    await updateDeal(prisma, "d1", { projectId: null }, null);
    expect(findUnique).not.toHaveBeenCalled();
    expect(update.mock.calls[0][0].data.projectId).toBeNull();
  });
});

describe("logActivity — the four reference columns", () => {
  const cases = [
    { field: "noteId", delegate: "note", error: CRM_ERRORS.NOTE_NOT_FOUND },
    { field: "emailMessageId", delegate: "emailMessage", error: CRM_ERRORS.EMAIL_MESSAGE_NOT_FOUND },
    {
      field: "calendarEventId",
      delegate: "calendarEvent",
      error: CRM_ERRORS.CALENDAR_EVENT_NOT_FOUND,
    },
    { field: "workItemId", delegate: "pmWorkItem", error: CRM_ERRORS.WORK_ITEM_NOT_FOUND },
  ] as const;

  // MUTATION: guard any three of the four and leave the fourth unchecked.
  // Table-driven so a column added later without a guard has nowhere to hide.
  for (const { field, delegate, error } of cases) {
    it(`refuses a ${field} that does not exist, and says which column`, async () => {
      const create = vi.fn();
      const prisma = {
        crmDeal: { findUnique: async () => ({ id: "d1" }) },
        [delegate]: missing,
        crmActivity: { create },
      } as never;

      await expect(
        logActivity(
          prisma,
          { subjectType: "DEAL", dealId: "d1", kind: "NOTE", summary: "s", [field]: "nope" },
          null,
        ),
      ).rejects.toThrow(error);
      expect(create).not.toHaveBeenCalled();
    });

    it(`writes the activity when the ${field} row is real`, async () => {
      const create = vi.fn().mockResolvedValue(activityRow({ [field]: "real" }));
      const prisma = {
        crmDeal: { findUnique: async () => ({ id: "d1" }) },
        [delegate]: present("real"),
        crmActivity: { create },
      } as never;

      await logActivity(
        prisma,
        { subjectType: "DEAL", dealId: "d1", kind: "NOTE", summary: "s", [field]: "real" },
        null,
      );
      expect(create.mock.calls[0][0].data[field]).toBe("real");
    });
  }

  // MUTATION: check the references before the subject. The subject is the more
  // fundamental error — an activity naming a deal that does not exist is not
  // improved by first being told its note id is fine.
  it("reports a missing subject before a missing reference", async () => {
    const prisma = {
      crmDeal: { findUnique: async () => null },
      note: missing,
      crmActivity: { create: vi.fn() },
    } as never;

    await expect(
      logActivity(
        prisma,
        { subjectType: "DEAL", dealId: "gone", kind: "NOTE", summary: "s", noteId: "also-gone" },
        null,
      ),
    ).rejects.toThrow(CRM_ERRORS.DEAL_NOT_FOUND);
  });

  // MUTATION: look every column up unconditionally. An activity that carries
  // no references must cost no lookups.
  it("looks nothing up when the activity carries no references", async () => {
    const note = vi.fn();
    const emailMessage = vi.fn();
    const calendarEvent = vi.fn();
    const pmWorkItem = vi.fn();
    const prisma = {
      crmDeal: { findUnique: async () => ({ id: "d1" }) },
      note: { findUnique: note },
      emailMessage: { findUnique: emailMessage },
      calendarEvent: { findUnique: calendarEvent },
      pmWorkItem: { findUnique: pmWorkItem },
      crmActivity: { create: async () => activityRow() },
    } as never;

    await logActivity(prisma, { subjectType: "DEAL", dealId: "d1", kind: "NOTE", summary: "s" }, null);
    for (const spy of [note, emailMessage, calendarEvent, pmWorkItem]) {
      expect(spy).not.toHaveBeenCalled();
    }
  });
});
