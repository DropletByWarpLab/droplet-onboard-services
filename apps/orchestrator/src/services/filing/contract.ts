/**
 * WARP-2730 (ADR-048) — the extraction contract, layer 3 of the PHI design.
 *
 * 🔴 THE ALLOW-LISTS ARE THE CONTROL, NOT THE PROMPT.
 *
 * Every schema here is `.strict()`, and there is no `dob`, `chart`, `mrn`,
 * `insurance`, `policy`, `diagnosis` or `treatment` field ANYWHERE in any of
 * them. That is deliberate and it is the difference between a rule and a
 * control: a prompt saying "do not include patient information" is a request
 * the model may decline; a schema with nowhere to put it means a model that
 * tries has its extra keys dropped at the parse boundary and counted.
 *
 * `.strict()` rather than `.strip()` for the same reason WARP-2549's landing
 * code uses `.strict()` bodies — a silently-dropped key is a silently-changed
 * meaning. Here we want the drop, but we want it VISIBLE, so the caller reads
 * `droppedKeys` off the failure and records it.
 *
 * Money is a string at every boundary (`ErpDocument` NUMERIC(20,6), and
 * `Number()` rounds above 2^53). There is no numeric money type in this file.
 */
import { z } from "zod";

/** Bounded so a runaway generation cannot become a 10 MB payload row. */
const shortText = z.string().trim().min(1).max(200);
const mediumText = z.string().trim().min(1).max(1000);

/** A decimal as a STRING. Never a JS number — see the header. */
const decimalString = z
  .string()
  .trim()
  .regex(/^-?\d{1,15}(\.\d{1,6})?$/, "money must be a plain decimal string");

const currency = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/, "currency must be ISO-4217 alpha-3");

const isoDate = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

const confidence = z.number().int().min(0).max(100);

/**
 * Evidence for one extracted field: a verbatim quote, and where it came from.
 *
 * The quote is VERIFIED against the source text by the caller before anything
 * is persisted — an entity whose quote is not a real substring is dropped and
 * counted (`droppedUnverified`). It is the cheapest hallucination guard
 * available here and it doubles as a second PHI pass, because a quote that
 * trips the screen takes its entity down with it.
 */
export const EvidenceSchema = z
  .object({
    quote: z.string().trim().min(1).max(200),
    chunkIdx: z.number().int().min(0).optional(),
  })
  .strict();

// ─────────────────────────── pass 0: classify ───────────────────────────

export const DocumentRole = z.enum([
  "INVOICE",
  "QUOTE",
  "CONTRACT",
  "CORRESPONDENCE",
  "SCAN",
  "PATIENT_RECORD",
  "OTHER",
  "PERSONAL",
]);
export type DocumentRole = z.infer<typeof DocumentRole>;

export const PhiVerdictSchema = z.enum(["CLEAN", "MENTIONS", "RECORD"]);
export type PhiVerdictValue = z.infer<typeof PhiVerdictSchema>;

/**
 * Signal CODES the classifier may report. Mirrors `PhiSignal` in phi-screen.ts
 * and is closed for the same reason: a free-text signal is where a quote of the
 * offending line would end up.
 */
export const PhiSignalCode = z.enum([
  "dob",
  "chart_no",
  "tooth_or_cdt_code",
  "insurance_id",
  "treatment_note",
  "rx",
  "clinical_image",
]);

export const ClassifyOut = z
  .object({
    role: DocumentRole,
    counterparty: z.enum(["BUSINESS", "INDIVIDUAL", "UNKNOWN"]),
    phi: z
      .object({
        verdict: PhiVerdictSchema,
        signals: z.array(PhiSignalCode).max(8).default([]),
      })
      .strict(),
    confidence,
  })
  .strict();
export type ClassifyOut = z.infer<typeof ClassifyOut>;

// ─────────────────────────── pass 1: extract ───────────────────────────

const entityBase = { confidence, evidence: z.array(EvidenceSchema).max(3).default([]) };

