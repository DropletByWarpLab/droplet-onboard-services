/**
 * WARP-2464 — the canonical `updated_at` column, and the proof that it was
 * added only where a vendor can honestly populate it.
 *
 * `CANONICAL_COLUMNS` carried `issued_at` and `due_at` but no modification
 * timestamp, so WARP-2218's incremental watermark had nothing to key on except
 * whatever ordering key a connector happened to expose — a created-at, an id
 * sequence. Every one of those is approximate BY CONSTRUCTION: a record edited
 * after creation, with an unchanged ordering key, is invisible to the
 * incremental path. That is why that story ships its sweep as mandatory rather
 * than as a safety net.
 *
 * The dangerous way to close that gap is to give all twenty-three datasets an
 * `updated_at` and let each connector fill it with the best thing it has. A
 * synthesised modification timestamp is worse than none, because a watermark
 * TRUSTS it: it advances, the sweep looks redundant, and edits stop being seen
 * with nothing anywhere reporting a fault. So the column exists on a dataset
 * only where a named vendor field supplies it, and this file is the gate on
 * that — an absent column is honest, an invented one is the no-guessing
 * violation.
 *
 * Every test names the mutation that must turn it red.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  DATASETS,
  REQUIRED_CANONICAL,
  type DatasetName,
} from "../src/export-drop/profiles.js";
import { NATURAL_KEY } from "../src/export-drop/scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILES_SOURCE = readFileSync(join(HERE, "../src/export-drop/profiles.ts"), "utf8");

// ── the pinned decision: which datasets have a vendor source, and which do not ──

/**
 * The thirteen datasets a named vendor field can populate, and that field.
 *
 * Pinned by hand rather than derived from the module — a fixture generated from
 * the thing it guards agrees with every mutation of it. Each value is the
 * substring the inline comment at that column must actually contain, so a
 * reviewer reading `profiles.ts` learns which vendor field a row's
 * `updated_at` came from without opening Jira.
 */
const VENDOR_SOURCE: Readonly<Record<string, string>> = {
  // Xero — the accounting pair. Its timestamp is documented-incomplete.
  invoice: "UpdatedDateUTC",
  bill: "UpdatedDateUTC",
  // Stripe — no object carries a modification time; /v1/events supplies it.
  charge: "/v1/events",
  refund: "/v1/events",
  payout: "/v1/events",
  subscription: "/v1/events",
  // HubSpot
  contact: "hs_lastmodifieddate",
  company: "hs_lastmodifieddate",
  deal: "hs_lastmodifieddate",
  ticket: "hs_lastmodifieddate",
  // Shopify — the only vendor whose own field is already called `updated_at`.
  order: "updated_at_min",
  product: "updated_at_min",
  customer: "updated_at_min",
};

/**
 * The ten datasets that get NO `updated_at`, each with the reason. This is
 * the acceptance criterion "no dataset gains a synthesised `updated_at`",
 * written as data so it can be asserted rather than reviewed.
 *
 * The last three arrived with WARP-2466's connector reconciliation, which
 * landed alongside WARP-2494 rather than after it — neither branch could see
 * the other's names, so their decisions are recorded here at the merge.
 */
const NO_HONEST_SOURCE: Readonly<Record<string, string>> = {
  // Practice management: the export-drop track is operator-authored CSV and no
  // built-in profile carries a modification column; the dental REST and SQL
  // tracks expose none either.
  appointment: "no PMS track exposes a modification timestamp",
  patient: "no PMS track exposes a modification timestamp",
  // Derived aggregates. There is no vendor OBJECT to carry a timestamp at all:
  // the row is computed from other rows. Xero's UpdatedDateUTC specifically
  // does NOT move on a contact-balance change (WARP-2383), so borrowing it
  // here would be precisely the lie this column exists to avoid.
  account: "a computed AR aggregate, not a vendor object",
  ap_summary: "a computed AP aggregate, not a vendor object",
  // Stripe emits no `balance_transaction.*` event type, so /v1/events — the
  // source for every other Stripe dataset — does not reach this one. Stamping
  // the parent charge's or payout's event time onto the ledger row would be
  // another object's timestamp wearing this one's name.
  balance_transaction: "Stripe emits no balance_transaction.* event",
  // Mailchimp's `last_changed` is on a LIST MEMBER. Neither the campaign
  // resource nor the list resource carries a modification timestamp of its own.
  campaign: "Mailchimp exposes last_changed on members, not on campaigns",
  audience: "Mailchimp exposes last_changed on members, not on the list",
  // ── WARP-2466's three (see the note above) ────────────────────────────────
  // The list member IS a dataset now, and it DOES carry Mailchimp's
  // `last_changed` — but WARP-2466 spelled that column `last_changed_at`
  // rather than `updated_at`. So this dataset has an honest modification time
  // under a different canonical name, which is why it is here rather than in
  // VENDOR_SOURCE: the column named `updated_at` is genuinely absent.
  audience_member: "its modification time is the canonical column last_changed_at",
  // `/ecommerce/stores/{id}/orders` documents no modification field and no
  // date filter of any kind — see MAILCHIMP_ECOMMERCE_ORDER_PARAMS, whose
  // completeness is the finding that makes an incremental read impossible.
  ecommerce_order: "the orders resource exposes no modification field at all",
  // WARP-2466 added this dataset with `occurred_at` — when the activity
  // HAPPENED — and decided no modification column. HubSpot's engagement object
  // does carry hs_lastmodifieddate, so this is an absence by omission rather
  // than for want of a source; changing it is a vocabulary decision, not a
  // connector one.
  engagement: "WARP-2466 added it with occurred_at only; no modification column decided",
};

