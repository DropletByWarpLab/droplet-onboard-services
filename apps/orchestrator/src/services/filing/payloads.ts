/**
 * WARP-2730 (ADR-048) — what a proposal is allowed to say, per kind.
 *
 * `IngestProposal.payload` is `Json`, which is the right column type and the
 * wrong contract. These schemas are the contract: one `.strict()` allow-list
 * per `IngestProposalKind`, parsed on the way IN (so a malformed draft never
 * reaches the table) and again on the way OUT (so a row hand-edited in psql,
 * or written by an older extractor version, cannot drive a write).
 *
 * Parsing on read is not paranoia about our own writer. A proposal can sit for
 * thirty days; `EXTRACTOR_VERSION` moves; the apply path is the one place in
 * this feature that creates rows other people will act on. Reading it back
 * through the same allow-list costs one function call and makes "what could
 * this row possibly do" answerable by looking at this file.
 *
 * 🔴 Same rule as `contract.ts`: no `dob`, no `chart`, no `insurance`, no
 * `treatment` field anywhere below, and the test asserts it structurally
 * rather than trusting this comment.
 */
import { z } from "zod";
import type { IngestProposalKind } from "@prisma/client";

const shortText = z.string().trim().min(1).max(200);
const mediumText = z.string().trim().min(1).max(1000);
const decimalString = z.string().trim().regex(/^-?\d{1,15}(\.\d{1,6})?$/);
const currency = z.string().trim().regex(/^[A-Z]{3}$/);
const isoDate = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Enough to attach a file to a record and to render the card without a
 *  second query. `filePath` is stored because `EntityLink` needs it — and it
 *  is re-checked against Nextcloud at apply time, never trusted from here. */
const FileRef = z
  .object({
    ncFileId: z.number().int().positive(),
    filePath: z.string().trim().min(1).max(4096),
    fileSpace: z.string().trim().min(1).max(200),
  })
  .strict();

/**
 * The key that found the match, carried on every payload that HAS a match.
 *
 * 🔴 This is what "Not this customer" teaches against. Without it the only
 * thing a correction could be written against is the proposal's dedupe key,
 * which for a `LINK_FILE` is a company UUID — and a `FilingDecision` keyed on a
 * UUID matches nothing the matcher ever looks up. The owner's correction would
 * silently never take effect, and the same wrong suggestion would come back
 * tomorrow.
 */
const MatchedKey = {
  matchedKeyKind: z.enum(["EMAIL_ADDRESS", "EMAIL_DOMAIN", "NAME", "NC_FOLDER"]).optional(),
  matchedKeyValue: z.string().trim().min(1).max(320).optional(),
};

export const LinkFilePayload = z
  .object({
    companyId: z.string().uuid(),
    companyName: shortText,
    file: FileRef,
    ...MatchedKey,
  })
  .strict();

export const LogEmailActivityPayload = z
  .object({
    companyId: z.string().uuid(),
    companyName: shortText,
    emailMessageId: z.string().min(1).max(200),
    /** Rendered as the timeline caption. Screened like every persisted string. */
    subject: shortText.optional(),
    occurredAt: z.string().datetime().optional(),
    ...MatchedKey,
  })
  .strict();

export const SetProjectCustomerPayload = z
  .object({
    projectId: z.string().uuid(),
    projectName: shortText,
    companyId: z.string().uuid(),
    companyName: shortText,
  })
  .strict();

export const CreateCustomerPayload = z
  .object({
    name: shortText,
    domain: z.string().trim().max(253).optional(),
    phone: z.string().trim().max(40).optional(),
    website: z.string().trim().max(500).optional(),
    address: mediumText.optional(),
    /** Attached in the same apply, so the document that created the customer
     *  is on the customer. Optional because the email arm has no file. */
    file: FileRef.optional(),
  })
  .strict();

export const CreateProjectPayload = z
  .object({
    name: shortText,
    summary: mediumText.optional(),
    companyId: z.string().uuid().optional(),
    companyName: shortText.optional(),
  })
  .strict();

export const CreateContactPayload = z
  .object({
    displayName: shortText,
    email: z.string().trim().email().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    organization: shortText.optional(),
    roleTitle: shortText.optional(),
    companyId: z.string().uuid().optional(),
  })
  .strict();

export const MatchReviewPayload = z
  .object({
    /** What the document called them. */
    extractedName: shortText,
    ...MatchedKey,
    candidates: z
      .array(z.object({ companyId: z.string().uuid(), name: shortText }).strict())
      .min(2)
      .max(5),
    file: FileRef.optional(),
  })
  .strict();

export const CreateMoneyDocPayload = z
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
    companyId: z.string().uuid().optional(),
    file: FileRef.optional(),
  })
  .strict();

/** The one place kind → schema is written down. A `satisfies` rather than a
 *  cast, so adding a member to `IngestProposalKind` without a schema is a
 *  compile error and not a runtime surprise. */
export const PAYLOAD_SCHEMAS = {
  LINK_FILE: LinkFilePayload,
  LOG_EMAIL_ACTIVITY: LogEmailActivityPayload,
  SET_PROJECT_CUSTOMER: SetProjectCustomerPayload,
  CREATE_CUSTOMER: CreateCustomerPayload,
  CREATE_PROJECT: CreateProjectPayload,
  CREATE_CONTACT: CreateContactPayload,
  MATCH_REVIEW: MatchReviewPayload,
  CREATE_MONEY_DOC: CreateMoneyDocPayload,
} satisfies Record<IngestProposalKind, z.ZodTypeAny>;

export type PayloadFor<K extends IngestProposalKind> = z.infer<(typeof PAYLOAD_SCHEMAS)[K]>;

/** Every payload shape, as one union. What `applyProposal` holds after
 *  `parsePayload` succeeds but before it has switched on the kind. */
export type AnyPayload = { [K in IngestProposalKind]: PayloadFor<K> }[IngestProposalKind];

/**
 * Parse a stored payload for its kind.
 *
 * Returns `null` rather than throwing: the caller is either the review list
 * (which renders the row as unreadable and offers Reject) or the apply path
 * (which refuses with a 422). Neither wants a stack trace, and a throw here
 * would take out a whole page of otherwise-fine cards.
 */
export function parsePayload<K extends IngestProposalKind>(
  kind: K,
  value: unknown,
): PayloadFor<K> | null {
  const schema = PAYLOAD_SCHEMAS[kind];
  const r = schema.safeParse(value);
  return r.success ? (r.data as PayloadFor<K>) : null;
}

/**
 * Why a payload was refused, as FIELD PATHS and messages only.
 *
 * 🔴 Never the values. A zod error carries the offending input by default, and
 * this string is written to a log that more people read than the CRM — the same
 * rule that keeps filenames out of `CrmActivity` summaries. Paths and codes are
 * enough to find the bug; the document is not.
 */
export function payloadRejectionReason<K extends IngestProposalKind>(
  kind: K,
  value: unknown,
): string | null {
  const r = PAYLOAD_SCHEMAS[kind].safeParse(value);
  if (r.success) return null;
  return r.error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`)
    .join("; ");
}
