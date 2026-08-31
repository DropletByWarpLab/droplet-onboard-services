/**
 * CRM service (WARP-2117) — the data layer behind `/api/crm/*` and, later, the
 * `crm_*` tools (WARP-2546) and the Customers/Deals surfaces (WARP-2545).
 *
 * Visibility: the CRM is BUSINESS-SHARED, the same model as PM and for the same
 * reason — a pipeline that only its author can see is not a pipeline. Reads are
 * open to any authenticated role; writes are gated by `requireRole` in the
 * route layer. `ownerId`/`actorId` are recorded for attribution and the
 * timeline, never used to scope visibility. Contacts are the exception and stay
 * owner-scoped in `contacts.service.ts`; the CRM reaches them through link rows
 * it owns, so linking never widens who can read a person's record.
 *
 * Money: `amountMinor` is a `BigInt` of minor units. It crosses the API
 * boundary as a decimal STRING — `JSON.stringify` throws on a BigInt, and the
 * obvious fix (`Number(...)`) silently rounds above 2^53, which for a currency
 * figure is a wrong number rather than an error. `currency` is required exactly
 * when an amount is present (CHECK constraint in the migration).
 *
 * Errors are thrown as plain `Error(code)` with stable string codes the route
 * layer maps to HTTP status, mirroring `pm.service.ts`.
 */

import type { Prisma, PrismaClient } from "@prisma/client";

export const CRM_ERRORS = {
  COMPANY_NOT_FOUND: "company_not_found",
  CONTACT_NOT_FOUND: "contact_not_found",
  DEAL_NOT_FOUND: "deal_not_found",
  PIPELINE_NOT_FOUND: "pipeline_not_found",
  STAGE_NOT_FOUND: "stage_not_found",
  ACTIVITY_NOT_FOUND: "activity_not_found",
  /// The stage exists but belongs to another pipeline. Distinct from
  /// STAGE_NOT_FOUND (404) so a cross-pipeline mistake reads as 422 rather
  /// than as a typo'd id.
  INVALID_STAGE: "invalid_stage",
  /// Deleting a stage that still holds deals, or the last stage of a pipeline.
  /// Silently moving or dropping those deals would be a data-loss bug wearing
  /// a success response.
  STAGE_HAS_DEALS: "stage_has_deals",
  STAGE_IS_LAST: "stage_is_last",
  PIPELINE_HAS_DEALS: "pipeline_has_deals",
  /// An amount with no currency, or a currency with no amount.
  AMOUNT_NEEDS_CURRENCY: "amount_needs_currency",
  DUPLICATE_LINK: "duplicate_link",
} as const;

// ── Default pipeline ─────────────────────────────────────────────────────────

export const DEFAULT_PIPELINE_NAME = "Sales";

/**
 * The stages a fresh box starts with. Names are a starting point the owner is
 * expected to rewrite; `kind` is what the box actually reasons about, which is
 * why "Won" being last is a coincidence and not a rule anything reads.
 */
export const DEFAULT_STAGES: ReadonlyArray<{
  name: string;
  kind: "OPEN" | "WON" | "LOST";
  sortOrder: number;
  probability: number | null;
}> = [
  { name: "Lead", kind: "OPEN", sortOrder: 0, probability: 10 },
  { name: "Qualified", kind: "OPEN", sortOrder: 1, probability: 30 },
  { name: "Proposal", kind: "OPEN", sortOrder: 2, probability: 60 },
  { name: "Negotiation", kind: "OPEN", sortOrder: 3, probability: 80 },
  { name: "Won", kind: "WON", sortOrder: 4, probability: 100 },
  { name: "Lost", kind: "LOST", sortOrder: 5, probability: 0 },
];

// ── API shapes ───────────────────────────────────────────────────────────────

export interface ApiCrmStage {
  id: string;
  pipelineId: string;
  name: string;
  kind: "OPEN" | "WON" | "LOST";
  sortOrder: number;
  probability: number | null;
}

export interface ApiCrmPipeline {
  id: string;
  name: string;
  isDefault: boolean;
  sortOrder: number;
  archived: boolean;
  stages: ApiCrmStage[];
}