describe("updated_at exists exactly where a vendor can populate it", () => {
  it("covers every dataset, splitting the twenty-three into sourced and unsourced", () => {
    // Mutation: add a twenty-fourth dataset without deciding whether it has a
    // modification source → red here, before that decision gets made by
    // default somewhere subtler.
    const decided = [...Object.keys(VENDOR_SOURCE), ...Object.keys(NO_HONEST_SOURCE)].sort();
    expect(decided).toEqual([...DATASETS].sort());
  });

  it("gives updated_at to every dataset with a named vendor source", () => {
    // Mutation: drop updated_at from CANONICAL_COLUMNS.order → red. This is
    // the column WARP-2218's watermark keys on; without it the incremental
    // path falls back to an ordering key that cannot see an edit.
    for (const dataset of Object.keys(VENDOR_SOURCE) as DatasetName[]) {
      expect(CANONICAL_COLUMNS[dataset], `${dataset} must carry updated_at`).toContain("updated_at");
    }
  });

  it("withholds updated_at from every dataset with no honest source", () => {
    // Mutation: add updated_at to CANONICAL_COLUMNS.patient, or to
    // balance_transaction → red. A column a connector can fill only by
    // inventing a value is worse than no column, because a watermark trusts it.
    for (const [dataset, why] of Object.entries(NO_HONEST_SOURCE)) {
      expect(
        CANONICAL_COLUMNS[dataset as DatasetName],
        `${dataset} must NOT carry updated_at — ${why}`,
      ).not.toContain("updated_at");
    }
  });

  it("appends updated_at last, so no existing column is reordered", () => {
    // Mutation: insert updated_at anywhere but the end of an array → red. The
    // canonical column list IS the row's column order on every track, and
    // WARP-2280 pinned the original six's arrays against 74492c21; appending
    // is the only shape of this change that is purely additive.
    for (const dataset of Object.keys(VENDOR_SOURCE) as DatasetName[]) {
      const columns = CANONICAL_COLUMNS[dataset];
      expect(columns[columns.length - 1], `${dataset} last column`).toBe("updated_at");
    }
  });
});

