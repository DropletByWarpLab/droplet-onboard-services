/**
 * WARP-2730 (ADR-048) — turn one extraction into proposals.
 *
 * This is the file where "the model read a document" becomes "there is a thing
 * you can click", and the two decisions it makes are worth stating plainly.
 *
 * 1. A COMPANY THE BOX DOES NOT HAVE becomes ONE proposal, not two. The
 *    `CREATE_CUSTOMER` payload carries the file, and applying it creates the
 *    customer and attaches the document in the same transaction. The schema
 *    has a `dependsOnProposalId` column for genuinely dependent pairs and this
 *    is deliberately not one of them: a parent/child split here would mean a
 *    rejected parent leaving an orphan child pointing at a customer that was
 *    never created, and a review queue that grows two rows per document for no
 *    gain the owner can see.
 *
 * 2. `role: "self"` IS DROPPED. An invoice names both parties. Creating a
 *    customer record for the business whose file server this is, is the most
 *    obvious wrong filing available, and it is the one a model makes every
 *    time it is not told which party is which.
 *
 * Nothing here writes. `buildDrafts` is pure given a match resolver, which is
 * what lets the unit tests drive canned JSON straight to exact rows.
 */
import type { PrismaClient } from "@prisma/client";
import type {
  AutoFilingLevel,
  AutoFilingMode,
  AutoFilingVertical,
  IngestMatchKind,
  IngestProposalKind,
  IngestSourceKind,
  PhiVerdict,
  Prisma,
} from "@prisma/client";

import type { ExtractOut } from "./contract.js";
import { EXTRACTOR_VERSION } from "./contract.js";
import { classify as classifyPolicy, MENTIONS_CONFIDENCE_CAP } from "./policy.js";
import { matchCompany, normalizeCompanyName, type MatchOutcome } from "./match.js";
import { parsePayload } from "./payloads.js";

export interface FileSourceRef {
  sourceKind: "FILE";
  sourceRef: string;
  ncFileId: number;
  filePath: string;
  fileSpace: string;
}

export interface EmailSourceRef {
  sourceKind: "EMAIL";
  sourceRef: string;
  emailMessageId: string;
  subject?: string;
  occurredAt?: string;
}

export type SourceRef = FileSourceRef | EmailSourceRef;

export interface FilingSettings {
  mode: AutoFilingMode;
  level: AutoFilingLevel;
  vertical: AutoFilingVertical;
}

export interface ProposalDraft {
  kind: IngestProposalKind;
  dedupeKey: string;
  confidence: number;
  matchKind: IngestMatchKind;
  payload: Record<string, unknown>;
  evidence: { quote: string; chunkIdx?: number }[];
  policyClass: "AUTO" | "REVIEW" | "NEVER";
  policyReason: string | null;
}

export interface BuildDraftsResult {
  drafts: ProposalDraft[];
  /** Sources the owner has told us to leave alone. Reported so the worker can
   *  retire the row `not_needed/ignored_by_you` rather than re-reading it
   *  every time the file is touched. */
  ignored: boolean;
}

type MatchResolver = (input: {
  name: string;
  domain?: string;
  emails: string[];
  folder: string | null;
}) => Promise<MatchOutcome>;

/** The folder a file sits in, for `NC_FOLDER` decisions. Path only, never the
 *  filename — filenames are PHI (WARP-1983). */
export function folderOf(source: SourceRef): string | null {
  if (source.sourceKind !== "FILE") return null;
  const cut = source.filePath.lastIndexOf("/");
  return cut <= 0 ? "/" : source.filePath.slice(0, cut);
}

function fileRef(source: SourceRef) {
  if (source.sourceKind !== "FILE") return undefined;
  return {
    ncFileId: source.ncFileId,
    filePath: source.filePath,
    fileSpace: source.fileSpace,
  };
}

/**
 * Build the drafts.
 *
 * `resolveMatch` is injected rather than called through prisma directly so the
 * unit suite can drive every match outcome — taught, ambiguous, ignored — with
 * no database at all. `proposeFromExtraction` below is the wired version.
 */
