/**
 * WARP-2458 — `IntegrationStatus` is mirrored by hand in four TypeScript
 * unions and nothing checked it. This is the check.
 *
 * The house pattern for a schema-enum test (`role-enum.schema.test.ts:26-61`,
 * `ap-device.schema.test.ts:45`) asserts each EXPECTED member is present. That
 * catches a member dropped from Prisma; it does not catch a member added to
 * Prisma and forgotten in the union, because the expected list is a hand-typed
 * literal that drifts with everything else. So this file is bidirectional in
 * the shape `packages/tools-core/__tests__/registry.test.ts:177-186` uses —
 * `{missing, extra}` set-compared both ways — and derives its expected list
 * from the TS union itself rather than from a literal.
 *
 * The derivation is the load-bearing part. A union type has no runtime value,
 * so `STATUS_NAMES` is the key set of a `Record<IntegrationStatusName, true>`:
 * `tsc` refuses the object literal if a member is missing AND refuses a key
 * that is not in the union, which makes the array provably the union. The
 * orchestrator's `tsconfig.json` carries `include: ["src/**\/*"]` with no test
 * exclusion, so this file is compiled by `tsc --noEmit` and the assertion is
 * real — unlike a `@ts-expect-error` in a package whose tests are excluded,
 * which asserts nothing in a green suite forever.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { IntegrationStatusName } from "../services/integrations.service.js";
import type { IntegrationStatusName as SaasIntegrationStatusName } from "../services/saas-credential.service.js";

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

/**
 * The TS union, as data. Every value is `true` and never read — the KEYS are
 * the assertion, and the exhaustive `Record` is what makes them provably the
 * union rather than a list somebody maintained alongside it.
 *
 * Mutation: delete a line → `tsc` red (the Record is not total). Add a line
 * that is not in the union → `tsc` red (excess property).
 */
const STATUS_MEMBERS: Record<IntegrationStatusName, true> = {
  NOT_CONFIGURED: true,
  PROVISIONING: true,
  CONNECTED: true,
  DEGRADED: true,
  DRIFT_LOCKED: true,
  NEEDS_RECONNECT: true,
  ERROR: true,
  DISABLED: true,
};
const STATUS_NAMES = Object.keys(STATUS_MEMBERS).sort();

/** Parse the members out of a Prisma enum block, ignoring `///` docstrings —
 *  which every member of this enum now carries. */
function prismaEnumMembers(name: string): string[] {
  const match = schema.match(new RegExp(`enum\\s+${name}\\s*\\{([^}]+)\\}`));
  expect(match, `${name} enum must be declared in schema.prisma`).not.toBeNull();
  return match![1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//"))
    .sort();
}

describe("IntegrationStatus — Prisma enum ↔ TypeScript union (WARP-2458)", () => {
  it("has exactly the same members on both sides — no missing, no extra", () => {
    // Mutation: add NEEDS_RECONNECT to only one side → this goes red naming
    // which side is short. That is the whole reason the test is bidirectional:
    // the one-directional house pattern stays green when Prisma grows a member
    // the TS union never learned about, which is the direction that actually
    // ships a `status` value no surface can render.
    const actual = prismaEnumMembers("IntegrationStatus");
    const missing = STATUS_NAMES.filter((n) => !actual.includes(n));
    const extra = actual.filter((n) => !STATUS_NAMES.includes(n));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("carries NEEDS_RECONNECT, the member ADR-041 §5 names as mandatory", () => {
    // Mutation: drop the member from the enum → red. Named on its own rather
    // than left to the set comparison because this is the member the ticket
    // exists for, and a reader of a failure should see why it matters.
    expect(prismaEnumMembers("IntegrationStatus")).toContain("NEEDS_RECONNECT");
  });

  it("documents every member, in the M365ConnectionState house style", () => {
    // `M365ConnectionState` documents each member; `IntegrationStatus` used to
    // document none, which is how NEEDS_RECONNECT's absence went unremarked
    // for seven members. Mutation: drop the `///` line above any member → red.
    const body = schema.match(/enum\s+IntegrationStatus\s*\{([^}]+)\}/)![1];
    const lines = body.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].startsWith("///")) continue;
      expect(
        lines[i - 1]?.startsWith("///"),
        `IntegrationStatus.${lines[i]} has no docstring`,
      ).toBe(true);
    }
  });

  it("keeps the saas-credential service's copy of the union in step", () => {
    // A second hand-maintained mirror in a different module. Mutation: add a
    // member to one union and not the other → `tsc` red at this assignment,
    // because each side must be assignable to the other.
    const forward: SaasIntegrationStatusName = "NEEDS_RECONNECT" as IntegrationStatusName;
    const backward: IntegrationStatusName = "NEEDS_RECONNECT" as SaasIntegrationStatusName;
    expect([forward, backward]).toEqual(["NEEDS_RECONNECT", "NEEDS_RECONNECT"]);
  });
});

describe("the NEEDS_RECONNECT migration (WARP-2458)", () => {
  const migrationsDir = join(PRISMA_DIR, "migrations");

  /** Statements in a migration file, ignoring `--` comments and blank lines. */
  function statementsIn(sql: string): string[] {
    return sql
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  it("ships exactly one migration adding NEEDS_RECONNECT", () => {
    const dirs = readdirSync(migrationsDir).filter((d) => d.includes("needs_reconnect"));
    expect(dirs).toHaveLength(1);
  });

  it("keeps the ALTER TYPE … ADD VALUE alone in its file", () => {
    // WARP-2458 asks for this, and it is the safe shape, but the reason needs
    // stating accurately or the next person will draw the wrong conclusion
    // from it.
    //
    // The ticket says `ALTER TYPE … ADD VALUE` "cannot run inside a
    // transaction in Postgres". That was true before PostgreSQL 12. From 12
    // on it is allowed inside a transaction block provided the NEW VALUE IS
    // NOT USED in that same transaction, and this box ships PostgreSQL 16
    // (`docker/docker-compose.yml` → `pgvector/pgvector:pg16`). Twelve
    // migrations already on `stage` mix an ADD VALUE with other statements —
    // `20260601000000_warp_onb_claim_step` does it inside a DO block — and
    // every one of them applies. So a repo-wide version of this assertion
    // would be red on arrival and would be asserting something false.
    //
    // Scoped to this migration, it still earns its place: a single statement
    // is the shape that is correct on every version, and the failure it
    // prevents (adding a statement that USES the new value) is invisible in
    // review and only fails on a real database.
    //
    // Mutation: add a second statement to the WARP-2458 migration → red.
    const dir = readdirSync(migrationsDir).find((d) => d.includes("needs_reconnect"))!;
    const statements = statementsIn(readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8"));
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^ALTER TYPE .* ADD VALUE/i);
  });

  it("pins the new value's position so the datamodel and the database agree", () => {
    // A bare ADD VALUE appends. The datamodel declares NEEDS_RECONNECT before
    // ERROR, and `prisma migrate diff --from-migrations --to-schema-datamodel`
    // compares member ORDER — so an unpositioned ADD VALUE reports drift on a
    // schema that is otherwise correct.
    // Mutation: drop `BEFORE 'ERROR'` → drift, and this goes red.
    const dir = readdirSync(migrationsDir).find((d) => d.includes("needs_reconnect"))!;
    const sql = readFileSync(join(migrationsDir, dir, "migration.sql"), "utf8");
    expect(sql).toMatch(
      /ALTER TYPE "IntegrationStatus" ADD VALUE 'NEEDS_RECONNECT' BEFORE 'ERROR';/,
    );
  });
});
