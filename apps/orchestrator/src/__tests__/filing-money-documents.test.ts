/**
 * WARP-2737 (ADR-048 slice 8) — an uploaded invoice becomes a money document.
 *
 * ── What is actually at risk here ──────────────────────────────────────────
 *
 * Every other kind this feature files is reversible in the sense that the owner
 * loses a minute. This one is not. An invoice filed against the wrong customer
 * is a claim on somebody who owes nothing; a total read off the wrong line of a
 * PDF is a figure a business will chase. So the tests below are weighted
 * towards the REFUSALS, and three of them assert an absence.
 *
 * ── The four things that must never happen ─────────────────────────────────
 *
 *   1. A money document applied without a person. `policyClass` is REVIEW in
 *      every cell of the table — mode, level, vertical and confidence cannot
 *      reach it, because the branch returns before any of them is consulted.
 *   2. A figure that passed through a JS number. `Number()` rounds above 2^53,
 *      and on a currency amount that is a wrong invoice rather than an error.
 *   3. A row written while the Money module is off — a write the owner cannot
 *      see is indistinguishable from one that never happened.
 *   4. An `erpDocument.create` outside `document-status.ts`. The provenance
 *      CHECK requires `status NOT NULL` on a LOCAL row and the single-writer
 *      guard forbids writing `status` anywhere else; the creator has to live
 *      in the file that owns the lifecycle.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { classify, type PolicyInput } from "../services/filing/policy.js";
import { FILING_ERRORS, applyProposal } from "../services/filing/apply.service.js";
import {
  DOCUMENT_ERRORS,
  INITIAL_STATUS,
  createLocalDocument,
  deleteDraftDocument,
} from "../services/money/document-status.js";
import { directionOf } from "../services/money/money.service.js";
import { CreateMoneyDocPayload } from "../services/filing/payloads.js";

// ── the policy table ────────────────────────────────────────────────────────

const MODES = ["off", "propose", "auto"] as const;
const LEVELS = ["links_only", "also_create"] as const;
const VERTICALS = ["general", "healthcare"] as const;
const MATCHES = ["EMAIL", "DOMAIN", "NAME", "NONE"] as const;

describe("🔴 money is never filed automatically, in any cell", () => {
  it("walks every (mode × level × vertical × match × confidence) and finds no AUTO", () => {
    const seen = new Set<string>();
    let cells = 0;
    for (const mode of MODES) {
      for (const level of LEVELS) {
        for (const vertical of VERTICALS) {
          for (const matchKind of MATCHES) {
            for (const confidence of [0, 50, 79, 80, 89, 90, 99, 100]) {
              for (const phiVerdict of ["CLEAN", "MENTIONS"] as const) {
                cells += 1;
                const input: PolicyInput = {
                  kind: "CREATE_MONEY_DOC",
                  mode,
                  level,
                  vertical,
                  phiVerdict,
                  confidence,
                  matchKind,
                  documentRole: "INVOICE",
                  counterparty: "BUSINESS",
                  nearestCandidateScore: 0,
                  capReached: false,
                };
                seen.add(classify(input).policyClass);
              }
            }
          }
        }
      }
    }
    // The whole assertion: one class, and it is not AUTO.
    expect([...seen]).toEqual(["REVIEW"]);
    // 3 modes x 2 levels x 2 verticals x 4 matches x 8 confidences x 2 verdicts.
    expect(cells).toBe(768);
  });

  it("MUTATION: let a perfect invoice auto-apply — money files itself overnight", () => {
    // The single most dangerous edit anyone could make to policy.ts, named so
    // it fails by name rather than as one cell of the grid above.
    const perfect: PolicyInput = {
      kind: "CREATE_MONEY_DOC",
      mode: "auto",
      level: "also_create",
      vertical: "general",
      phiVerdict: "CLEAN",
      confidence: 100,
      matchKind: "DOMAIN",
      documentRole: "INVOICE",
      counterparty: "BUSINESS",
      nearestCandidateScore: 0,
      capReached: false,
    };
    expect(classify(perfect).policyClass).toBe("REVIEW");
  });

  it("says why, in the owner's words, without the machine's", () => {
    const reason = classify({
      kind: "CREATE_MONEY_DOC",
      mode: "propose",
      level: "links_only",
      vertical: "general",
      phiVerdict: "CLEAN",
      confidence: 95,
      matchKind: "DOMAIN",
      documentRole: "INVOICE",
      counterparty: "BUSINESS",
      nearestCandidateScore: 0,
      capReached: false,
    }).policyReason;
    expect(reason).toMatch(/never filed automatically/i);
    expect(reason).not.toMatch(/proposal|policy|classif|entity|extraction/i);
  });

  it("🔴 names the document it read, and never calls a bill an invoice", () => {
    // The card is the owner's whole basis for deciding. A BILL is money owed
    // BY the business and a CREDIT_NOTE reduces what is owed — telling
    // somebody Droplet "read an invoice" when it read either is a false
    // statement about a figure they are about to act on, and the surface's own
    // card title (`FilingSurface.tsx`) already gets this right.
    const reasonFor = (moneyKind: string | null) =>
      classify({
        kind: "CREATE_MONEY_DOC",
        mode: "propose",
        level: "links_only",
        vertical: "general",
        phiVerdict: "CLEAN",
        confidence: 95,
        matchKind: "DOMAIN",
        documentRole: "INVOICE",
        counterparty: "BUSINESS",
        nearestCandidateScore: 0,
        capReached: false,
        moneyKind,
      }).policyReason;

    expect(reasonFor("INVOICE")).toContain("an invoice");
    expect(reasonFor("QUOTE")).toContain("a quote");
    expect(reasonFor("BILL")).toContain("a bill");
    expect(reasonFor("RECEIPT")).toContain("a receipt");
    expect(reasonFor("CREDIT_NOTE")).toContain("a credit note");

    // 🔴 And none of the four non-invoice kinds may say "invoice" ANYWHERE in
    // the sentence — a `toContain` alone would pass a string that named both.
    for (const kind of ["QUOTE", "BILL", "RECEIPT", "CREDIT_NOTE"]) {
      expect(reasonFor(kind), kind).not.toMatch(/invoice/i);
    }

    // Absent — an older row, or a sixth kind nobody has written a word for —
    // reads as vague rather than as wrong. The enum member itself must never
    // reach the owner.
    expect(reasonFor(null)).toContain("a money document");
    expect(reasonFor("SOMETHING_NEW")).toContain("a money document");
    expect(reasonFor("SOMETHING_NEW")).not.toMatch(/SOMETHING_NEW/);
  });
});

// ── the payload contract ────────────────────────────────────────────────────

describe("🔴 money crosses every boundary as a string", () => {
  const good = {
    kind: "INVOICE" as const,
    number: "INV-1042",
    issuedAt: "2026-09-01",
    dueAt: "2026-10-01",
    currency: "USD",
    total: "4250.00",
    balance: "4250.00",
    direction: "RECEIVABLE" as const,
    counterpartyName: "ACME Dental Supply Ltd",
  };

  it("accepts a decimal string and refuses a number", () => {
    expect(CreateMoneyDocPayload.safeParse(good).success).toBe(true);
    // The failure this prevents: 90071992547409.93 is not representable in
    // binary floating point, and the column is NUMERIC(20,6).
    expect(
      CreateMoneyDocPayload.safeParse({ ...good, total: 4250.0 }).success,
    ).toBe(false);
  });

  it("holds a figure larger than 2^53 exactly", () => {
    const big = "90071992547409.93";
    const parsed = CreateMoneyDocPayload.parse({ ...good, total: big });
    expect(parsed.total).toBe(big);
    // The point of the whole rule, stated as an assertion: the round trip a
    // JS number would have made is lossy.
    expect(String(Number(big))).not.toBe(big);
  });

  it("refuses a currency that is not ISO-4217 alpha-3", () => {
    for (const bad of ["usd", "US", "DOLLARS", "$"]) {
      expect(CreateMoneyDocPayload.safeParse({ ...good, currency: bad }).success).toBe(
        false,
      );
    }
  });
});

// ── the creator ─────────────────────────────────────────────────────────────

function txMock(created: Record<string, unknown> = { id: "doc-1", status: "DRAFT" }) {
  const create = vi.fn(async (_a: { data: Record<string, unknown> }) => created);
  const deleteMany = vi.fn(async (_a: { where: Record<string, unknown> }) => ({ count: 1 }));
  return { tx: { erpDocument: { create, deleteMany } } as never, create, deleteMany };
}

describe("🔴 createLocalDocument is the only way a local document begins", () => {
  it("writes the exact shape the provenance CHECK demands", async () => {
    const { tx, create } = txMock();
    await createLocalDocument(tx, {
      kind: "INVOICE",
      companyId: "co-1",
      documentNumber: "INV-1042",
      currency: "USD",
      total: "4250.00",
      balance: "4250.00",
      issuedAt: new Date("2026-09-01T00:00:00.000Z"),
      dueAt: new Date("2026-10-01T00:00:00.000Z"),
      counterpartyName: "ACME",
    });

    const data = create.mock.calls[0][0].data;
    expect(data.origin).toBe("LOCAL");
    expect(data.status).toBe(INITIAL_STATUS);
    // 🔴 All four NULL, and asserted individually. A LOCAL row that borrowed a
    // connection would be vendor-owned: uneditable, archive-only, overwritten
    // by the next landing tick.
    expect(data.connectionId).toBeNull();
    expect(data.externalSystem).toBeNull();
    expect(data.externalId).toBeNull();
    expect(data.vendorStatus).toBeNull();
    // The number goes to its OWN column, never to the vendor's.
    expect(data.documentNumber).toBe("INV-1042");
  });

  it("MUTATION: pass money through Number() — the figure silently changes", async () => {
    const { tx, create } = txMock();
    await createLocalDocument(tx, {
      kind: "INVOICE",
      companyId: "co-1",
      currency: "USD",
      total: "90071992547409.93",
    });
    const data = create.mock.calls[0][0].data;
    expect(data.amount).toBe("90071992547409.93");
    expect(typeof data.amount).toBe("string");
  });

  it("defaults the balance to the total, because a new invoice is wholly unpaid", async () => {
    const { tx, create } = txMock();
    await createLocalDocument(tx, {
      kind: "INVOICE",
      companyId: "co-1",
      currency: "USD",
      total: "4250.00",
    });
    // NOT null: a null balance means "unreadable" to money.service, and would
    // make a brand-new invoice count as open with no figure behind it.
    expect(create.mock.calls[0][0].data.balance).toBe("4250.00");
  });

  it("🔴 refuses a document with no customer — NEEDS_PARTY finally has a caller", async () => {
    const { tx, create } = txMock();
    await expect(
      createLocalDocument(tx, {
        kind: "INVOICE",
        companyId: "",
        currency: "USD",
        total: "1.00",
      }),
    ).rejects.toThrow(DOCUMENT_ERRORS.NEEDS_PARTY);
    // The CHECK cannot carry this (SetNull would fire inside the delete), so
    // the refusal has to happen before the write, not after it.
    expect(create).not.toHaveBeenCalled();
  });
});

describe("🔴 undo deletes a DRAFT and refuses anything further", () => {
  it("guards the delete on BOTH origin and status", async () => {
    const { tx, deleteMany } = txMock();
    const ok = await deleteDraftDocument(tx, "doc-1");
    expect(ok).toBe(true);
    // A bare delete-by-id would take a landed row (the vendor's) or a sent one
    // (somebody else has it).
    expect(deleteMany.mock.calls[0][0].where).toEqual({
      id: "doc-1",
      origin: "LOCAL",
      status: "DRAFT",
    });
  });

  it("MUTATION: report success when the guard matched nothing", async () => {
    const deleteMany = vi.fn(async () => ({ count: 0 }));
    const tx = { erpDocument: { deleteMany } } as never;
    // An invoice already SENT does not match the predicate. Undo must say it
    // did NOT take the document back, rather than claiming a deletion that
    // never happened — the WARP-2731 defect class, on money this time.
    expect(await deleteDraftDocument(tx, "doc-1")).toBe(false);
  });
});

// ── direction coherence ─────────────────────────────────────────────────────

describe("🔴 a document whose kind and direction disagree is not filed", () => {
  it("derives direction from kind, and the two must agree", () => {
    expect(directionOf("INVOICE")).toBe("RECEIVABLE");
    expect(directionOf("BILL")).toBe("PAYABLE");
    // A credit note is receivable AND negative — the case a client re-deriving
    // direction for itself gets wrong first.
    expect(directionOf("CREDIT_NOTE")).toBe("RECEIVABLE");
  });

  it("🔴 returns NULL for the kinds that are not money owed either way", () => {
    // This is the fact the apply-time guard has to be written around.
    // `KINDS_BY_DIRECTION` is an allow-list precisely so an unaccepted quote
    // never joins "what you are owed"; the cost is that `directionOf` has a
    // third answer, and a comparison that forgets it refuses a whole kind.
    expect(directionOf("QUOTE")).toBeNull();
    expect(directionOf("ORDER")).toBeNull();
  });

  it("names the refusal the apply path uses for an incoherent reading", () => {
    // Asserted here so the constant cannot be quietly renamed out from under
    // the branch that throws it.
    expect(FILING_ERRORS.PAYLOAD_UNREADABLE).toBe("proposal_payload_unreadable");
    expect(FILING_ERRORS.MONEY_MODULE_OFF).toBe("proposal_money_module_off");
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});


// ── the three apply-time refusals, driven through applyProposal ─────────────

/**
 * 🔴 THE GUARDS ABOVE ARE UNIT-TESTED; THESE ARE THE SAME GUARDS AS THEY
 * ACTUALLY FIRE.
 *
 * Everything else in this file tests `directionOf()`, `createLocalDocument()`
 * and the policy table in isolation. None of it proves the three refusals in
 * `apply.service.ts`'s `CREATE_MONEY_DOC` branch ever run — a branch that is
 * deleted, reordered, or made unreachable by an early return would leave every
 * one of those tests green (Romain, review of 2026-09-06).
 *
 * So these call `applyProposal` for real and assert the refusal AND that
 * nothing was written. The prisma double is deliberately minimal: any table
 * the branch reaches that is not stubbed here throws, which is itself a signal.
 *
 * ORDER MATTERS AND IS ASSERTED BY CONSTRUCTION. The branch checks the module
 * first, then the customer, then the direction — so each test below satisfies
 * every earlier guard, which is the only way to prove the guard under test is
 * the one that fired rather than the first one.
 */
