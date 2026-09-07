/**
 * WARP-2730 (ADR-048) — the PHI screen and the extraction contract.
 *
 * These are the two layers that can refuse a document, and the reason they are
 * tested this hard is asymmetry: a false SKIP is one line in the Skipped tab
 * that an owner re-opens; a false PASS puts a patient's name in the CRM.
 *
 * The dental-lab invoice case is the one worth reading. It is the document a
 * practice actually receives every week — a legitimate vendor bill that happens
 * to list patient case names — and the design's whole MENTIONS class exists for
 * it. Refusing it wholesale loses the vendor and the money; extracting it
 * naively leaks names. The tests below pin the middle path.
 *
 * MUTATIONS THESE CATCH:
 *   - delete any TEXT_PATTERNS entry → its test goes red
 *   - drop a term from DEFAULT_PATH_DENYLIST → red
 *   - loosen `.strict()` on any schema → the smuggling tests go red
 *   - add a `dob`/`chart` field to any entity → the absence test goes red
 *   - weaken verifyEvidence to accept a paraphrase → red
 */
import { describe, it, expect } from "vitest";

import {
  DEFAULT_PATH_DENYLIST,
  screenPath,
  screenText,
  screenSource,
  screenPersistedString,
} from "../services/filing/phi-screen.js";
import {
  ClassifyOut,
  CompanyEntity,
  ExtractOut,
  PersonEntity,
  verifyEvidence,
} from "../services/filing/contract.js";
import { extractJson } from "../services/llm-json.js";

describe("the path denylist refuses before a model is ever called", () => {
  it.each([
    "/Patients/smith-j.pdf",
    "/Clinical/2026/notes.docx",
    "/Charts/4471.pdf",
    "/Xrays/pano.jpg",
    "/Insurance-Claims/aetna.pdf",
    "/Perio/chart.pdf",
  ])("blocks %s", (p) => {
    expect(screenPath(p).blocked).toBe(true);
    expect(screenPath(p).signals).toEqual(["path_denylist"]);
  });

  it.each([
    "/Customers/acme-invoice.pdf",
    "/Invoices/2026-04.pdf",
    "/Contracts/northgate-msa.pdf",
    "/Suppliers/dental-lab-statement.pdf",
  ])("allows %s", (p) => {
    expect(screenPath(p).blocked).toBe(false);
  });

  it("matches case-insensitively and anywhere in the path", () => {
    expect(screenPath("/Shared/PATIENT records/x.pdf").blocked).toBe(true);
  });

  it("honours an owner-supplied denylist", () => {
    expect(screenPath("/Vault/x.pdf", ["vault"]).blocked).toBe(true);
    // and an empty list disables the layer rather than blocking everything
    expect(screenPath("/Patients/x.pdf", []).blocked).toBe(false);
  });

  it("ignores blank terms rather than matching every path", () => {
    // A blank entry in an owner's list would otherwise `includes("")` → true
    // for every path, silently disabling filing entirely.
    expect(screenPath("/Customers/acme.pdf", ["", "   "]).blocked).toBe(false);
  });
});

describe("the text screen catches clinical content, and leaves business paper alone", () => {
  it.each([
    ["dob", "Patient DOB: 12/03/1984"],
    ["dob", "Date of Birth 1984-03-12"],
    ["chart_no", "Chart #4471"],
    ["chart_no", "MRN 99312"],
    ["tooth_or_cdt_code", "Procedure D2740 completed"],
    ["tooth_or_cdt_code", "tooth #14 restored"],
    ["insurance_id", "Member ID: XZ-99312"],
    ["treatment_note", "Chief complaint: pain on biting"],
    ["treatment_note", "Treatment plan agreed"],
    ["rx", "Rx: amoxicillin 500mg"],
    ["clinical_image", "bitewing taken 4 Mar"],
  ])("flags %s in %j", (signal, text) => {
    const r = screenText(text);
    expect(r.blocked).toBe(true);
    expect(r.signals).toContain(signal);
  });

  it.each([
    "Invoice 1042. Total $4,250.00 USD due 2026-10-01. ACME Dental Supply Ltd.",
    "Quote for 12 chairs, delivery 6 weeks, net 30.",
    "Master services agreement between Northgate Dental and Warp Lab.",
    "Purchase order PO-88213 for consumables, group 4 pricing.",
  ])("leaves ordinary business paper alone: %j", (text) => {
    expect(screenText(text).blocked).toBe(false);
  });

  it("does not fire on a bare date or a bare number", () => {
    // The patterns are anchored to a nearby LABEL on purpose: an invoice number
    // is digits and a due date is a date, and matching those shapes bare would
    // refuse every invoice the feature exists to file.
    expect(screenText("Issued 2026-03-12, due 2026-04-12. Ref 4471.").blocked).toBe(false);
  });

  it("reports every distinct signal, not just the first", () => {
    const r = screenText("DOB: 12/03/1984. Chart #4471. Rx: ibuprofen.");
    expect(r.signals.length).toBeGreaterThanOrEqual(3);
  });

  it("never returns the matched text — codes only", () => {
    const r = screenText("Patient DOB: 12/03/1984");
    expect(JSON.stringify(r)).not.toContain("1984");
  });
});

describe("screenSource runs the cheap layer first", () => {
  it("blocks on path without needing text at all", () => {
    expect(screenSource({ storedPath: "/Patients/x.pdf" }).blocked).toBe(true);
  });

  it("passes a clean business document", () => {
    expect(
      screenSource({ storedPath: "/Customers/acme.pdf", text: "Invoice 1042, $4,250.00" })
        .blocked,
    ).toBe(false);
  });

  it("blocks a clean-pathed document whose CONTENT is clinical", () => {
    expect(
      screenSource({ storedPath: "/Inbox/scan001.pdf", text: "Chart #4471, tooth #14" })
        .blocked,
    ).toBe(true);
  });
});

