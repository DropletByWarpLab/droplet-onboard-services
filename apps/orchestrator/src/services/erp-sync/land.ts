/**
 * The landing seam — where a canonical row read from a connector becomes a
 * record on this box (WARP-2549).
 *
 * Until this module existed the sync tick was a machine that read customer data
 * and dropped it: `erp-sync.service.ts` moved cursors and watermarks and
 * persisted nothing, so a customer who exists in HubSpot did not exist here.
 * The only live read path was `cloud_query_dataset`, which answers one question
 * over HTTP and keeps nothing. That is the opposite of what ADR-041 §4 says the
 * cloud tracks are FOR — the local copy is the point.
 *
 * ## What lands, and what deliberately does not
 *
 * `company`, `contact` and `deal` land, into the CRM tables a human already
 * types into. `patient`, `appointment` and `account` land NOWHERE and there is
 * no flag that turns that on: PHI has one home on this box, behind one gate
 * (`canRead` on the ERP router), and a patient projected into an address book
 * with no `canViewPhi` check is the exact disclosure ADR-044 §3 forbids.
 * `ticket` and `engagement` are not landed either — a support ticket has no CRM
 * home yet, and an engagement cannot satisfy `CrmActivity`'s exactly-one-subject
 * CHECK because HubSpot's search API returns a property bag with no association
 * data (`contact_id` and `deal_id` are present-and-undefined on every row).
 *
 * ## Why this file does not call `crm.service.ts`
 *
 * That service is route-facing and LOCAL-only. Its inputs back `.strict()` zod
 * bodies, so teaching it to accept `connectionId` / `externalSystem` /
 * `externalId` would let an HTTP request FORGE provenance — claim a row came
 * from a connector it never came from, and inherit the edit refusals that go
 * with that claim. Landing writes through the transaction client directly, and
 * the two paths stay unable to impersonate each other.
 *
 * ## Why not `upsert`
 *
 * The reconcile key is `(connectionId, externalId)` and both columns are
 * nullable, so Prisma's generated `where` for the compound unique compares
 * NULLs — and `NULL = NULL` is false in Postgres, so the upsert would never
 * match and would create a duplicate on every tick. `updateMany`-then-`create`
 * with a P2002 retry is the shape that survives both that and a concurrent
 * tick: two ticks racing on the same row have one create and one retry, and the
 * retry updates.
 *
 * ## The one column a landing must never write
 *
 * 🔴 `isArchived` is OWNER state on a synced row — the only column on a landed
 * record that is not vendor-owned. It is how a person gets a synced customer
 * off their screen when the upstream will not stop sending it (WARP-2554). A
 * landing that wrote the whole row would un-archive it on the next tick, and
 * the owner's only available action would silently stop working.
 */
import { Prisma } from "@prisma/client";
import { providerDescriptor } from "@droplet/shared-types";

import { toMinorUnits } from "@droplet/shared-types";
import { createLogger } from "../../lib/logger.js";

const logger = createLogger("erp-sync-land");

/** The tables a landing touches. Narrow on purpose — it is also the mock's shape. */
export type LandingDb = Pick<
  Prisma.TransactionClient,
  | "user"
  | "contact"
  | "contactEmail"
  | "crmCompany"
  | "crmCompanyContact"
  | "crmDeal"
  | "crmPipeline"
  | "crmPipelineStage"
>;

export interface LandingConnection {
  readonly id: string;
  readonly provider: string;
}

/** Why a row was not landed. `null` on the ordinary path. */
export type LandSkipReason =
  /** The dataset has no CRM home, or is PHI and never will have one. */
  | "not-landed"
  /** A contact is owner-scoped and this box has no owner to scope it to. */
  | "no-owner"
  /** The vendor row carried no id, so nothing could reconcile it. */
  | "unidentified";

export interface LandOutcome {
  readonly entity: string;
  readonly landed: number;
  readonly skipped: number;
  readonly reason: LandSkipReason | null;
}

/** Datasets that land in the CRM. */
export const LANDED_ENTITIES = ["company", "contact", "deal"] as const;

/**
 * Datasets that must never land, listed so the refusal is a decision a reader
 * meets rather than an absence they have to notice. PHI on this box is
 * read-through, per connector, behind the ERP gate.
 */
export const NEVER_LANDED_ENTITIES = ["patient", "appointment", "account"] as const;

export function landsInCrm(entity: string): boolean {
  return (LANDED_ENTITIES as readonly string[]).includes(entity);
}

type Row = Record<string, unknown>;

