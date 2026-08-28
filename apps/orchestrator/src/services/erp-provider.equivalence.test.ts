/**
 * WARP-2217 — the equivalence table for `parseProviderConfig`.
 *
 * THIS FILE IS THE SAFETY ARGUMENT FOR THE DESCRIPTOR REFACTOR, and it was
 * written and watched pass against the PRE-CHANGE hand-written `switch` before
 * a single line of that switch was deleted. Written afterwards it would prove
 * nothing: a table derived from the replacement can only ever agree with the
 * replacement.
 *
 * Every row is a literal captured from the switch's observable behaviour —
 * provider × value × exact returned object (or `undefined`). Nothing here is
 * computed from the implementation, and nothing is asserted loosely:
 *
 *  • `toStrictEqual` rather than `toEqual`, because the switch returns objects
 *    whose optional keys are PRESENT-with-value-undefined (`callCeiling:
 *    undefined`), not absent. `toEqual` treats those as identical and would let
 *    a generic validator that emits `{}` pass while `JSON.stringify` of a
 *    persisted config changed shape underneath a caller.
 *  • key ORDER is pinned separately, for the same serialisation reason.
 *
 * Note what the pre-change switch does NOT have: error messages. Every
 * rejection path is a bare `undefined` — the "honest degradation" contract
 * documented on the function itself, where an unusable config leaves the
 * connector blocked rather than throwing out of a read handler. The equivalence
 * table therefore pins rejection *identity* (undefined, on exactly these
 * inputs), which is the whole of the observable rejection behaviour.
 *
 * Mutation coverage: drop `required: true` from a descriptor's credential field
 * and that provider's missing-identifier rows go red; trim a string field and
 * the untrimmed-passthrough row goes red; emit an absent key instead of an
 * undefined one and the strict-equality rows go red.
 */
import { describe, it, expect } from "vitest";
import { QUICKBOOKS_ONLINE_PROVIDER, DENTRIX_ASCEND_PROVIDER } from "@droplet/erp-connector";
import { parseProviderConfig, type ProviderConfig } from "./erp-provider.js";

/** One captured row: what the pre-change switch returned for this input. */
interface EquivalenceRow {
  /** Provider key handed to the parser. */
  provider: string;
  /** Human label — what this row is actually about. */
  label: string;
  /** The persisted `providerConfig` value. */
  value: unknown;
  /** Captured output. `undefined` means the switch rejected this input. */
  expected: ProviderConfig | undefined;
}

const QBO = QUICKBOOKS_ONLINE_PROVIDER;
const ASCEND = DENTRIX_ASCEND_PROVIDER;

/**
 * The non-object inputs, which every provider rejects identically because the
 * guard runs before the per-provider arm. Crossed against every provider below
 * so a refactor that moves the guard INSIDE an arm — and thereby lets one
 * provider accept a string — cannot pass.
 */
const NON_OBJECT_VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "null", value: null },
  { label: "undefined", value: undefined },
  { label: "a number", value: 0 },
  { label: "a non-zero number", value: 42 },
  { label: "the empty string", value: "" },
  { label: "a string", value: '{"realmId":"9130347"}' },
  { label: "true", value: true },
  { label: "false", value: false },
  { label: "an empty array", value: [] },
  { label: "an array of configs", value: [{ realmId: "9130347" }] },
  { label: "an array of ids", value: ["9130347"] },
];

/**
 * Every provider key the parser can be reached with. The four registered ones
 * plus the shapes a stale or hand-edited row can carry — an export-drop key, a
 * key for a vendor with no track, and the empty string.
 */
const ALL_PROVIDERS: readonly string[] = [
  QBO,
  ASCEND,
  "eaglesoft",
  "eaglesoft-api",
  "eaglesoft-export",
  "opendental",
  "mystery",
  "",
];

/** Providers that have no `providerConfig` concept at all: every input, valid
 *  or not, is rejected. Captured from the switch's fall-through `undefined`. */
