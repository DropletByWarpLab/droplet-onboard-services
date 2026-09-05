/**
 * WARP-2730 (ADR-048) — the loop, on the required `node / orchestrator` leg.
 *
 * Everything here runs without Postgres and without a gateway. The subject is
 * the sequence of REFUSALS, because that is what this feature is: a pipeline
 * whose job is mostly to decide not to do things, and whose failures are all
 * silent by nature — a wrong filing looks exactly like a right one until
 * somebody opens the record.
 *
 * MUTATIONS THESE CATCH (each named again on its own test):
 *   - delete the deterministic screen's early return in `extractFromText`
 *   - delete the `role === "PATIENT_RECORD" ⇒ RECORD` line
 *   - delete the `resolveOffLanProvider` refusal
 *   - delete the repair-retry's second failure branch (swallow to a default)
 *   - delete the `role === "self"` skip in `buildDrafts`
 *   - delete the MENTIONS person-drop or the confidence cap
 *   - loosen `classify()` so a NAME match can auto-apply
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const completeOnceMock = vi.hoisted(() => vi.fn());
vi.mock("../services/llm-complete.service.js", () => ({
  completeOnce: completeOnceMock,
}));

const listModelsMock = vi.hoisted(() => vi.fn());
const chatMock = vi.hoisted(() => vi.fn());
vi.mock("../services/ai-gateway.client.js", () => ({
  listModels: listModelsMock,
  chat: chatMock,
  isTimeoutError: () => false,
}));

const resolveOffLanProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../services/cloud-access.service.js", () => ({
  resolveOffLanProvider: resolveOffLanProviderMock,
  isLocalProvider: (p: string) => p === "ollama" || p === "dmr" || p === "local",
}));

import { extractFromText, resolveFilingModel } from "../services/filing/extract.js";
import { buildDrafts, folderOf } from "../services/filing/propose.js";
import { classify, AUTO_FLOOR_LINK, MENTIONS_CONFIDENCE_CAP } from "../services/filing/policy.js";
import {
  fingerprintChunks,
  joinDeOverlapped,
  readFileContent,
  stripChunkHeader,
} from "../services/filing/read-content.js";
import { screenPath } from "../services/filing/phi-screen.js";
import { isInScope, permittedOwnerIds, readFilingSettings } from "../services/filing/settings.js";
import { parsePayload } from "../services/filing/payloads.js";
import { notSameKey } from "../services/filing/apply.service.js";
import {
  domainFromEmail,
  isPublicEmailDomain,
  type MatchOutcome,
} from "../services/filing/match.js";

const INVOICE_TEXT =
  "Invoice 1042\nACME Dental Supply Ltd\n12 Mill Road\nTotal $4,250.00 USD\nDue 2026-10-01";

const CLASSIFY_CLEAN = JSON.stringify({
  role: "INVOICE",
  counterparty: "BUSINESS",
  phi: { verdict: "CLEAN", signals: [] },
  confidence: 94,
});

const EXTRACT_ACME = JSON.stringify({
  companies: [
    {
      name: "ACME Dental Supply Ltd",
      domain: "acme-dental.example",
      role: "vendor",
      confidence: 93,
      evidence: [{ quote: "ACME Dental Supply Ltd" }],
    },
  ],
  moneyDocuments: [
    {
      kind: "INVOICE",
      number: "1042",
      currency: "USD",
      total: "4250.00",
      direction: "PAYABLE",
      counterpartyName: "ACME Dental Supply Ltd",
      confidence: 90,
      evidence: [{ quote: "Total $4,250.00" }],
    },
  ],
});

/** `completeOnce` is called once per pass. Queue the replies in order. */
function queueReplies(...contents: string[]): void {
  completeOnceMock.mockReset();
  for (const content of contents) {
    completeOnceMock.mockResolvedValueOnce({ content, model: "test-model" });
  }
  // Anything past the queue is an empty reply, which the code must treat as a
  // parse failure rather than as "nothing found".
  completeOnceMock.mockResolvedValue({ content: "", model: "test-model" });
}

