/**
 * WARP-2730 (ADR-048) — the two prompts.
 *
 * They are in their own file because they are the part of this feature most
 * likely to be edited by someone who is not reading `extract.ts`, and every
 * edit here must bump `EXTRACTOR_VERSION` in `contract.ts` — the version is
 * part of a proposal's uniqueness key, so without the bump a re-extraction
 * collides with the row the previous prompt produced and silently keeps the
 * old answer.
 *
 * 🔴 NOTHING HERE IS A CONTROL. The PHI instructions below are a request, and
 * a model may decline a request. What actually stops PHI reaching the CRM is
 * the deterministic screen that runs before this prompt is ever built
 * (`phi-screen.ts`), the zod `.strict()` schemas that have nowhere to put it
 * (`contract.ts`), and the code — not the prompt — that turns
 * `role: PATIENT_RECORD` into a terminal verdict. The prompt is here to make
 * the common case cheap, not to make the dangerous case safe.
 */
import { EXTRACTOR_VERSION } from "./contract.js";

/**
 * Pass 0. One question: what IS this document, and does it carry clinical
 * content.
 *
 * Separate from extraction rather than folded into one call, because the
 * cheapest possible outcome is a refusal — a patient record must cost one
 * short classification and then stop, not a full extraction that we then throw
 * away having already sent the whole document.
 */
export const CLASSIFY_SYSTEM = `You are reading one business document that was uploaded to a small company's own file server. You do not act on it. You answer one question about it.

Reply with ONE JSON object and nothing else. No prose, no markdown fence, no explanation.

{
  "role": "INVOICE" | "QUOTE" | "CONTRACT" | "CORRESPONDENCE" | "SCAN" | "PATIENT_RECORD" | "OTHER" | "PERSONAL",
  "counterparty": "BUSINESS" | "INDIVIDUAL" | "UNKNOWN",
  "phi": { "verdict": "CLEAN" | "MENTIONS" | "RECORD", "signals": [] },
  "confidence": 0-100
}

role:
- PATIENT_RECORD when the document is ABOUT a patient's care: a chart, a treatment note, a clinical letter, a radiograph report, an insurance claim for a course of treatment.
- PERSONAL when it is not business paper at all: a payslip, a personal letter, a photo, a receipt for someone's own shopping.
- SCAN when it is clearly a scanned page whose purpose you cannot tell.

counterparty: is the other party in this document a business, or a private individual?

phi.verdict:
- CLEAN: no patient information of any kind.
- MENTIONS: a business document that happens to name patients. A dental laboratory's invoice listing case names is the usual one. The document is still a vendor invoice.
- RECORD: the document exists to record someone's care. Anything you would call a patient record.

phi.signals: zero or more of these EXACT codes, and nothing else — never quote the text you saw:
  "dob", "chart_no", "tooth_or_cdt_code", "insurance_id", "treatment_note", "rx", "clinical_image"

confidence: how sure you are of "role". 0-100.`;

/**
 * Pass 1. Only ever reached for CLEAN and MENTIONS.
 *
 * The schema in `contract.ts` is what actually holds; this text exists so the
 * model's first attempt usually satisfies it and the repair retry stays rare.
 */
export const EXTRACT_SYSTEM = `You are reading one business document belonging to a small company. Pull out only the business facts listed below, exactly as they are written in the document.

Reply with ONE JSON object and nothing else. No prose, no markdown fence, no explanation.

{
  "companies": [{ "name": "", "domain": "", "emails": [], "phones": [], "address": "", "taxId": "", "role": "customer" | "vendor" | "self" | "unknown", "confidence": 0-100, "evidence": [{ "quote": "" }] }],
  "people":    [{ "displayName": "", "email": "", "phone": "", "organization": "", "roleTitle": "", "confidence": 0-100, "evidence": [{ "quote": "" }] }],
  "projects":  [{ "name": "", "summary": "", "companyRef": "", "confidence": 0-100, "evidence": [{ "quote": "" }] }],
  "moneyDocuments": [{ "kind": "INVOICE" | "QUOTE" | "BILL" | "RECEIPT" | "CREDIT_NOTE", "number": "", "issuedAt": "YYYY-MM-DD", "dueAt": "YYYY-MM-DD", "currency": "USD", "total": "0.00", "balance": "0.00", "direction": "RECEIVABLE" | "PAYABLE", "counterpartyName": "", "confidence": 0-100, "evidence": [{ "quote": "" }] }],
  "deals":     [{ "title": "", "amount": "0.00", "currency": "USD", "companyRef": "", "confidence": 0-100, "evidence": [{ "quote": "" }] }]
}

RULES

1. Every field must come from the document. If it is not written there, leave the field out. Do not infer, complete or tidy up a name, and never guess a domain from a company name.

2. "evidence" is required for every entry: one to three SHORT VERBATIM quotes from the document, copied character for character, that show where you read it. An entry whose quotes are not found in the document is discarded.

3. Money is a STRING. "4250.00", never 4250.0 and never "$4,250.00". Currency is a three-letter ISO code in capitals. "direction" is RECEIVABLE when the company receiving this document is owed the money, PAYABLE when it owes it.

4. "role" on a company: "customer" if they buy, "vendor" if they sell, "self" if it is the company whose file server this is. An invoice names both parties — say which is which.

5. Omit every key you have no value for. Do not invent keys. Any key not listed above is discarded and counted against this extraction.

6. NEVER include a date of birth, a chart or patient number, an insurance or policy number, a procedure code, a diagnosis, a treatment note or a prescription — not in a field, not in a quote, not anywhere. If a person is named only as a patient, do not list them at all.`;

/** The user turn: the document's text, and nothing about where it came from —
 *  no path, no filename. Filenames are PHI (WARP-1983) and the model does not
 *  need one to read an invoice. */
export function buildUserTurn(text: string): string {
  return `Document text:\n\n${text}`;
}

/**
 * The one repair retry.
 *
 * Appends the zod failure verbatim. Not a second chance at the CONTENT — the
 * document text is unchanged — only at the SHAPE, which is the failure a small
 * instruction-tuned model actually makes.
 */
export function buildRepairTurn(text: string, previous: string, zodError: string): string {
  return `Document text:\n\n${text}\n\nYour previous reply could not be used. It was:\n\n${previous}\n\nIt failed validation with:\n\n${zodError}\n\nReply again with ONE corrected JSON object and nothing else.`;
}

/** Stamped on every proposal alongside the extraction. Re-exported here so a
 *  prompt edit and the version bump are visible in the same diff. */
export { EXTRACTOR_VERSION };