const NO_CONFIG_PROVIDERS: readonly string[] = [
  "eaglesoft",
  "eaglesoft-api",
  "eaglesoft-export",
  "opendental",
  "mystery",
  "",
];

/** Object-shaped inputs crossed against the no-config providers. Includes both
 *  cloud tracks' VALID configs, because "a QuickBooks config on an Eaglesoft
 *  row" must not half-configure the wrong track. */
const OBJECT_VALUES: ReadonlyArray<{ label: string; value: unknown }> = [
  { label: "an empty object", value: {} },
  { label: "a valid QuickBooks config", value: { realmId: "9130347" } },
  { label: "a valid Dentrix config", value: { organizationId: "org-1" } },
  { label: "an unrelated object", value: { host: "10.0.0.5", port: 2638 } },
];

const TABLE: readonly EquivalenceRow[] = [
  // ── QuickBooks Online: accepts ─────────────────────────────────────────
  {
    provider: QBO,
    label: "realm id alone — every optional key present and undefined",
    value: { realmId: "9130347" },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: undefined,
      callCeiling: undefined,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "realm id + operator-chosen sandbox base url",
    value: { realmId: "9130347", baseUrl: "https://sandbox-quickbooks.api.intuit.com" },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: "https://sandbox-quickbooks.api.intuit.com",
      callCeiling: undefined,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a positive integer call ceiling is kept",
    value: { realmId: "9130347", callCeiling: 250 },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: undefined,
      callCeiling: 250,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "all three fields together",
    value: {
      realmId: "9130347",
      baseUrl: "https://quickbooks.api.intuit.com",
      callCeiling: 1,
    },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: "https://quickbooks.api.intuit.com",
      callCeiling: 1,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a padded realm id is passed through UNTRIMMED — the switch never normalises",
    value: { realmId: "  9130347  " },
    expected: {
      provider: QBO,
      realmId: "  9130347  ",
      baseUrl: undefined,
      callCeiling: undefined,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "unknown extra keys are dropped, not carried through",
    value: { realmId: "9130347", organizationId: "org-1", nonsense: true },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: undefined,
      callCeiling: undefined,
    } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a `provider` key in the stored value is IGNORED — the argument wins",
    value: { realmId: "9130347", provider: ASCEND },
    expected: {
      provider: QBO,
      realmId: "9130347",
      baseUrl: undefined,
      callCeiling: undefined,
    } as ProviderConfig,
  },

  // ── QuickBooks Online: rejects on the identifier it cannot work without ──
  { provider: QBO, label: "no realm id at all", value: {}, expected: undefined },
  { provider: QBO, label: "an empty realm id", value: { realmId: "" }, expected: undefined },
  {
    provider: QBO,
    label: "a whitespace-only realm id",
    value: { realmId: "   " },
    expected: undefined,
  },
  {
    provider: QBO,
    label: "a tab/newline-only realm id",
    value: { realmId: "\t\n" },
    expected: undefined,
  },
  {
    provider: QBO,
    label: "a numeric realm id — the type is the contract, not the value",
    value: { realmId: 9130347 },
    expected: undefined,
  },
  { provider: QBO, label: "a null realm id", value: { realmId: null }, expected: undefined },
  {
    provider: QBO,
    label: "an explicitly-undefined realm id",
    value: { realmId: undefined },
    expected: undefined,
  },
  {
    provider: QBO,
    label: "an array realm id",
    value: { realmId: ["9130347"] },
    expected: undefined,
  },
  {
    provider: QBO,
    label: "an object realm id",
    value: { realmId: { id: "9130347" } },
    expected: undefined,
  },
  {
    provider: QBO,
    label: "a Dentrix-shaped config on a QuickBooks row fails CLOSED",
    value: { organizationId: "org-1", locationId: "7" },
    expected: undefined,
  },

  // ── QuickBooks Online: the call ceiling is ignored, never fatal ─────────
  // A nonsense ceiling must neither block every read (ceiling 0) nor silently
  // restore the default while looking configured. The switch drops it and
  // keeps the connection; these rows pin that it is NOT a rejection path.
  {
    provider: QBO,
    label: "a zero call ceiling is ignored, not fatal",
    value: { realmId: "r", callCeiling: 0 },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a negative call ceiling is ignored",
    value: { realmId: "r", callCeiling: -5 },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a fractional call ceiling is ignored",
    value: { realmId: "r", callCeiling: 1.5 },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a numeric-string call ceiling is ignored",
    value: { realmId: "r", callCeiling: "500" },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "NaN is ignored",
    value: { realmId: "r", callCeiling: Number.NaN },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "Infinity is ignored (not an integer)",
    value: { realmId: "r", callCeiling: Number.POSITIVE_INFINITY },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a null call ceiling is ignored",
    value: { realmId: "r", callCeiling: null },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },

  // ── QuickBooks Online: the base url is optional and never validated here ─
  // Host safety is the CONNECTOR's job (`QBO_ALLOWED_API_HOSTS` +
  // UnsafeBaseUrlError). The parser deliberately accepts any non-blank string,
  // and these rows pin that the descriptor refactor did not quietly move that
  // guard — moving it would change a blocked-at-dial into a not-configured.
  {
    provider: QBO,
    label: "a blank base url collapses to undefined",
    value: { realmId: "r", baseUrl: "   " },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "a numeric base url collapses to undefined",
    value: { realmId: "r", baseUrl: 443 },
    expected: { provider: QBO, realmId: "r", baseUrl: undefined, callCeiling: undefined } as ProviderConfig,
  },
  {
    provider: QBO,
    label: "an UNSAFE base url is still ACCEPTED here — the connector refuses it, not the parser",
    value: { realmId: "r", baseUrl: "http://attacker.invalid" },
    expected: {
      provider: QBO,
      realmId: "r",
      baseUrl: "http://attacker.invalid",
      callCeiling: undefined,
    } as ProviderConfig,
  },

  // ── Dentrix Ascend: accepts ────────────────────────────────────────────
  {
    provider: ASCEND,
    label: "organization id alone — locationId stays optional BY DESIGN",
    value: { organizationId: "org-1" },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: undefined,
      baseUrl: undefined,
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "organization + location",
    value: { organizationId: "org-1", locationId: "7" },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: "7",
      baseUrl: undefined,
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "organization + location + sandbox base url",
    value: {
      organizationId: "org-1",
      locationId: "7",
      baseUrl: "https://test.hs1api.com/ascend-gateway/api",
    },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: "7",
      baseUrl: "https://test.hs1api.com/ascend-gateway/api",
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "a blank location id collapses to undefined without rejecting the row",
    value: { organizationId: "org-1", locationId: "  " },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: undefined,
      baseUrl: undefined,
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "a numeric location id collapses to undefined without rejecting the row",
    value: { organizationId: "org-1", locationId: 7 },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: undefined,
      baseUrl: undefined,
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "a padded organization id is passed through UNTRIMMED",
    value: { organizationId: " org-1 " },
    expected: {
      provider: ASCEND,
      organizationId: " org-1 ",
      locationId: undefined,
      baseUrl: undefined,
    } as ProviderConfig,
  },
  {
    provider: ASCEND,
    label: "QuickBooks' callCeiling is NOT a Dentrix field and is dropped",
    value: { organizationId: "org-1", callCeiling: 250 },
    expected: {
      provider: ASCEND,
      organizationId: "org-1",
      locationId: undefined,
      baseUrl: undefined,
    } as ProviderConfig,
  },

  // ── Dentrix Ascend: rejects ────────────────────────────────────────────
  { provider: ASCEND, label: "no organization id", value: {}, expected: undefined },
  {
    provider: ASCEND,
    label: "an empty organization id",
    value: { organizationId: "" },
    expected: undefined,
  },
  {
    provider: ASCEND,
    label: "a whitespace-only organization id",
    value: { organizationId: "  " },
    expected: undefined,
  },
  {
    provider: ASCEND,
    label: "a numeric organization id",
    value: { organizationId: 1 },
    expected: undefined,
  },
  {
    provider: ASCEND,
    label: "a null organization id",
    value: { organizationId: null },
    expected: undefined,
  },
  {
    provider: ASCEND,
    label: "a QuickBooks-shaped config on a Dentrix row fails CLOSED",
    value: { realmId: "9130347", callCeiling: 250 },
    expected: undefined,
  },
  {
    provider: ASCEND,
    label: "a location id without an organization id is not enough",
    value: { locationId: "7" },
    expected: undefined,
  },
];