const noMatch = async (): Promise<MatchOutcome> => ({ kind: "NONE" });
const PROPOSE_SETTINGS = {
  mode: "propose" as const,
  level: "links_only" as const,
  vertical: "general" as const,
};
const FILE_SOURCE = {
  sourceKind: "FILE" as const,
  sourceRef: "file:8891",
  ncFileId: 8891,
  filePath: "/Customers/acme-invoice.pdf",
  fileSpace: "files",
};

beforeEach(() => {
  completeOnceMock.mockReset();
  listModelsMock.mockReset();
  chatMock.mockReset();
  resolveOffLanProviderMock.mockReset();
  resolveOffLanProviderMock.mockResolvedValue(null);
});

describe("🔴 the deterministic screen refuses BEFORE any model is called", () => {
  it("MUTATION: delete the screen's early return — a denylisted path reaches the model", async () => {
    queueReplies(CLASSIFY_CLEAN, EXTRACT_ACME);
    const out = await extractFromText({
      model: "m",
      storedPath: "/Patients/smith-j.pdf",
      text: INVOICE_TEXT,
    });
    expect(out).toEqual({ ok: false, reason: "phi_path", detail: "path_denylist" });
    // The assertion that matters. Not "it returned a refusal" — "it never
    // asked". A refusal after the document has been sent is not a refusal.
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("refuses clinical CONTENT under a clean path, still without a model call", async () => {
    queueReplies(CLASSIFY_CLEAN, EXTRACT_ACME);
    const out = await extractFromText({
      model: "m",
      storedPath: "/Inbox/scan001.pdf",
      text: "Chart #4471. Treatment plan agreed.",
    });
    expect(out.ok).toBe(false);
    expect(completeOnceMock).not.toHaveBeenCalled();
  });
});

describe("🔴 PATIENT_RECORD is terminal, decided in code", () => {
  it("MUTATION: delete the role⇒RECORD line — a PATIENT_RECORD/CLEAN reply extracts", async () => {
    // Small instruction-tuned models really do answer this pair: they read
    // "clean" as "well-formed". The role already settled it.
    queueReplies(
      JSON.stringify({
        role: "PATIENT_RECORD",
        counterparty: "INDIVIDUAL",
        phi: { verdict: "CLEAN", signals: [] },
        confidence: 88,
      }),
      EXTRACT_ACME,
    );
    const out = await extractFromText({
      model: "m",
      storedPath: "/Inbox/letter.pdf",
      text: "Dear Dr Ellis, thank you for referring this case.",
    });
    expect(out).toMatchObject({ ok: false, reason: "phi_record" });
    // One call — the classifier — and no extraction pass.
    expect(completeOnceMock).toHaveBeenCalledTimes(1);
  });

  it("a RECORD verdict produces zero proposals", async () => {
    queueReplies(
      JSON.stringify({
        role: "CORRESPONDENCE",
        counterparty: "INDIVIDUAL",
        phi: { verdict: "RECORD", signals: ["treatment_note"] },
        confidence: 91,
      }),
    );
    const out = await extractFromText({
      model: "m",
      storedPath: "/Inbox/letter.pdf",
      text: "A letter about a referral.",
    });
    expect(out.ok).toBe(false);
  });
});

describe("🔴 unattended extraction never leaves the LAN", () => {
  it("MUTATION: delete the resolveOffLanProvider refusal — a MISLABELLED cloud model is used", async () => {
    // The case the second check exists for. `localModelIdentifiers` already
    // drops anything the catalogue calls cloud, so a plainly-labelled
    // `anthropic` entry never gets this far — it comes out `model_unreachable`
    // (no local models), which is also a refusal.
    //
    // The gap that leaves is a model the catalogue labels LOCAL while
    // `resolveOffLanProvider` — which also consults the PROVIDER_PREFIXES
    // mirror — says otherwise. That is a catalogue disagreeing with itself,
    // and a disagreement about whether a request leaves the LAN is resolved in
    // the direction of not sending it.
    listModelsMock.mockResolvedValue({
      models: [{ id: "claude-opus-5", name: "claude-opus-5", provider: "ollama" }],
    });
    resolveOffLanProviderMock.mockResolvedValue("anthropic");
    const prisma = {
      workspaceSetting: { findUnique: async () => ({ valueJson: "claude-opus-5" }) },
    } as never;

    const r = await resolveFilingModel(prisma);
    expect(r).toMatchObject({ ok: false, reason: "cloud_model_refused", detail: "anthropic" });
    expect(completeOnceMock).not.toHaveBeenCalled();
    expect(chatMock).not.toHaveBeenCalled();
  });

  it("a plainly-labelled cloud model is refused too — as 'no local model'", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "claude-opus-5", name: "claude-opus-5", provider: "anthropic" }],
    });
    const prisma = {
      workspaceSetting: { findUnique: async () => ({ valueJson: "claude-opus-5" }) },
    } as never;
    expect(await resolveFilingModel(prisma)).toMatchObject({
      ok: false,
      reason: "model_unreachable",
    });
    expect(completeOnceMock).not.toHaveBeenCalled();
  });

  it("a DEGRADED listing is unreachable, not 'no models'", async () => {
    // The stored tag would otherwise pass through unresolved and be dispatched
    // against a set we could not confirm.
    listModelsMock.mockResolvedValue({ models: [], degraded: true });
    const prisma = {
      workspaceSetting: { findUnique: async () => ({ valueJson: "llama3" }) },
    } as never;
    expect(await resolveFilingModel(prisma)).toMatchObject({
      ok: false,
      reason: "model_unreachable",
    });
  });

  it("accepts a confirmed local model", async () => {
    listModelsMock.mockResolvedValue({
      models: [{ id: "llama3:8b", name: "llama3:8b", provider: "ollama" }],
    });
    const prisma = {
      workspaceSetting: { findUnique: async () => ({ valueJson: "llama3:8b" }) },
    } as never;
    expect(await resolveFilingModel(prisma)).toEqual({ ok: true, model: "llama3:8b" });
  });
});

