/**
 * WARP-2735 (ADR-048 slice 5) — a mail from a known customer lands on their
 * timeline by itself.
 *
 * ── The three things that must not happen ──────────────────────────────────
 *
 *   1. A mail filed onto the WRONG customer. Sender resolution is a join, so
 *      this is not a confidence question — either the address is on a contact
 *      or it is not. The failure mode is a free-mail domain matching whichever
 *      company happened to be created with `gmail.com` in its domain field.
 *   2. The same mail filed TWICE. `CrmActivity` is `@@unique([externalSystem,
 *      externalId])` and carries no `connectionId`, so that pair is the only
 *      idempotency key available on the table.
 *   3. A mail from a stranger vanishing. A miss must produce a SKIP with a
 *      reason, not silence — silence is the mode the "Left alone" tab exists
 *      to prevent, and an owner cannot tell it apart from a broken worker.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { FILING_EXTERNAL_SYSTEM, logActivity } from "../services/crm/crm.service.js";
import {
  EMAIL_CLAIM_BATCH,
  claimEmails,
  decideEmail,
  resolveSender,
  type EmailClaim,
} from "../services/filing/email-arm.js";

const CLAIM: EmailClaim = {
  id: "msg-1",
  accountId: "acct-1",
  fromAddr: "Jo@Northgate.Example",
  subject: "Quote for the fit-out",
  receivedAt: new Date("2026-09-05T09:00:00.000Z"),
};

function prismaMock(over: Record<string, unknown> = {}) {
  return {
    contactEmail: { findFirst: vi.fn(async () => null) },
    crmCompany: { findFirst: vi.fn(async () => null) },
    ...over,
  } as never;
}

beforeEach(() => vi.clearAllMocks());

describe("🔴 sender resolution is a join, not a guess", () => {
  it("matches the exact address through ContactEmail.addressLower", async () => {
    const findFirst = vi.fn(async (_a: { where: { addressLower: string } }) => ({
      contactId: "c-1",
      contact: { companyLinks: [{ companyId: "co-1", company: { name: "Northgate Dental" } }] },
    }));
    const prisma = prismaMock({ contactEmail: { findFirst } });

    const match = await resolveSender(prisma, CLAIM.fromAddr);
    expect(match).toEqual({
      kind: "EMAIL",
      companyId: "co-1",
      companyName: "Northgate Dental",
      contactId: "c-1",
    });
    // 🔴 Lower-cased before the lookup. `addressLower` is documented as the
    // join key to `EmailMessage.fromAddr`, and a From header carries whatever
    // case the sender's client felt like.
    expect(findFirst.mock.calls[0][0].where.addressLower).toBe("jo@northgate.example");
  });

  it("falls back to the domain when no contact carries the address", async () => {
    const prisma = prismaMock({
      crmCompany: { findFirst: vi.fn(async () => ({ id: "co-2", name: "Northgate Dental" })) },
    });
    const match = await resolveSender(prisma, "accounts@northgate.example");
    expect(match).toMatchObject({ kind: "DOMAIN", companyId: "co-2" });
  });

  it("🔴 MUTATION: match on a free-mail domain — every personal mail files onto one customer", async () => {
    // The failure this prevents: one company created with `gmail.com` in its
    // domain field would collect every personal mail from every customer's
    // staff. The exclusion is why there is no NAME fallback here either — a
    // display name in a From header is attacker-controlled.
    const crmFindFirst = vi.fn(async () => ({ id: "co-3", name: "Whoever" }));
    const prisma = prismaMock({ crmCompany: { findFirst: crmFindFirst } });

    for (const addr of ["someone@gmail.com", "someone@outlook.com", "someone@yahoo.com"]) {
      const match = await resolveSender(prisma, addr);
      expect(match, addr).toEqual({ kind: "NONE", reason: "free_mail" });
    }
    // And the company lookup was never even reached.
    expect(crmFindFirst).not.toHaveBeenCalled();
  });

  it("ignores an archived company on both paths", async () => {
    // An archived customer is one the owner has put away. Filing new mail onto
    // it would quietly bring it back into view.
    const contactFindFirst = vi.fn(async (_a: { where: unknown }) => ({
      contactId: "c-1",
      // `companyLinks` is filtered on `company.isArchived: false`, so an
      // archived link simply is not returned.
      contact: { companyLinks: [] },
    }));
    const crmFindFirst = vi.fn(async (_a: { where: Record<string, unknown> }) => null);
    const prisma = prismaMock({
      contactEmail: { findFirst: contactFindFirst },
      crmCompany: { findFirst: crmFindFirst },
    });

    expect(await resolveSender(prisma, CLAIM.fromAddr)).toEqual({
      kind: "NONE",
      reason: "unknown_sender",
    });
    expect(crmFindFirst.mock.calls[0][0].where).toMatchObject({ isArchived: false });
  });
});

describe("🔴 what one mail becomes", () => {
  it("proposes a timeline entry keyed on the MESSAGE", async () => {
    const outcome = decideEmail(CLAIM, {
      kind: "EMAIL",
      companyId: "co-1",
      companyName: "Northgate Dental",
      contactId: "c-1",
    });
    expect(outcome.draft).toMatchObject({
      kind: "LOG_EMAIL_ACTIVITY",
      dedupeKey: "email:msg-1",
      matchKind: "EMAIL",
    });
    expect(outcome.draft?.payload).toMatchObject({
      companyId: "co-1",
      companyName: "Northgate Dental",
      emailMessageId: "msg-1",
      subject: "Quote for the fit-out",
    });
    expect(outcome.skipReason).toBeNull();
  });

  it("rates an exact address above a shared domain", async () => {
    const exact = decideEmail(CLAIM, {
      kind: "EMAIL",
      companyId: "co-1",
      companyName: "N",
      contactId: "c-1",
    });
    const domain = decideEmail(CLAIM, { kind: "DOMAIN", companyId: "co-1", companyName: "N" });
    // An address is an identity; a domain is an affiliation. Anyone at a
    // company shares its domain.
    expect(exact.draft!.confidence).toBeGreaterThan(domain.draft!.confidence);
  });

  it("🔴 MUTATION: return nothing on a miss — the feature gets a silent mode", async () => {
    // A mail from a stranger is the ORDINARY case. Producing nothing at all
    // would leave an owner unable to tell "Droplet looked and decided not to"
    // from "Droplet never looked" — the exact failure the Left alone tab was
    // built for.
    const outcome = decideEmail(CLAIM, { kind: "NONE", reason: "unknown_sender" });
    expect(outcome.draft).toBeNull();
    expect(outcome.skipReason).toBe("not_business");
  });

  it("🔴 files the mail but drops a subject that trips the screen", async () => {
    // A subject reading like a patient reference must not be copied onto a CRM
    // timeline. Dropping the caption while keeping the link is strictly better
    // than dropping both: the owner still sees that this customer wrote.
    const phi = { ...CLAIM, subject: "Referral: patient DOB 1984-02-11, chart 88213" };
    const outcome = decideEmail(phi, {
      kind: "EMAIL",
      companyId: "co-1",
      companyName: "N",
      contactId: "c-1",
    });
    expect(outcome.draft).not.toBeNull();
    expect(outcome.draft!.payload.subject).toBeUndefined();
  });

  it("never copies the body — there is no body field to copy", async () => {
    const outcome = decideEmail(CLAIM, {
      kind: "EMAIL",
      companyId: "co-1",
      companyName: "N",
      contactId: "c-1",
    });
    // The schema says the CRM stores a caption and never a copy of the body.
    // Asserted structurally: no key on the payload could hold one.
    expect(Object.keys(outcome.draft!.payload).sort()).toEqual([
      "companyId",
      "companyName",
      "emailMessageId",
      "matchedKeyKind",
      "matchedKeyValue",
      "occurredAt",
      "subject",
    ]);
  });
});

describe("🔴 the claim is durable and bounded", () => {
  it("🔴 takes nothing when filing was never switched on", async () => {
    const $transaction = vi.fn();
    // `enabledAt` is the consent stamp AND the backlog boundary. Without one
    // there is no authority to read anything — and the check happens BEFORE
    // the transaction opens, so a box with filing off does no database work
    // per tick rather than opening and closing one for nothing.
    expect(await claimEmails({ $transaction } as never, ["acct-1"], null)).toEqual([]);
    expect($transaction).not.toHaveBeenCalled();
  });

  it("takes nothing when the owner has no mailbox", async () => {
    const $transaction = vi.fn();
    expect(await claimEmails({ $transaction } as never, [], new Date())).toEqual([]);
    expect($transaction).not.toHaveBeenCalled();
  });

  it("bounds a tick so a mail burst cannot starve the file arm", () => {
    expect(EMAIL_CLAIM_BATCH).toBeGreaterThan(0);
    expect(EMAIL_CLAIM_BATCH).toBeLessThanOrEqual(25);
  });
});


/**
 * 🔴 What the filed row itself carries.
 *
 * Both assertions below were added because a mutation run SURVIVED without
 * them: `logActivity`'s filing branch had no coverage at all, so removing
 * either field went unnoticed. They are the two properties that make a filed
 * caption safe to write repeatedly.
 */