export interface ApiCrmCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  phone: string | null;
  website: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  note: string | null;
  ownerId: string | null;
  origin: "LOCAL" | "EXTERNAL";
  externalSystem: string | null;
  archived: boolean;
  /** Present on list and detail — the two numbers a customer row is read for. */
  openDealCount: number;
  contactCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ApiCrmDeal {
  id: string;
  title: string;
  companyId: string | null;
  companyName: string | null;
  pipelineId: string;
  stageId: string;
  stage: ApiCrmStage;
  /** Decimal string of minor units, or null. Never a JS number — see header. */
  amountMinor: string | null;
  currency: string | null;
  expectedCloseOn: string | null;
  closedAt: string | null;
  closeReason: string | null;
  ownerId: string | null;
  projectId: string | null;
  origin: "LOCAL" | "EXTERNAL";
  externalSystem: string | null;
  archived: boolean;
  contactIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ApiCrmActivity {
  id: string;
  subjectType: "COMPANY" | "CONTACT" | "DEAL";
  companyId: string | null;
  contactId: string | null;
  dealId: string | null;
  kind: string;
  summary: string;
  actorId: string | null;
  occurredAt: string;
  noteId: string | null;
  emailMessageId: string | null;
  calendarEventId: string | null;
  workItemId: string | null;
  fromStageId: string | null;
  toStageId: string | null;
  createdAt: string;
}

/**
 * WARP-2556 — what a stage's money total MEANS, as three named states rather
 * than as two shapes and a null nobody could tell apart.
 *
 *  • `priced`           — every priced deal shares one currency; the total is real.
 *  • `mixed_currencies` — more than one currency present. NOT summed: adding
 *                         500 EUR to 500 USD produces a number that looks
 *                         authoritative and means nothing.
 *  • `unpriced`         — no deal in the stage carries an amount at all. The
 *                         common case on a new box, and previously reported as
 *                         `mixed_currencies` because both rendered as
 *                         `{ amountMinor: "0", currency: null }`.
 */
export type CrmStageValuation = "priced" | "mixed_currencies" | "unpriced";

export interface ApiCrmStageSummary {
  stageId: string;
  stageName: string;
  kind: "OPEN" | "WON" | "LOST";
  sortOrder: number;
  dealCount: number;
  /** WARP-2556 — branch on THIS, never on `currency === null`. */
  valuation: CrmStageValuation;
  /** Decimal string of minor units. Meaningful only when `valuation` is
   *  `"priced"`; "0" otherwise. */
  amountMinor: string;
  /** ISO-4217 code when `valuation` is `"priced"`, null otherwise. */
  currency: string | null;
}

// ── Row → API ────────────────────────────────────────────────────────────────

const STAGE_SELECT = {
  id: true,
  pipelineId: true,
  name: true,
  kind: true,
  sortOrder: true,
  probability: true,
} satisfies Prisma.CrmPipelineStageSelect;

function stageToApi(row: Prisma.CrmPipelineStageGetPayload<{ select: typeof STAGE_SELECT }>): ApiCrmStage {
  return {
    id: row.id,
    pipelineId: row.pipelineId,
    name: row.name,
    kind: row.kind,
    sortOrder: row.sortOrder,
    probability: row.probability,
  };
}

const DEAL_INCLUDE = {
  stage: { select: STAGE_SELECT },
  company: { select: { name: true } },
  contactLinks: { select: { contactId: true } },
} satisfies Prisma.CrmDealInclude;

function dealToApi(row: Prisma.CrmDealGetPayload<{ include: typeof DEAL_INCLUDE }>): ApiCrmDeal {
  return {
    id: row.id,
    title: row.title,
    companyId: row.companyId,
    companyName: row.company?.name ?? null,
    pipelineId: row.pipelineId,
    stageId: row.stageId,
    stage: stageToApi(row.stage),
    amountMinor: row.amountMinor === null ? null : row.amountMinor.toString(),
    currency: row.currency,
    expectedCloseOn: row.expectedCloseOn?.toISOString() ?? null,
    closedAt: row.closedAt?.toISOString() ?? null,
    closeReason: row.closeReason,
    ownerId: row.ownerId,
    projectId: row.projectId,
    origin: row.origin,
    externalSystem: row.externalSystem,
    archived: row.isArchived,
    contactIds: row.contactLinks.map((l) => l.contactId),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function activityToApi(row: Prisma.CrmActivityGetPayload<object>): ApiCrmActivity {
  return {
    id: row.id,
    subjectType: row.subjectType,
    companyId: row.companyId,
    contactId: row.contactId,
    dealId: row.dealId,
    kind: row.kind,
    summary: row.summary,
    actorId: row.actorId,
    occurredAt: row.occurredAt.toISOString(),
    noteId: row.noteId,
    emailMessageId: row.emailMessageId,
    calendarEventId: row.calendarEventId,
    workItemId: row.workItemId,
    fromStageId: row.fromStageId,
    toStageId: row.toStageId,
    createdAt: row.createdAt.toISOString(),
  };
}

// ── Pipelines ────────────────────────────────────────────────────────────────

/**
 * Idempotent seed of the default pipeline. Called on first read rather than in
 * a migration: a migration cannot know whether the box has been used, and
 * seeding rows from SQL puts product decisions somewhere no test reads them.
 *
 * The `isDefault` partial unique index is the real guard against two callers
 * racing here; this returns the existing row rather than fighting it.
 */
export async function ensureDefaultPipeline(prisma: PrismaClient): Promise<ApiCrmPipeline> {
  const existing = await prisma.crmPipeline.findFirst({
    where: { isDefault: true },
    include: { stages: { select: STAGE_SELECT, orderBy: { sortOrder: "asc" } } },
  });
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      isDefault: existing.isDefault,
      sortOrder: existing.sortOrder,
      archived: existing.isArchived,
      stages: existing.stages.map(stageToApi),
    };
  }

  try {
    const created = await prisma.crmPipeline.create({
      data: {
        name: DEFAULT_PIPELINE_NAME,
        isDefault: true,
        stages: { create: DEFAULT_STAGES.map((s) => ({ ...s })) },
      },
      include: { stages: { select: STAGE_SELECT, orderBy: { sortOrder: "asc" } } },
    });
    return {
      id: created.id,
      name: created.name,
      isDefault: created.isDefault,
      sortOrder: created.sortOrder,
      archived: created.isArchived,
      stages: created.stages.map(stageToApi),
    };
  } catch (err) {
    // Lost the race against the partial unique index — read the winner rather
    // than surfacing a unique violation to a caller who only asked to read.
    if (isUniqueViolation(err)) return ensureDefaultPipeline(prisma);
    throw err;
  }
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

export async function listPipelines(
  prisma: PrismaClient,
  opts: { includeArchived?: boolean } = {},
): Promise<ApiCrmPipeline[]> {
  await ensureDefaultPipeline(prisma);
  const rows = await prisma.crmPipeline.findMany({
    where: opts.includeArchived ? {} : { isArchived: false },
    include: { stages: { select: STAGE_SELECT, orderBy: { sortOrder: "asc" } } },
    orderBy: [{ isDefault: "desc" }, { sortOrder: "asc" }, { name: "asc" }],
  });
  return rows.map((p) => ({
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    sortOrder: p.sortOrder,
    archived: p.isArchived,
    stages: p.stages.map(stageToApi),
  }));
}

export async function getPipeline(prisma: PrismaClient, id: string): Promise<ApiCrmPipeline> {
  const p = await prisma.crmPipeline.findUnique({
    where: { id },
    include: { stages: { select: STAGE_SELECT, orderBy: { sortOrder: "asc" } } },
  });
  if (!p) throw new Error(CRM_ERRORS.PIPELINE_NOT_FOUND);
  return {
    id: p.id,
    name: p.name,
    isDefault: p.isDefault,
    sortOrder: p.sortOrder,
    archived: p.isArchived,
    stages: p.stages.map(stageToApi),
  };
}

export async function createPipeline(
  prisma: PrismaClient,
  input: { name: string; seedDefaultStages?: boolean },
): Promise<ApiCrmPipeline> {
  const created = await prisma.crmPipeline.create({
    data: {
      name: input.name,
      isDefault: false,
      stages:
        input.seedDefaultStages === false
          ? undefined
          : { create: DEFAULT_STAGES.map((s) => ({ ...s })) },
    },
    include: { stages: { select: STAGE_SELECT, orderBy: { sortOrder: "asc" } } },
  });
  return {
    id: created.id,
    name: created.name,
    isDefault: created.isDefault,
    sortOrder: created.sortOrder,
    archived: created.isArchived,
    stages: created.stages.map(stageToApi),
  };
}

export async function updatePipeline(
  prisma: PrismaClient,
  id: string,
  input: { name?: string; archived?: boolean; sortOrder?: number },
): Promise<ApiCrmPipeline> {
  const existing = await prisma.crmPipeline.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.PIPELINE_NOT_FOUND);
  await prisma.crmPipeline.update({
    where: { id },
    data: {
      name: input.name,
      sortOrder: input.sortOrder,
      // `archivedAt` is the audit timestamp; `isArchived` is the state. Both
      // move together here so the pair can never disagree.
      ...(input.archived === undefined
        ? {}
        : { isArchived: input.archived, archivedAt: input.archived ? new Date() : null }),
    },
  });
  return getPipeline(prisma, id);
}

export async function deletePipeline(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.crmPipeline.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.PIPELINE_NOT_FOUND);
  const deals = await prisma.crmDeal.count({ where: { pipelineId: id } });
  if (deals > 0) throw new Error(CRM_ERRORS.PIPELINE_HAS_DEALS);
  await prisma.crmPipeline.delete({ where: { id } });
}