describe("parseProviderConfig — equivalence table captured from the pre-change switch", () => {
  it.each(TABLE.map((r) => [`${r.provider || "<empty>"}: ${r.label}`, r] as const))(
    "%s",
    (_name, row) => {
      expect(parseProviderConfig(row.provider, row.value)).toStrictEqual(row.expected);
    },
  );

  it("covers both cloud tracks' accept AND reject paths — an under-sampled table proves nothing", () => {
    const rejects = TABLE.filter((r) => r.expected === undefined);
    const accepts = TABLE.filter((r) => r.expected !== undefined);
    expect(accepts.filter((r) => r.provider === QBO).length).toBeGreaterThanOrEqual(7);
    expect(rejects.filter((r) => r.provider === QBO).length).toBeGreaterThanOrEqual(10);
    expect(accepts.filter((r) => r.provider === ASCEND).length).toBeGreaterThanOrEqual(7);
    expect(rejects.filter((r) => r.provider === ASCEND).length).toBeGreaterThanOrEqual(7);
  });
});

describe("parseProviderConfig — the non-object guard, crossed against EVERY provider", () => {
  // Runs before any per-provider arm today. Crossing it against every provider
  // is what stops a refactor that moves the guard into one arm from letting a
  // different provider parse a JSON *string* as a config.
  it.each(
    ALL_PROVIDERS.flatMap((provider) =>
      NON_OBJECT_VALUES.map((v) => [`${provider || "<empty>"} rejects ${v.label}`, provider, v.value] as const),
    ),
  )("%s", (_name, provider, value) => {
    expect(parseProviderConfig(provider, value)).toBeUndefined();
  });
});