describe("the output post-filter drops a field rather than the document", () => {
  it("keeps a clean company name", () => {
    expect(screenPersistedString("ACME Dental Supply Ltd")).toBe("ACME Dental Supply Ltd");
  });

  it("drops a quote that carries a chart number", () => {
    expect(screenPersistedString("Case for chart #4471")).toBeNull();
  });
});

describe("🔴 the extraction contract has nowhere to put PHI", () => {
  it("has no dob/chart/insurance/treatment field on ANY entity", () => {
    // The structural control. A prompt saying "don't include patient data" is a
    // request; a schema with no such key is a control. Read off the shapes so a
    // field added later is caught rather than listed and forgotten.
    const shapes = {
      company: Object.keys(CompanyEntity.shape),
      person: Object.keys(PersonEntity.shape),
    };
    const forbidden =
      /dob|birth|chart|mrn|insur|policy|member|diagnos|treatment|prescription|rx|tooth|cdt/i;
    for (const [entity, keys] of Object.entries(shapes)) {
      for (const k of keys) {
        expect(forbidden.test(k), `${entity}.${k} looks like a PHI field`).toBe(false);
      }
    }
  });

  it("refuses to carry an unknown key rather than silently dropping it", () => {
    const r = PersonEntity.safeParse({
      displayName: "A Patient",
      dob: "1984-03-12",
      confidence: 90,
      evidence: [{ quote: "x" }],
    });
    expect(r.success).toBe(false);
  });

  it("refuses money as a number", () => {
    const r = ExtractOut.safeParse({
      moneyDocuments: [
        {
          kind: "INVOICE",
          currency: "USD",
          total: 4250.0,
          direction: "RECEIVABLE",
          confidence: 90,
          evidence: [{ quote: "x" }],
        },
      ],
    });
    expect(r.success).toBe(false);
  });

  it("accepts money as a decimal string", () => {
    const r = ExtractOut.safeParse({
      moneyDocuments: [
        {
          kind: "INVOICE",
          currency: "USD",
          total: "4250.00",
          direction: "RECEIVABLE",
          confidence: 90,
          evidence: [{ quote: "Total $4,250.00" }],
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("refuses an out-of-range confidence", () => {
    expect(ClassifyOut.safeParse({
      role: "INVOICE",
      counterparty: "BUSINESS",
      phi: { verdict: "CLEAN", signals: [] },
      confidence: 101,
    }).success).toBe(false);
  });

  it("refuses a currency that is not ISO-4217 alpha-3", () => {
    const money = {
      kind: "INVOICE",
      total: "10.00",
      direction: "RECEIVABLE",
      confidence: 90,
      evidence: [{ quote: "x" }],
    };
    expect(ExtractOut.safeParse({ moneyDocuments: [{ ...money, currency: "dollars" }] })
      .success).toBe(false);
    expect(ExtractOut.safeParse({ moneyDocuments: [{ ...money, currency: "usd" }] })
      .success).toBe(false);
  });

  it("refuses a free-text PHI signal — codes only", () => {
    const r = ClassifyOut.safeParse({
      role: "PATIENT_RECORD",
      counterparty: "INDIVIDUAL",
      phi: { verdict: "RECORD", signals: ["saw 'DOB: 12/03/1984' on page 2"] },
      confidence: 95,
    });
    expect(r.success).toBe(false);
  });
});

describe("evidence verification is the cheapest hallucination guard", () => {
  const text = "Invoice 1042 from ACME Dental Supply Ltd. Total $4,250.00 USD.";

  it("keeps an entity whose quote really occurs", () => {
    const { kept, droppedUnverified } = verifyEvidence(
      [{ evidence: [{ quote: "ACME Dental Supply Ltd" }] }],
      text,
    );
    expect(kept).toHaveLength(1);
    expect(droppedUnverified).toBe(0);
  });

  it("drops an entity whose quote was invented", () => {
    const { kept, droppedUnverified } = verifyEvidence(
      [{ evidence: [{ quote: "Northgate Dental Group" }] }],
      text,
    );
    expect(kept).toHaveLength(0);
    expect(droppedUnverified).toBe(1);
  });

  it("drops an entity with no evidence at all", () => {
    // Not a pass-through: an entity arriving with no evidence is the exact
    // shape a fabrication takes, and the prompt asks for evidence.
    const { kept } = verifyEvidence([{ evidence: [] }], text);
    expect(kept).toHaveLength(0);
  });

  it("tolerates reflowed whitespace and case, but not a paraphrase", () => {
    expect(
      verifyEvidence([{ evidence: [{ quote: "acme   dental\nsupply ltd" }] }], text).kept,
    ).toHaveLength(1);
    expect(
      verifyEvidence([{ evidence: [{ quote: "ACME Dental Supplies Limited" }] }], text).kept,
    ).toHaveLength(0);
  });

  it("drops the whole entity when ANY of its quotes fails", () => {
    const { kept } = verifyEvidence(
      [{ evidence: [{ quote: "Invoice 1042" }, { quote: "invented" }] }],
      text,
    );
    expect(kept).toHaveLength(0);
  });
});

describe("extractJson recovers one object, or says it cannot", () => {
  it("reads a bare object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("reads a fenced object with prose around it", () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```\nHope that helps'))
      .toEqual({ a: 1 });
  });

  it("is not fooled by a brace inside a string", () => {
    expect(extractJson('{"a":"}"}')).toEqual({ a: "}" });
  });

  it("returns null on prose with no object — never a partial", () => {
    expect(extractJson("I could not read that document.")).toBeNull();
    expect(extractJson('{"a":')).toBeNull();
  });
});
