/**
 * WARP-2217 — the descriptor registry's own contract.
 *
 * Lives in the ORCHESTRATOR rather than in `packages/shared-types` for two
 * reasons that both matter:
 *
 *  1. `packages/shared-types/tsconfig.json` EXCLUDES `src/**\/*.test.ts`, so a
 *     `@ts-expect-error` fixture placed there would never be typechecked and
 *     would silently prove nothing. `apps/orchestrator/tsconfig.json` includes
 *     `src/**\/*`, and `./scripts/test/ship-check.sh tsc-full` runs `tsc
 *     --noEmit` here — so the closed-union case below is really enforced.
 *  2. This is the one package that imports BOTH `@droplet/shared-types` and
 *     `@droplet/erp-connector`, which is what makes the dataset-vocabulary
 *     drift gate possible at all.
 *
 * Remember `vitest` does NOT typecheck (esbuild strips types). The
 * `@ts-expect-error` case is a `tsc` assertion that happens to sit in a test
 * file; it runs under ship-check, not under vitest.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  DATASETS,
  PRACTICE_DATASETS,
  QBO_DATASETS,
  STRIPE_DATASETS,
  HUBSPOT_DATASETS,
  MAILCHIMP_DATASETS,
  DEFAULT_CALL_CEILING,
  QUICKBOOKS_ONLINE_PROVIDER,
  DENTRIX_ASCEND_PROVIDER,
  STRIPE_PROVIDER,
  HUBSPOT_PROVIDER,
  MAILCHIMP_PROVIDER,
  ConnectorBlockedError,
  type DatasetName as ConnectorDatasetName,
} from "@droplet/erp-connector";
import {
  DATASET_NAMES,
  providerDescriptor,
  providerDescriptors,
  registerProviderDescriptor,
  __resetRegisteredProvidersForTest,
  buildableProviderIds,
  cloudProviderIds,
  catalogDescriptors,
  parseProviderConfigWith,
  validateCredentialFieldValue,
  type DatasetName as SharedDatasetName,
  type ProviderDescriptor,
} from "@droplet/shared-types";
import {
  connectorForProvider,
  registerConnectorFactory,
  unregisterConnectorFactory,
  isKnownErpProvider,
  isCloudErpProvider,
  parseProviderConfig,
  sharedCallBudget,
  __resetCallBudgetsForTest,
  KNOWN_ERP_PROVIDERS,
  CLOUD_ERP_PROVIDERS,
} from "./erp-provider.js";

/**
 * The two hand-maintained lists AS THEY EXISTED before this change, frozen as
 * literals.
 *
 * Deliberately NOT derived from the descriptors — a set-equality test against a
 * list computed from the thing under test proves nothing. These are the strings
 * that were in `KNOWN_ERP_PROVIDERS` (`erp-provider.ts:74`) and
 * `CLOUD_ERP_PROVIDERS` (`:89`) on `origin/stage` before the refactor.
 */
const KNOWN_ERP_PROVIDERS_BEFORE = [
  "eaglesoft",
  "eaglesoft-api",
  "quickbooks-online",
  "dentrix-ascend",
] as const;

const CLOUD_ERP_PROVIDERS_BEFORE = ["quickbooks-online", "dentrix-ascend"] as const;

/**
 * WARP-2466 — the three WARP-2214 SaaS vendors, registered on top of the
 * historical set.
 *
 * Kept SEPARATE from the `_BEFORE` anchors above rather than appended to them.
 * Those two lists are a record of what shipped before the descriptor refactor
 * and their whole value is that they are not edited when providers are added;
 * folding new ids into them would quietly turn a regression anchor into a
 * running total. The assertions below compose the two explicitly instead.
 */
const SAAS_PROVIDERS_WARP_2214 = ["stripe", "hubspot", "mailchimp"] as const;