export async function buildDrafts(args: {
  source: SourceRef;
  entities: ExtractOut;
  phiVerdict: PhiVerdict;
  settings: FilingSettings;
  resolveMatch: MatchResolver;
}): Promise<BuildDraftsResult> {
  const { source, entities, phiVerdict, settings } = args;
  const folder = folderOf(source);
  const drafts: ProposalDraft[] = [];

  const cap = (n: number) =>
    phiVerdict === "MENTIONS" ? Math.min(n, MENTIONS_CONFIDENCE_CAP) : n;

  const add = (
    kind: IngestProposalKind,
    dedupeKey: string,
    confidence: number,
    matchKind: IngestMatchKind,
    payload: Record<string, unknown>,
    evidence: { quote: string; chunkIdx?: number }[],
  ) => {
    // Parse on the way in. A draft that does not satisfy its own kind's
    // allow-list is a bug in this file, and the right time to find out is
    // before the row exists rather than at apply time thirty days later.
    if (parsePayload(kind, payload) === null) return;
    const c = cap(confidence);
    const verdict = classifyPolicy({
      kind,
      mode: settings.mode,
      level: settings.level,
      vertical: settings.vertical,
      phiVerdict,
      confidence: c,
      matchKind,
    });
    drafts.push({
      kind,
      dedupeKey,
      confidence: c,
      matchKind,
      payload,
      evidence,
      policyClass: verdict.policyClass,
      policyReason: verdict.policyReason,
    });
  };

  /** Company name → the record it resolved to, for `companyRef` on projects. */
  const resolved = new Map<string, { companyId: string; companyName: string }>();
  let anyIgnored = false;

  for (const company of entities.companies) {
    if (company.role === "self") continue;

    const outcome = await args.resolveMatch({
      name: company.name,
      domain: company.domain,
      emails: company.emails,
      folder,
    });

    if (outcome.kind === "IGNORED") {
      anyIgnored = true;
      continue;
    }

    if (outcome.kind === "MATCH") {
      resolved.set(normalizeCompanyName(company.name), {
        companyId: outcome.companyId,
        companyName: outcome.companyName,
      });
      const file = fileRef(source);
      if (file) {
        add(
          "LINK_FILE",
          outcome.companyId,
          company.confidence,
          outcome.matchKind,
          { companyId: outcome.companyId, companyName: outcome.companyName, file },
          company.evidence,
        );
      } else if (source.sourceKind === "EMAIL") {
        add(
          "LOG_EMAIL_ACTIVITY",
          outcome.companyId,
          company.confidence,
          outcome.matchKind,
          {
            companyId: outcome.companyId,
            companyName: outcome.companyName,
            emailMessageId: source.emailMessageId,
            ...(source.subject ? { subject: source.subject } : {}),
            ...(source.occurredAt ? { occurredAt: source.occurredAt } : {}),
          },
          company.evidence,
        );
      }
      continue;
    }

    if (outcome.kind === "AMBIGUOUS") {
      add(
        "MATCH_REVIEW",
        normalizeCompanyName(company.name),
        company.confidence,
        "NAME",
        {
          extractedName: company.name,
          candidates: outcome.candidates.map((c) => ({ companyId: c.companyId, name: c.name })),
          ...(fileRef(source) ? { file: fileRef(source) } : {}),
        },
        company.evidence,
      );
      continue;
    }

    // NONE — propose the customer, with the document that named them.
    add(
      "CREATE_CUSTOMER",
      normalizeCompanyName(company.name) || company.name.toLowerCase(),
      company.confidence,
      "NONE",
      {
        name: company.name,
        ...(company.domain ? { domain: company.domain } : {}),
        ...(company.phones[0] ? { phone: company.phones[0] } : {}),
        ...(company.address ? { address: company.address } : {}),
        ...(fileRef(source) ? { file: fileRef(source) } : {}),
      },
      company.evidence,
    );
  }

  for (const project of entities.projects) {
    const link = project.companyRef
      ? resolved.get(normalizeCompanyName(project.companyRef))
      : undefined;
    add(
      "CREATE_PROJECT",
      normalizeCompanyName(project.name) || project.name.toLowerCase(),
      project.confidence,
      link ? "NAME" : "NONE",
      {
        name: project.name,
        ...(project.summary ? { summary: project.summary } : {}),
        ...(link ? { companyId: link.companyId, companyName: link.companyName } : {}),
      },
      project.evidence,
    );
  }

  // Already empty on a MENTIONS document — `applyPhiPosture` dropped them —
  // but the loop is written to be correct on its own rather than to rely on
  // an invariant established two files away.
  for (const person of phiVerdict === "MENTIONS" ? [] : entities.people) {
    const link = person.organization
      ? resolved.get(normalizeCompanyName(person.organization))
      : undefined;
    add(
      "CREATE_CONTACT",
      (person.email ?? person.displayName).toLowerCase(),
      person.confidence,
      "NONE",
      {
        displayName: person.displayName,
        ...(person.email ? { email: person.email } : {}),
        ...(person.phone ? { phone: person.phone } : {}),
        ...(person.organization ? { organization: person.organization } : {}),
        ...(person.roleTitle ? { roleTitle: person.roleTitle } : {}),
        ...(link ? { companyId: link.companyId } : {}),
      },
      person.evidence,
    );
  }

  for (const money of entities.moneyDocuments) {
    const link = money.counterpartyName
      ? resolved.get(normalizeCompanyName(money.counterpartyName))
      : undefined;
    add(
      "CREATE_MONEY_DOC",
      `${money.kind}:${money.number ?? ""}:${money.currency}:${money.total}`,
      money.confidence,
      link ? "NAME" : "NONE",
      {
        kind: money.kind,
        ...(money.number ? { number: money.number } : {}),
        ...(money.issuedAt ? { issuedAt: money.issuedAt } : {}),
        ...(money.dueAt ? { dueAt: money.dueAt } : {}),
        currency: money.currency,
        total: money.total,
        ...(money.balance ? { balance: money.balance } : {}),
        direction: money.direction,
        ...(money.counterpartyName ? { counterpartyName: money.counterpartyName } : {}),
        ...(link ? { companyId: link.companyId } : {}),
        ...(fileRef(source) ? { file: fileRef(source) } : {}),
      },
      money.evidence,
    );
  }

  return { drafts, ignored: anyIgnored && drafts.length === 0 };
}