describe("🔴 bad JSON is a failure, never a default object", () => {
  it("MUTATION: swallow the second parse failure — a default extraction is filed", async () => {
    queueReplies("I'm sorry, I can't do that.", "Still no JSON here.");
    const out = await extractFromText({
      model: "m",
      storedPath: "/Customers/x.pdf",
      text: INVOICE_TEXT,
    });
    expect(out).toMatchObject({ ok: false, reason: "bad_json" });
    // Exactly two: the attempt and the one repair. Not three, not a loop.
    expect(completeOnceMock).toHaveBeenCalledTimes(2);
  });

  it("an EMPTY completion is a parse failure, not an empty extraction", async () => {
    // `completeOnce` resolves `{content: ""}` rather than throwing, so this is
    // the shape a wedged model actually produces.
    queueReplies("", "");
    const out = await extractFromText({
      model: "m",
      storedPath: "/Customers/x.pdf",
      text: INVOICE_TEXT,
    });
    expect(out).toMatchObject({ ok: false, reason: "bad_json" });
  });

  it("the repair retry is used, and a corrected second reply is accepted", async () => {
    queueReplies("no json", CLASSIFY_CLEAN, EXTRACT_ACME);
    const out = await extractFromText({
      model: "m",
      storedPath: "/Customers/x.pdf",
      text: INVOICE_TEXT,
    });
    expect(out.ok).toBe(true);
  });
});