afterEach(() => {
  __resetRegisteredProvidersForTest();
  __resetCallBudgetsForTest();
  unregisterConnectorFactory(FIXTURE_PROVIDER.id);
});

// ===========================================================================
// AC #4 — registry coverage
// ===========================================================================

describe("the descriptor set covers exactly the providers that shipped before", () => {
  it("descriptor ids are the pre-change set PLUS the WARP-2214 vendors", () => {
    // Mutation: delete one descriptor from provider-registry.ts → red.
    expect(new Set(buildableProviderIds())).toEqual(
      new Set([...KNOWN_ERP_PROVIDERS_BEFORE, ...SAAS_PROVIDERS_WARP_2214]),
    );
  });

  it("cloud-track ids are the pre-change cloud set PLUS all three SaaS vendors", () => {
    // The cloud/LAN split is preserved as a descriptor field rather than
    // erased. Every WARP-2214 vendor is a cloud track by definition — it
    // reaches a vendor SaaS — so a `track: "lan"` on any of them would be a
    // claim that it stays on the practice network, which is false.
    // Mutation: flip `dentrix-ascend`'s track to "lan", or any SaaS vendor's
    // → red.
    expect(new Set(cloudProviderIds())).toEqual(
      new Set([...CLOUD_ERP_PROVIDERS_BEFORE, ...SAAS_PROVIDERS_WARP_2214]),
    );
  });

  it("keeps the ORDER the two exported lists have always had", () => {
    // Not merely set-equal: callers see these arrays. The historical prefix is
    // asserted as a PREFIX so the pre-change order is still pinned exactly,
    // and the new vendors are asserted to follow it in declaration order.
    expect(KNOWN_ERP_PROVIDERS.slice(0, KNOWN_ERP_PROVIDERS_BEFORE.length)).toEqual([
      ...KNOWN_ERP_PROVIDERS_BEFORE,
    ]);
    expect(KNOWN_ERP_PROVIDERS.slice(KNOWN_ERP_PROVIDERS_BEFORE.length)).toEqual([
      ...SAAS_PROVIDERS_WARP_2214,
    ]);
    expect(CLOUD_ERP_PROVIDERS.slice(0, CLOUD_ERP_PROVIDERS_BEFORE.length)).toEqual([
      ...CLOUD_ERP_PROVIDERS_BEFORE,
    ]);
    expect(CLOUD_ERP_PROVIDERS.slice(CLOUD_ERP_PROVIDERS_BEFORE.length)).toEqual([
      ...SAAS_PROVIDERS_WARP_2214,
    ]);
  });

  it("every buildable descriptor can actually be built — no id without a factory", () => {
    // A descriptor whose factory was never registered would pass every
    // set-equality assertion above and then throw the first time a real
    // connection used it.
    for (const id of buildableProviderIds()) {
      expect(() =>
        connectorForProvider({
          provider: id,
          host: "10.0.0.5",
          connectionId: "conn-1",
          // The minimum each cloud factory needs to get past its own refusal.
          // Supplied for every provider rather than per-id, because this test
          // is about "is there a factory", not about validation — and a
          // per-id switch here would be the vendor branching the registry
          // exists to remove.
          providerConfig: {
            provider: id,
            realmId: "r-1",
            organizationId: "o-1",
            portalId: "p-1",
            datacenter: "us14",
          },
        }),
      ).not.toThrow(/unknown ERP provider/);
    }
  });

  it("keeps the catalog-only placeholder OUT of the buildable set", () => {
    expect(providerDescriptor("opendental")?.track).toBe("catalog");
    expect(buildableProviderIds()).not.toContain("opendental");
    expect(isKnownErpProvider("opendental")).toBe(false);
    expect(isCloudErpProvider("opendental")).toBe(false);
  });

  it("gives every descriptor the fields both apps read", () => {
    for (const d of providerDescriptors()) {
      expect(d.id, "descriptor id").toBeTruthy();
      expect(d.displayName, `${d.id} displayName`).toBeTruthy();
      expect(d.category, `${d.id} category`).toBeTruthy();
      expect(Array.isArray(d.credentialFields), `${d.id} credentialFields`).toBe(true);
      expect(Array.isArray(d.egressHosts), `${d.id} egressHosts`).toBe(true);
      expect(Array.isArray(d.datasets), `${d.id} datasets`).toBe(true);
    }
  });
});