/** The wired matcher. Separate from `buildDrafts` so the pure half stays
 *  testable without a database. */
export function prismaMatcher(prisma: PrismaClient): MatchResolver {
  return (input) =>
    matchCompany(prisma, {
      name: input.name,
      domain: input.domain ?? null,
      emails: input.emails,
      folder: input.folder,
    });
}

export interface PersistResult {
  created: number;
  /** Already there from a previous run at this extractor version. */
  duplicate: number;
  proposalIds: string[];
}

/**
 * Write the drafts.
 *
 * One `create` per draft, catching the unique violation rather than upserting.
 * `@@unique([sourceRef, kind, dedupeKey, extractorVersion])` is the guard, and
 * an upsert would UPDATE the existing row — which is wrong, because that row
 * may already have been decided: re-extracting a touched file must not quietly
 * resurrect a proposal the owner rejected last week.
 */
export async function persistDrafts(
  prisma: PrismaClient,
  source: SourceRef,
  drafts: ProposalDraft[],
  ctx: { requestedById: string; phiVerdict: PhiVerdict },
): Promise<PersistResult> {
  let created = 0;
  let duplicate = 0;
  const proposalIds: string[] = [];

  for (const d of drafts) {
    const data = {
      sourceKind: source.sourceKind as IngestSourceKind,
      sourceRef: source.sourceRef,
      ncFileId: source.sourceKind === "FILE" ? source.ncFileId : null,
      emailMessageId: source.sourceKind === "EMAIL" ? source.emailMessageId : null,
      kind: d.kind,
      policyClass: d.policyClass,
      policyReason: d.policyReason,
      confidence: d.confidence,
      phiVerdict: ctx.phiVerdict,
      matchKind: d.matchKind,
      payload: d.payload as Prisma.InputJsonValue,
      evidence: d.evidence as unknown as Prisma.InputJsonValue,
      extractorVersion: EXTRACTOR_VERSION,
      dedupeKey: d.dedupeKey,
      requestedById: ctx.requestedById,
    };
    try {
      const row = await prisma.ingestProposal.create({ data, select: { id: true } });
      created += 1;
      proposalIds.push(row.id);
    } catch (err) {
      if (isUniqueViolation(err)) {
        duplicate += 1;
        continue;
      }
      throw err;
    }
  }

  return { created, duplicate, proposalIds };
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
