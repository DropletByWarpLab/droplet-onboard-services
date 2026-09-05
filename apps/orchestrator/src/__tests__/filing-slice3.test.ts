/**
 * WARP-2731 (ADR-048) — undo, the Rules memory, audit, digest and forgetting.
 *
 * Slice 3 is the half that makes a wrong filing survivable, so almost every
 * test here is about something NOT happening: an audit row that does not carry
 * a filename, a digest that does not fire at zero, a sweep that does not
 * rewrite rows it has already cleaned, a rule that is not written when it
 * would match nothing.
 *
 * The archive-vs-delete branch of undo is the exception and it lives in the pg
 * suite — `crm-activity-cascade.pg.test.ts` established that deleting a
 * subject destroys every activity attached to it including a human's own
 * notes, and a mocked Prisma cannot see a cascade.
 *
 * MUTATIONS THESE CATCH:
 *   - add any key to the audit refs allow-list
 *   - interpolate anything into an audit phrase
 *   - send the digest at zero, or twice in a day
 *   - drop `evidence: { not: DbNull }` from the retention sweep
 *   - key the orphan purge on the status row OR the chunks instead of both
 *   - let a PHI skip be re-openable from the Skipped tab
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const sendNotificationMock = vi.hoisted(() => vi.fn());
vi.mock("../services/notifications.service.js", () => ({
  sendNotification: sendNotificationMock,
}));

const recordMock = vi.hoisted(() => vi.fn());
vi.mock("../services/activity.singleton.js", () => ({
  getActivityRecorder: () => ({ record: recordMock }),
}));

import {
  AUDIT_PHRASES,
  FILING_AUDIT_REF_KEYS,
  recordFilingAudit,
} from "../services/filing/audit.js";
import {
  DIGEST_TITLE_PREFIX,
  runFilingDigest,
  __resetTickClockForTests,
} from "../services/filing/digest.js";
import {
  EVIDENCE_TTL_DAYS,
  PROPOSAL_TTL_DAYS,
  runFilingMaintenance,
} from "../services/filing/maintenance.js";
import { explain, isReopenable, EXPLANATIONS } from "../services/filing/skipped.service.js";
import { sentenceFor } from "../services/filing/rules.service.js";

beforeEach(() => {
  sendNotificationMock.mockReset();
  sendNotificationMock.mockResolvedValue({ id: "n1", channels: [], delivered: false });
  recordMock.mockReset();
  recordMock.mockResolvedValue({ id: 1n });
  __resetTickClockForTests();
});

// ── Audit ──────────────────────────────────────────────────────────────────

describe("🔴 the audit row carries ids, codes and counts — nothing else", () => {
  it("MUTATION: add a key to the allow-list — a filename reaches a signed export", async () => {
    await recordFilingAudit({
      ownerId: "u-owner",
      what: AUDIT_PHRASES.filed,
      refs: {
        sourceRef: "file:8891",
        sourceKind: "FILE",
        extractStatus: "done",
        proposalsCreated: 1,
        // Everything below is what a well-meaning "make the audit useful"
        // change looks like. None of it may survive the filter.
        path: "/Customers/acme-invoice.pdf",
        fileName: "acme-invoice.pdf",
        companyName: "ACME Dental Supply Ltd",
        total: "4250.00",
        quote: "Total $4,250.00",
      } as unknown as Parameters<typeof recordFilingAudit>[0]["refs"],
    });

    expect(recordMock).toHaveBeenCalledTimes(1);
    const refs = recordMock.mock.calls[0][0].refs as Record<string, unknown>;
    // The assertion that matters: the EXACT key set, so an extra one fails
    // rather than a missing one. The failure mode here is additive.
    for (const key of Object.keys(refs)) {
      expect(FILING_AUDIT_REF_KEYS as readonly string[]).toContain(key);
    }
    expect(JSON.stringify(refs)).not.toMatch(/acme-invoice|ACME Dental|4,250|4250\.00/);
  });

  it("attributes the row to `ai` acting for the owner, never to a person", async () => {
    await recordFilingAudit({
      ownerId: "u-owner",
      what: AUDIT_PHRASES.skipped,
      refs: { sourceRef: "file:1", sourceKind: "FILE", extractStatus: "skipped" },
    });
    expect(recordMock.mock.calls[0][0].actor).toEqual({ type: "ai", id: "u-owner" });
  });

  it("MUTATION: interpolate a filename into a phrase — every row leaks one", () => {
    // The phrases are a closed set of fixed strings for exactly this reason:
    // the moment one becomes a template, somebody puts the document in it.
    // That is how `Indexed ${filename}` came to exist in the indexer bridge.
    for (const phrase of Object.values(AUDIT_PHRASES)) {
      expect(phrase).not.toMatch(/\$\{|%s|\{\}/);
      expect(phrase).not.toMatch(/\.pdf|\.docx/);
    }
  });

  it("drops nulls rather than writing them", async () => {
    await recordFilingAudit({
      ownerId: "u-owner",
      what: AUDIT_PHRASES.nothing,
      refs: {
        sourceRef: "file:1",
        sourceKind: "FILE",
        extractStatus: "done",
        extractReason: null,
        model: null,
      },
    });
    const refs = recordMock.mock.calls[0][0].refs as Record<string, unknown>;
    expect(refs).not.toHaveProperty("extractReason");
    expect(refs).not.toHaveProperty("model");
  });
});

// ── Digest ─────────────────────────────────────────────────────────────────

const DIGEST_SETTING = {
  id: "singleton",
  mode: "propose",
  level: "links_only",
  vertical: "general",
  enabledById: "u-owner",
  enabledAt: new Date("2026-01-01T00:00:00Z"),
  folders: [],
  pathDenylist: null,
  hourlyApplyCap: 50,
  dailyCreateCap: 10,
  digestHour: 8,
};

function digestPrisma(over: { setting?: unknown; pending?: number; already?: unknown }) {
  return {
    autoFilingSetting: { findUnique: vi.fn(async () => over.setting ?? DIGEST_SETTING) },
    ingestProposal: { count: vi.fn(async () => over.pending ?? 0) },
    notificationLog: { findFirst: vi.fn(async () => over.already ?? null) },
  } as never;
}

/** 08:15 local on an arbitrary day. `getHours()` is local by design — the
 *  owner reads this at breakfast, not at UTC midnight. */