// ── Stages ───────────────────────────────────────────────────────────────────

export async function createStage(
  prisma: PrismaClient,
  pipelineId: string,
  input: { name: string; kind?: "OPEN" | "WON" | "LOST"; sortOrder?: number; probability?: number | null },
): Promise<ApiCrmStage> {
  const pipeline = await prisma.crmPipeline.findUnique({ where: { id: pipelineId } });
  if (!pipeline) throw new Error(CRM_ERRORS.PIPELINE_NOT_FOUND);
  const last = await prisma.crmPipelineStage.findFirst({
    where: { pipelineId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const row = await prisma.crmPipelineStage.create({
    data: {
      pipelineId,
      name: input.name,
      kind: input.kind ?? "OPEN",
      sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0),
      probability: input.probability ?? null,
    },
    select: STAGE_SELECT,
  });
  return stageToApi(row);
}

export async function updateStage(
  prisma: PrismaClient,
  id: string,
  input: { name?: string; kind?: "OPEN" | "WON" | "LOST"; sortOrder?: number; probability?: number | null },
): Promise<ApiCrmStage> {
  const existing = await prisma.crmPipelineStage.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.STAGE_NOT_FOUND);
  const row = await prisma.crmPipelineStage.update({
    where: { id },
    data: {
      name: input.name,
      kind: input.kind,
      sortOrder: input.sortOrder,
      probability: input.probability === undefined ? undefined : input.probability,
    },
    select: STAGE_SELECT,
  });
  return stageToApi(row);
}

/**
 * Refuses rather than reassigning. A stage holding deals cannot be removed
 * without deciding where those deals go, and that decision belongs to the
 * person deleting the stage, not to this function.
 */
export async function deleteStage(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.crmPipelineStage.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.STAGE_NOT_FOUND);
  const deals = await prisma.crmDeal.count({ where: { stageId: id } });
  if (deals > 0) throw new Error(CRM_ERRORS.STAGE_HAS_DEALS);
  const siblings = await prisma.crmPipelineStage.count({ where: { pipelineId: existing.pipelineId } });
  if (siblings <= 1) throw new Error(CRM_ERRORS.STAGE_IS_LAST);
  await prisma.crmPipelineStage.delete({ where: { id } });
}

