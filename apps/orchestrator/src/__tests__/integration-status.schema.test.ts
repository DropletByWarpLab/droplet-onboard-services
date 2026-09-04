/**
 * WARP-2458 — `IntegrationStatus` is mirrored by hand in four TypeScript
 * unions and nothing checked it. This is the check.
 *
 * WARP-2639 — there is no longer anything to keep in step: the four copies
 * became one `INTEGRATION_STATUSES` array in `@droplet/shared-types`, derived
 * into the `IntegrationStatus` union, and all four modules re-export it. So
 * this file no longer compares mirrors to each other (`tsc` does that for
 * free, in every workspace, on every build). What is left is the ONE thing a
 * compiler cannot see: the Prisma enum, which is a text file.
 *
 * The house pattern for a schema-enum test (`role-enum.schema.test.ts:26-61`,
 * `ap-device.schema.test.ts:45`) asserts each EXPECTED member is present. That
 * catches a member dropped from Prisma; it does not catch a member added to
 * Prisma and forgotten in the union, because the expected list is a hand-typed
 * literal that drifts with everything else. So this file is bidirectional in
 * the shape `packages/tools-core/__tests__/registry.test.ts:177-186` uses —
 * `{missing, extra}` set-compared both ways.
 *
 * The expected list is now the shared array itself rather than the key set of
 * a `Record<IntegrationStatusName, true>`, because the array IS the definition
 * the union is derived from; a `Record` keyed off a union derived from that
 * same array would only be asserting that the array equals itself.
 *
 * The one thing `tsc` still needs help with is the module boundary: nothing
 * stops a future edit re-declaring a local union in one of the four modules,
 * and if the copy happens to match on the day it is written, every compiler
 * and every set comparison stays green. The assignability assertions below are
 * the gate against that. The orchestrator's `tsconfig.json` carries
 * `include: ["src/**\/*"]` with no test exclusion, so this file is compiled by
 * `tsc --noEmit` and those assertions are real. The dashboard's two modules
 * cannot be reached from here (a test in `apps/orchestrator` cannot import
 * from `apps/web-dashboard`); their half lives in
 * `apps/web-dashboard/src/__tests__/reports.connectors.test.ts`.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  INTEGRATION_STATUSES,
  NON_CONNECTION_INTEGRATION_STATUSES,
  SAAS_CONNECTION_STATES,
  type IntegrationStatus,
  type SaasConnectionState,
} from "@droplet/shared-types";

import type { IntegrationStatusName } from "../services/integrations.service.js";
import type { IntegrationStatusName as SaasIntegrationStatusName } from "../services/saas-credential.service.js";
import type { SaasConnectionState as ServiceSaasConnectionState } from "../services/saas-credential.service.js";
import { PRISMA_DIR } from "./helpers/test-paths.js";

const schema = readFileSync(join(PRISMA_DIR, "schema.prisma"), "utf8");

/**
 * The union, as data — WARP-2639, straight from the one definition rather
 * than from a `Record` re-listing it here.
 */