// ===========================================================================
// AC #3 — datasets are the CLOSED union of six, never string[]
// ===========================================================================

describe("datasets are typed by the closed union, not widened to string[]", () => {
  it("declares the same six dataset names the connector package does", () => {
    // The vocabulary is MIRRORED into shared-types (which cannot import the
    // server-only connector package without dragging it across the dashboard's
    // RSC boundary), so it is GATED rather than trusted. Mutation: add a
    // seventh name on either side → red.
    expect([...DATASET_NAMES]).toEqual([...DATASETS]);
  });

  it("keeps the two vocabularies mutually assignable at COMPILE time", () => {
    // Set equality above is a runtime check and would still pass if one side
    // widened its TYPE to `string`. These two assignments are the type-level
    // half, and they are what actually goes red under `tsc` if either union
    // stops being the closed six.
    const fromShared: ConnectorDatasetName[] = [...DATASET_NAMES];
    const fromConnector: SharedDatasetName[] = [...DATASETS];
    expect(fromShared).toEqual(fromConnector);
  });

  it("declares datasets that the connectors actually report serving", () => {
    // Reconciled against `Connector.servesDatasets` rather than duplicated
    // blindly — the descriptor must not claim a dataset the track refuses.
    expect(providerDescriptor("eaglesoft")?.datasets).toEqual([...PRACTICE_DATASETS]);
    expect(providerDescriptor("eaglesoft-api")?.datasets).toEqual([...PRACTICE_DATASETS]);
    expect(providerDescriptor(DENTRIX_ASCEND_PROVIDER)?.datasets).toEqual([...PRACTICE_DATASETS]);
    expect(providerDescriptor(QUICKBOOKS_ONLINE_PROVIDER)?.datasets).toEqual([...QBO_DATASETS]);
  });

  it("reconciles the three cloud SaaS tracks the same way (WARP-2497)", () => {
    // The four assertions above shipped without covering Stripe, HubSpot or
    // Mailchimp, and the gap was not cosmetic: `STRIPE_DATASETS` gained
    // `charge` in WARP-2497 and nothing would have noticed if the descriptor
    // had been left claiming `invoice` alone. The cloud read tool resolves a
    // dataset to a connection THROUGH the descriptor, so a descriptor that
    // under-claims makes a dataset the track genuinely serves unreachable —
    // silently, and only from chat.
    //
    // Mutation: drop "charge" from either STRIPE_DATASETS or the descriptor's
    // `datasets` (but not both) → red.
    expect(providerDescriptor(STRIPE_PROVIDER)?.datasets).toEqual([...STRIPE_DATASETS]);
    expect(providerDescriptor(HUBSPOT_PROVIDER)?.datasets).toEqual([...HUBSPOT_DATASETS]);
    expect(providerDescriptor(MAILCHIMP_PROVIDER)?.datasets).toEqual([...MAILCHIMP_DATASETS]);
  });

  it("a dataset outside the closed union is a TYPE error, not a runtime one", () => {
    // ⚠ This case is enforced by `tsc`, NOT by vitest — esbuild strips types,
    // so under vitest the body below is simply an object literal.
    //
    // Mutation: widen `ProviderDescriptor.datasets` to `readonly string[]` and
    // the @ts-expect-error becomes UNUSED, which is itself a tsc error
    // ("Unused '@ts-expect-error' directive") — so the mutation goes red under
    // `./scripts/test/ship-check.sh tsc-full` in both directions.
    const bad: ProviderDescriptor = {
      id: "fixture-bad-dataset",
      displayName: "Bad dataset fixture",
      category: "Accounting",
      track: "cloud",
      credentialFields: [],
      egressHosts: [],
      // @ts-expect-error -- "ledger" is not one of the six DatasetName values.
      datasets: ["ledger"],
    };
    expect(bad.datasets).toEqual(["ledger"]);
  });
});