describe("evidence that is not in the document takes its entity with it", () => {
  it("drops an invented company and counts it", async () => {
    queueReplies(
      CLASSIFY_CLEAN,
      JSON.stringify({
        companies: [
          {
            name: "Northgate Dental Group",
            role: "customer",
            confidence: 95,
            evidence: [{ quote: "Northgate Dental Group" }],
          },
          {
            name: "ACME Dental Supply Ltd",
            role: "vendor",
            confidence: 93,
            evidence: [{ quote: "ACME Dental Supply Ltd" }],
          },
        ],
      }),
    );
    const out = await extractFromText({
      model: "m",
      storedPath: "/Customers/acme-invoice.pdf",
      text: INVOICE_TEXT,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.entities.companies.map((c) => c.name)).toEqual(["ACME Dental Supply Ltd"]);
    expect(out.result.droppedUnverified).toBe(1);
  });
});

describe("🔴 MENTIONS — the dental-lab invoice", () => {
  const MENTIONS_CLASSIFY = JSON.stringify({
    role: "INVOICE",
    counterparty: "BUSINESS",
    phi: { verdict: "MENTIONS", signals: [] },
    confidence: 96,
  });

  it("MUTATION: delete the person-drop — patient names reach the CRM", async () => {
    const text = "Invoice 1042 from ACME Dental Lab. Case for J Smith. Total $980.00";
    queueReplies(
      MENTIONS_CLASSIFY,
      JSON.stringify({
        companies: [
          {
            name: "ACME Dental Lab",
            role: "vendor",
            confidence: 92,
            evidence: [{ quote: "ACME Dental Lab" }],
          },
        ],
        people: [
          { displayName: "J Smith", confidence: 88, evidence: [{ quote: "Case for J Smith" }] },
        ],
      }),
    );
    const out = await extractFromText({ model: "m", storedPath: "/Suppliers/lab.pdf", text });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    // The vendor and the money survive — that is the whole point of the class.
    expect(out.result.entities.companies).toHaveLength(1);
    // Every person is gone, and it is COUNTED so the card can say so.
    expect(out.result.entities.people).toEqual([]);
    expect(out.result.droppedPhi).toBeGreaterThanOrEqual(1);
    // No quote survives either — a quote from a page listing cases is the leak
    // in miniature.
    expect(out.result.entities.companies[0].evidence.every((e) => e.quote === "")).toBe(true);
  });

  it("MUTATION: delete the confidence cap — a MENTIONS document can clear an auto floor", async () => {
    const text = "Invoice from ACME Dental Lab. Total $980.00";
    queueReplies(
      MENTIONS_CLASSIFY,
      JSON.stringify({
        companies: [
          {
            name: "ACME Dental Lab",
            role: "vendor",
            confidence: 99,
            evidence: [{ quote: "ACME Dental Lab" }],
          },
        ],
      }),
    );
    const out = await extractFromText({ model: "m", storedPath: "/Suppliers/lab.pdf", text });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.confidence).toBeLessThanOrEqual(MENTIONS_CONFIDENCE_CAP);
    // The cap is only meaningful relative to the floor — assert the relation,
    // not the number, so moving either one cannot silently open the gate.
    expect(MENTIONS_CONFIDENCE_CAP).toBeLessThan(AUTO_FLOOR_LINK);
  });
});