/**
 * An organisation. `role` distinguishes the party the document is FROM, the
 * party it is TO, and the box's own business — `self` is dropped by the caller,
 * because an invoice names both parties and creating a customer record for
 * yourself is the most obvious wrong filing there is.
 */
export const CompanyEntity = z
  .object({
    name: shortText,
    domain: z.string().trim().max(253).optional(),
    emails: z.array(z.string().trim().email().max(320)).max(5).default([]),
    phones: z.array(z.string().trim().max(40)).max(5).default([]),
    address: mediumText.optional(),
    taxId: z.string().trim().max(64).optional(),
    role: z.enum(["customer", "vendor", "self", "unknown"]),
    ...entityBase,
  })
  .strict();

/**
 * A person.
 *
 * NOTE WHAT IS ABSENT: no date of birth, no identifier of any kind, no note
 * field. A person entity can never become a `Contact` automatically (the policy
 * table makes `CREATE_CONTACT` review-only in every mode), and on a MENTIONS
 * verdict every person entity is dropped outright before it is persisted.
 */
export const PersonEntity = z
  .object({
    displayName: shortText,
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    organization: shortText.optional(),
    roleTitle: shortText.optional(),
    ...entityBase,
  })
  .strict();

export const ProjectEntity = z
  .object({
    name: shortText,
    summary: mediumText.optional(),
    companyRef: shortText.optional(),
    ...entityBase,
  })
  .strict();

export const MoneyDocumentEntity = z
  .object({
    kind: z.enum(["INVOICE", "QUOTE", "BILL", "RECEIPT", "CREDIT_NOTE"]),
    number: z.string().trim().max(64).optional(),
    issuedAt: isoDate.optional(),
    dueAt: isoDate.optional(),
    currency,
    total: decimalString,
    balance: decimalString.optional(),
    direction: z.enum(["RECEIVABLE", "PAYABLE"]),
    counterpartyName: shortText.optional(),
    ...entityBase,
  })
  .strict();

export const DealEntity = z
  .object({
    title: shortText,
    amount: decimalString.optional(),
    currency: currency.optional(),
    companyRef: shortText.optional(),
    ...entityBase,
  })
  .strict();

export const ExtractOut = z
  .object({
    companies: z.array(CompanyEntity).max(5).default([]),
    people: z.array(PersonEntity).max(5).default([]),
    projects: z.array(ProjectEntity).max(3).default([]),
    moneyDocuments: z.array(MoneyDocumentEntity).max(3).default([]),
    deals: z.array(DealEntity).max(3).default([]),
  })
  .strict();
export type ExtractOut = z.infer<typeof ExtractOut>;

/**
 * The extractor version stamped on every proposal.
 *
 * Part of the proposal's uniqueness key, so bumping it is what makes a
 * re-extraction able to propose again rather than colliding with the row from
 * the previous generation. Bump it whenever a prompt or a schema in this file
 * changes in a way that would produce different output — the same discipline
 * `EXTRACTOR_CAPABILITY` uses on the Python side.
 */
export const EXTRACTOR_VERSION = "filing-1";

/**
 * Verify every quote is a real substring of what we actually sent, and drop the
 * entities whose evidence does not hold up.
 *
 * Normalised on whitespace and case, because a model reflowing a line break is
 * not a hallucination and refusing it would make the guard useless. Anything
 * beyond that — a paraphrase, an invented figure — fails.
 */
export function verifyEvidence<T extends { evidence: { quote: string }[] }>(
  entities: T[],
  sourceText: string,
): { kept: T[]; droppedUnverified: number } {
  const hay = sourceText.replace(/\s+/g, " ").toLowerCase();
  const kept: T[] = [];
  let dropped = 0;
  for (const e of entities) {
    // No evidence at all is not a pass: the prompt asks for it, and an entity
    // that arrives without any is exactly the shape a fabrication takes.
    const ok =
      e.evidence.length > 0 &&
      e.evidence.every((ev) => hay.includes(ev.quote.replace(/\s+/g, " ").toLowerCase()));
    if (ok) kept.push(e);
    else dropped += 1;
  }
  return { kept, droppedUnverified: dropped };
}
