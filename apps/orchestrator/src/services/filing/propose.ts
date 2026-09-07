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
import { createLogger } from "../../lib/logger.js";
import { matchCompany, normalizeCompanyName, type MatchOutcome } from "./match.js";
import { parsePayload, payloadRejectionReason } from "./payloads.js";

const logger = createLogger("filing-propose");

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

/**
 * What the policy table needs to know about the DOCUMENT and the BOX, beyond
 * the entity itself (WARP-2733).
 *
 * 🔴 Threaded explicitly rather than defaulted, because every one of these is
 * fail-CLOSED when absent: an undefined `documentRole` is not in `CREATE_ROLES`
 * and refuses the create. That is the right direction — a caller who forgets to
 * pass it gets review cards, not unattended writes — but it also means a
 * forgetful caller would silently disable auto-create with no error, so the
 * worker passes them and a test asserts an auto-create actually happens.
 */
export interface AutoContext {
  /** The classifier's `role` for this document. */
  documentRole?: string | null;
  /** `BUSINESS` | `INDIVIDUAL` | `UNKNOWN`. */
  counterparty?: string | null;
  /** True when the hourly or the relevant daily budget is already spent. */
  capReached?: (kind: IngestProposalKind) => boolean;
  /** Does a project of this name already exist? */
  projectNameExists?: (name: string) => boolean;
}

/**
 * A pointer from a draft to the draft it cannot be applied without.
 *
 * Named by (kind, dedupeKey) rather than by id, because at build time no draft
 * HAS an id — `buildDrafts` is pure and writes nothing. `persistDrafts` turns
 * the pair into the parent row's real id.
 */