describe("drafts: canned JSON to exact rows", () => {
  it("a new company becomes ONE CREATE_CUSTOMER carrying the file", async () => {
    const { drafts } = await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: noMatch,
      entities: {
        companies: [
          {
            name: "ACME Dental Supply Ltd",
            domain: "acme-dental.example",
            emails: [],
            phones: [],
            role: "vendor",
            confidence: 93,
            evidence: [{ quote: "ACME Dental Supply Ltd" }],
          },
        ],
        people: [],
        projects: [],
        moneyDocuments: [],
        deals: [],
      },
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: "CREATE_CUSTOMER",
      dedupeKey: "acme dental supply",
      confidence: 93,
      matchKind: "NONE",
      policyClass: "REVIEW",
    });
    expect(drafts[0].payload).toMatchObject({
      name: "ACME Dental Supply Ltd",
      file: { ncFileId: 8891, filePath: "/Customers/acme-invoice.pdf", fileSpace: "files" },
    });
    // Every draft satisfies its own kind's allow-list on the way in.
    expect(parsePayload("CREATE_CUSTOMER", drafts[0].payload)).not.toBeNull();
  });

  it("a matched company becomes a LINK_FILE keyed on the company id", async () => {
    const { drafts } = await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: async () => ({
        kind: "MATCH",
        matchKind: "DOMAIN",
        matchedValue: "acme-dental.example",
        companyId: "11111111-1111-4111-8111-111111111111",
        companyName: "ACME Dental Supply Ltd",
        taught: false,
      }),
      entities: {
        companies: [
          {
            name: "ACME Dental Supply Ltd",
            emails: [],
            phones: [],
            role: "vendor",
            confidence: 91,
            evidence: [{ quote: "ACME" }],
          },
        ],
        people: [],
        projects: [],
        moneyDocuments: [],
        deals: [],
      },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: "LINK_FILE",
      dedupeKey: "11111111-1111-4111-8111-111111111111",
      matchKind: "DOMAIN",
    });
    // 🔴 MUTATION: drop `matchedKey` from the payload — "Not this customer"
    // then has only the dedupe key to write a rule against, which for a
    // LINK_FILE is a company UUID. The rule would match nothing the matcher
    // ever looks up, so the correction silently never takes effect and the
    // same wrong suggestion comes back tomorrow.
    expect(drafts[0].payload).toMatchObject({
      matchedKeyKind: "EMAIL_DOMAIN",
      matchedKeyValue: "acme-dental.example",
    });
    expect(notSameKey("LINK_FILE", drafts[0].payload as never)).toEqual({
      keyKind: "EMAIL_DOMAIN",
      keyValue: "acme-dental.example",
    });
  });

  it("a CREATE_CUSTOMER teaches against the name the DOCUMENT used", () => {
    // It matched nothing by definition, so there is no carried key — and the
    // name is exactly what the matcher's NAME key looks up.
    expect(
      notSameKey("CREATE_CUSTOMER", { name: "ACME Dental Supply Ltd" } as never),
    ).toEqual({ keyKind: "NAME", keyValue: "acme dental supply" });
  });

  it("a payload with nothing usable teaches no rule at all", () => {
    // The rejection still holds; the RULE does not get written. A rule that
    // matches nothing is one the owner finds on the Rules page later and
    // cannot explain.
    expect(notSameKey("CREATE_PROJECT", { name: "Fitout" } as never)).toBeNull();
  });

  it("MUTATION: delete the role==='self' skip — the box files itself as a customer", async () => {
    const { drafts } = await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: noMatch,
      entities: {
        companies: [
          {
            name: "Northgate Dental",
            emails: [],
            phones: [],
            role: "self",
            confidence: 97,
            evidence: [{ quote: "Northgate Dental" }],
          },
        ],
        people: [],
        projects: [],
        moneyDocuments: [],
        deals: [],
      },
    });
    expect(drafts).toEqual([]);
  });

  it("an IGNORED source produces nothing and says so", async () => {
    const { drafts, ignored } = await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: async () => ({ kind: "IGNORED", reason: "nc_folder:/junk" }),
      entities: {
        companies: [
          {
            name: "Whoever",
            emails: [],
            phones: [],
            role: "vendor",
            confidence: 90,
            evidence: [{ quote: "Whoever" }],
          },
        ],
        people: [],
        projects: [],
        moneyDocuments: [],
        deals: [],
      },
    });
    expect(drafts).toEqual([]);
    expect(ignored).toBe(true);
  });

  it("a money document is proposed but classed NEVER", async () => {
    const { drafts } = await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: noMatch,
      entities: {
        companies: [],
        people: [],
        projects: [],
        deals: [],
        moneyDocuments: [
          {
            kind: "INVOICE",
            number: "1042",
            currency: "USD",
            total: "4250.00",
            direction: "PAYABLE",
            confidence: 90,
            evidence: [{ quote: "Total $4,250.00" }],
          },
        ],
      },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: "CREATE_MONEY_DOC",
      policyClass: "NEVER",
      dedupeKey: "INVOICE:1042:USD:4250.00",
    });
    // Money is a string all the way to the payload. `Number()` rounds above
    // 2^53 and the column is NUMERIC(20,6).
    expect((drafts[0].payload as { total: unknown }).total).toBe("4250.00");
  });
});