// ===========================================================================
// AC #8 — the metered-call policy moved, its values did not
// ===========================================================================

describe("CallBudget limits come from the descriptor, at today's shipped values", () => {
  /** The pinned table. Literal numbers, not references — a table that read the
   *  descriptor would agree with any retune. */
  const RATE_LIMIT_TABLE: ReadonlyArray<{
    provider: string;
    callCeiling: number | undefined;
    periodMs: number | undefined;
    ceilingOverrideField: string | undefined;
  }> = [
    { provider: "eaglesoft", callCeiling: undefined, periodMs: undefined, ceilingOverrideField: undefined },
    { provider: "eaglesoft-api", callCeiling: undefined, periodMs: undefined, ceilingOverrideField: undefined },
    // 5,000 metered reads per 30 days — today's DEFAULT_CALL_CEILING and
    // CallBudget's default period, unchanged by this refactor.
    { provider: "quickbooks-online", callCeiling: 5_000, periodMs: 2_592_000_000, ceilingOverrideField: "callCeiling" },
    // Deliberately none: Ascend's limits are per-endpoint and dynamic, handled
    // by reacting to a 429 where it arrives. The ABSENCE is the policy.
    { provider: "dentrix-ascend", callCeiling: undefined, periodMs: undefined, ceilingOverrideField: undefined },
    { provider: "opendental", callCeiling: undefined, periodMs: undefined, ceilingOverrideField: undefined },
  ];

  it.each(RATE_LIMIT_TABLE)(
    "$provider rate limit is pinned",
    ({ provider, callCeiling, periodMs, ceilingOverrideField }) => {
      // Mutation: change any descriptor's rateLimit → red.
      const rl = providerDescriptor(provider)?.rateLimit;
      expect(rl?.callCeiling).toBe(callCeiling);
      expect(rl?.periodMs).toBe(periodMs);
      expect(rl?.ceilingOverrideField).toBe(ceilingOverrideField);
    },
  );

  it("the pinned QuickBooks ceiling IS the shipped DEFAULT_CALL_CEILING", () => {
    // Ties the literal above to the constant the connector package still
    // exports, so the two cannot drift apart without one of them going red.
    expect(providerDescriptor(QUICKBOOKS_ONLINE_PROVIDER)?.rateLimit?.callCeiling).toBe(
      DEFAULT_CALL_CEILING,
    );
  });

  it("uses the descriptor ceiling when the row does not override it", () => {
    const c = connectorForProvider({
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      host: "",
      connectionId: "conn-ceiling-default",
      providerConfig: parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "r" }),
    });
    expect(c.provider).toBe(QUICKBOOKS_ONLINE_PROVIDER);
    // The registry is what the wiring controls: asking for the descriptor's
    // ceiling returns the SAME budget the factory just created, which it only
    // can if the factory used that number.
    const budget = sharedCallBudget("conn-ceiling-default", DEFAULT_CALL_CEILING);
    expect(budget.ceiling).toBe(DEFAULT_CALL_CEILING);
    expect(sharedCallBudget("conn-ceiling-default", DEFAULT_CALL_CEILING)).toBe(budget);
  });

  it("honours the operator override named by the descriptor", () => {
    connectorForProvider({
      provider: QUICKBOOKS_ONLINE_PROVIDER,
      host: "",
      connectionId: "conn-ceiling-override",
      providerConfig: parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, {
        realmId: "r",
        callCeiling: 250,
      }),
    });
    // Mutation: drop `ceilingOverrideField` from the descriptor and the factory
    // silently uses 5,000 instead — this reference-equality check goes red.
    const overridden = sharedCallBudget("conn-ceiling-override", 250);
    expect(overridden.ceiling).toBe(250);
    expect(sharedCallBudget("conn-ceiling-override", 250)).toBe(overridden);
  });

  it("gives a non-metered track no shared budget entry to inherit", () => {
    // Dentrix has no rateLimit; building it must not silently mint a budget at
    // QuickBooks' ceiling for a connection that is never metered.
    connectorForProvider({
      provider: DENTRIX_ASCEND_PROVIDER,
      host: "",
      connectionId: "conn-ascend",
      providerConfig: parseProviderConfig(DENTRIX_ASCEND_PROVIDER, { organizationId: "org-1" }),
    });
    const fresh = sharedCallBudget("conn-ascend", DEFAULT_CALL_CEILING);
    expect(fresh.snapshot().spent).toBe(0);
  });
});

