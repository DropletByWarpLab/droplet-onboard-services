/**
 * WARP-2733 (ADR-048) — auto mode: the table, the caps, and the pre-flight.
 *
 * The table test walks EVERY cell of (kind × mode × level × verdict × matchKind
 * × confidence) and asserts AUTO / REVIEW / NEVER, because the failure this
 * feature can have is not a crash — it is one cell reading AUTO that should
 * have read REVIEW, on a box nobody is watching. A spot-check of the
 * interesting rows is exactly how such a cell survives: it is never the row
 * somebody thought to check.
 *
 * MUTATIONS THESE CATCH:
 *   - let `CREATE_CONTACT` auto-apply in any cell
 *   - let a MENTIONS document clear an auto floor
 *   - drop the document-role or counterparty condition on CREATE_CUSTOMER
 *   - drop the near-candidate ceiling
 *   - drop the EXTERNAL refusal
 *   - count human applies against the unattended cap
 *   - read `scope: null` from resolveAttributedToolAccess as permission
 *   - leave a cap-deferred proposal in review forever
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const resolveAttributedToolAccessMock = vi.hoisted(() => vi.fn());
vi.mock("../services/tool-access.service.js", () => ({
  resolveAttributedToolAccess: resolveAttributedToolAccessMock,
}));

import type { PolicyInput } from "../services/filing/policy.js";
import {
  AUTO_FLOOR_CREATE,
  AUTO_FLOOR_LINK,
  BOUNDED_MARKER,
  CREATE_ROLES,
  MENTIONS_CONFIDENCE_CAP,
  NEAREST_CANDIDATE_CEILING,
  classify,
} from "../services/filing/policy.js";
import { capReachedFor, readCaps, reconsiderBounded } from "../services/filing/caps.js";
import { preflight, runAutoApply } from "../services/filing/auto-apply.js";
import { runFilingReconcile } from "../services/filing/reconcile.js";
import { buildDrafts } from "../services/filing/propose.js";
import {
  buildReadback,
  formatEnabledAt,
  promotionSentence,
  shouldOfferPromotion,
} from "../services/filing/readback.js";

const KINDS = [
  "LINK_FILE",
  "LOG_EMAIL_ACTIVITY",
  "SET_PROJECT_CUSTOMER",
  "CREATE_CUSTOMER",
  "CREATE_PROJECT",
  "CREATE_CONTACT",
  "MATCH_REVIEW",
  "CREATE_MONEY_DOC",
] as const;
const MODES = ["off", "propose", "auto"] as const;
const LEVELS = ["links_only", "also_create"] as const;
const VERDICTS = ["CLEAN", "MENTIONS"] as const;
const MATCHES = ["EMAIL", "DOMAIN", "NAME", "NONE"] as const;
const VERTICALS = ["general", "healthcare"] as const;

/** The best case a kind can present: everything the table asks for, satisfied. */
const best = (over: Partial<PolicyInput> = {}): PolicyInput => ({
  kind: "LINK_FILE",
  mode: "auto" as const,
  level: "also_create" as const,
  vertical: "general" as const,
  phiVerdict: "CLEAN" as const,
  confidence: 100,
  matchKind: "DOMAIN" as const,
  documentRole: "INVOICE",
  counterparty: "BUSINESS",
  nearestCandidateScore: 0,
  capReached: false,
  ...over,
});