describe("🔴 the policy table", () => {
  const base = {
    mode: "auto" as const,
    level: "also_create" as const,
    vertical: "general" as const,
    phiVerdict: "CLEAN" as const,
    confidence: 99,
    matchKind: "DOMAIN" as const,
  };

  it("MUTATION: let a NAME match auto-apply — a lookalike customer gets the file", () => {
    expect(classify({ ...base, kind: "LINK_FILE", matchKind: "NAME" }).policyClass).toBe("REVIEW");
  });

  it("MUTATION: delete CREATE_CONTACT's own branch — the reason stops being about people", () => {
    // The class alone does NOT catch this mutation, and that is worth knowing:
    // with the branch gone, CREATE_CONTACT falls through every later test and
    // lands on the closing REVIEW, so the class is unchanged. What changes is
    // the REASON on the card — from a sentence about people to a generic "ask
    // me first" — and the reason is not decoration: it is what tells the owner
    // this one is never automatic, no matter what else they turn on.
    for (const vertical of ["general", "healthcare"] as const) {
      for (const level of ["links_only", "also_create"] as const) {
        const v = classify({ ...base, kind: "CREATE_CONTACT", vertical, level });
        expect(v.policyClass).toBe("REVIEW");
        expect(v.policyReason).toBe("New people are always added by you, never automatically.");
      }
    }
  });

  it("CREATE_MONEY_DOC is NEVER, in every mode", () => {
    for (const mode of ["off", "propose", "auto"] as const) {
      expect(classify({ ...base, kind: "CREATE_MONEY_DOC", mode }).policyClass).toBe("NEVER");
    }
  });

  it("propose mode never returns AUTO for anything", () => {
    const kinds = [
      "LINK_FILE",
      "LOG_EMAIL_ACTIVITY",
      "SET_PROJECT_CUSTOMER",
      "CREATE_CUSTOMER",
      "CREATE_PROJECT",
      "CREATE_CONTACT",
      "MATCH_REVIEW",
      "CREATE_MONEY_DOC",
    ] as const;
    for (const kind of kinds) {
      expect(classify({ ...base, kind, mode: "propose" }).policyClass).not.toBe("AUTO");
    }
  });

  it("a healthcare box never creates unattended", () => {
    expect(
      classify({ ...base, kind: "CREATE_CUSTOMER", vertical: "healthcare" }).policyClass,
    ).toBe("REVIEW");
  });

  it("every REVIEW carries a reason a person can read", () => {
    const v = classify({ ...base, kind: "LINK_FILE", mode: "propose" });
    expect(v.policyReason).toBeTruthy();
    // ADR-002 voice: file, customer, look, undo — never the machine's words.
    expect(v.policyReason).not.toMatch(/proposal|extraction|entity|confidence/i);
  });
});

describe("reading content back out of the index", () => {
  it("strips the WARP-435 header, which carries the filename", () => {
    expect(stripChunkHeader("Document: J Smith perio chart.pdf / Section: A\n\nHello")).toBe(
      "Hello",
    );
    expect(stripChunkHeader("Total $4,250.00")).toBe("Total $4,250.00");
  });

  it("de-overlaps the 20% the chunker shares between chunks", () => {
    const a = "Invoice 1042 from ACME Dental Supply Ltd for consumables delivered in March.";
    const b = "for consumables delivered in March. Total $4,250.00 USD due 2026-10-01.";
    const joined = joinDeOverlapped(a, b);
    // The shared sentence appears once. Twice is what makes a model emit two
    // money documents for one invoice.
    expect(joined.match(/consumables/g)).toHaveLength(1);
    expect(joined).toContain("Total $4,250.00");
  });

  it("tolerates a reflowed line break in the overlap", () => {
    const a = "…for consumables delivered in March and April of this year.";
    const b = "for consumables delivered in March\nand April of this year. Total $10.00";
    expect(joinDeOverlapped(a, b).match(/consumables/g)).toHaveLength(1);
  });

  it("the fingerprint changes with content and not with chunk count alone", () => {
    expect(fingerprintChunks(["a", "b"])).toBe(fingerprintChunks(["a", "b"]));
    expect(fingerprintChunks(["a", "b"])).not.toBe(fingerprintChunks(["a", "c"]));
    expect(fingerprintChunks(["a", "b"])).not.toBe(fingerprintChunks(["a", "x", "b"]));
  });
});