// ── Companies ────────────────────────────────────────────────────────────────

export interface CompanyInput {
  name?: string;
  domain?: string | null;
  industry?: string | null;
  phone?: string | null;
  website?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  note?: string | null;
  ownerId?: string | null;
  archived?: boolean;
}

/** Lowercased and stripped of scheme/path, so `https://Example.com/pricing`
 *  and `example.com` are the same dedupe key rather than two customers.
 *
 *  The illustration uses an RFC-2606 reserved name deliberately: any other
 *  domain written here, even inside a comment, is a hostname literal that
 *  `check-egress-allowlist.py` reads as an unregistered outbound destination
 *  and blocks the PR on. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;
  return trimmed
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .replace(/\.$/, "");
}

const COMPANY_COUNTS = {
  _count: { select: { contactLinks: true } },
} satisfies Prisma.CrmCompanyInclude;

async function companyToApi(
  prisma: PrismaClient,
  row: Prisma.CrmCompanyGetPayload<{ include: typeof COMPANY_COUNTS }>,
  openDealCount: number,
): Promise<ApiCrmCompany> {
  void prisma;
  return {
    id: row.id,
    name: row.name,
    domain: row.domain,
    industry: row.industry,
    phone: row.phone,
    website: row.website,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    city: row.city,
    region: row.region,
    postalCode: row.postalCode,
    country: row.country,
    note: row.note,
    ownerId: row.ownerId,
    origin: row.origin,
    externalSystem: row.externalSystem,
    archived: row.isArchived,
    openDealCount,
    contactCount: row._count.contactLinks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * "Open" means the deal's stage is `kind: OPEN`. Counted with a grouped query
 * over the OPEN stage ids rather than per row, so a customer list of 200 is one
 * extra query and not 200.
 */
async function openDealCounts(
  prisma: PrismaClient,
  companyIds: string[],
): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (companyIds.length === 0) return counts;
  const grouped = await prisma.crmDeal.groupBy({
    by: ["companyId"],
    where: {
      companyId: { in: companyIds },
      isArchived: false,
      stage: { kind: "OPEN" },
    },
    _count: { _all: true },
  });
  for (const g of grouped) {
    if (g.companyId) counts.set(g.companyId, g._count._all);
  }
  return counts;
}