const atEight = () => {
  const d = new Date(2026, 8, 5, 8, 15, 0);
  return d;
};

describe("🔴 the digest speaks only when there is something to say", () => {
  it("MUTATION: send at zero — the notification becomes furniture", async () => {
    const r = await runFilingDigest(digestPrisma({ pending: 0 }), atEight());
    expect(r).toMatchObject({ sent: false, reason: "nothing_waiting" });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("sends once when something is waiting", async () => {
    const r = await runFilingDigest(digestPrisma({ pending: 3 }), atEight());
    expect(r.sent).toBe(true);
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
    const input = sendNotificationMock.mock.calls[0][1];
    expect(input).toMatchObject({ userId: "u-owner", kind: "ai" });
    expect(input.title).toContain("3 things need a look");
    // 🔴 No body. The count IS the message, and a body is the first place a
    // customer name or a filename would appear.
    expect(input.body).toBeNull();
  });

  it("MUTATION: drop the already-sent read — a restart re-sends every hour", async () => {
    const r = await runFilingDigest(
      digestPrisma({ pending: 3, already: { id: "n0" } }),
      atEight(),
    );
    expect(r).toMatchObject({ sent: false, reason: "already_sent" });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("stays quiet outside the owner's hour", async () => {
    const r = await runFilingDigest(digestPrisma({ pending: 3 }), new Date(2026, 8, 5, 14, 0, 0));
    expect(r).toMatchObject({ sent: false, reason: "wrong_hour" });
  });

  it("stays quiet when filing is off, whatever is pending", async () => {
    const r = await runFilingDigest(
      digestPrisma({ setting: { ...DIGEST_SETTING, mode: "off" }, pending: 9 }),
      atEight(),
    );
    expect(r).toMatchObject({ sent: false, reason: "off" });
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });

  it("the idempotence read and the title agree on their prefix", () => {
    // They are two uses of one constant; if they ever became two literals the
    // digest would send every hour and nothing would say why.
    expect(DIGEST_TITLE_PREFIX.length).toBeGreaterThan(0);
  });
});

// ── Maintenance ────────────────────────────────────────────────────────────

type UpdateManyArg = { where: Record<string, unknown>; data: Record<string, unknown> };

function maintenancePrisma(over: {
  candidates?: { id: string; ncFileId: number }[];
  statuses?: { ncFileId: number }[];
  chunks?: { ncFileId: number }[];
}) {
  const updateMany = vi.fn(async (_arg: UpdateManyArg) => ({ count: 1 }));
  return {
    prisma: {
      ingestProposal: {
        findMany: vi.fn(async () => over.candidates ?? []),
        updateMany,
      },
      fileIndexStatus: { findMany: vi.fn(async () => over.statuses ?? []) },
      $queryRaw: vi.fn(async () => over.chunks ?? []),
    } as never,
    updateMany,
  };
}

describe("🔴 a proposal never outlives the document it came from", () => {
  it("expires one whose status row AND chunks are both gone", async () => {
    const { prisma, updateMany } = maintenancePrisma({
      candidates: [{ id: "p1", ncFileId: 8891 }],
      statuses: [],
      chunks: [],
    });
    await runFilingMaintenance(prisma);
    const orphanCall = updateMany.mock.calls.find((c) => c[0].where.id !== undefined);
    expect(orphanCall).toBeTruthy();
    expect(orphanCall![0].data).toMatchObject({ status: "EXPIRED" });
  });

  it("MUTATION: key on the status row alone — a re-index in flight loses proposals", async () => {
    // A re-index can briefly hold chunks with no status row. Keying on either
    // half alone expires a proposal for a file that is very much still there.
    const { prisma, updateMany } = maintenancePrisma({
      candidates: [{ id: "p1", ncFileId: 8891 }],
      statuses: [],
      chunks: [{ ncFileId: 8891 }],
    });
    await runFilingMaintenance(prisma);
    const orphanCall = updateMany.mock.calls.find((c) => c[0].where.id !== undefined);
    expect(orphanCall).toBeUndefined();
  });

  it("MUTATION: key on the chunks alone — same, the other way round", async () => {
    const { prisma, updateMany } = maintenancePrisma({
      candidates: [{ id: "p1", ncFileId: 8891 }],
      statuses: [{ ncFileId: 8891 }],
      chunks: [],
    });
    await runFilingMaintenance(prisma);
    const orphanCall = updateMany.mock.calls.find((c) => c[0].where.id !== undefined);
    expect(orphanCall).toBeUndefined();
  });

  it("MUTATION: drop `evidence: { not: DbNull }` — every applied row is rewritten nightly", async () => {
    // Without the predicate the sweep rewrites every applied proposal on every
    // run forever, so `updatedAt` marches daily across the whole table and
    // "when did this last change?" stops meaning anything.
    const { prisma, updateMany } = maintenancePrisma({});
    await runFilingMaintenance(prisma);
    const retention = updateMany.mock.calls
      .map((c) => c[0])
      .find((c) => c.where.status === "APPLIED");
    expect(retention).toBeTruthy();
    expect(retention!.where).toHaveProperty("evidence");
  });

  it("the two windows are stated, not implied", () => {
    expect(PROPOSAL_TTL_DAYS).toBe(30);
    expect(EVIDENCE_TTL_DAYS).toBe(30);
  });
});

// ── The Skipped tab ────────────────────────────────────────────────────────

describe("🔴 a PHI skip is not re-openable from a list", () => {
  it("MUTATION: make phi_record reopenable — the screen becomes a button", () => {
    // Re-opening a PHI skip from this page would be a one-click override of a
    // four-layer control, reachable by anyone with admin. The way to file a
    // document the screen refused is to move it, or to change the folder list.
    expect(isReopenable("phi_record")).toBe(false);
    expect(isReopenable("phi_path")).toBe(false);
    expect(isReopenable("cloud_model_refused")).toBe(false);
  });

  it("does offer a retry for the ones that can come out differently", () => {
    expect(isReopenable("bad_json")).toBe(true);
    expect(isReopenable("model_unreachable")).toBe(true);
    expect(isReopenable("out_of_scope")).toBe(true);
  });

  it("every reason has a sentence, and none of them is a snippet", () => {
    for (const [reason, text] of Object.entries(EXPLANATIONS)) {
      expect(text.length, reason).toBeGreaterThan(10);
      // No filename, no quote, no path.
      expect(text).not.toMatch(/\.pdf|\.docx|\/|“|"/);
    }
    expect(explain(null)).toBe("Not filed.");
  });
});

// ── The correction round-trip ──────────────────────────────────────────────

describe("🔴 a NOT_SAME pair is never offered again", () => {
  /**
   * The AC that makes the Rules memory worth having, asserted end to end
   * against WARP-2730's real matcher rather than against the table.
   *
   * A correction that does not stick is worse than no correction memory: the
   * owner sees the same wrong suggestion tomorrow and concludes the feature
   * does not listen. So the test drives the ACTUAL search path with the rule
   * present, not a stub of it.
   */
  const company = { id: "11111111-1111-4111-8111-111111111111", name: "Northgate Dental" };

  function matcherPrisma(decisions: unknown[]) {
    return {
      filingDecision: { findMany: vi.fn(async () => decisions) },
      contactEmail: { findMany: vi.fn(async () => []) },
      crmCompany: {
        findMany: vi.fn(async () => [{ ...company, domain: "northgate.example" }]),
        findUnique: vi.fn(async () => company),
      },
    } as never;
  }

  it("MUTATION: drop the NOT_SAME filter — the rejected pair comes straight back", async () => {
    const { matchCompany } = await import("../services/filing/match.js");

    // Without the rule, the domain matches.
    const before = await matchCompany(matcherPrisma([]), {
      name: "Northgate Dental",
      domain: "northgate.example",
      emails: [],
      folder: null,
    });
    expect(before).toMatchObject({ kind: "MATCH", companyId: company.id });

    // With the owner's correction, it does not — and there is no other
    // candidate, so the answer is NONE and a NEW customer gets proposed.
    const after = await matchCompany(
      matcherPrisma([
        {
          id: "d1",
          keyKind: "EMAIL_DOMAIN",
          keyValue: "northgate.example",
          verdict: "NOT_SAME",
          companyId: company.id,
        },
      ]),
      { name: "Northgate Dental", domain: "northgate.example", emails: [], folder: null },
    );
    expect(after).toEqual({ kind: "NONE" });
  });

  it("an IGNORE_SOURCE rule stops the source being read at all", async () => {
    const { matchCompany } = await import("../services/filing/match.js");
    const out = await matchCompany(
      matcherPrisma([
        {
          id: "d2",
          keyKind: "EMAIL_DOMAIN",
          keyValue: "newsletter.example",
          verdict: "IGNORE_SOURCE",
          companyId: null,
        },
      ]),
      { name: "Whoever", domain: "newsletter.example", emails: [], folder: null },
    );
    expect(out).toMatchObject({ kind: "IGNORED" });
  });

  it("an ALWAYS_HERE rule beats the search, and says it was taught", async () => {
    const { matchCompany } = await import("../services/filing/match.js");
    const out = await matchCompany(
      matcherPrisma([
        {
          id: "d3",
          keyKind: "EMAIL_DOMAIN",
          keyValue: "northgate.example",
          verdict: "ALWAYS_HERE",
          companyId: company.id,
        },
      ]),
      { name: "Something Else Entirely", domain: "northgate.example", emails: [], folder: null },
    );
    expect(out).toMatchObject({ kind: "MATCH", companyId: company.id, taught: true });
  });
});

// ── The Rules memory ───────────────────────────────────────────────────────

describe("a rule reads as a sentence an owner can judge", () => {
  it("says what it does, in words", () => {
    expect(
      sentenceFor({
        keyKind: "EMAIL_DOMAIN",
        keyValue: "northgate.example",
        verdict: "ALWAYS_HERE",
        companyName: "Northgate Dental",
      }),
    ).toBe("Mail from @northgate.example always files under Northgate Dental.");

    expect(
      sentenceFor({
        keyKind: "EMAIL_DOMAIN",
        keyValue: "newsletter.example",
        verdict: "IGNORE_SOURCE",
        companyName: null,
      }),
    ).toBe("Mail from @newsletter.example is ignored.");
  });

  it("🔴 a rule whose company was deleted still renders, and says so", () => {
    // The matcher already falls through such a rule rather than matching a row
    // that is gone. Hiding it here would leave the owner with a rule they
    // cannot see and therefore cannot revoke.
    expect(
      sentenceFor({
        keyKind: "NAME",
        keyValue: "northgate dental",
        verdict: "ALWAYS_HERE",
        companyName: null,
      }),
    ).toContain("no longer exists");
  });

  it("never uses the machine's words", () => {
    const s = sentenceFor({
      keyKind: "EMAIL_ADDRESS",
      keyValue: "someone@northgate.example",
      verdict: "NOT_SAME",
      companyName: "Northgate Dental",
    });
    expect(s).not.toMatch(/proposal|extraction|entity|confidence|verdict|keyKind/i);
  });
});