export interface DraftDependency {
  kind: IngestProposalKind;
  dedupeKey: string;
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
  /**
   * WARP-2737 — the draft this one cannot apply before.
   *
   * Set for a money document whose counterparty this run is also proposing to
   * CREATE: the invoice has no customer to land on until that card is applied,
   * and the payload cannot carry an id for a row that does not exist yet.
   *
   * The header of this file argues that a `CREATE_CUSTOMER` must not be split
   * into a parent/child pair, and that still holds — a customer created without
   * the paper that created them is a record nobody can check, which is why the
   * file travels ON the customer draft. This is the other case the schema
   * column was written for: two proposals that were always going to be two
   * cards, one of which is meaningless until the other is said yes to.
   */
  dependsOn?: DraftDependency;
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

/**
 * `IngestMatchKind` (what kind of key matched) to `IngestKeyKind` (what kind of
 * key a rule is written against). Two enums for two jobs, and the mapping is
 * written once, here, rather than inline at each of its three call sites.
 */
export function matchedKey(
  kind: IngestMatchKind,
  value: string,
): { matchedKeyKind?: string; matchedKeyValue?: string } {
  if (!value) return {};
  if (kind === "EMAIL") return { matchedKeyKind: "EMAIL_ADDRESS", matchedKeyValue: value };
  if (kind === "DOMAIN") return { matchedKeyKind: "EMAIL_DOMAIN", matchedKeyValue: value };
  if (kind === "NAME") return { matchedKeyKind: "NAME", matchedKeyValue: value };
  return {};
}

/**
 * The key both halves of the money chain are looked up under (WARP-2737).
 *
 * 🔴 The `|| lowercase` fallback is load-bearing, and it is the same one the
 * dedupe keys already carry. `normalizeCompanyName` collapses some inputs — a
 * bare "LLC" — to the empty string, and without the fallback two different
 * unmatched businesses on one document would share the key `""`. A money
 * document would then chain to whichever of them happened to be written last,
 * which is the wrong customer rather than no customer.
 */
export function chainKey(name: string): string {
  return normalizeCompanyName(name) || name.toLowerCase();
}

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
  auto?: AutoContext;
}): Promise<BuildDraftsResult> {
  const { source, entities, phiVerdict, settings } = args;
  const auto = args.auto ?? {};
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
    /** Per-draft facts the table needs — the near-miss score, the target's
     *  origin — that only the loop producing this draft knows. */
    extra: {
      nearestCandidateScore?: number;
      targetIsExternal?: boolean;
      sameNameProjectExists?: boolean;
    } = {},
    /** The draft this one cannot be applied before. See `ProposalDraft`. */
    dependsOn?: DraftDependency,
  ): boolean => {
    // Parse on the way in. A draft that does not satisfy its own kind's
    // allow-list is a bug in THIS file, and the right time to find out is
    // before the row exists rather than at apply time thirty days later.
    //
    // 🔴 It is logged, not merely dropped. If this ever fires, the document
    // silently ends up with fewer proposals — or none — and the owner sees an
    // empty queue with nothing anywhere saying why. That is the exact shape of
    // failure this feature is most likely to have and least likely to notice.
    // Field PATHS and zod codes only; never the values, which are the document.
    if (parsePayload(kind, payload) === null) {
      logger.warn(
        { kind, reason: payloadRejectionReason(kind, payload) },
        "filing: dropped a draft that failed its own payload allow-list",
      );
      // Reported, so a caller that is about to point ANOTHER draft at this one
      // finds out it was never made. A pointer at a draft that was dropped is a
      // chain that can never resolve.
      return false;
    }
    const c = cap(confidence);
    const verdict = classifyPolicy({
      kind,
      mode: settings.mode,
      level: settings.level,
      vertical: settings.vertical,
      phiVerdict,
      confidence: c,
      matchKind,
      documentRole: auto.documentRole ?? null,
      counterparty: auto.counterparty ?? null,
      capReached: auto.capReached?.(kind) ?? false,
      // The money kind, so the review card names the document instead of
      // calling a bill an invoice. Read off the payload AFTER `parsePayload`
      // accepted it above, so this is the validated value and not a guess; for
      // every other kind it is absent and the table never looks at it.
      moneyKind:
        kind === "CREATE_MONEY_DOC" && typeof payload.kind === "string"
          ? payload.kind
          : null,
      ...extra,
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
      ...(dependsOn ? { dependsOn } : {}),
    });
    return true;
  };

  /** Company name → the record it resolved to, for `companyRef` on projects. */
  const resolved = new Map<string, { companyId: string; companyName: string }>();
  /**
   * WARP-2737 — company name → the dedupe key of the `CREATE_CUSTOMER` draft
   * this run is proposing for it.
   *
   * The other half of `resolved`: that one holds the customers that already
   * exist, this one holds the ones that would. A money document naming a
   * business in here is chained to that draft rather than left with no customer
   * at all, which is what made every first invoice permanently unappliable.
   */
  const proposedCustomers = new Map<string, string>();
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
      // The key that found it, carried onto the payload so "Not this customer"
      // has something the matcher will actually look up next time.
      const matched = matchedKey(outcome.matchKind, outcome.matchedValue);
      const file = fileRef(source);
      if (file) {
        add(
          "LINK_FILE",
          outcome.companyId,
          company.confidence,
          outcome.matchKind,
          {
            companyId: outcome.companyId,
            companyName: outcome.companyName,
            file,
            ...matched,
          },
          company.evidence,
          // 🔴 A connector owns this row; anything we wrote would be reverted
          // by the next sync tick. NEVER, not review — there is no confidence
          // at which writing to somebody else's system of record is right.
          { targetIsExternal: outcome.targetIsExternal },
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
            ...matched,
          },
          company.evidence,
          { targetIsExternal: outcome.targetIsExternal },
        );
      }
      continue;
    }

    if (outcome.kind === "AMBIGUOUS") {
      add(
        "MATCH_REVIEW",
        // The same `|| lowercase` fallback its CREATE_CUSTOMER and
        // CREATE_PROJECT siblings carry, and that `matchedKeyValue` three lines
        // below already had. `normalizeCompanyName` collapses inputs like "LLC"
        // to "", so without it two different ambiguous companies whose names
        // both normalise to empty share a dedupeKey for one sourceRef — the
        // second is counted as a duplicate by `persistDrafts`' unique-violation
        // catch and silently dropped, and a real ambiguous match never reaches
        // the owner's review queue.
        normalizeCompanyName(company.name) || company.name.toLowerCase(),
        company.confidence,
        "NAME",
        {
          extractedName: company.name,
          matchedKeyKind: "NAME",
          matchedKeyValue: normalizeCompanyName(company.name) || company.name.toLowerCase(),
          candidates: outcome.candidates.map((c) => ({ companyId: c.companyId, name: c.name })),
          ...(fileRef(source) ? { file: fileRef(source) } : {}),
        },
        company.evidence,
      );
      continue;
    }

    // NONE — propose the customer, with the document that named them.
    //
    // 🔴 `outcome.nearestScore` travels with it. "No match" and "nothing like
    // it exists" are different facts, and only the second one makes an
    // unattended create safe.
    const customerKey = chainKey(company.name);
    const madeCustomerDraft = add(
      "CREATE_CUSTOMER",
      customerKey,
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
      { nearestCandidateScore: outcome.nearestScore },
    );
    // Recorded only once the draft actually EXISTS. `add` drops a draft that
    // fails its own payload allow-list, and a money document chained to a card
    // nobody can see would be waiting on something that is never coming.
    //
    // The VALUE is the dedupe key rather than the lookup key: they are the same
    // string today, and storing it means the chain keeps following the dedupe
    // key if the two ever diverge.
    if (madeCustomerDraft) proposedCustomers.set(customerKey, customerKey);
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
      { sameNameProjectExists: auto.projectNameExists?.(project.name) ?? false },
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
    // 🔴 Only when the counterparty did NOT resolve to an existing customer. A
    // payload that names one carries the resolution the matcher already made,
    // and a pointer beside it would be a second answer to a settled question.
    // Keyed on the counterparty's own name, so an invoice from one business on
    // a document that also names another cannot inherit the other's customer.
    const parent =
      !link && money.counterpartyName
        ? proposedCustomers.get(chainKey(money.counterpartyName))
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
      {},
      parent ? { kind: "CREATE_CUSTOMER", dedupeKey: parent } : undefined,
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
  /** `kind` + `dedupeKey` → the row id this run just wrote for it. */
  const idsThisRun = new Map<string, string>();

  for (const d of drafts) {
    // WARP-2737 — resolved BEFORE the create, so the pointer lands in the same
    // INSERT as the row rather than in a follow-up UPDATE that a crash could
    // skip. `buildDrafts` emits companies before money, so the parent is
    // already in `idsThisRun` on the ordinary path; `parentIdFor` covers the
    // re-extraction path, where the parent exists from an earlier read and its
    // create above raised the unique violation instead of returning an id.
    const dependsOnProposalId = d.dependsOn
      ? await parentIdFor(prisma, source, d.dependsOn, idsThisRun)
      : null;
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
      dependsOnProposalId,
    };
    try {
      const row = await prisma.ingestProposal.create({ data, select: { id: true } });
      created += 1;
      proposalIds.push(row.id);
      idsThisRun.set(draftKey(d.kind, d.dedupeKey), row.id);
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

/** The map key. `IngestProposalKind` is an enum of A-Z and underscores and
 *  can never contain the separator, so the pair cannot be spelled two ways. */
function draftKey(kind: IngestProposalKind, dedupeKey: string): string {
  return `${kind}|${dedupeKey}`;
}

/**
 * The parent row's id, from this run or from the last one.
 *
 * 🔴 The second lookup is not belt-and-braces. Re-extracting a touched file
 * re-proposes the same customer, whose `create` raises `P2002` and returns no
 * id — so on every read after the first, a chain resolved only from this run's
 * map would be silently null and the money card would be stuck in exactly the
 * way this slice exists to fix. The composite key below is the same one that
 * collision was against.
 *
 * Null when there is no parent at all. That is not an error: the money card
 * refuses honestly and says what the owner needs to do.
 */
async function parentIdFor(
  prisma: PrismaClient,
  source: SourceRef,
  dep: DraftDependency,
  idsThisRun: ReadonlyMap<string, string>,
): Promise<string | null> {
  const fresh = idsThisRun.get(draftKey(dep.kind, dep.dedupeKey));
  if (fresh) return fresh;
  const existing = await prisma.ingestProposal.findUnique({
    where: {
      sourceRef_kind_dedupeKey_extractorVersion: {
        sourceRef: source.sourceRef,
        kind: dep.kind,
        dedupeKey: dep.dedupeKey,
        extractorVersion: EXTRACTOR_VERSION,
      },
    },
    select: { id: true },
  });
  return existing?.id ?? null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "P2002"
  );
}