export async function listCompanies(
  prisma: PrismaClient,
  opts: { query?: string; includeArchived?: boolean; perPage?: number; page?: number } = {},
): Promise<{ companies: ApiCrmCompany[]; total: number }> {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where: Prisma.CrmCompanyWhereInput = {};
  if (!opts.includeArchived) where.isArchived = false;
  const q = opts.query?.trim();
  if (q) {
    where.OR = [
      { name: { contains: q, mode: "insensitive" } },
      { domain: { contains: normalizeDomain(q) ?? q } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.crmCompany.findMany({
      where,
      include: COMPANY_COUNTS,
      orderBy: { name: "asc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.crmCompany.count({ where }),
  ]);
  const counts = await openDealCounts(prisma, rows.map((r) => r.id));
  const companies = await Promise.all(
    rows.map((r) => companyToApi(prisma, r, counts.get(r.id) ?? 0)),
  );
  return { companies, total };
}

export async function getCompany(prisma: PrismaClient, id: string): Promise<ApiCrmCompany> {
  const row = await prisma.crmCompany.findUnique({ where: { id }, include: COMPANY_COUNTS });
  if (!row) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  const counts = await openDealCounts(prisma, [id]);
  return companyToApi(prisma, row, counts.get(id) ?? 0);
}

export async function createCompany(
  prisma: PrismaClient,
  input: CompanyInput & { name: string },
  actorId: string | null,
): Promise<ApiCrmCompany> {
  const row = await prisma.crmCompany.create({
    data: {
      name: input.name,
      domain: normalizeDomain(input.domain),
      industry: input.industry ?? null,
      phone: input.phone ?? null,
      website: input.website ?? null,
      addressLine1: input.addressLine1 ?? null,
      addressLine2: input.addressLine2 ?? null,
      city: input.city ?? null,
      region: input.region ?? null,
      postalCode: input.postalCode ?? null,
      country: input.country ?? null,
      note: input.note ?? null,
      ownerId: input.ownerId ?? null,
      createdById: actorId,
      origin: "LOCAL",
      activities: {
        create: {
          subjectType: "COMPANY",
          kind: "CREATED",
          summary: `Customer created: ${input.name}`,
          actorId,
        },
      },
    },
    include: COMPANY_COUNTS,
  });
  return companyToApi(prisma, row, 0);
}

export async function updateCompany(
  prisma: PrismaClient,
  id: string,
  input: CompanyInput,
): Promise<ApiCrmCompany> {
  const existing = await prisma.crmCompany.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  await prisma.crmCompany.update({
    where: { id },
    data: {
      name: input.name,
      domain: input.domain === undefined ? undefined : normalizeDomain(input.domain),
      industry: input.industry === undefined ? undefined : input.industry,
      phone: input.phone === undefined ? undefined : input.phone,
      website: input.website === undefined ? undefined : input.website,
      addressLine1: input.addressLine1 === undefined ? undefined : input.addressLine1,
      addressLine2: input.addressLine2 === undefined ? undefined : input.addressLine2,
      city: input.city === undefined ? undefined : input.city,
      region: input.region === undefined ? undefined : input.region,
      postalCode: input.postalCode === undefined ? undefined : input.postalCode,
      country: input.country === undefined ? undefined : input.country,
      note: input.note === undefined ? undefined : input.note,
      ownerId: input.ownerId === undefined ? undefined : input.ownerId,
      ...(input.archived === undefined
        ? {}
        : { isArchived: input.archived, archivedAt: input.archived ? new Date() : null }),
    },
  });
  return getCompany(prisma, id);
}

export async function deleteCompany(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.crmCompany.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  // Deals survive with `companyId = NULL` (SetNull in the schema): losing the
  // account record must not lose the record of the money.
  await prisma.crmCompany.delete({ where: { id } });
}

export async function linkContactToCompany(
  prisma: PrismaClient,
  companyId: string,
  contactId: string,
  input: { title?: string | null; isPrimary?: boolean } = {},
): Promise<void> {
  const [company, contact] = await Promise.all([
    prisma.crmCompany.findUnique({ where: { id: companyId }, select: { id: true } }),
    prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } }),
  ]);
  if (!company) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  if (!contact) throw new Error(CRM_ERRORS.CONTACT_NOT_FOUND);
  try {
    await prisma.crmCompanyContact.create({
      data: { companyId, contactId, title: input.title ?? null, isPrimary: input.isPrimary ?? false },
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error(CRM_ERRORS.DUPLICATE_LINK);
    throw err;
  }
}

export async function unlinkContactFromCompany(
  prisma: PrismaClient,
  companyId: string,
  contactId: string,
): Promise<void> {
  const { count } = await prisma.crmCompanyContact.deleteMany({ where: { companyId, contactId } });
  if (count === 0) throw new Error(CRM_ERRORS.CONTACT_NOT_FOUND);
}

// ── Deals ────────────────────────────────────────────────────────────────────

export interface DealInput {
  title?: string;
  companyId?: string | null;
  pipelineId?: string;
  stageId?: string;
  /** Decimal string of minor units. A string, never a number — see the header. */
  amountMinor?: string | null;
  currency?: string | null;
  expectedCloseOn?: string | null;
  closeReason?: string | null;
  ownerId?: string | null;
  projectId?: string | null;
  archived?: boolean;
}

/**
 * Amount and currency are all-or-nothing, matched to the CHECK constraint. The
 * validation lives here as well as in Postgres so the caller gets a 422 naming
 * the problem rather than a driver error naming a constraint.
 */
function resolveAmount(
  amountMinor: string | null | undefined,
  currency: string | null | undefined,
  current: { amountMinor: bigint | null; currency: string | null },
): { amountMinor: bigint | null; currency: string | null } {
  const nextAmount =
    amountMinor === undefined ? current.amountMinor : amountMinor === null ? null : BigInt(amountMinor);
  const nextCurrency = currency === undefined ? current.currency : currency;
  if ((nextAmount === null) !== (nextCurrency === null)) {
    throw new Error(CRM_ERRORS.AMOUNT_NEEDS_CURRENCY);
  }
  return { amountMinor: nextAmount, currency: nextCurrency };
}

/** The stage must belong to the pipeline the deal is in. */
async function requireStageInPipeline(
  prisma: PrismaClient,
  stageId: string,
  pipelineId: string,
): Promise<Prisma.CrmPipelineStageGetPayload<{ select: typeof STAGE_SELECT }>> {
  const stage = await prisma.crmPipelineStage.findUnique({ where: { id: stageId }, select: STAGE_SELECT });
  if (!stage) throw new Error(CRM_ERRORS.STAGE_NOT_FOUND);
  if (stage.pipelineId !== pipelineId) throw new Error(CRM_ERRORS.INVALID_STAGE);
  return stage;
}

export interface ListDealsOptions {
  pipelineId?: string;
  stageId?: string;
  companyId?: string;
  ownerId?: string;
  /** Filter by outcome class, not by stage name. */
  kind?: "OPEN" | "WON" | "LOST";
  includeArchived?: boolean;
  /** Deals whose most recent timeline entry is older than N days. */
  idleDays?: number;
  perPage?: number;
  page?: number;
}

export async function listDeals(
  prisma: PrismaClient,
  opts: ListDealsOptions = {},
): Promise<{ deals: ApiCrmDeal[]; total: number }> {
  const perPage = Math.min(Math.max(opts.perPage ?? 100, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where: Prisma.CrmDealWhereInput = {};
  if (!opts.includeArchived) where.isArchived = false;
  if (opts.pipelineId) where.pipelineId = opts.pipelineId;
  if (opts.stageId) where.stageId = opts.stageId;
  if (opts.companyId) where.companyId = opts.companyId;
  if (opts.ownerId) where.ownerId = opts.ownerId;
  if (opts.kind) where.stage = { kind: opts.kind };
  if (opts.idleDays !== undefined) {
    const cutoff = new Date(Date.now() - opts.idleDays * 24 * 60 * 60 * 1000);
    // "Idle" is about the last INTERACTION, so it reads the timeline. A deal
    // with no activity at all is idle by its creation date, which is why the
    // OR arm exists — `none` rather than treating absence as "recently active".
    where.OR = [
      { activities: { none: {} }, createdAt: { lt: cutoff } },
      { activities: { every: { occurredAt: { lt: cutoff } } } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.crmDeal.findMany({
      where,
      include: DEAL_INCLUDE,
      orderBy: [{ stage: { sortOrder: "asc" } }, { updatedAt: "desc" }],
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.crmDeal.count({ where }),
  ]);
  return { deals: rows.map(dealToApi), total };
}

export async function getDeal(prisma: PrismaClient, id: string): Promise<ApiCrmDeal> {
  const row = await prisma.crmDeal.findUnique({ where: { id }, include: DEAL_INCLUDE });
  if (!row) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);
  return dealToApi(row);
}

export async function createDeal(
  prisma: PrismaClient,
  input: DealInput & { title: string },
  actorId: string | null,
): Promise<ApiCrmDeal> {
  const pipeline = input.pipelineId
    ? await getPipeline(prisma, input.pipelineId)
    : await ensureDefaultPipeline(prisma);

  // Default landing stage: the lowest-ordered OPEN stage. Not "the first
  // stage" — a pipeline whose first column is a LOST bucket is legal.
  const stageId =
    input.stageId ??
    pipeline.stages.find((s) => s.kind === "OPEN")?.id ??
    pipeline.stages[0]?.id;
  if (!stageId) throw new Error(CRM_ERRORS.STAGE_NOT_FOUND);
  const stage = await requireStageInPipeline(prisma, stageId, pipeline.id);

  if (input.companyId) {
    const company = await prisma.crmCompany.findUnique({
      where: { id: input.companyId },
      select: { id: true },
    });
    if (!company) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  }

  const { amountMinor, currency } = resolveAmount(input.amountMinor, input.currency, {
    amountMinor: null,
    currency: null,
  });

  const row = await prisma.crmDeal.create({
    data: {
      title: input.title,
      companyId: input.companyId ?? null,
      pipelineId: pipeline.id,
      stageId: stage.id,
      amountMinor,
      currency,
      expectedCloseOn: input.expectedCloseOn ? new Date(input.expectedCloseOn) : null,
      // A deal created directly into a WON/LOST stage is closed on creation —
      // read from `stage.kind`, never assumed to be OPEN.
      closedAt: stage.kind === "OPEN" ? null : new Date(),
      ownerId: input.ownerId ?? null,
      projectId: input.projectId ?? null,
      createdById: actorId,
      origin: "LOCAL",
      activities: {
        create: {
          subjectType: "DEAL",
          kind: "CREATED",
          summary: `Deal created: ${input.title}`,
          actorId,
        },
      },
    },
    include: DEAL_INCLUDE,
  });
  return dealToApi(row);
}

export async function updateDeal(
  prisma: PrismaClient,
  id: string,
  input: DealInput,
  actorId: string | null,
): Promise<ApiCrmDeal> {
  const existing = await prisma.crmDeal.findUnique({ where: { id } });
  if (!existing) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);

  // A stage move through this route goes through the same path the board uses,
  // so the timeline gets its STAGE_CHANGE either way rather than only when the
  // caller happened to use the dedicated endpoint.
  if (input.stageId && input.stageId !== existing.stageId) {
    await moveDealStage(prisma, id, input.stageId, actorId);
  }

  const { amountMinor, currency } = resolveAmount(input.amountMinor, input.currency, {
    amountMinor: existing.amountMinor,
    currency: existing.currency,
  });

  if (input.companyId) {
    const company = await prisma.crmCompany.findUnique({
      where: { id: input.companyId },
      select: { id: true },
    });
    if (!company) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  }

  await prisma.crmDeal.update({
    where: { id },
    data: {
      title: input.title,
      companyId: input.companyId === undefined ? undefined : input.companyId,
      amountMinor,
      currency,
      expectedCloseOn:
        input.expectedCloseOn === undefined
          ? undefined
          : input.expectedCloseOn === null
            ? null
            : new Date(input.expectedCloseOn),
      closeReason: input.closeReason === undefined ? undefined : input.closeReason,
      ownerId: input.ownerId === undefined ? undefined : input.ownerId,
      projectId: input.projectId === undefined ? undefined : input.projectId,
      ...(input.archived === undefined
        ? {}
        : { isArchived: input.archived, archivedAt: input.archived ? new Date() : null }),
    },
  });
  return getDeal(prisma, id);
}

/**
 * The write with the most blast radius: it is what the forecast reads. Writes a
 * `STAGE_CHANGE` activity in the same transaction as the move, so the timeline
 * cannot disagree with the board.
 *
 * `closedAt` is maintained here and nowhere else: set when entering a non-OPEN
 * stage, cleared when returning to an OPEN one. It is an audit timestamp — the
 * OUTCOME is always `stage.kind`, so nothing needs to read `closedAt` to know
 * whether a deal is won.
 */
export async function moveDealStage(
  prisma: PrismaClient,
  dealId: string,
  stageId: string,
  actorId: string | null,
): Promise<ApiCrmDeal> {
  const deal = await prisma.crmDeal.findUnique({
    where: { id: dealId },
    include: { stage: { select: STAGE_SELECT } },
  });
  if (!deal) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);
  const target = await requireStageInPipeline(prisma, stageId, deal.pipelineId);
  if (target.id === deal.stageId) return getDeal(prisma, dealId);

  await prisma.$transaction([
    prisma.crmDeal.update({
      where: { id: dealId },
      data: {
        stageId: target.id,
        closedAt: target.kind === "OPEN" ? null : (deal.closedAt ?? new Date()),
      },
    }),
    prisma.crmActivity.create({
      data: {
        subjectType: "DEAL",
        dealId,
        kind: "STAGE_CHANGE",
        summary: `${deal.stage.name} → ${target.name}`,
        actorId,
        fromStageId: deal.stageId,
        toStageId: target.id,
      },
    }),
  ]);
  return getDeal(prisma, dealId);
}

export async function deleteDeal(prisma: PrismaClient, id: string): Promise<void> {
  const existing = await prisma.crmDeal.findUnique({ where: { id }, select: { id: true } });
  if (!existing) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);
  await prisma.crmDeal.delete({ where: { id } });
}

export async function linkContactToDeal(
  prisma: PrismaClient,
  dealId: string,
  contactId: string,
  role?: string | null,
): Promise<void> {
  const [deal, contact] = await Promise.all([
    prisma.crmDeal.findUnique({ where: { id: dealId }, select: { id: true } }),
    prisma.contact.findUnique({ where: { id: contactId }, select: { id: true } }),
  ]);
  if (!deal) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);
  if (!contact) throw new Error(CRM_ERRORS.CONTACT_NOT_FOUND);
  try {
    await prisma.crmDealContact.create({ data: { dealId, contactId, role: role ?? null } });
  } catch (err) {
    if (isUniqueViolation(err)) throw new Error(CRM_ERRORS.DUPLICATE_LINK);
    throw err;
  }
}

export async function unlinkContactFromDeal(
  prisma: PrismaClient,
  dealId: string,
  contactId: string,
): Promise<void> {
  const { count } = await prisma.crmDealContact.deleteMany({ where: { dealId, contactId } });
  if (count === 0) throw new Error(CRM_ERRORS.CONTACT_NOT_FOUND);
}

// ── Timeline ─────────────────────────────────────────────────────────────────

export interface ActivityInput {
  subjectType: "COMPANY" | "CONTACT" | "DEAL";
  companyId?: string | null;
  contactId?: string | null;
  dealId?: string | null;
  kind: "NOTE" | "EMAIL" | "CALL" | "MEETING" | "TASK";
  summary: string;
  occurredAt?: string;
  noteId?: string | null;
  emailMessageId?: string | null;
  calendarEventId?: string | null;
  workItemId?: string | null;
}

/**
 * `STAGE_CHANGE`, `CREATED` and `SYNCED` are written by the box, never by a
 * caller — a hand-written stage change with no move behind it would make the
 * timeline lie about what happened. The route layer's zod enum is the first
 * gate; this is the second, so a non-route caller cannot skip it.
 */
export async function logActivity(
  prisma: PrismaClient,
  input: ActivityInput,
  actorId: string | null,
): Promise<ApiCrmActivity> {
  const subjectId =
    input.subjectType === "COMPANY"
      ? input.companyId
      : input.subjectType === "CONTACT"
        ? input.contactId
        : input.dealId;
  if (!subjectId) throw new Error("activity_needs_a_subject");

  // Verify the subject exists before writing. The CHECK constraint enforces
  // the exactly-one shape; it cannot enforce that the row pointed at is real.
  if (input.subjectType === "COMPANY") {
    const c = await prisma.crmCompany.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!c) throw new Error(CRM_ERRORS.COMPANY_NOT_FOUND);
  } else if (input.subjectType === "CONTACT") {
    const c = await prisma.contact.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!c) throw new Error(CRM_ERRORS.CONTACT_NOT_FOUND);
  } else {
    const d = await prisma.crmDeal.findUnique({ where: { id: subjectId }, select: { id: true } });
    if (!d) throw new Error(CRM_ERRORS.DEAL_NOT_FOUND);
  }

  const row = await prisma.crmActivity.create({
    data: {
      subjectType: input.subjectType,
      companyId: input.subjectType === "COMPANY" ? subjectId : null,
      contactId: input.subjectType === "CONTACT" ? subjectId : null,
      dealId: input.subjectType === "DEAL" ? subjectId : null,
      kind: input.kind,
      summary: input.summary,
      actorId,
      occurredAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
      noteId: input.noteId ?? null,
      emailMessageId: input.emailMessageId ?? null,
      calendarEventId: input.calendarEventId ?? null,
      workItemId: input.workItemId ?? null,
      origin: "LOCAL",
    },
  });
  return activityToApi(row);
}

export async function listActivities(
  prisma: PrismaClient,
  subject: { subjectType: "COMPANY" | "CONTACT" | "DEAL"; id: string },
  opts: { perPage?: number; page?: number } = {},
): Promise<{ activities: ApiCrmActivity[]; total: number }> {
  const perPage = Math.min(Math.max(opts.perPage ?? 50, 1), 200);
  const page = Math.max(opts.page ?? 1, 1);
  const where: Prisma.CrmActivityWhereInput =
    subject.subjectType === "COMPANY"
      ? { companyId: subject.id }
      : subject.subjectType === "CONTACT"
        ? { contactId: subject.id }
        : { dealId: subject.id };

  const [rows, total] = await Promise.all([
    prisma.crmActivity.findMany({
      where,
      orderBy: { occurredAt: "desc" },
      skip: (page - 1) * perPage,
      take: perPage,
    }),
    prisma.crmActivity.count({ where }),
  ]);
  return { activities: rows.map(activityToApi), total };
}

// ── Summary ──────────────────────────────────────────────────────────────────

/**
 * Count and value per stage — what the board header and "how's the quarter
 * looking" both read.
 *
 * Currency is reported as null when a stage holds deals in more than one, and
 * the amounts are NOT summed across them. Adding 500 EUR to 500 USD produces a
 * number that looks authoritative and means nothing; a null currency at least
 * says so.
 */
export async function getPipelineSummary(
  prisma: PrismaClient,
  pipelineId?: string,
): Promise<{ pipelineId: string; stages: ApiCrmStageSummary[] }> {
  const pipeline = pipelineId
    ? await getPipeline(prisma, pipelineId)
    : await ensureDefaultPipeline(prisma);

  const deals = await prisma.crmDeal.findMany({
    where: { pipelineId: pipeline.id, isArchived: false },
    select: { stageId: true, amountMinor: true, currency: true },
  });

  const byStage = new Map<string, { count: number; total: bigint; currencies: Set<string> }>();
  for (const stage of pipeline.stages) {
    byStage.set(stage.id, { count: 0, total: 0n, currencies: new Set() });
  }
  for (const deal of deals) {
    const bucket = byStage.get(deal.stageId);
    if (!bucket) continue;
    bucket.count += 1;
    // ONE predicate decides whether this deal is priced, and it gates BOTH
    // halves of the bucket.
    //
    // These used to be two independent conditions, and they disagreed on the
    // empty string: `if (deal.currency)` skipped `currencies`, while the
    // amount still landed in `total`. A row like `{ amountMinor: 50000n,
    // currency: "" }` then left `currencies` empty — so the stage read
    // `unpriced`, and `unpriced` reports `amountMinor: "0"`, silently
    // discarding real money and telling the model "no amounts entered yet"
    // for a stage that has some. Exactly the false-statement class WARP-2556
    // set out to remove, reintroduced through a narrower door.
    //
    // Postgres only enforces null-PAIRING (`CHECK`: both null or both set),
    // not non-emptiness, so an import, a migration, or a future caller of the
    // exported deal writers can produce that row without going through the
    // Zod schema that would reject it. Pairing the two conditions here makes
    // `total` unconditionally the sum of amounts denominated in `currencies`
    // — an invariant the three-state valuation below can rely on, instead of
    // one the database happens not to violate today.
    const currency = deal.currency?.trim() || null;
    if (currency !== null && deal.amountMinor !== null) {
      bucket.currencies.add(currency);
      bucket.total += deal.amountMinor;
    }
  }

  return {
    pipelineId: pipeline.id,
    stages: pipeline.stages.map((stage) => {
      const bucket = byStage.get(stage.id)!;
      // WARP-2556 — THREE states, named. This used to be two, and the missing
      // one was the common case.
      //
      // `currency: mixed ? null : ([...currencies][0] ?? null)` collapsed
      // "several currencies, cannot sum" and "nothing here is priced" onto the
      // identical wire shape — `{ amountMinor: "0", currency: null }` — and the
      // tool read that as proof of mixing. So a fresh stage full of unpriced
      // deals told the model "mixed currencies", on essentially every new box.
      //
      // Discriminated explicitly rather than inferred from a null, which is
      // the same rule that made `origin` and `isArchived` real columns
      // (WARP-884). A reader never has to work out which null they have.
      const valuation: CrmStageValuation =
        bucket.currencies.size > 1
          ? "mixed_currencies"
          : bucket.currencies.size === 0
            ? "unpriced"
            : "priced";
      return {
        stageId: stage.id,
        stageName: stage.name,
        kind: stage.kind,
        sortOrder: stage.sortOrder,
        dealCount: bucket.count,
        valuation,
        // Only meaningful when `valuation === "priced"`. Kept as "0"/null in
        // the other two rather than omitted so the field's TYPE does not vary
        // by state — callers branch on `valuation`, never on these.
        amountMinor: valuation === "priced" ? bucket.total.toString() : "0",
        currency: valuation === "priced" ? [...bucket.currencies][0] : null,
      };
    }),
  };
}