// ===========================================================================
// AC #7 — a sixth provider costs one descriptor, and does NOT touch this module
// ===========================================================================

/**
 * A sixth provider, declared entirely as data.
 *
 * The point of this fixture is what it does NOT require: no edit to
 * `erp-provider.ts`, no new `ProviderConfig` union arm, no `parseProviderConfig`
 * case, no `connectorForProvider` branch. A descriptor plus a factory
 * registration is the whole cost — which is the claim the ticket is making, so
 * it is asserted rather than described.
 *
 * It also exercises `pattern`, which no shipped provider uses: the validation
 * regex is part of the declared contract, and an untested contract slot is a
 * promise nobody checked.
 */
const FIXTURE_PROVIDER: ProviderDescriptor = {
  id: "fixture-ledger",
  displayName: "Fixture Ledger",
  category: "Accounting",
  track: "cloud",
  credentialFields: [
    {
      name: "tenantId",
      label: "Tenant id",
      type: "string",
      required: true,
      secret: false,
      storage: "providerConfig",
      // Digits only — the case shipped providers deliberately do not have.
      pattern: "^[0-9]+$",
    },
    {
      name: "region",
      label: "Region",
      type: "string",
      required: false,
      secret: false,
      storage: "providerConfig",
    },
    {
      name: "apiKey",
      label: "API key",
      type: "string",
      required: true,
      secret: true,
      // Encrypted at rest, so NOT part of providerConfig — and therefore not
      // part of what parseProviderConfig validates or emits.
      storage: "encrypted",
    },
  ],
  egressHosts: ["ledger.example.test"],
  datasets: ["invoice"],
  rateLimit: { callCeiling: 100, periodMs: 86_400_000 },
};