describe("🔴 the policy table, every cell", () => {
  it("walks the whole grid and never surprises", () => {
    const surprises: string[] = [];
    for (const kind of KINDS) {
      for (const mode of MODES) {
        for (const level of LEVELS) {
          for (const vertical of VERTICALS) {
            for (const phiVerdict of VERDICTS) {
              for (const matchKind of MATCHES) {
                for (const confidence of [0, 50, 84, 85, 89, 90, 100]) {
                  const v = classify(
                    best({ kind, mode, level, vertical, phiVerdict, matchKind, confidence }),
                  );
                  const auto = v.policyClass === "AUTO";
                  const expected = expectAuto({
                    kind,
                    mode,
                    level,
                    vertical,
                    phiVerdict,
                    matchKind,
                    confidence,
                  });
                  if (auto !== expected) {
                    surprises.push(
                      `${kind} mode=${mode} level=${level} vertical=${vertical} ` +
                        `phi=${phiVerdict} match=${matchKind} conf=${confidence} ` +
                        `→ ${v.policyClass} (expected ${expected ? "AUTO" : "not AUTO"})`,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(surprises).toEqual([]);
  });

  /**
   * The table, stated independently of the implementation.
   *
   * 🔴 Written as its own predicate rather than by calling `classify` — a test
   * that re-derives the answer from the code under test proves only that the
   * code is self-consistent.
   */
  function expectAuto(c: {
    kind: string;
    mode: string;
    level: string;
    vertical: string;
    phiVerdict: string;
    matchKind: string;
    confidence: number;
  }): boolean {
    if (c.kind === "CREATE_MONEY_DOC") return false; // NEVER
    if (c.kind === "CREATE_CONTACT") return false; // review, always
    if (c.kind === "MATCH_REVIEW") return false; // a person picks
    if (c.mode !== "auto") return false;
    if (c.phiVerdict === "MENTIONS") return false;
    if (c.matchKind === "NAME") return false; // a lookalike is not a match

    const links = ["LINK_FILE", "LOG_EMAIL_ACTIVITY", "SET_PROJECT_CUSTOMER"];
    if (links.includes(c.kind)) return c.confidence >= AUTO_FLOOR_LINK;

    // creates
    if (c.level !== "also_create") return false;
    if (c.vertical === "healthcare") return false;
    return c.confidence >= AUTO_FLOOR_CREATE;
  }
});

describe("🔴 the conditions a CREATE must additionally satisfy", () => {
  it("MUTATION: drop the document-role condition — a letter mints a customer", () => {
    for (const role of ["CORRESPONDENCE", "SCAN", "OTHER", null]) {
      expect(
        classify(best({ kind: "CREATE_CUSTOMER", matchKind: "NONE", documentRole: role }))
          .policyClass,
        String(role),
      ).toBe("REVIEW");
    }
    for (const role of CREATE_ROLES) {
      expect(
        classify(best({ kind: "CREATE_CUSTOMER", matchKind: "NONE", documentRole: role }))
          .policyClass,
      ).toBe("AUTO");
    }
  });

  it("MUTATION: drop the counterparty condition — a private individual becomes a customer", () => {
    for (const cp of ["INDIVIDUAL", "UNKNOWN", null]) {
      expect(
        classify(best({ kind: "CREATE_CUSTOMER", matchKind: "NONE", counterparty: cp }))
          .policyClass,
      ).toBe("REVIEW");
    }
  });

  it("MUTATION: drop the near-candidate ceiling — the duplicate the matcher exists to prevent", () => {
    // `matchKind: NONE` says the matcher found no key it TRUSTS. It does not
    // say the record is absent, and a near miss is exactly where creating
    // produces a duplicate the owner finds weeks later.
    expect(
      classify(
        best({
          kind: "CREATE_CUSTOMER",
          matchKind: "NONE",
          nearestCandidateScore: NEAREST_CANDIDATE_CEILING,
        }),
      ).policyClass,
    ).toBe("REVIEW");
    expect(
      classify(
        best({
          kind: "CREATE_CUSTOMER",
          matchKind: "NONE",
          nearestCandidateScore: NEAREST_CANDIDATE_CEILING - 0.01,
        }),
      ).policyClass,
    ).toBe("AUTO");
  });

  it("a same-named project is not minted twice", () => {
    expect(
      classify(best({ kind: "CREATE_PROJECT", matchKind: "NONE", sameNameProjectExists: true }))
        .policyClass,
    ).toBe("REVIEW");
  });
});

describe("🔴 NEVER means never, including for a human", () => {
  it("MUTATION: drop the EXTERNAL refusal — Droplet writes to a connector's row", () => {
    // A vendor is the system of record for a landed row: our write would be
    // reverted by the next sync tick, so it is not merely risky but pointless
    // — and for the hours in between it looks like a change that vanished.
    for (const kind of KINDS) {
      const v = classify(best({ kind, targetIsExternal: true }));
      expect(v.policyClass, kind).toBe("NEVER");
    }
  });

  /**
   * 🔴 WARP-2737 changed this assertion from NEVER to REVIEW, and the change is
   * a narrowing of the guarantee, not a loosening of it.
   *
   * NEVER was right while `ErpDocument` was landed-only: there was no row shape
   * a local invoice could take, so offering an Apply button would have been a
   * lie. WARP-2739 widened the table, so a PERSON can now file one.
   *
   * What did not change — and what this test is really pinning — is that only a
   * person ever can. The assertion below is deliberately `not.toBe("AUTO")`
   * rather than `toBe("REVIEW")`, because the invariant worth defending is the
   * absence of the automatic path, and a future third class must not slip
   * through an equality check written for two.
   */
  it("money documents are never AUTO, in any mode", () => {
    for (const mode of MODES) {
      const v = classify(best({ kind: "CREATE_MONEY_DOC", mode }));
      expect(v.policyClass, mode).not.toBe("AUTO");
      expect(v.policyClass, mode).toBe("REVIEW");
    }
  });
});

describe("🔴 MENTIONS can never clear a floor", () => {
  it("the cap sits below both floors, and the class is REVIEW regardless", () => {
    expect(MENTIONS_CONFIDENCE_CAP).toBeLessThan(AUTO_FLOOR_LINK);
    expect(MENTIONS_CONFIDENCE_CAP).toBeLessThan(AUTO_FLOOR_CREATE);
    for (const kind of KINDS) {
      expect(classify(best({ kind, phiVerdict: "MENTIONS" })).policyClass).not.toBe("AUTO");
    }
  });
});

describe("🔴 caps bound, they do not discard", () => {
  it("MUTATION: drop a proposal at the cap — a busy morning looks like a broken worker", () => {
    const v = classify(best({ kind: "CREATE_CUSTOMER", matchKind: "NONE", capReached: true }));
    expect(v.policyClass).toBe("REVIEW");
    expect(v.policyReason).toContain(BOUNDED_MARKER);
  });

  it("every cap reason carries the marker the sweep keys on", () => {
    // The sweep matches on the SENTENCE, so an edit that breaks it must break
    // a test rather than silently make `bounded` a life sentence.
    for (const kind of ["LINK_FILE", "CREATE_CUSTOMER"] as const) {
      const v = classify(best({ kind, matchKind: kind === "LINK_FILE" ? "DOMAIN" : "NONE", capReached: true }));
      expect(v.policyReason, kind).toContain(BOUNDED_MARKER);
    }
  });

  it("a create is bounded by BOTH budgets, the tighter winning", () => {
    expect(capReachedFor("CREATE_CUSTOMER", { hourlyReached: true, dailyReached: false })).toBe(true);
    expect(capReachedFor("CREATE_CUSTOMER", { hourlyReached: false, dailyReached: true })).toBe(true);
    // A link is bounded only by the hourly budget.
    expect(capReachedFor("LINK_FILE", { hourlyReached: false, dailyReached: true })).toBe(false);
  });

  it("MUTATION: count human applies against the unattended budget", async () => {
    // The cap exists to bound what happens WITHOUT a person. A morning spent
    // clicking Apply is evidence against needing the bound, not for it.
    const count = vi.fn(async (_arg: { where: Record<string, unknown> }) => 0);
    const prisma = { ingestProposal: { count } } as never;
    await readCaps(prisma, { hourlyApplyCap: 50, dailyCreateCap: 10 });
    for (const call of count.mock.calls) {
      expect(call[0].where.autoApplied).toBe(true);
    }
  });

  it("MUTATION: never reconsider — `bounded` becomes a life sentence", async () => {
    const updateMany = vi.fn(
      async (_arg: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        count: 1,
      }),
    );
    const prisma = {
      ingestProposal: {
        findMany: vi.fn(async () => [{ id: "p1", kind: "CREATE_CUSTOMER" }]),
        updateMany,
      },
    } as never;
    const freed = await reconsiderBounded(prisma, {
      appliedThisHour: 0,
      createdToday: 0,
      hourlyCap: 50,
      dailyCap: 10,
      hourlyReached: false,
      dailyReached: false,
    });
    expect(freed).toBe(1);
    // Back to AUTO with the reason cleared — the next tick applies it. Nothing
    // is applied from inside the sweep, so it can never become a second,
    // unbounded, apply path.
    expect(updateMany.mock.calls[0][0].data).toMatchObject({
      policyClass: "AUTO",
      policyReason: null,
    });

    // 🔴 And the WHERE, which nothing asserted. `data` alone says what the
    // sweep writes; it says nothing about HOW MANY rows it writes it to.
    // Without `id: { in: freed }` this updateMany promotes every PENDING REVIEW
    // proposal on the box to AUTO with its reason cleared — every card the
    // owner was meant to look at, applied unattended on the next tick, with
    // the sentence explaining why it needed a person deleted in the same
    // statement. The suite stayed green through exactly that mutation.
    const where = updateMany.mock.calls[0][0].where as {
      id?: { in?: string[] };
      status?: string;
      policyClass?: string;
    };
    expect(where.id).toEqual({ in: ["p1"] });
    // Re-checked under the same conditions they were read under, so a row a
    // person decided between the read and the write is not clobbered.
    expect(where.status).toBe("PENDING");
    expect(where.policyClass).toBe("REVIEW");
  });

  it("🔴 MUTATION: sweep every REVIEW card, not just the ones a CAP held", async () => {
    // The other half of the same guard, one query earlier. `findMany`'s own
    // `where` is what limits the sweep to proposals held back by a CAP —
    // `policyReason` carrying BOUNDED_MARKER. Drop it and the sweep collects
    // every card in review, including the ones a person is meant to decide
    // because they are LOW CONFIDENCE or mention PHI, and hands them all to
    // the filter below on grounds that have nothing to do with why they are
    // there.
    const findMany = vi.fn(async (_a: { where: Record<string, unknown> }) => []);
    const prisma = { ingestProposal: { findMany, updateMany: vi.fn() } } as never;
    await reconsiderBounded(prisma, {
      appliedThisHour: 0,
      createdToday: 0,
      hourlyCap: 50,
      dailyCap: 10,
      hourlyReached: false,
      dailyReached: false,
    });
    const where = findMany.mock.calls[0][0].where as {
      status?: string;
      policyClass?: string;
      policyReason?: { contains?: string };
    };
    expect(where.status).toBe("PENDING");
    expect(where.policyClass).toBe("REVIEW");
    // Matched on the reason rather than a column, because `policyReason` is
    // already the durable record of why a proposal is in review.
    expect(where.policyReason?.contains).toBe(BOUNDED_MARKER);
  });

  it("🔴 frees a LINK held by the daily CREATE cap, and never a CREATE", async () => {
    // The daily cap counts CREATE kinds only, so when it alone is spent a link
    // may go and a create may not. Asserted through the sweep rather than on
    // `capReachedFor` directly: the sweep is where the two are joined, and a
    // filter that dropped the kind check would free a create against a cap
    // that is still spent — the caps' whole purpose being that an unattended
    // box cannot invent an unbounded number of customers in a day.
    const updateMany = vi.fn(
      async (_a: { where: { id: { in: string[] } } }) => ({ count: 1 }),
    );
    const prisma = {
      ingestProposal: {
        findMany: vi.fn(async () => [
          { id: "link-1", kind: "LINK_FILE" },
          { id: "create-1", kind: "CREATE_CUSTOMER" },
        ]),
        updateMany,
      },
    } as never;

    await reconsiderBounded(prisma, {
      appliedThisHour: 0,
      createdToday: 10,
      hourlyCap: 50,
      dailyCap: 10,
      hourlyReached: false,
      dailyReached: true,
    });

    const where = updateMany.mock.calls[0]![0].where;
    expect(where.id.in).toEqual(["link-1"]);
    expect(where.id.in).not.toContain("create-1");
  });

  it("does not free anything while the window is still spent", async () => {
    const prisma = {
      ingestProposal: { findMany: vi.fn(), updateMany: vi.fn() },
    } as never;
    const freed = await reconsiderBounded(prisma, {
      appliedThisHour: 50,
      createdToday: 10,
      hourlyCap: 50,
      dailyCap: 10,
      hourlyReached: true,
      dailyReached: true,
    });
    expect(freed).toBe(0);
  });
});

describe("🔴 the pre-flight is fail-closed", () => {
  const SETTINGS = {
    mode: "auto" as const,
    level: "also_create" as const,
    vertical: "general" as const,
    enabledById: "u-owner",
    enabledAt: new Date(),
    folders: [],
    pathDenylist: [],
    hourlyApplyCap: 50,
    dailyCreateCap: 10,
    digestHour: 8,
  };

  function prismaWith(moduleEnabled = true) {
    return {
      moduleSetting: { findUnique: vi.fn(async () => ({ enabled: moduleEnabled })) },
      ingestProposal: { count: vi.fn(async () => 0) },
    } as never;
  }

  beforeEach(() => {
    resolveAttributedToolAccessMock.mockReset();
    resolveAttributedToolAccessMock.mockResolvedValue({
      scope: null,
      tier: "owner",
      unresolved: null,
    });
  });

  it("does nothing at all when the mode is not auto", async () => {
    const r = await preflight(prismaWith(), { ...SETTINGS, mode: "propose" });
    expect(r).toMatchObject({ ok: false, reason: "not_auto" });
    expect(resolveAttributedToolAccessMock).not.toHaveBeenCalled();
  });

  it("MUTATION: run for a deactivated owner — a schedule someone left behind", async () => {
    resolveAttributedToolAccessMock.mockResolvedValue({
      scope: null,
      tier: null,
      unresolved: "user_deactivated",
    });
    const r = await preflight(prismaWith(), SETTINGS);
    expect(r).toMatchObject({ ok: false, reason: "owner_unavailable" });
    expect((r as { message: string }).message).toMatch(/no longer active/);
  });

  it("MUTATION: read `scope: null` as permission — a role-less family creator files", async () => {
    // 🔴 `scope: null` means "resolved, needs no §3 narrowing". A family user
    // with no AccessRole resolves to exactly that. The TIER assertion is ours.
    resolveAttributedToolAccessMock.mockResolvedValue({
      scope: null,
      tier: "family",
      unresolved: null,
    });
    const r = await preflight(prismaWith(), SETTINGS);
    expect(r).toMatchObject({ ok: false, reason: "wrong_role" });
  });

  it("admins may enable it; family may not", async () => {
    resolveAttributedToolAccessMock.mockResolvedValue({ scope: null, tier: "admin", unresolved: null });
    expect((await preflight(prismaWith(), SETTINGS)).ok).toBe(true);
  });

  it("pauses when the Customers module is switched off", async () => {
    const r = await preflight(prismaWith(false), SETTINGS);
    expect(r).toMatchObject({ ok: false, reason: "module_off" });
  });
});

describe("🔴 the readback is derived, not written", () => {
  const base = { mode: "auto" as const, level: "links_only" as const, vertical: "general" as const };

  it("MUTATION: hand-write the sentence — the table changes and consent does not", () => {
    // At links_only the box must SAY it does not create; at also_create it must
    // say what it will create from. Two settings, two different promises, both
    // produced by asking the table.
    const linksOnly = buildReadback(base).join(" ");
    const alsoCreate = buildReadback({ ...base, level: "also_create" }).join(" ");
    expect(linksOnly).toMatch(/Never adds a new customer by itself/);
    expect(alsoCreate).toMatch(/only from a business invoice, quote or contract/);
    expect(linksOnly).not.toBe(alsoCreate);
  });

  it("a healthcare box is told it never creates, at either level", () => {
    for (const level of LEVELS) {
      const text = buildReadback({ ...base, level, vertical: "healthcare" }).join(" ");
      expect(text).toMatch(/Never adds a new customer by itself/);
    }
  });

  it("always says the two things a practice owner is deciding about", () => {
    for (const level of LEVELS) {
      for (const vertical of VERTICALS) {
        const text = buildReadback({ ...base, level, vertical }).join(" ");
        expect(text).toMatch(/patient record/);
        expect(text).toMatch(/address book/);
        expect(text).toMatch(/undone with one click/);
      }
    }
  });

  it("speaks the owner's language", () => {
    for (const mode of MODES) {
      const text = buildReadback({ ...base, mode }).join(" ");
      expect(text).not.toMatch(/proposal|extraction|entity|confidence|policyClass/i);
    }
  });

  it("names who it runs as, and when it was turned on", () => {
    const text = buildReadback({
      ...base,
      ownerName: "Stefan",
      enabledAt: new Date("2026-09-04T10:00:00Z"),
    }).join(" ");
    expect(text).toContain("Runs as: Stefan.");
    expect(text).toContain("Turned on 4 Sep.");
  });

  it("MUTATION: leave the month to ICU — the consent record reads differently per build", () => {
    // `toLocaleDateString("en-GB", { month: "short" })` gives "Sept" on current
    // ICU and "Sep" on older builds. A consent sentence whose wording depends
    // on which ICU the container shipped is one nobody can assert — in a test,
    // or in a screenshot a year later.
    expect(formatEnabledAt(new Date("2026-09-04T10:00:00Z"))).toBe("4 Sep");
    expect(formatEnabledAt(new Date("2026-01-31T23:59:00Z"))).toBe("31 Jan");
  });
});

describe("🔴 auto-create actually happens — the fail-closed trap", () => {
  /**
   * Everything the table needs is fail-CLOSED when absent: an undefined
   * `documentRole` is not in `CREATE_ROLES` and refuses the create. That is
   * the right direction — a caller who forgets a field gets review cards, not
   * unattended writes — but it also means a forgetful caller silently disables
   * the whole feature with no error anywhere.
   *
   * So this asserts the POSITIVE path through `buildDrafts`, not just the
   * negatives. A slice that only tested refusals could ship with auto-create
   * permanently off and every test green.
   */
  const AUTO_SETTINGS = {
    mode: "auto" as const,
    level: "also_create" as const,
    vertical: "general" as const,
  };

  const company = {
    name: "ACME Dental Supply Ltd",
    domain: "acme-dental.example",
    emails: [],
    phones: [],
    role: "vendor" as const,
    confidence: 95,
    evidence: [{ quote: "ACME Dental Supply Ltd" }],
  };

  const entities = {
    companies: [company],
    people: [],
    projects: [],
    moneyDocuments: [],
    deals: [],
  };

  const SOURCE = {
    sourceKind: "FILE" as const,
    sourceRef: "file:8891",
    ncFileId: 8891,
    filePath: "/Customers/acme-invoice.pdf",
    fileSpace: "files",
  };

  it("a business invoice from an unknown company is AUTO", async () => {
    const { drafts } = await buildDrafts({
      source: SOURCE,
      entities,
      phiVerdict: "CLEAN",
      settings: AUTO_SETTINGS,
      resolveMatch: async () => ({ kind: "NONE", nearestScore: 0 }),
      auto: { documentRole: "INVOICE", counterparty: "BUSINESS" },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ kind: "CREATE_CUSTOMER", policyClass: "AUTO" });
    expect(drafts[0].policyReason).toBeNull();
  });

  it("MUTATION: forget to pass the auto context — auto-create is silently off", async () => {
    const { drafts } = await buildDrafts({
      source: SOURCE,
      entities,
      phiVerdict: "CLEAN",
      settings: AUTO_SETTINGS,
      resolveMatch: async () => ({ kind: "NONE", nearestScore: 0 }),
      // no `auto` — every condition unset
    });
    expect(drafts[0].policyClass).toBe("REVIEW");
  });

  it("the matcher's near-miss score reaches the table", async () => {
    // The matcher said NONE, but something scored 0.8. That is the duplicate
    // case, and it must not create unattended.
    const { drafts } = await buildDrafts({
      source: SOURCE,
      entities,
      phiVerdict: "CLEAN",
      settings: AUTO_SETTINGS,
      resolveMatch: async () => ({ kind: "NONE", nearestScore: 0.8 }),
      auto: { documentRole: "INVOICE", counterparty: "BUSINESS" },
    });
    expect(drafts[0].policyClass).toBe("REVIEW");
    expect(drafts[0].policyReason).toMatch(/customer you already have/);
  });

  it("a matched EXTERNAL customer is NEVER, not merely review", async () => {
    const { drafts } = await buildDrafts({
      source: SOURCE,
      entities,
      phiVerdict: "CLEAN",
      settings: AUTO_SETTINGS,
      resolveMatch: async () => ({
        kind: "MATCH",
        matchKind: "DOMAIN",
        matchedValue: "acme-dental.example",
        companyId: "11111111-1111-4111-8111-111111111111",
        companyName: "ACME Dental Supply Ltd",
        taught: false,
        targetIsExternal: true,
      }),
      auto: { documentRole: "INVOICE", counterparty: "BUSINESS" },
    });
    expect(drafts[0].policyClass).toBe("NEVER");
  });

  it("a spent budget defers rather than drops", async () => {
    const { drafts } = await buildDrafts({
      source: SOURCE,
      entities,
      phiVerdict: "CLEAN",
      settings: AUTO_SETTINGS,
      resolveMatch: async () => ({ kind: "NONE", nearestScore: 0 }),
      auto: {
        documentRole: "INVOICE",
        counterparty: "BUSINESS",
        capReached: () => true,
      },
    });
    // Still there, still visible, still clickable — and reconsidered when the
    // window rolls.
    expect(drafts).toHaveLength(1);
    expect(drafts[0].policyClass).toBe("REVIEW");
    expect(drafts[0].policyReason).toContain(BOUNDED_MARKER);
  });
});

describe("promotion is offered on evidence, not on a timer", () => {
  it("waits for a track record", () => {
    expect(shouldOfferPromotion({ applied: 19, corrections: 0, mode: "propose" })).toBe(false);
    expect(shouldOfferPromotion({ applied: 20, corrections: 0, mode: "propose" })).toBe(true);
  });

  it("a corrected history withdraws the offer", () => {
    expect(shouldOfferPromotion({ applied: 40, corrections: 3, mode: "propose" })).toBe(false);
    expect(shouldOfferPromotion({ applied: 40, corrections: 2, mode: "propose" })).toBe(true);
  });

  it("is never offered when auto is already on, or filing is off", () => {
    expect(shouldOfferPromotion({ applied: 99, corrections: 0, mode: "auto" })).toBe(false);
    expect(shouldOfferPromotion({ applied: 99, corrections: 0, mode: "off" })).toBe(false);
  });

  it("counts in the owner's words", () => {
    expect(promotionSentence({ applied: 20, corrections: 1 })).toBe(
      "You've filed 20 things and corrected 1. Want Droplet to do the easy ones by itself?",
    );
    expect(promotionSentence({ applied: 20, corrections: 0 })).toContain("not corrected any");
  });
});

/**
 * 🔴 The cap sweep must not depend on the model being reachable.
 *
 * `runFilingTick` returns before auto-apply when the model is unreachable or
 * the canary has it paused — right for extraction, wrong for a proposal that
 * was already read and only deferred because an hour's budget was spent.
 * Freeing it is pure DB work. Without the sweep in `reconcile.ts` a box with a
 * model outage leaves every cap-deferred card wearing a reason that stopped
 * applying hours ago: "manual forever, then silently EXPIRED", reached through
 * an unrelated fault.
 */
describe("🔴 the reconcile sweep frees capped work with no model at all", () => {
  const AUTO_ROW = {
    id: "singleton",
    mode: "auto",
    level: "also_create",
    vertical: "general",
    enabledById: "u-owner",
    enabledAt: new Date(),
    folders: [],
    pathDenylist: [],
    hourlyApplyCap: 50,
    dailyCreateCap: 10,
    digestHour: 8,
  };

  const harness = (row: Record<string, unknown> | null) => {
    const updateMany = vi.fn(async () => ({ count: 0 }));
    const proposalUpdateMany = vi.fn(
      async (_arg: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
        count: 2,
      }),
    );
    const findMany = vi.fn(async (_arg: { where: Record<string, unknown> }) => [
      { id: "p1", kind: "LINK_FILE" },
      { id: "p2", kind: "LINK_FILE" },
    ]);
    const prisma = {
      fileIndexStatus: { updateMany },
      autoFilingSetting: { findUnique: vi.fn(async () => row) },
      ingestProposal: { count: vi.fn(async () => 0), findMany, updateMany: proposalUpdateMany },
    } as never;
    return { prisma, findMany, proposalUpdateMany };
  };

  it("MUTATION: leave the sweep only inside runAutoApply — a model outage strands them", async () => {
    const { prisma, findMany, proposalUpdateMany } = harness(AUTO_ROW);
    const result = await runFilingReconcile(prisma);

    expect(result.freed).toBe(2);
    // Matched on the REASON, not a second column: `policyReason` is already the
    // durable record of why a proposal is in review.
    expect(findMany.mock.calls[0][0].where.policyReason).toEqual({
      contains: BOUNDED_MARKER,
    });
    // Back into the queue the tick reads — never applied from here.
    expect(proposalUpdateMany.mock.calls[0][0].data).toMatchObject({
      policyClass: "AUTO",
      policyReason: null,
    });
  });

  it("does nothing when the owner never promoted anything", async () => {
    const { prisma, findMany } = harness({ ...AUTO_ROW, mode: "propose" });
    const result = await runFilingReconcile(prisma);
    expect(result.freed).toBe(0);
    expect(findMany).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 A REFUSAL THIS LOOP DOES NOT RECOGNISE TAKES THE WHOLE TICK WITH IT.
 *
 * `runAutoApply`'s catch re-throws anything `isExpected` does not list. That is
 * the right default — an unrecognised failure must not be swallowed — but it
 * means an OMISSION from that list does not fail where the omission is. It
 * aborts the tick, abandons every proposal queued behind the offending one, and
 * leaves the box with unattended filing quietly stopped until somebody reads a
 * stack trace.
 *
 * `MONEY_MODULE_OFF` and `CUSTOMER_REQUIRED` are money refusals, and money is
 * REVIEW in every cell of the policy table, so neither is reachable today. They
 * are listed anyway, and pinned here anyway, because "unreachable" is a
 * property of a table somebody could widen — and the day they widen it is
 * exactly the day nobody is looking at this loop.
 */
describe("🔴 an unrecognised refusal would abandon the rest of the tick", () => {
  const SETTINGS = {
    mode: "auto" as const,
    level: "also_create" as const,
    vertical: "general" as const,
    enabledById: "u-owner",
    enabledAt: new Date("2026-09-05T08:00:00.000Z"),
    folders: [],
    pathDenylist: [],
    hourlyApplyCap: 50,
    dailyCreateCap: 10,
    digestHour: 8,
  };

  /** Two AUTO money proposals: the first refused for the module, the second for
   *  having no customer. Both are the codes under test, and the second only
   *  runs at all if the first was walked past rather than thrown. */
  const harness = (moneyEnabled: boolean) => {
    const rows = [
      { id: "p-money-1", kind: "CREATE_MONEY_DOC" },
      { id: "p-money-2", kind: "CREATE_MONEY_DOC" },
    ];
    const erpCreate = vi.fn(async () => {
      throw new Error("REACHED_CREATE");
    });
    const prisma = {
      moduleSetting: {
        findUnique: vi.fn(async (args: { where: { moduleId: string } }) =>
          args.where.moduleId === "crm"
            ? { moduleId: "crm", enabled: true }
            : { moduleId: "money", enabled: moneyEnabled },
        ),
      },
      ingestProposal: {
        count: vi.fn(async () => 0),
        findMany: vi.fn(async (args: { where: Record<string, unknown> }) =>
          args.where.policyClass === "AUTO" && args.where.status === "PENDING" ? rows : [],
        ),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: vi.fn(async () => ({})),
        findUnique: vi.fn(async (args: { where: { id: string } }) => ({
          id: args.where.id,
          status: "PENDING",
          policyClass: "AUTO",
          kind: "CREATE_MONEY_DOC",
          confidence: 99,
          dependsOnProposalId: null,
          payload: {
            kind: "INVOICE",
            currency: "USD",
            total: "4250.00",
            direction: "RECEIVABLE",
          },
        })),
      },
      crmCompany: { findUnique: vi.fn(async () => null) },
      erpDocument: { create: erpCreate },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    };
    return { prisma, erpCreate };
  };

  it("🔴 MUTATION: walks past a Money-module refusal and keeps going", async () => {
    const { prisma, erpCreate } = harness(false);
    const result = await runAutoApply(prisma as never, SETTINGS, {
      resolveFileId: async () => null,
    });
    // Not a throw, and not a tick that stopped at the first card.
    expect(result).toEqual({ applied: 0, refused: 2, freed: 0 });
    expect(erpCreate).not.toHaveBeenCalled();
  });

  it("🔴 MUTATION: walks past a money document with no customer too", async () => {
    // Module ON this time, so the refusal can only be the customer one.
    const { prisma, erpCreate } = harness(true);
    const result = await runAutoApply(prisma as never, SETTINGS, {
      resolveFileId: async () => null,
    });
    expect(result).toEqual({ applied: 0, refused: 2, freed: 0 });
    expect(erpCreate).not.toHaveBeenCalled();
  });

  it("VACUITY: a refusal nobody listed still stops the tick", async () => {
    // The default has to stay fail-loud, or the two tests above would pass just
    // as well against a catch that swallowed everything.
    const { prisma } = harness(true);
    prisma.ingestProposal.updateMany = vi.fn(async () => {
      throw new Error("something nobody has thought about");
    }) as never;
    await expect(
      runAutoApply(prisma as never, SETTINGS, { resolveFileId: async () => null }),
    ).rejects.toThrow("something nobody has thought about");
  });
});