function asRow(value: unknown): Row | null {
  return typeof value === "object" && value !== null ? (value as Row) : null;
}

/** A trimmed non-empty string, or null. Empty string is absence, not a value. */
function str(row: Row, key: string): string | null {
  const value = row[key];
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * A vendor timestamp, or null. Never `new Date(undefined)` — that is Invalid
 * Date, which Prisma accepts into a nullable column and Postgres then rejects
 * mid-transaction, taking the whole tick down for one bad row.
 */
function date(row: Row, key: string): Date | null {
  const raw = str(row, key);
  if (raw === null) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "P2002"
  );
}

/**
 * HubSpot's default pipeline uses two well-known internal ids for its terminal
 * stages. Everything else — including every stage of a custom pipeline, whose
 * ids are opaque — is OPEN.
 *
 * 🔴 We never INFER an outcome from `closed_at`. A closed date says the deal
 * stopped moving; it does not say whether the business won it, and a lost deal
 * filed as won is a number the owner will act on. An unmapped closed stage
 * lands OPEN and stays visibly open, which is wrong in the direction a human
 * can see and correct.
 */
const TERMINAL_STAGE_KINDS: Readonly<Record<string, "WON" | "LOST">> = {
  closedwon: "WON",
  closedlost: "LOST",
};

function stageKindFor(externalKey: string): "OPEN" | "WON" | "LOST" {
  return TERMINAL_STAGE_KINDS[externalKey.toLowerCase()] ?? "OPEN";
}

/** The vendor's display name, for anything a person will read. */
function vendorLabel(provider: string): string {
  return providerDescriptor(provider)?.displayName ?? provider;
}

/**
 * Land one page of canonical rows.
 *
 * Runs inside the caller's transaction: landing and the watermark advance must
 * commit together, or a crash between them loses rows the cursor has already
 * declared read.
 */
export async function landCanonicalRows(
  db: LandingDb,
  args: {
    readonly connection: LandingConnection;
    readonly entity: string;
    readonly rows: readonly unknown[];
    readonly now: Date;
  },
): Promise<LandOutcome> {
  const { connection, entity, rows } = args;

  if (!landsInCrm(entity)) {
    return { entity, landed: 0, skipped: rows.length, reason: "not-landed" };
  }

  if (entity === "company") return landCompanies(db, connection, rows);
  if (entity === "contact") return landContacts(db, connection, rows);
  return landDeals(db, connection, rows);
}

// ── company ─────────────────────────────────────────────────────────────────