describe("🔴 a box-written timeline caption", () => {
  function activityPrisma() {
    const create = vi.fn(async (_a: { data: Record<string, unknown> }) => ({
      id: "act-1",
      subjectType: "COMPANY",
      companyId: "co-1",
      contactId: null,
      dealId: null,
      kind: "EMAIL",
      summary: "Quote for the fit-out",
      actorId: "u-1",
      occurredAt: new Date(),
      createdAt: new Date(),
      origin: "EXTRACTED",
      noteId: null,
      emailMessageId: "msg-1",
      calendarEventId: null,
      workItemId: null,
      fromStageId: null,
      toStageId: null,
      externalSystem: null,
      externalId: null,
    }));
    return {
      prisma: {
        crmCompany: { findUnique: vi.fn(async () => ({ id: "co-1" })) },
        emailMessage: { findUnique: vi.fn(async () => ({ id: "msg-1" })) },
        crmActivity: { create },
      } as never,
      create,
    };
  }

  const INPUT = {
    subjectType: "COMPANY" as const,
    companyId: "co-1",
    kind: "EMAIL" as const,
    summary: "Quote for the fit-out",
    emailMessageId: "msg-1",
  };

  it("MUTATION: drop the idempotency key — one mail lands on the timeline twice", async () => {
    const { prisma, create } = activityPrisma();
    await logActivity(prisma, INPUT, "u-1", { proposalId: "p-1", externalId: "msg-1" });

    const data = create.mock.calls[0][0].data;
    // `CrmActivity` is @@unique([externalSystem, externalId]) and carries no
    // connectionId, so this pair is the ONLY idempotency key the table has.
    expect(data.externalSystem).toBe(FILING_EXTERNAL_SYSTEM);
    expect(data.externalId).toBe("msg-1");
  });

  it("🔴 MUTATION: let a filed row enter the notify queue — mail starves deal alerts", async () => {
    const { prisma, create } = activityPrisma();
    await logActivity(prisma, INPUT, "u-1", { proposalId: "p-1", externalId: "msg-1" });

    // `activity-notify.service.ts` sweeps `notifyStatus: "pending"` FIFO, 500
    // rows per 60 s, with NO kind filter — and marks everything that is not a
    // WON/LOST stage change `not_needed` on arrival. A morning's mail taking
    // the default would sit ahead of a real deal notification in a shared
    // budget and delay it, for a row nobody was ever going to be told about.
    expect(data0(create)).toBe("not_needed");
  });

  it("a HUMAN note is untouched by both", async () => {
    const { prisma, create } = activityPrisma();
    await logActivity(prisma, { ...INPUT, kind: "NOTE" }, "u-1");
    const data = create.mock.calls[0][0].data;
    // No filing provenance means no key and no notify override — a person's
    // note keeps the schema default and the ordinary sweep.
    expect(data.externalSystem).toBeUndefined();
    expect(data.notifyStatus).toBeUndefined();
    expect(data.origin).toBe("LOCAL");
  });
});

function data0(create: { mock: { calls: [{ data: Record<string, unknown> }][] } }): unknown {
  return create.mock.calls[0][0].data.notifyStatus;
}