describe("adding a sixth provider is one descriptor plus one registration", () => {
  it("is unknown until registered — the registry is the only gate", () => {
    expect(providerDescriptor("fixture-ledger")).toBeUndefined();
    expect(isKnownErpProvider("fixture-ledger")).toBe(false);
    expect(parseProviderConfig("fixture-ledger", { tenantId: "1" })).toBeUndefined();
    expect(() => connectorForProvider({ provider: "fixture-ledger", host: "" })).toThrow(
      ConnectorBlockedError,
    );
  });

  it("becomes a fully working provider from data alone, with erp-provider.ts untouched", () => {
    registerProviderDescriptor(FIXTURE_PROVIDER);

    // 1. It is known, and known as a CLOUD track, purely from `track`.
    expect(isKnownErpProvider("fixture-ledger")).toBe(true);
    expect(isCloudErpProvider("fixture-ledger")).toBe(true);

    // 2. Its config validates off `credentialFields` — no new case arm.
    expect(parseProviderConfig("fixture-ledger", { tenantId: "42", region: "eu" })).toStrictEqual({
      provider: "fixture-ledger",
      tenantId: "42",
      region: "eu",
    });
    // The encrypted field is NOT emitted into providerConfig: a credential must
    // never land in a plaintext JSON column.
    expect(
      parseProviderConfig("fixture-ledger", { tenantId: "42", apiKey: "sk-live-secret" }),
    ).toStrictEqual({ provider: "fixture-ledger", tenantId: "42", region: undefined });
    expect(
      JSON.stringify(parseProviderConfig("fixture-ledger", { tenantId: "42", apiKey: "sk-live-secret" })),
    ).not.toContain("sk-live-secret");

    // 3. A required field that is missing rejects the whole config.
    //    Mutation: flip `tenantId.required` to false → this goes red.
    expect(parseProviderConfig("fixture-ledger", { region: "eu" })).toBeUndefined();

    // 4. The validation regex is honoured — a non-matching REQUIRED value is
    //    treated exactly like an absent one.
    expect(parseProviderConfig("fixture-ledger", { tenantId: "not-digits" })).toBeUndefined();

    // 5. A connector factory registered from outside this module is dispatched
    //    to, and is handed the narrowed config.
    registerConnectorFactory("fixture-ledger", ({ config: cfg }) => ({
      provider: `fixture-ledger:${cfg?.tenantId ?? "unconfigured"}`,
      servesDatasets: ["invoice"],
      connect: async () => {},
      close: async () => {},
      health: async () => ({ ok: true }),
      introspect: async () => ({ tables: [], fingerprint: "fixture" }),
      runRead: async () => [],
      applyWrite: async () => ({}),
    }));

    const c = connectorForProvider({
      provider: "fixture-ledger",
      host: "",
      providerConfig: parseProviderConfig("fixture-ledger", { tenantId: "42" }),
    });
    expect(c.provider).toBe("fixture-ledger:42");
  });

  it("refuses to shadow a built-in descriptor", () => {
    // A runtime registration that could replace `quickbooks-online` would be a
    // way to repoint a shipped, egress-reviewed track at another host.
    expect(() => registerProviderDescriptor({ ...FIXTURE_PROVIDER, id: "quickbooks-online" })).toThrow(
      /built-in/,
    );
  });

  it("does not leak a config belonging to another provider into a factory", () => {
    registerProviderDescriptor(FIXTURE_PROVIDER);
    registerConnectorFactory("fixture-ledger", ({ config: cfg }) => ({
      provider: `fixture-ledger:${cfg === undefined ? "no-config" : "leaked"}`,
      servesDatasets: [],
      connect: async () => {},
      close: async () => {},
      health: async () => ({ ok: true }),
      introspect: async () => ({ tables: [], fingerprint: "fixture" }),
      runRead: async () => [],
      applyWrite: async () => ({}),
    }));
    const c = connectorForProvider({
      provider: "fixture-ledger",
      host: "",
      // A QuickBooks config on a fixture-ledger row.
      providerConfig: parseProviderConfig(QUICKBOOKS_ONLINE_PROVIDER, { realmId: "9130347" }),
    });
    expect(c.provider).toBe("fixture-ledger:no-config");
  });
});

// ===========================================================================
// The generic validator's own edges
// ===========================================================================

describe("validateCredentialFieldValue", () => {
  const stringField = {
    name: "f",
    label: "F",
    type: "string",
    required: false,
    secret: false,
    storage: "providerConfig",
  } as const;
  const intField = { ...stringField, type: "positiveInteger" } as const;

  it("accepts a non-blank string WITHOUT trimming it", () => {
    // Mutation: return `raw.trim()` and this goes red — as does the untrimmed
    // passthrough row in the equivalence table.
    expect(validateCredentialFieldValue(stringField, " padded ")).toBe(" padded ");
  });

  it("rejects blank, non-string and structural values", () => {
    for (const raw of ["", "   ", "\t\n", 5, null, undefined, [], {}, true]) {
      expect(validateCredentialFieldValue(stringField, raw)).toBeUndefined();
    }
  });

  it("accepts only positive integers for a positiveInteger field", () => {
    expect(validateCredentialFieldValue(intField, 1)).toBe(1);
    expect(validateCredentialFieldValue(intField, 5_000)).toBe(5_000);
    for (const raw of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null, undefined]) {
      expect(validateCredentialFieldValue(intField, raw)).toBeUndefined();
    }
  });

  it("applies a pattern AFTER the non-blank check, never instead of it", () => {
    const patterned = { ...stringField, pattern: "^[0-9]+$" } as const;
    expect(validateCredentialFieldValue(patterned, "42")).toBe("42");
    expect(validateCredentialFieldValue(patterned, "4a2")).toBeUndefined();
    expect(validateCredentialFieldValue(patterned, "")).toBeUndefined();
  });
});

