/**
 * WARP-2018 (contacts) + WARP-2117 (CRM core) — schema shape tests.
 *
 * Nothing consumes these models yet, which is exactly why the shape is worth
 * pinning now: a wrong column is cheap today and expensive after the sync
 * paths are written against it.
 *
 * These read the schema and migration SQL as SOURCE, following the house
 * pattern in `access-role.schema.test.ts` and `integration-status.schema.test.ts`.
 * Each block names the mutation that must turn it red — a test that cannot
 * fail is the repo's most-repeated review finding.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

function findPrismaDir(): string {
  const candidates = [
    join(process.cwd(), "prisma"),
    join(process.cwd(), "apps", "orchestrator", "prisma"),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "schema.prisma"))) return resolve(candidate);
  }
  throw new Error(
    `Could not locate prisma/schema.prisma from ${process.cwd()} — tried ${candidates.join(", ")}`,
  );
}

const PRISMA_DIR = findPrismaDir();
const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");
const MIGRATIONS_DIR = join(PRISMA_DIR, "migrations");

/** The body of a `model X { … }` block, or throws naming the missing model. */
function modelBlock(name: string): string {
  const match = schema.match(new RegExp(`\\nmodel\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

/** Enum members, ignoring `///` docstrings — every enum here carries them. */
function enumMembers(name: string): string[] {
  const match = schema.match(new RegExp(`\\nenum\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`));
  if (!match) throw new Error(`enum ${name} not found in schema.prisma`);
  return match[1]
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("//") && !l.startsWith("///"));
}

/** The single line declaring `field` inside `model`, whitespace-collapsed. */
function fieldLine(model: string, field: string): string {
  const line = modelBlock(model)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => new RegExp(`^${field}\\s`).test(l));
  if (!line) throw new Error(`field ${model}.${field} not found`);
  return line.replace(/\s+/g, " ");
}

const MIGRATION_DIRS = readdirSync(MIGRATIONS_DIR).filter((d) =>
  existsSync(join(MIGRATIONS_DIR, d, "migration.sql")),
);
const MODULE_ID_MIGRATION = "20260829000000_warp_2117_module_ids";
const TABLES_MIGRATION = "20260829001000_warp_2117_contacts_crm";
const moduleIdSql = readFileSync(join(MIGRATIONS_DIR, MODULE_ID_MIGRATION, "migration.sql"), "utf8");
const tablesSql = readFileSync(join(MIGRATIONS_DIR, TABLES_MIGRATION, "migration.sql"), "utf8");

describe("WARP-2018 — the one contact entity", () => {
  it("gives AddressBookSource an explicit non-nullable status column", () => {
    // Mutation: delete `status` and let the dashboard read `lastSyncError` →
    // red. That derive-from-NULL shape is what WARP-218 forbids and what
    // CalendarSource still does.
    const line = fieldLine("AddressBookSource", "status");
    expect(line).toBe("status AddressBookStatus @default(NOT_CONFIGURED)");
    expect(line).not.toContain("?");
  });

  it("splits AUTH_FAILED from DEGRADED so a dead credential backs off", () => {
    // Mutation: collapse AUTH_FAILED into DEGRADED → red. They differ in
    // behaviour: DEGRADED retries, AUTH_FAILED must not retry into a lockout.
    expect(enumMembers("AddressBookStatus")).toEqual([
      "NOT_CONFIGURED",
      "VERIFYING",
      "CONNECTED",
      "DEGRADED",
      "AUTH_FAILED",
      "UNSUPPORTED_SERVER",
      "DISABLED",
    ]);
  });

  it("documents lastSyncError as diagnostic detail, never the state", () => {
    // Mutation: drop the doc comment → red. The comment is the guard against
    // the next reader reaching for it as a health signal.
    const block = modelBlock("AddressBookSource");
    expect(block).toMatch(/DIAGNOSTIC DETAIL ONLY[\s\S]*?lastSyncError/);
  });

  it("persists the negotiated sync mode rather than the intended one", () => {
    expect(enumMembers("AddressBookSyncMode")).toEqual([
      "SYNC_COLLECTION",
      "ETAG_DIFF",
      "FULL_PULL",
    ]);
    expect(fieldLine("AddressBookSource", "syncMode")).toContain("@default(FULL_PULL)");
  });

  it("keeps Contact.birthday a String — RFC 6350 §4.3.1 partial dates", () => {
    // Mutation: change to `DateTime?` → red. A vCard birthday of `--0423`
    // (April 23rd, year unknown) has no Date representation and coercing it
    // invents a year.
    expect(fieldLine("Contact", "birthday")).toBe("birthday String?");
    expect(modelBlock("Contact")).toContain("RFC 6350");
  });

  it("cascades contacts from their source in the SCHEMA, not in a service", () => {
    // Mutation: drop `onDelete: Cascade` → red here, and an FK violation at
    // runtime. `calendar.service.ts` hand-rolls this in a $transaction; a
    // hand-rolled cascade is one forgotten call site away from orphans.
    expect(fieldLine("Contact", "source")).toContain("onDelete: Cascade");
    expect(tablesSql).toMatch(
      /"Contact_sourceId_fkey" FOREIGN KEY \("sourceId"\)[\s\S]*?ON DELETE CASCADE/,
    );
  });

  it("cascades a contact's emails and phones too", () => {
    for (const model of ["ContactEmail", "ContactPhone"]) {
      expect(fieldLine(model, "contact")).toContain("onDelete: Cascade");
    }
  });

  it("indexes the lowercase email — the join key to EmailMessage.fromAddr", () => {
    expect(modelBlock("ContactEmail")).toContain("@@index([addressLower])");
  });

  it("states a contact's origin explicitly instead of inferring it", () => {
    // Mutation: delete `origin` and infer "external" from externalUid != NULL
    // → red. Same rule as `status` above.
    expect(enumMembers("ContactOrigin")).toEqual(["LOCAL", "EXTERNAL"]);
    expect(fieldLine("Contact", "origin")).toBe("origin ContactOrigin @default(LOCAL)");
  });

  it("is the ONLY contact entity — no second person record was added", () => {
    // WARP-2117's hard sequencing constraint: the CardDAV lane, the Graph
    // connector and the CRM must share one row per human, or the box ends up
    // with three rows for one person and no way to say which is current.
    //
    // Detected by SHAPE, not by name: a person record is whatever carries the
    // given/family name pair. A `CrmContact` called something else still trips
    // this. Mutation: add a second model with both fields → red.
    const personRecords = [...schema.matchAll(/\nmodel\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => /\n\s*givenName\s/.test(body) && /\n\s*familyName\s/.test(body))
      .map(([, name]) => name)
      .sort();
    expect(personRecords).toEqual(["Contact"]);
  });
});

describe("WARP-2117 — CRM core", () => {
  it("classifies stage outcome explicitly, never by position or name", () => {
    // Mutation: delete `kind` and derive won/lost from the last column or a
    // name match → red. Stages are owner-configurable, so neither position
    // nor name carries any guarantee.
    expect(enumMembers("CrmStageKind")).toEqual(["OPEN", "WON", "LOST"]);
    expect(fieldLine("CrmPipelineStage", "kind")).toBe("kind CrmStageKind @default(OPEN)");
  });

  it("orders stages by an explicit non-nullable column", () => {
    // Mutation: make sortOrder optional, or drop it and rely on createdAt →
    // red. Reordering a pipeline must not mean re-creating its stages.
    expect(fieldLine("CrmPipelineStage", "sortOrder")).toBe("sortOrder Int");
    expect(modelBlock("CrmPipelineStage")).toContain("@@unique([pipelineId, sortOrder])");
  });

  it("allows at most one default pipeline, enforced in Postgres", () => {
    // Mutation: drop the partial index → red. A plain @unique on a boolean
    // would instead forbid a SECOND non-default pipeline, which is backwards.
    expect(tablesSql).toMatch(
      /CREATE UNIQUE INDEX "CrmPipeline_one_default"[\s\S]*?WHERE "isDefault" = true/,
    );
  });

  it("holds money as BigInt minor units with a currency it cannot lose", () => {
    // Mutation: change to Float/Decimal → red on the first assertion. Drop the
    // CHECK → red on the second, and a deal can then carry an amount with no
    // currency, which no report can add up.
    expect(fieldLine("CrmDeal", "amountMinor")).toBe("amountMinor BigInt?");
    expect(tablesSql).toMatch(
      /"CrmDeal_amount_needs_currency"[\s\S]*?CHECK \(\("amountMinor" IS NULL\) = \("currency" IS NULL\)\)/,
    );
  });

  it("links a won deal to the project that delivers it, without coupling their lifetimes", () => {
    // Mutation: change to onDelete: Cascade → red. Deleting a delivery project
    // must not erase the commercial record of the sale.
    expect(fieldLine("CrmDeal", "project")).toContain("onDelete: SetNull");
    expect(modelBlock("PmProject")).toContain("crmDeals CrmDeal[]");
  });

  it("archives with an explicit flag, not a nullable timestamp", () => {
    // Mutation: delete isArchived and derive from `archivedAt IS NOT NULL` →
    // red. WARP-884 settled this for PmProject; the CRM inherits the rule.
    for (const model of ["CrmCompany", "CrmDeal", "CrmPipeline"]) {
      expect(fieldLine(model, "isArchived")).toBe("isArchived Boolean @default(false)");
    }
  });

  it("hangs every timeline entry off exactly one subject, enforced in Postgres", () => {
    // Mutation: drop the CHECK → red, and a row can then claim
    // subjectType='DEAL' while carrying only a companyId, which every
    // timeline query built on subjectType silently drops.
    expect(enumMembers("CrmActivitySubject")).toEqual(["COMPANY", "CONTACT", "DEAL"]);
    expect(tablesSql).toContain('"CrmActivity_subject_exactly_one"');
    expect(tablesSql).toMatch(
      /\("companyId" IS NOT NULL\)::int \+ \("contactId" IS NOT NULL\)::int \+ \("dealId" IS NOT NULL\)::int\) = 1/,
    );
    // The subjectType↔column agreement half, not just the count half.
    expect(tablesSql).toContain(`("subjectType" = 'DEAL') = ("dealId" IS NOT NULL)`);
  });

  it("references the primitives that hold content instead of copying them", () => {
    // Mutation: replace these FKs with `bodyText String` → red. A note stays
    // one note; mail retention stays governed by the mail surface alone.
    for (const [field, target] of [
      ["note", "Note"],
      ["emailMessage", "EmailMessage"],
      ["calendarEvent", "CalendarEvent"],
      ["workItem", "PmWorkItem"],
    ] as const) {
      expect(fieldLine("CrmActivity", field)).toContain("onDelete: SetNull");
      expect(modelBlock(target)).toContain("crmActivities CrmActivity[]");
    }
    expect(modelBlock("CrmActivity")).not.toMatch(/^\s*bodyT?e?xt/m);
  });

  it("records occurredAt separately from createdAt", () => {
    // Mutation: delete occurredAt and sort the timeline by createdAt → red.
    // A backfilled email from March is not an event that happened today.
    expect(fieldLine("CrmActivity", "occurredAt")).toContain("DateTime");
    expect(modelBlock("CrmActivity")).toContain("@@index([dealId, occurredAt])");
  });

  it("carries provenance on every syncable record", () => {
    // Mutation: drop externalSystem/externalId from any of these → red, and
    // two connectors will each create their own copy of one customer.
    for (const model of ["Contact", "CrmCompany", "CrmDeal", "CrmActivity"]) {
      const block = modelBlock(model);
      expect(block, `${model}.externalSystem`).toMatch(/externalSystem\s+String\?/);
      expect(block, `${model}.externalId`).toMatch(/externalId\s+String\?/);
      expect(block, `${model} reconcile key`).toContain("@@unique([externalSystem, externalId])");
    }
  });

  it("states record origin explicitly on CRM records too", () => {
    expect(enumMembers("CrmRecordOrigin")).toEqual(["LOCAL", "EXTERNAL"]);
    for (const model of ["CrmCompany", "CrmDeal", "CrmActivity"]) {
      expect(fieldLine(model, "origin")).toBe("origin CrmRecordOrigin @default(LOCAL)");
    }
  });

  it("models company↔contact as a link table — people change jobs", () => {
    // Mutation: replace with `companyId` on Contact → red. A person can be
    // reachable at two organizations, and moving jobs must not rewrite the
    // history of who they were when a deal closed.
    expect(modelBlock("CrmCompanyContact")).toContain("@@unique([companyId, contactId])");
    expect(modelBlock("Contact")).not.toMatch(/^\s*companyId\s/m);
  });

  it("keeps a deal's pipeline and stage from being deleted out from under it", () => {
    // Mutation: change either to Cascade or SetNull → red. Deleting a stage
    // that still holds deals must fail loudly, not silently move or delete them.
    expect(fieldLine("CrmDeal", "pipeline")).toContain("onDelete: Restrict");
    expect(fieldLine("CrmDeal", "stage")).toContain("onDelete: Restrict");
  });

  it("bounds the advisory forecast weighting", () => {
    expect(tablesSql).toMatch(
      /"CrmPipelineStage_probability_range"[\s\S]*?"probability" >= 0 AND "probability" <= 100/,
    );
  });
});

describe("migrations", () => {
  it("appends contacts and crm to ModuleId", () => {
    const members = enumMembers("ModuleId");
    expect(members).toContain("contacts");
    expect(members).toContain("crm");
  });

  it("puts the enum append in its OWN directory, ahead of the tables", () => {
    // Mutation: merge the ALTER TYPE into the tables migration → red here, and
    // `prisma migrate deploy` fails for real: Postgres will not let a
    // transaction use an enum value the same transaction added.
    expect(MIGRATION_DIRS).toContain(MODULE_ID_MIGRATION);
    expect(MIGRATION_DIRS).toContain(TABLES_MIGRATION);
    expect(MODULE_ID_MIGRATION < TABLES_MIGRATION).toBe(true);
    expect(tablesSql).not.toMatch(/ALTER TYPE "ModuleId" ADD VALUE/);
  });

  it("guards the enum append on pg_enum so a re-run is a no-op", () => {
    for (const value of ["contacts", "crm"]) {
      expect(moduleIdSql).toMatch(
        new RegExp(
          `WHERE t\\.typname = 'ModuleId' AND e\\.enumlabel = '${value}'[\\s\\S]*?ALTER TYPE "ModuleId" ADD VALUE '${value}'`,
        ),
      );
    }
  });

  it("stamps both directories after the migration that preceded them", () => {
    // Mutation: re-stamp either to 20260101… → red. A stamp that predates a
    // migration already on main deploys out of order and breaks; this team
    // has hit that.
    //
    // WARP-2554 — this used to assert these two sorted after EVERY other
    // directory, i.e. that they were last. That is not an invariant, it is a
    // description of the day they landed: the very next migration anyone adds
    // makes it false, and it did — `20260830220000_warp_2554_contact_archive`
    // turned it red while being perfectly correct. Pinning the PREDECESSOR is
    // the durable form, and it is what the ordering hazard is actually about:
    // deploying before something that already exists, not failing to be last
    // forever.
    const PREDECESSOR = "20260828020000_warp_2458_integration_status_needs_reconnect";
    expect(MIGRATION_DIRS).toContain(PREDECESSOR);
    expect(PREDECESSOR < MODULE_ID_MIGRATION).toBe(true);
    expect(PREDECESSOR < TABLES_MIGRATION).toBe(true);
  });
});