describe("updated_at carries its vendor provenance at the column", () => {
  /**
   * The `CANONICAL_COLUMNS` object literal as SOURCE TEXT.
   *
   * Read from the file rather than through the module because the thing under
   * test is a COMMENT, which no runtime value preserves. This follows the
   * money-comment convention WARP-2107 established on `CANONICAL_COLUMNS.invoice`
   * (why `balance` is not `amount`) and WARP-2280 carried to fourteen datasets:
   * a number whose meaning is not stated at the column gets misread, and a
   * timestamp whose limits are not stated gets over-trusted. The five vendors'
   * fields genuinely differ, so "there is an updated_at" is not enough
   * information to use one safely.
   */
  const block = (() => {
    const start = PROFILES_SOURCE.indexOf("export const CANONICAL_COLUMNS");
    expect(start, "CANONICAL_COLUMNS declaration not found in profiles.ts").toBeGreaterThan(-1);
    const end = PROFILES_SOURCE.indexOf("\n};", start);
    expect(end, "CANONICAL_COLUMNS literal is unterminated").toBeGreaterThan(start);
    return PROFILES_SOURCE.slice(start, end);
  })();

  /**
   * dataset -> the contiguous `//` comment block immediately above that
   * dataset's `"updated_at",` entry. An entry with no comment above it maps to
   * the empty string, which is the failure this describe block exists to catch.
   */
  const commentByDataset: Map<string, string> = (() => {
    const found = new Map<string, string>();
    const lines = block.split("\n");
    let current: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const opens = /^ {2}(\w+): \[/.exec(lines[i]);
      if (opens) current = opens[1];
      if (lines[i].trim() !== '"updated_at",') continue;

      const comment: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j].trim().startsWith("//"); j--) {
        comment.unshift(lines[j].trim().replace(/^\/\/\s?/, ""));
      }
      found.set(current ?? `<no dataset open at line ${i}>`, comment.join(" "));
    }
    return found;
  })();

  it("finds an updated_at entry in the source for exactly the sourced datasets", () => {
    // Guards the PARSER, not the data. Mutation: collapse one of these arrays
    // back onto a single line so `"updated_at",` never appears alone → this
    // test goes red, rather than the comment gate below going VACUOUSLY green.
    // A source-text assertion that silently stops matching is worthless, and
    // that is the failure mode it fails in.
    expect([...commentByDataset.keys()].sort()).toEqual(Object.keys(VENDOR_SOURCE).sort());
  });

  it("names the vendor field in a comment at every updated_at", () => {
    // Mutation: add an updated_at with no comment above it, or a comment that
    // does not name the vendor field → red. This is the acceptance criterion:
    // the five vendors' fields do not mean the same thing, so the column has to
    // say which one produced it.
    for (const [dataset, field] of Object.entries(VENDOR_SOURCE)) {
      const comment = commentByDataset.get(dataset) ?? "";
      expect(comment, `${dataset}.updated_at has no comment above it`).not.toBe("");
      expect(comment, `${dataset}.updated_at does not name ${field}`).toContain(field);
    }
  });

  it("records at the Xero columns that UpdatedDateUTC is documented-incomplete", () => {
    // The explicit acceptance criterion, and the reason WARP-2218's sweep stays
    // mandatory for Xero specifically rather than becoming a safety net.
    // Mutation: drop the DueDate / SentToContact caveat, or the WARP-2383
    // reference, from the invoice or bill comment → red.
    for (const dataset of ["invoice", "bill"]) {
      const comment = commentByDataset.get(dataset) ?? "";
      expect(comment, `${dataset}: missing the DueDate caveat`).toContain("DueDate");
      expect(comment, `${dataset}: missing the SentToContact caveat`).toContain("SentToContact");
      expect(comment, `${dataset}: missing the WARP-2383 reference`).toContain("WARP-2383");
    }
  });

  it("records at the Stripe columns that the value is the event's, not the object's", () => {
    // Mutation: describe Stripe's source as a field on the object → red. A
    // reader who believes `charge.updated` exists writes a filter against a
    // field Stripe does not have, and gets an empty page rather than an error.
    for (const dataset of ["charge", "refund", "payout", "subscription"]) {
      const comment = commentByDataset.get(dataset) ?? "";
      expect(comment, `${dataset}: does not say the value comes from the event`).toMatch(/event/i);
    }
  });
});

describe("updated_at obeys the rules every other canonical column obeys", () => {
  it("parses as a timestamp, not as text", () => {
    // Mutation: declare updated_at as "text" → a watermark comparison becomes a
    // string comparison, which orders "2026-9-1" after "2026-10-1" → red.
    expect(COLUMN_KIND.updated_at).toBe("timestamp");
  });

  it("is never part of a dataset's natural key", () => {
    // Mutation: add updated_at to NATURAL_KEY.invoice → red. The natural key is
    // what makes a re-read of the same record the SAME row; keying identity on
    // the modification time makes every edit look like a brand-new record and
    // duplicates it on each sync — the exact bug an incremental pass exists to
    // avoid.
    for (const dataset of DATASETS) {
      expect(NATURAL_KEY[dataset], `${dataset} natural key`).not.toContain("updated_at");
    }
  });

  it("is never required of a profile", () => {
    // Mutation: add updated_at to REQUIRED_CANONICAL.invoice → red. Requiring
    // it would refuse real rows: Xero's is documented missing on some edits and
    // an operator-authored export profile has nothing to map it to. The column
    // being declared-but-unmapped is exactly what lets a watermark fall back to
    // the ordering key instead of failing.
    for (const dataset of DATASETS) {
      expect(REQUIRED_CANONICAL[dataset], `${dataset} required`).not.toContain("updated_at");
    }
  });
});