async function landCompanies(
  db: LandingDb,
  connection: LandingConnection,
  rows: readonly unknown[],
): Promise<LandOutcome> {
  let landed = 0;
  let skipped = 0;

  for (const raw of rows) {
    const row = asRow(raw);
    const externalId = row === null ? null : str(row, "company_id");
    if (row === null || externalId === null) {
      skipped += 1;
      continue;
    }

    const domain = str(row, "domain");
    // `name` is NOT NULL and a vendor record can genuinely have none. The
    // fallbacks are in descending order of what a person would recognise; the
    // last one is ugly on purpose, because a row identified only by its id
    // should LOOK like one rather than like a customer nobody named.
    const name = str(row, "name") ?? domain ?? `${vendorLabel(connection.provider)} ${externalId}`;

    const vendorOwned = { name, domain };

    const updated = await db.crmCompany.updateMany({
      where: { connectionId: connection.id, externalId },
      data: vendorOwned,
    });
    if (updated.count === 0) {
      try {
        await db.crmCompany.create({
          data: {
            ...vendorOwned,
            origin: "EXTERNAL",
            connectionId: connection.id,
            externalSystem: connection.provider,
            externalId,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        // A concurrent tick created it between the updateMany and the create.
        await db.crmCompany.updateMany({
          where: { connectionId: connection.id, externalId },
          data: vendorOwned,
        });
      }
    }
    landed += 1;
  }

  return { entity: "company", landed, skipped, reason: skipped > 0 ? "unidentified" : null };
}

// ── contact ─────────────────────────────────────────────────────────────────

/**
 * Contacts are owner-scoped (`Contact.userId`), and an `IntegrationConnection`
 * has no owner column — nothing on the connection says whose address book a
 * synced person belongs in. The box's owner is the only defensible answer: they
 * are the account that can already read every CRM surface, and the alternative
 * (inventing a shared null-owner contact) would need a second read model on a
 * table whose every index starts with `userId`.
 *
 * Deterministic, because "whichever owner the query happened to return" would
 * move a customer's contacts between address books on an unrelated day. If the
 * box has no owner at all, contacts do not land and say so — WARP-2016 already
 * guards against a box reaching that state, and guessing here would hide it.
 */
async function ownerUserId(db: LandingDb): Promise<string | null> {
  const owner = await db.user.findFirst({
    where: { role: "owner" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  return owner?.id ?? null;
}

async function landContacts(
  db: LandingDb,
  connection: LandingConnection,
  rows: readonly unknown[],
): Promise<LandOutcome> {
  const userId = await ownerUserId(db);
  if (userId === null) {
    logger.warn(
      {
        connectionId: connection.id,
        provider: connection.provider,
        rows: rows.length,
      },
      "contacts not landed: this box has no owner account",
    );
    return { entity: "contact", landed: 0, skipped: rows.length, reason: "no-owner" };
  }

  let landed = 0;
  let skipped = 0;

  for (const raw of rows) {
    const row = asRow(raw);
    const externalId = row === null ? null : str(row, "contact_id");
    if (row === null || externalId === null) {
      skipped += 1;
      continue;
    }

    const givenName = str(row, "first_name");
    const familyName = str(row, "last_name");
    const email = str(row, "email");
    const displayName =
      [givenName, familyName].filter((part) => part !== null).join(" ").trim() ||
      email ||
      `${vendorLabel(connection.provider)} ${externalId}`;

    // `isArchived`/`archivedAt` are absent from this object on purpose — see
    // the file header. The owner's decision to archive survives every tick.
    const vendorOwned = { displayName, givenName, familyName, userId };

    const updated = await db.contact.updateMany({
      where: { connectionId: connection.id, externalId },
      data: vendorOwned,
    });
    if (updated.count === 0) {
      try {
        await db.contact.create({
          data: {
            ...vendorOwned,
            origin: "EXTERNAL",
            connectionId: connection.id,
            externalSystem: connection.provider,
            externalId,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await db.contact.updateMany({
          where: { connectionId: connection.id, externalId },
          data: vendorOwned,
        });
      }
    }

    const contact = await db.contact.findFirst({
      where: { connectionId: connection.id, externalId },
      select: { id: true },
    });
    if (contact !== null) {
      await landContactEmail(db, contact.id, email);
      await linkContactToCompany(db, connection, contact.id, str(row, "company_id"));
    }
    landed += 1;
  }

  return { entity: "contact", landed, skipped, reason: skipped > 0 ? "unidentified" : null };
}

/**
 * The vendor owns this person's addresses, so the landed set is REPLACED rather
 * than merged: a merge would keep an address the customer deleted upstream,
 * which is the failure mode that gets an email sent to a former employee.
 */
async function landContactEmail(
  db: LandingDb,
  contactId: string,
  email: string | null,
): Promise<void> {
  await db.contactEmail.deleteMany({ where: { contactId } });
  if (email === null) return;
  await db.contactEmail.create({
    data: {
      contactId,
      address: email,
      // `addressLower` is the lookup column; deriving it here rather than
      // trusting the vendor's casing is what makes the reconcile key stable.
      addressLower: email.toLowerCase(),
      isPrimary: true,
    },
  });
}

/**
 * `contact.company_id` is the ONE association HubSpot's search API can supply —
 * `deal.company_id`, `ticket.contact_id` and both engagement links come back
 * present-and-undefined, because search returns a property bag with no
 * association data. Landing the association we do have is what makes a customer
 * record show its people.
 */
async function linkContactToCompany(
  db: LandingDb,
  connection: LandingConnection,
  contactId: string,
  companyExternalId: string | null,
): Promise<void> {
  if (companyExternalId === null) return;
  const company = await db.crmCompany.findFirst({
    where: { connectionId: connection.id, externalId: companyExternalId },
    select: { id: true },
  });
  // The company may not have landed yet — its cursor is a different entity on
  // a different tick. Nothing is created for a company we have not seen; the
  // next contact tick after the company lands makes the link.
  if (company === null) return;
  const existing = await db.crmCompanyContact.findFirst({
    where: { companyId: company.id, contactId },
    select: { id: true },
  });
  if (existing !== null) return;
  try {
    await db.crmCompanyContact.create({ data: { companyId: company.id, contactId } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
}

// ── deal ────────────────────────────────────────────────────────────────────

/**
 * One pipeline per connection, created on the first landed deal.
 *
 * The owner's own board stays theirs: a vendor's stage set is not the owner's,
 * and mapping between them would either invent a correspondence nobody agreed
 * or dump every synced deal into whichever stage sorted first.
 */
async function syncedPipeline(
  db: LandingDb,
  connection: LandingConnection,
): Promise<{ id: string }> {
  const existing = await db.crmPipeline.findFirst({
    where: { connectionId: connection.id },
    select: { id: true },
  });
  if (existing !== null) return existing;
  try {
    return await db.crmPipeline.create({
      data: {
        name: vendorLabel(connection.provider),
        connectionId: connection.id,
        // NOT the default pipeline: a deal a human creates must not land on a
        // board whose stages a vendor renames.
        isDefault: false,
      },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await db.crmPipeline.findFirst({
      where: { connectionId: connection.id },
      select: { id: true },
    });
    if (raced === null) throw err;
    return raced;
  }
}

/** A stage per distinct vendor stage value, keyed on the vendor's own string. */
async function syncedStage(
  db: LandingDb,
  pipelineId: string,
  externalKey: string,
): Promise<{ id: string }> {
  const existing = await db.crmPipelineStage.findFirst({
    where: { pipelineId, externalKey },
    select: { id: true },
  });
  if (existing !== null) return existing;

  // `sortOrder` is unique per pipeline, so it is taken from the current tail
  // rather than from a count — a deleted stage would make a count collide.
  const tail = await db.crmPipelineStage.findFirst({
    where: { pipelineId },
    orderBy: { sortOrder: "desc" },
    select: { sortOrder: true },
  });
  const sortOrder = (tail?.sortOrder ?? -1) + 1;

  try {
    return await db.crmPipelineStage.create({
      data: {
        pipelineId,
        externalKey,
        name: externalKey,
        sortOrder,
        kind: stageKindFor(externalKey),
      },
      select: { id: true },
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = await db.crmPipelineStage.findFirst({
      where: { pipelineId, externalKey },
      select: { id: true },
    });
    if (raced === null) throw err;
    return raced;
  }
}

async function landDeals(
  db: LandingDb,
  connection: LandingConnection,
  rows: readonly unknown[],
): Promise<LandOutcome> {
  let landed = 0;
  let skipped = 0;
  let pipelineId: string | null = null;

  for (const raw of rows) {
    const row = asRow(raw);
    const externalId = row === null ? null : str(row, "deal_id");
    if (row === null || externalId === null) {
      skipped += 1;
      continue;
    }

    // Built lazily: a connection whose deal cursor only ever returns empty
    // pages never acquires an empty pipeline on somebody's board.
    if (pipelineId === null) pipelineId = (await syncedPipeline(db, connection)).id;

    const externalKey = str(row, "stage") ?? "unstaged";
    const stage = await syncedStage(db, pipelineId, externalKey);
    const kind = stageKindFor(externalKey);

    // Amount and currency are all-or-nothing, matching the CHECK on the table.
    // `toMinorUnits` refuses anything it cannot represent exactly — a vendor
    // priced in thousandths lands with NO amount rather than a rounded one.
    const currency = str(row, "currency");
    const amountRaw = str(row, "amount");
    const amountMinor =
      currency !== null && amountRaw !== null ? toMinorUnits(amountRaw, currency) : null;

    const company =
      str(row, "company_id") === null
        ? null
        : await db.crmCompany.findFirst({
            where: { connectionId: connection.id, externalId: str(row, "company_id") as string },
            select: { id: true },
          });

    const vendorOwned = {
      title: str(row, "name") ?? `${vendorLabel(connection.provider)} ${externalId}`,
      stageId: stage.id,
      pipelineId,
      companyId: company?.id ?? null,
      amountMinor,
      currency: amountMinor === null ? null : currency,
      // `closedAt` is maintained ONLY where the stage says the deal is closed,
      // which is the same rule `moveDealStage` follows for locally typed deals.
      closedAt: kind === "OPEN" ? null : date(row, "closed_at"),
    };

    const updated = await db.crmDeal.updateMany({
      where: { connectionId: connection.id, externalId },
      data: vendorOwned,
    });
    if (updated.count === 0) {
      try {
        await db.crmDeal.create({
          data: {
            ...vendorOwned,
            origin: "EXTERNAL",
            connectionId: connection.id,
            externalSystem: connection.provider,
            externalId,
          },
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
        await db.crmDeal.updateMany({
          where: { connectionId: connection.id, externalId },
          data: vendorOwned,
        });
      }
    }
    landed += 1;
  }

  return { entity: "deal", landed, skipped, reason: skipped > 0 ? "unidentified" : null };
}