describe("🔴 the settings row fails closed", () => {
  it("a missing row is OFF, and does not create itself", async () => {
    // A settings row that appears because something READ it is a consent
    // record nobody gave.
    const findUnique = vi.fn().mockResolvedValue(null);
    const prisma = { autoFilingSetting: { findUnique } } as never;
    const s = await readFilingSettings(prisma);
    expect(s.mode).toBe("off");
    expect(s.enabledById).toBeNull();
  });

  it("MUTATION: an emptied denylist disables the layer instead of restoring defaults", async () => {
    // "I cleared the box" must not silently mean "look in Patients/".
    const prisma = {
      autoFilingSetting: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "propose",
          level: "links_only",
          vertical: "general",
          enabledById: "u-owner",
          enabledAt: new Date(),
          folders: [],
          pathDenylist: [],
          hourlyApplyCap: 50,
          dailyCreateCap: 10,
        }),
      },
    } as never;
    const s = await readFilingSettings(prisma);
    expect(s.pathDenylist).toContain("patient");
    expect(screenPath("/Patients/x.pdf", s.pathDenylist).blocked).toBe(true);
  });

  it("a Json column holding something else is treated as absent, never as a wildcard", async () => {
    const prisma = {
      autoFilingSetting: {
        findUnique: vi.fn().mockResolvedValue({
          mode: "propose",
          level: "links_only",
          vertical: "general",
          enabledById: "u-owner",
          enabledAt: new Date(),
          folders: "everything",
          pathDenylist: 42,
          hourlyApplyCap: 50,
          dailyCreateCap: 10,
        }),
      },
    } as never;
    const s = await readFilingSettings(prisma);
    expect(s.folders).toEqual([]);
    expect(s.pathDenylist).toContain("patient");
  });

  it("no enabling owner means no permitted readers — not every reader", async () => {
    const prisma = { user: { findUnique: vi.fn() } } as never;
    expect(
      await permittedOwnerIds(prisma, {
        mode: "propose",
        level: "links_only",
        vertical: "general",
        enabledById: null,
        enabledAt: null,
        folders: [],
        pathDenylist: [],
        hourlyApplyCap: 0,
        dailyCreateCap: 0,
      }),
    ).toEqual([]);
  });

  it("the owner's own space plus the household share, and nothing else", async () => {
    const prisma = {
      user: { findUnique: vi.fn().mockResolvedValue({ username: "stefan" }) },
    } as never;
    expect(
      await permittedOwnerIds(prisma, {
        mode: "propose",
        level: "links_only",
        vertical: "general",
        enabledById: "u-owner",
        enabledAt: new Date(),
        folders: [],
        pathDenylist: [],
        hourlyApplyCap: 0,
        dailyCreateCap: 0,
      }),
    ).toEqual(["stefan", "__household__"]);
  });
});