describe("🔴 the CREATE_MONEY_DOC refusals, as they actually fire", () => {
  const BASE_PAYLOAD = {
    kind: "INVOICE" as const,
    currency: "USD",
    total: "1250.00",
    direction: "RECEIVABLE" as const,
    companyId: "11111111-1111-4111-8111-111111111111",
  };

  function harness(opts: {
    moneyEnabled: boolean;
    payload: Record<string, unknown>;
  }) {
    const erpCreate = vi.fn(async () => {
      // A sentinel: reaching here means all three refusals let this through.
      throw new Error("REACHED_CREATE");
    });
    // The proposal is CLAIMED inside the transaction, before the branch runs —
    // so the refusals below all throw with the claim already written, and the
    // rollback is what un-writes it. (The PR body used to say the no-customer
    // refusal happened "before the transaction opens"; it does not, and
    // `apply.service.ts`'s own comment says "we are inside the transaction".)
    const resultWrite = vi.fn(async () => ({}));
    const db = {
      ingestProposal: {
        findUnique: vi.fn(async () => ({
          id: "prop-1",
          status: "PENDING",
          policyClass: "REVIEW",
          kind: "CREATE_MONEY_DOC",
          confidence: 95,
          payload: opts.payload,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        update: resultWrite,
      },
      moduleSetting: {
        findUnique: vi.fn(async () => ({ moduleId: "money", enabled: opts.moneyEnabled })),
      },
      erpDocument: { create: erpCreate },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    };
    const ctx = {
      actorId: "u-owner",
      resolveFileId: vi.fn(async () => null),
    };
    return { db, ctx, erpCreate, resultWrite };
  }

  const run = (h: ReturnType<typeof harness>) =>
    applyProposal(h.db as never, "prop-1", h.ctx as never);

  it("refuses while the Money module is off, and writes nothing", async () => {
    // A write the owner cannot see is indistinguishable from one that never
    // happened — the opposite of what this feature promises.
    const h = harness({ moneyEnabled: false, payload: { ...BASE_PAYLOAD } });
    await expect(run(h)).rejects.toThrow(FILING_ERRORS.MONEY_MODULE_OFF);
    expect(h.erpCreate).not.toHaveBeenCalled();
    // The claim is written before the branch runs, so the ONLY thing that
    // un-writes it is the transaction rolling back — nothing downstream ran.
    expect(h.resultWrite).not.toHaveBeenCalled();
  });

  it("refuses a money document with no customer, with the module ON", async () => {
    // Module enabled, so this can only be the companyId guard. An invoice
    // filed against nobody is a claim on nobody.
    const { companyId: _drop, ...noParty } = BASE_PAYLOAD;
    const h = harness({ moneyEnabled: true, payload: noParty });
    await expect(run(h)).rejects.toThrow(FILING_ERRORS.CHOICE_REQUIRED);
    expect(h.erpCreate).not.toHaveBeenCalled();
    // The claim is written before the branch runs, so the ONLY thing that
    // un-writes it is the transaction rolling back — nothing downstream ran.
    expect(h.resultWrite).not.toHaveBeenCalled();
  });

  it("refuses a kind and direction that disagree, with module ON and a customer", async () => {
    // A BILL is money owed BY the business, so RECEIVABLE is a second opinion
    // that contradicts the kind. Two opinions that disagree mean the
    // extraction is incoherent — refuse rather than silently prefer one.
    const h = harness({
      moneyEnabled: true,
      payload: { ...BASE_PAYLOAD, kind: "BILL", direction: "RECEIVABLE" },
    });
    await expect(run(h)).rejects.toThrow(FILING_ERRORS.PAYLOAD_UNREADABLE);
    expect(h.erpCreate).not.toHaveBeenCalled();
    // The claim is written before the branch runs, so the ONLY thing that
    // un-writes it is the transaction rolling back — nothing downstream ran.
    expect(h.resultWrite).not.toHaveBeenCalled();
  });

  it("🔴 REGRESSION: a QUOTE is not refused for having no derived direction", async () => {
    // The bug this pins: `directionOf("QUOTE")` is null and `p.direction` is a
    // required RECEIVABLE|PAYABLE, so a bare `!==` was true for EVERY quote
    // ever extracted. Every quote card was permanently unappliable, and the
    // owner was told their perfectly good proposal was unreadable and that
    // clearing it was safe. Reaching the create is the whole assertion.
    const h = harness({
      moneyEnabled: true,
      payload: { ...BASE_PAYLOAD, kind: "QUOTE", direction: "RECEIVABLE" },
    });
    await expect(run(h)).rejects.toThrow("REACHED_CREATE");
    expect(h.erpCreate).toHaveBeenCalledTimes(1);
  });

  it("🔴 REGRESSION: nor for the other direction, because it has neither", async () => {
    // Both values, not one. A fix that special-cased QUOTE by pinning it to
    // RECEIVABLE would pass the test above and fail this one — there is no
    // direction a quote agrees with, which is exactly why the comparison must
    // not run rather than run against a chosen answer.
    const h = harness({
      moneyEnabled: true,
      payload: { ...BASE_PAYLOAD, kind: "QUOTE", direction: "PAYABLE" },
    });
    await expect(run(h)).rejects.toThrow("REACHED_CREATE");
    expect(h.erpCreate).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a kind that DOES derive a direction is still refused when they disagree", async () => {
    // The guard must be narrowed, not deleted. A CREDIT_NOTE is receivable;
    // reading one as PAYABLE is the incoherent extraction the guard exists for,
    // and a fix that dropped the comparison entirely would let it through.
    const h = harness({
      moneyEnabled: true,
      payload: { ...BASE_PAYLOAD, kind: "CREDIT_NOTE", direction: "PAYABLE" },
    });
    await expect(run(h)).rejects.toThrow(FILING_ERRORS.PAYLOAD_UNREADABLE);
    expect(h.erpCreate).not.toHaveBeenCalled();
    expect(h.resultWrite).not.toHaveBeenCalled();
  });

  it("VACUITY: a coherent payload gets past all three and reaches the write", async () => {
    // Without this, all three tests above would pass just as happily if
    // applyProposal threw on everything.
    const h = harness({ moneyEnabled: true, payload: { ...BASE_PAYLOAD } });
    await expect(run(h)).rejects.toThrow("REACHED_CREATE");
    expect(h.erpCreate).toHaveBeenCalledTimes(1);
  });

  it("MUTATION: a module row that is absent entirely still refuses", async () => {
    // `!moneyModule?.enabled` — the optional chain is load-bearing. A box that
    // has never touched the Money switch has no row at all, and reading that
    // as "not off" would file into a module the owner never turned on.
    const h = harness({ moneyEnabled: true, payload: { ...BASE_PAYLOAD } });
    h.db.moduleSetting.findUnique = vi.fn(async () => null) as never;
    await expect(run(h)).rejects.toThrow(FILING_ERRORS.MONEY_MODULE_OFF);
    expect(h.erpCreate).not.toHaveBeenCalled();
    // The claim is written before the branch runs, so the ONLY thing that
    // un-writes it is the transaction rolling back — nothing downstream ran.
    expect(h.resultWrite).not.toHaveBeenCalled();
  });
});
