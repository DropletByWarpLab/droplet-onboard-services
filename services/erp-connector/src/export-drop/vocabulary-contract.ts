/**
 * WARP-2280 — the dataset vocabulary's COMPILE-TIME contract.
 *
 * Every assertion in this file is a type error waiting to happen. Nothing here
 * runs; `tsc` is the test runner, and each `@ts-expect-error` is a claim that
 * the line below it MUST NOT compile. Delete the guard it protects and the
 * directive becomes unused, which is itself a `tsc` error — so a widening that
 * quietly reopens the union goes red in both directions.
 *
 * ## Why this lives in `src/` and not in `__tests__/`
 *
 * Because `__tests__/` is not typechecked by anything. This package's
 * `tsconfig.json` carries `"exclude": ["node_modules", "dist", "__tests__"]`,
 * and `services/erp-connector` is not in the workspace list that
 * `scripts/test/ship-check.sh`'s `tsc-full` phase 3 runs `tsc --noEmit` over —
 * it appears only in phase 2, which runs `npm run -w @droplet/erp-connector
 * build`, i.e. the same excluding `tsconfig.json`. CI does the same thing
 * (`.github/workflows/ci.yml` builds the package, then runs `vitest`).
 *
 * And `vitest` does not typecheck at all: esbuild strips types, so a
 * `@ts-expect-error` in a test file is a comment. Put these fixtures in
 * `__tests__/` and they assert NOTHING, in a green suite, forever.
 *
 * In `src/` they are compiled by the package build — which CI runs on every PR
 * touching this path, and which `tsc-full` runs first — so they actually bind.
 * The cost is a `dist/` module that emits no runtime behaviour worth the name;
 * that is the price of the assertion being real.
 */
import type { Connector } from "../connector.js";
import type { ReadQuery } from "../read-queries.js";
import {
  CANONICAL_COLUMNS,
  DATASET_CATEGORY,
  DATASETS,
  REQUIRED_CANONICAL,
  type DatasetCategory,
  type DatasetName,
} from "./profiles.js";

// ── the union is closed ─────────────────────────────────────────────────────

/** A name in the vocabulary is assignable; this is the control for the two
 *  refusals below, so a fixture that stopped compiling for an unrelated reason
 *  cannot masquerade as the union doing its job. */
const _knownName: DatasetName = "invoice";

// @ts-expect-error -- "ledger" is not in DATASETS. Mutation: widen DatasetName
// to `string` and this directive becomes unused → tsc red.
const _unknownName: DatasetName = "ledger";

// @ts-expect-error -- a namespaced spelling is NOT the flat name. The vocabulary
// decision (see profiles.ts) is flat; if someone reintroduces dotted names, the
// two spellings must not silently coexist.
const _namespacedName: DatasetName = "payments.charge";

// ── the category value union widened past practice|accounting ───────────────

/** WARP-2301: the value union is closed too, and had to widen. Mutation:
 *  revert DatasetCategory to `"practice" | "accounting"` → this assignment
 *  fails → tsc red. */
const _payments: DatasetCategory = "payments";
const _commerce: DatasetCategory = "commerce";
const _crm: DatasetCategory = "crm";
const _marketing: DatasetCategory = "marketing";

// @ts-expect-error -- an invented category is still refused; widening the union
// must not have turned it into `string`.
const _notACategory: DatasetCategory = "logistics";

// ── the three Records are TOTAL, not partial ────────────────────────────────
//
// A `Partial<Record<DatasetName, …>>` keeps the same `keyof`, so asserting on
// keys cannot catch that mutation. Asserting that a lookup returns a defined
// value can: under `Partial` each of these becomes `… | undefined` and stops
// being assignable to the declared return type.

/** Mutation: `Record<DatasetName, DatasetCategory>` →
 *  `Partial<Record<…>>` → tsc red. Same for a dataset added to DATASETS with
 *  no category entry, which fails at the object literal itself. */
const _categoryIsTotal: (d: DatasetName) => DatasetCategory = (d) => DATASET_CATEGORY[d];

/** Mutation: make CANONICAL_COLUMNS partial, or drop an entry → tsc red. */
const _columnsAreTotal: (d: DatasetName) => readonly string[] = (d) => CANONICAL_COLUMNS[d];

/** Mutation: make REQUIRED_CANONICAL partial, or drop an entry → tsc red. */
const _requiredIsTotal: (d: DatasetName) => readonly string[] = (d) => REQUIRED_CANONICAL[d];

// ── the union at the two capability boundaries ──────────────────────────────

/**
 * WARP-2306 typed `Connector.servesDatasets` as the union so a track could not
 * declare a dataset nothing can serve. That refusal is NOT asserted here, and
 * deliberately: the shipped HubSpot and Mailchimp tracks declare vendor names
 * (`crm_contact`, `ecommerce_order`, …) the vocabulary spells flatly, and
 * reconciling the two is WARP-2466's step 4 — it re-narrows the field and owns
 * the acceptance criterion "tsc rejects a name outside the union on a
 * connector". Asserting it before then would be asserting a decision nobody
 * has made. The comment above the field in `connector.ts` carries the same
 * note, so the two cannot drift apart silently.
 *
 * What still holds, and is worth pinning, is the direction that survives the
 * loosening: every name in the vocabulary is a legal capability declaration.
 * That is what makes the union usable at this boundary at all, and it is the
 * precondition WARP-2466 will tighten onto. Mutation: retype `servesDatasets`
 * to anything `DatasetName` is not assignable to (`readonly DatasetCategory[]`,
 * `readonly number[]`) → this assignment fails → tsc red.
 */
const _servesVocabulary: Connector["servesDatasets"] = DATASETS;

/** WARP-2308: a read query declares its datasets with the same union. */
const _dependsKnown: ReadQuery["dependsOnTables"] = ["charge", "refund"];

// @ts-expect-error -- a query may not depend on a dataset nothing can serve.
// Mutation: type `dependsOnTables` as `string[]` → directive unused → tsc red.
const _dependsUnknown: ReadQuery["dependsOnTables"] = ["stripe_ledger"];

/**
 * Referenced so the fixtures above are not dead bindings a future
 * `noUnusedLocals` would delete — deleting them would delete the assertions.
 * The array is never read; its existence is the point.
 */
export const DATASET_VOCABULARY_CONTRACT: readonly unknown[] = [
  _knownName,
  _unknownName,
  _namespacedName,
  _payments,
  _commerce,
  _crm,
  _marketing,
  _notACategory,
  _categoryIsTotal,
  _columnsAreTotal,
  _requiredIsTotal,
  _servesVocabulary,
  _dependsKnown,
  _dependsUnknown,
];
