/**
 * WARP-2509 — the sync entity table agrees with the connector vocabulary it
 * claims to be a view over.
 *
 * `entities.ts` says of itself: "this table is not a fourth vocabulary; it is
 * a view over the existing one." Nothing checked that. The consequence was the
 * defect this ticket fixes — `audience_member`'s marker named
 * `last_changed_at` while other tracks called the same idea `updated_at`, and
 * a column name that does not exist on the row does not fail. It reads as
 * `undefined`, the watermark stays null, and the connection re-enumerates its
 * whole audience on every tick, forever, silently.
 *
 * So the assertions below are about CORRESPONDENCE, not about values:
 *
 *   - every `readQuery` is a registered read query
 *   - and that query serves THIS entity's dataset, not a neighbouring one
 *   - every declared field is a canonical column OF that dataset
 *
 * Each is derived from `@droplet/erp-connector`'s own exports, so the table
 * cannot drift away from the vocabulary without going red here.
 */
import { CANONICAL_COLUMNS, getReadQuery } from "@droplet/erp-connector";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERP_SYNC_ENTITIES, erpSyncEntity } from "./entities.js";

/**
 * Resolved from `process.cwd()` rather than from `import.meta.url`: this app
 * emits CommonJS, where `import.meta` is a compile error (TS1470). Same
 * candidate-list shape the schema tests in `__tests__/` use, so the file is
 * found whether vitest runs from the app or from the repo root.
 */
const ENTITIES_SOURCE = (() => {
  const relative = join("src", "services", "erp-sync", "entities.ts");
  for (const base of [process.cwd(), join(process.cwd(), "apps", "orchestrator")]) {
    const candidate = join(base, relative);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not locate ${relative} from ${process.cwd()}`);
})();
const source = readFileSync(ENTITIES_SOURCE, "utf8");

describe("WARP-2509 — the entity table is a view over the canonical vocabulary", () => {
  it("points every entity at a read query that serves that very dataset", () => {
    // MUTATION: point `contact` at `get_company` → red. Both are real queries
    // on real datasets, so a "is this a known query" check alone would pass
    // and the poller would enumerate companies into a contact cursor.
    expect(ERP_SYNC_ENTITIES.length).toBeGreaterThan(0);
    for (const spec of ERP_SYNC_ENTITIES) {
      const query = getReadQuery(spec.readQuery);
      expect(query, `${spec.entity} names an unregistered read query`).toBeTruthy();
      expect(
        query.dependsOnTables[0],
        `${spec.entity} reads through ${spec.readQuery}, which serves ${query.dependsOnTables[0]}`,
      ).toBe(spec.entity);
    }
  });

  it("names only canonical columns of its own dataset", () => {
    // THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT. A marker
    // naming a column the dataset does not carry is invisible at runtime —
    // `row[markerField]` is `undefined`, `watermarkValueOf` returns null, and
    // the cursor never advances. There is no error to notice.
    //
    // MUTATION: set any markerField to a plausible-but-absent name
    // (`last_changed_at`, `modified_at`) → red, naming the dataset.
    for (const spec of ERP_SYNC_ENTITIES) {
      const columns = CANONICAL_COLUMNS[spec.entity as keyof typeof CANONICAL_COLUMNS];
      expect(columns, `${spec.entity} is not a canonical dataset`).toBeTruthy();
      for (const [field, column] of [
        ["sourceKeyField", spec.sourceKeyField],
        ["markerField", spec.markerField],
      ] as const) {
        expect(
          columns as readonly string[],
          `${spec.entity}.${field} = "${column}" is not a column of ${spec.entity}`,
        ).toContain(column);
      }
    }
  });

  it("lets updatedAtField name a column the dataset lacks, and only that one", () => {
    // The deliberate asymmetry, stated so it is not mistaken for an oversight.
    // `updatedAtField` is allowed to name an absent column because absence IS
    // the fallback mechanism: `watermark.ts` tests the VALUE for definedness
    // and drops to the marker. `campaign` and `ecommerce_order` rely on that.
    //
    // A marker gets no such licence — it is the fallback, and a fallback that
    // resolves to nothing is the null watermark this ticket is about.
    const withoutUpdatedAt = ERP_SYNC_ENTITIES.filter((spec) => {
      const columns = CANONICAL_COLUMNS[
        spec.entity as keyof typeof CANONICAL_COLUMNS
      ] as readonly string[];
      return !columns.includes(spec.updatedAtField);
    }).map((spec) => spec.entity);

    // Exactly the two Mailchimp datasets whose vendor resources publish no
    // modification field. MUTATION: give one of them a bogus marker as well →
    // the test above goes red, and this one keeps passing, which is the point.
    expect(withoutUpdatedAt.sort()).toEqual(["campaign", "ecommerce_order"]);
  });

  it("resolves each entity by name", () => {
    for (const spec of ERP_SYNC_ENTITIES) {
      expect(erpSyncEntity(spec.entity)).toBe(spec);
    }
    expect(erpSyncEntity("no-such-entity")).toBeUndefined();
  });

  it("no longer claims no canonical column carries a modification timestamp", () => {
    // The cheap drift gate WARP-2509 asked for. This file's rationale for the
    // mandatory reconciliation sweep rested on a sentence that WARP-2494 had
    // already falsified, and a conclusion resting on a dead premise is how a
    // reader inherits the conclusion without the reasoning.
    //
    // MUTATION: paste the old sentence back → red.
    expect(source).not.toContain("no canonical column carried a vendor-side modification");
    // And the replacement rationale is actually present, so this cannot be
    // satisfied by deleting the paragraph rather than fixing it.
    expect(source).toContain("ABSENT on some datasets and UNDEFINED on some rows");
  });
});