describe("🔴 the chunk reader is scoped", () => {
  it("MUTATION: an empty owner list reads EVERY owner's chunks", async () => {
    // The ncFileId-keyed read escapes `resolveChunkOwnerIds`. A filter that
    // degrades to "no filter" when it cannot work one out is how an
    // authorization bug ships looking like a convenience.
    const queryRaw = vi.fn();
    const prisma = { $queryRaw: queryRaw } as never;
    const r = await readFileContent(prisma, 8891, []);
    expect(r).toEqual({ ok: false, reason: "no_text" });
    // The assertion that matters: it did not ASK.
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it("refuses a document whose chunks are encrypted rather than guessing", async () => {
    const prisma = {
      $queryRaw: vi.fn().mockResolvedValue([{ text: "dcv1:...", sensitivity: "sensitive" }]),
    } as never;
    expect(await readFileContent(prisma, 8891, ["stefan"])).toEqual({
      ok: false,
      reason: "encrypted_content",
    });
  });

  it("an indexed file with no readable body is `no_text`, not a failure", async () => {
    const prisma = { $queryRaw: vi.fn().mockResolvedValue([]) } as never;
    expect(await readFileContent(prisma, 8891, ["stefan"])).toEqual({
      ok: false,
      reason: "no_text",
    });
  });
});

describe("🔴 free mail providers are never a match key", () => {
  it("recognises a provider under any of its TLDs", () => {
    for (const d of ["gmail.com", "gmx.net", "gmx.com", "proton.me", "yahoo.co.uk"]) {
      expect(isPublicEmailDomain(d), d).toBe(true);
    }
  });

  it("MUTATION: read the FIRST label — a business at mail.acme.example is refused", () => {
    // `mail` IS a free provider's label. Reading the first label instead of
    // the one before the suffix would classify this business's own mail domain
    // as public and silently stop it ever matching by domain.
    expect(isPublicEmailDomain("mail.acme.example")).toBe(false);
    expect(isPublicEmailDomain("mail.northgate.example")).toBe(false);
  });

  it("leaves ordinary business domains alone", () => {
    for (const d of ["acme-dental.example", "northgate.example", "warp-lab.example"]) {
      expect(isPublicEmailDomain(d), d).toBe(false);
    }
  });

  it("a bare label or nothing is not a provider", () => {
    expect(isPublicEmailDomain(null)).toBe(false);
    expect(isPublicEmailDomain("gmail")).toBe(false);
  });

  it("a free-provider sender never becomes a DOMAIN match key", async () => {
    // The end-to-end consequence: two unrelated private customers sharing a
    // free provider must not resolve to one company.
    const seen: string[] = [];
    await buildDrafts({
      source: FILE_SOURCE,
      phiVerdict: "CLEAN",
      settings: PROPOSE_SETTINGS,
      resolveMatch: async (input) => {
        seen.push(...(input.emails ?? []));
        return { kind: "NONE" };
      },
      entities: {
        companies: [
          {
            name: "A Person",
            emails: ["someone@gmail.com"],
            phones: [],
            role: "customer",
            confidence: 90,
            evidence: [{ quote: "A Person" }],
          },
        ],
        people: [],
        projects: [],
        moneyDocuments: [],
        deals: [],
      },
    });
    // The matcher is still given the address — an EMAIL key is exact and safe.
    // What it must not do is derive a DOMAIN key from it, which `matchCompany`
    // filters with `isPublicEmailDomain`.
    expect(seen).toEqual(["someone@gmail.com"]);
    expect(domainFromEmail("someone@gmail.com")).toBe("gmail.com");
    expect(isPublicEmailDomain(domainFromEmail("someone@gmail.com"))).toBe(true);
  });
});

describe("the folder fence", () => {
  it("matches on a folder boundary, never a prefix", () => {
    expect(isInScope("/Customers/acme.pdf", ["/Customers"])).toBe(true);
    expect(isInScope("/CustomersOld/acme.pdf", ["/Customers"])).toBe(false);
    expect(isInScope("/customers/acme.pdf", ["/Customers"])).toBe(true);
  });

  it("an empty list means everything the owner can see", () => {
    expect(isInScope("/anywhere/x.pdf", [])).toBe(true);
  });

  it("folderOf never returns the filename", () => {
    expect(folderOf(FILE_SOURCE)).toBe("/Customers");
  });
});