const STATUS_NAMES = [...INTEGRATION_STATUSES].sort();

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
    const extra = actual.filter((n) => !(STATUS_NAMES as string[]).includes(n));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it("derives the union from the list, so the list cannot carry a duplicate", () => {
    // WARP-2639. `(typeof INTEGRATION_STATUSES)[number]` de-duplicates
    // silently — the TYPE is identical whether or not a member appears twice,
    // so nothing in the compiler notices, and the set comparison above would
    // not notice either. Mutation: repeat a member in the array → red.
    expect(STATUS_NAMES).toEqual([...new Set(INTEGRATION_STATUSES)].sort());
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

  it("has one definition, re-exported by the orchestrator's two modules", () => {
    // WARP-2639 — these were two hand-maintained mirrors; both now re-export
    // `@droplet/shared-types`. The assertion is the gate against undoing that:
    // give either module its own `export type IntegrationStatusName =` again
    // with a member the shared list lacks (or lacking one it has) and `tsc`
    // goes red at BOTH of these assignments, because each side must be
    // assignable to the other. A test that only compared the two to each other
    // would stay green on a pair of matching local copies, which is exactly
    // the state this refactor removed.
    const forward: SaasIntegrationStatusName = "NEEDS_RECONNECT" as IntegrationStatusName;
    const backward: IntegrationStatusName = "NEEDS_RECONNECT" as SaasIntegrationStatusName;
    const shared: IntegrationStatus = "NEEDS_RECONNECT" as IntegrationStatusName;
    const roundTrip: IntegrationStatusName = "NEEDS_RECONNECT" as IntegrationStatus;
    expect([forward, backward, shared, roundTrip]).toEqual(
      Array(4).fill("NEEDS_RECONNECT"),
    );
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

  /**
   * WARP-2623 — the same three properties for CAPABILITY_LIMITED.
   *
   * Written as its own block rather than folded into the WARP-2458 one because
   * each migration is a separate file with its own single statement, and a
   * shared assertion over "the migration" would have to pick one of them.
   */
  describe("the CAPABILITY_LIMITED migration (WARP-2623)", () => {
    const dirsFor = () =>
      readdirSync(migrationsDir).filter((d) => d.includes("capability_limited"));

    it("ships exactly one migration adding CAPABILITY_LIMITED", () => {
      expect(dirsFor()).toHaveLength(1);
    });

    it("keeps the ALTER TYPE … ADD VALUE alone in its file", () => {
      // Mutation: add a second statement to the WARP-2623 migration → red.
      const statements = statementsIn(
        readFileSync(join(migrationsDir, dirsFor()[0], "migration.sql"), "utf8"),
      );
      expect(statements).toHaveLength(1);
      expect(statements[0]).toMatch(/^ALTER TYPE .* ADD VALUE/i);
    });

    it("pins the new value between CONNECTED and DEGRADED", () => {
      // The datamodel declares it there, and `migrate diff` compares order.
      // Mutation: drop `BEFORE 'DEGRADED'` → the value appends, the datamodel
      // and the database disagree about position, and drift is reported on a
      // schema that is otherwise correct.
      const sql = readFileSync(join(migrationsDir, dirsFor()[0], "migration.sql"), "utf8");
      expect(sql).toMatch(
        /ALTER TYPE "IntegrationStatus" ADD VALUE 'CAPABILITY_LIMITED' BEFORE 'DEGRADED';/,
      );
    });

    it("sorts after the migration that adds the value it positions against", () => {
      // `BEFORE 'DEGRADED'` only resolves once `IntegrationStatus` exists, and
      // Prisma applies migrations in directory-name order. Deliberately NOT
      // "is the newest migration in the tree" — that assertion would go red on
      // the next unrelated migration anyone adds.
      const creating = readdirSync(migrationsDir)
        .filter((d) => /^\d{14}_/.test(d))
        .sort()
        .find((d) =>
          readFileSync(join(migrationsDir, d, "migration.sql"), "utf8").includes(
            'CREATE TYPE "IntegrationStatus"',
          ),
        );
      expect(creating, "no migration creates IntegrationStatus").toBeDefined();
      expect(dirsFor()[0] > creating!).toBe(true);
    });

    it("sorts after the last migration already on the base branch", () => {
      // Prisma applies migrations in DIRECTORY-NAME order, not merge order, so
      // a long-lived branch whose stamp predates a migration that landed on
      // the base while it sat becomes a migration that deploys out of order.
      // This one was stamped 20260902113000 and `stage` acquired
      // 20260903010000 underneath it.
      //
      // Harmless for THIS statement in isolation — a standalone
      // `ALTER TYPE ... ADD VALUE` neither reads nor is read by the party-link
      // change — but the invariant is asserted for exactly this reason at
      // `crm-contacts.schema.test.ts:337-341`, and an exception granted
      // because one instance happened to be harmless is how the next one
      // arrives unnoticed.
      //
      // Pins the PREDECESSOR, not "is newest": WARP-2554 already learned that
      // "sorts after everything" is a description of the day a branch landed,
      // not an invariant — the next unrelated migration turns it red while
      // being perfectly correct.
      //
      // Mutation: re-stamp back to 20260902113000 → red.
      const PREDECESSOR = "20260903010000_warp_2562_party_link_archive_scope";
      expect(
        readdirSync(migrationsDir),
        "predecessor migration is gone — re-pin this to the new one",
      ).toContain(PREDECESSOR);
      expect(dirsFor()[0] > PREDECESSOR).toBe(true);
    });
  });
});

/**
 * WARP-2633 — `SaasConnectionState` had the WARP-2458 defect too, and worse.
 *
 * `IntegrationStatus` was mirrored four times and gated by the suite above.
 * `SaasConnectionState` — the union the credentials page renders through a
 * TOTAL `Record` — was mirrored TWICE, by hand, with nothing comparing the two
 * to each other or either to the Prisma enum. WARP-2623 had to edit both
 * copies; WARP-2517's ticket claimed the union had already moved into
 * `packages/shared-types`, and it had not.
 *
 * There is now one definition (`@droplet/shared-types/saas-connection-state`)
 * and both former copies re-export it, so `tsc` makes the two SURFACES agree
 * for free. What `tsc` cannot see is the third party to the agreement: the
 * Prisma enum, which is a text file. That is what this block is.
 */
describe("SaasConnectionState ↔ Prisma IntegrationStatus (WARP-2633)", () => {
  const statuses = prismaEnumMembers("IntegrationStatus");

  it("has one definition, re-exported by the two modules that used to copy it", () => {
    // Mutation: give either module its own `export type SaasConnectionState =`
    // again with a member the shared list lacks → `tsc` red at BOTH of these
    // assignments, because each side must be assignable to the other. This is
    // the `integration-status.schema.test.ts:114-121` pattern, applied to the
    // union the credentials page actually renders from.
    const forward: ServiceSaasConnectionState = "CONNECTED" as SaasConnectionState;
    const backward: SaasConnectionState = "CONNECTED" as ServiceSaasConnectionState;
    expect([forward, backward]).toEqual(["CONNECTED", "CONNECTED"]);
  });

  it("derives the type from the list, so the list cannot carry a duplicate", () => {
    // `(typeof SAAS_CONNECTION_STATES)[number]` de-duplicates silently — the
    // TYPE is identical whether or not a member appears twice, so nothing in
    // the compiler notices. Every OTHER assertion here is a set comparison and
    // would not notice either. Mutation: repeat a member in the array → red.
    expect([...SAAS_CONNECTION_STATES].sort()).toEqual(
      [...new Set(SAAS_CONNECTION_STATES)].sort(),
    );
  });

  it("covers every IntegrationStatus except the ones excluded ON PURPOSE", () => {
    // The direction that ships a broken page: Prisma grows a member, the box
    // sends it, and `STATE_COPY[view.state]` is `undefined`.
    //
    // The exclusion list is read, not inferred. A status missing from the
    // union because somebody forgot it and a status missing because it is
    // internal look identical to a set difference — this is the "no guessing
    // state" rule, applied to a union instead of a column. It is empty today
    // and the assertion is the same either way.
    //
    // Mutation: remove CAPABILITY_LIMITED from SAAS_CONNECTION_STATES → red,
    // naming it under `uncovered`.
    const uncovered = statuses.filter(
      (s) =>
        !(SAAS_CONNECTION_STATES as readonly string[]).includes(s) &&
        !NON_CONNECTION_INTEGRATION_STATUSES.includes(s),
    );
    expect(uncovered).toEqual([]);
  });

  it("declares no state the Prisma enum cannot produce", () => {
    // The other direction: a member in the union that no `status` column value
    // ever maps to is dead copy on the credentials page, and a typo in it is
    // invisible — `STATE_COPY` stays total, `tsc` stays green, and the row it
    // was meant for renders as something else.
    //
    // Mutation: add a bogus member to SAAS_CONNECTION_STATES → red here, AND
    // `tsc` red in the dashboard because `STATE_COPY` is no longer total.
    const unknown = (SAAS_CONNECTION_STATES as readonly string[]).filter(
      (s) => !statuses.includes(s),
    );
    expect(unknown).toEqual([]);
  });

  it("never both includes and excludes a status", () => {
    // The exclusion list is only meaningful if it is disjoint from the union.
    // Both are hand-edited literals; nothing else would catch a member added
    // to one without being removed from the other, and the result would be a
    // state the page renders while the gate believes nobody ever sees it.
    // Mutation: add any current member to NON_CONNECTION_INTEGRATION_STATUSES
    // → red.
    const both = NON_CONNECTION_INTEGRATION_STATUSES.filter((s) =>
      (SAAS_CONNECTION_STATES as readonly string[]).includes(s),
    );
    expect(both).toEqual([]);
  });

  it("excludes only statuses that exist", () => {
    // A typo in the exclusion list silences the coverage assertion for a
    // status that is still uncovered — the gate would go green on the exact
    // defect it exists to catch. Vacuous today, and it is the assertion that
    // keeps the list honest the first time somebody adds to it.
    const bogus = NON_CONNECTION_INTEGRATION_STATUSES.filter(
      (s) => !statuses.includes(s),
    );
    expect(bogus).toEqual([]);
  });
});