describe("parseProviderConfig — providers with no providerConfig concept reject everything", () => {
  // The LAN tracks take their connection facts from real columns (host, port,
  // databaseName), so there is nothing for a providerConfig to mean. Captured
  // as `undefined` for every object shape, INCLUDING a well-formed cloud
  // config, so a stale row cannot half-configure the wrong track.
  it.each(
    NO_CONFIG_PROVIDERS.flatMap((provider) =>
      OBJECT_VALUES.map((v) => [`${provider || "<empty>"} rejects ${v.label}`, provider, v.value] as const),
    ),
  )("%s", (_name, provider, value) => {
    expect(parseProviderConfig(provider, value)).toBeUndefined();
  });
});

describe("parseProviderConfig — the returned key ORDER is part of the contract", () => {
  // A persisted config is JSON, and JSON.stringify emits insertion order. A
  // generic validator that walked its field definitions in a different order
  // would round-trip differently on every row it rewrote.
  it("QuickBooks: provider, realmId, baseUrl, callCeiling", () => {
    const cfg = parseProviderConfig(QBO, { realmId: "9130347" });
    expect(Object.keys(cfg as object)).toEqual(["provider", "realmId", "baseUrl", "callCeiling"]);
  });

  it("Dentrix Ascend: provider, organizationId, locationId, baseUrl", () => {
    const cfg = parseProviderConfig(ASCEND, { organizationId: "org-1" });
    expect(Object.keys(cfg as object)).toEqual([
      "provider",
      "organizationId",
      "locationId",
      "baseUrl",
    ]);
  });

  it("emits optional keys PRESENT-with-undefined, not absent", () => {
    // `toEqual` cannot see this difference; JSON.stringify can, and so can a
    // caller doing `"baseUrl" in cfg`.
    const cfg = parseProviderConfig(QBO, { realmId: "9130347" }) as object;
    expect("baseUrl" in cfg).toBe(true);
    expect("callCeiling" in cfg).toBe(true);
  });
});