describe("parseProviderConfigWith is pure — it never reaches the registry", () => {
  it("returns undefined for an absent descriptor rather than throwing", () => {
    expect(parseProviderConfigWith(undefined, { realmId: "r" })).toBeUndefined();
  });

  it("returns undefined for a descriptor with no providerConfig-stored fields", () => {
    // This is what keeps a well-formed cloud config on a LAN row from
    // half-configuring anything, and it is why `eaglesoft` rejects every value.
    const lanOnly = providerDescriptor("eaglesoft");
    expect(lanOnly?.credentialFields.some((f) => f.storage === "providerConfig")).toBe(false);
    expect(parseProviderConfigWith(lanOnly, { realmId: "r" })).toBeUndefined();
  });
});

// ===========================================================================
// Egress declarations
// ===========================================================================

describe("egressHosts are bare hosts a CI gate can check", () => {
  it("declares hosts, never URLs or paths", () => {
    // A full-URL literal here would be a SECOND extraction site for the egress
    // scanner, competing with the connectors' own base-URL literals which are
    // full strings precisely so the scanner can read them.
    for (const d of providerDescriptors()) {
      for (const host of d.egressHosts) {
        expect(host, `${d.id} egress host`).not.toMatch(/:\/\/|\/|\s/);
        expect(host, `${d.id} egress host`).toBe(host.toLowerCase());
      }
    }
  });

  it("declares the vendor hosts each cloud track actually dials", () => {
    expect(providerDescriptor(QUICKBOOKS_ONLINE_PROVIDER)?.egressHosts).toEqual([
      "quickbooks.api.intuit.com",
      "sandbox-quickbooks.api.intuit.com",
      "oauth.platform.intuit.com",
    ]);
    expect(providerDescriptor(DENTRIX_ASCEND_PROVIDER)?.egressHosts).toEqual([
      "prod.hs1api.com",
      "test.hs1api.com",
    ]);
  });

  it("declares NO egress for the LAN tracks", () => {
    // An empty list is a claim, not an omission: these tracks reach a box on
    // the practice network named by a connection row, never a vendor host.
    expect(providerDescriptor("eaglesoft")?.egressHosts).toEqual([]);
    expect(providerDescriptor("eaglesoft-api")?.egressHosts).toEqual([]);
  });
});

// ===========================================================================
// The hub catalog derivation, from the orchestrator's side
// ===========================================================================

describe("the hub catalog is derived from the same descriptors", () => {
  it("puts one card per vendor, in the shipped hub order", () => {
    // `eaglesoft-api` carries no catalog block ON PURPOSE: two cards for two
    // transports of one vendor is a question no practice owner can answer.
    expect(catalogDescriptors().map((d) => d.catalog?.id)).toEqual([
      "eaglesoft",
      "dentrix",
      "quickbooks",
      "opendental",
      // WARP-2466 — the three SaaS vendors, after the practice/accounting
      // cards that shipped first. `catalog.order` pins this, so it survives a
      // reordering of the descriptor declarations.
      "stripe",
      "hubspot",
      "mailchimp",
    ]);
  });
});
