/**
 * WARP-2217 — the provider registry: one descriptor per provider, and the only
 * gate on what a provider IS.
 *
 * `IntegrationConnection.provider` is free-text TEXT with no enum and no check
 * constraint (`schema.prisma`), so a new provider key has never needed a
 * migration. What it needed instead was four hand-edits in two apps. This file
 * replaces all four: adding a provider is adding one object here, plus its
 * `Connector` implementation and its egress allowlist entries.
 *
 * Both apps read THIS list. The orchestrator drives config validation,
 * connector dispatch and the metered-call budget off it; the dashboard drives
 * its hub catalog and its credential form off it. That is the point — before
 * this, the dashboard's idea of a provider's credential fields was
 * structurally unrelated to the orchestrator's, so the two could not even be
 * compared.
 *
 * Ordering in this file is the historical order of the two provider lists it
 * replaces (`KNOWN_ERP_PROVIDERS`, then the cloud tracks), so the derived lists
 * come out in the order callers already see. Hub ordering is separate and
 * pinned by `catalog.order`.
 */
import type { ProviderDescriptor } from "./provider-descriptor";

/** Practice-management datasets — mirrors `PRACTICE_DATASETS` in the connector
 *  package, gated by the orchestrator's dataset-vocabulary drift test. */
const PRACTICE_DATASETS = ["appointment", "patient", "account"] as const;

/** 30 days in ms — `CallBudget`'s shipped period, matching Intuit's monthly
 *  allowance rather than a calendar month (which would need a timezone a
 *  connector has no business having an opinion about). */
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The providers this appliance knows about.
 *
 * `as const satisfies` rather than a plain annotation ON PURPOSE: the literal
 * types survive, so a `datasets` entry outside the closed union of six is a
 * `tsc` error at the declaration site — see the `@ts-expect-error` fixture in
 * `provider-registry.test.ts`.
 */
export const BUILT_IN_PROVIDER_DESCRIPTORS = [
  {
    id: "eaglesoft",
    displayName: "Eaglesoft",
    category: "Practice management",
    // The flagship direct-SQL track: reads a Patterson SAP SQL Anywhere
    // database on the practice LAN, via the erp-sql-bridge sidecar.
    track: "lan",
    credentialFields: [
      {
        name: "host",
        label: "Server host or IP",
        type: "string",
        required: true,
        secret: false,
        storage: "column",
        help: "The machine on your network running the Eaglesoft database.",
      },
      {
        name: "port",
        label: "TCP port",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "column",
        help: "Defaults to 2638, SQL Anywhere's port.",
      },
      {
        name: "databaseName",
        label: "Database name",
        type: "string",
        required: false,
        secret: false,
        storage: "column",
        help: 'Defaults to "PattersonPM".',
      },
      {
        // A POINTER into the encrypted secret store, never cleartext — which
        // is why it is not marked `secret`: the value in this field is a
        // label that appears in logs and audit rows by design.
        name: "secretRef",
        label: "Read-account secret reference",
        type: "string",
        required: false,
        secret: false,
        storage: "column",
      },
    ],
    // Never leaves the LAN. An empty list is a CLAIM, checked by the egress
    // drift gate like any other — not an omission.
    egressHosts: [],
    datasets: PRACTICE_DATASETS,
    catalog: {
      id: "eaglesoft",
      name: "Eaglesoft",
      category: "Practice management",
      description:
        "Read your schedule, patients, and balances — directly from Eaglesoft, on your network.",
      availability: "available",
      order: 0,
    },
  },
  {
    id: "eaglesoft-api",
    displayName: "Eaglesoft (Patterson API)",
    category: "Practice management",
    // The dual-track official-REST-API provider — Patterson Innovation
    // Connection over HTTPS :9888, still on the practice LAN.
    track: "lan",
    credentialFields: [
      {
        name: "host",
        label: "Server host or IP",
        type: "string",
        required: true,
        secret: false,
        storage: "column",
      },
      {
        name: "port",
        label: "HTTPS port",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "column",
        help: "Defaults to 9888, Patterson's Innovation Connection port.",
      },
      {
        name: "integrationKey",
        label: "Integration key",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
      {
        name: "userId",
        label: "User id",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
      {
        name: "password",
        label: "Password",
        type: "string",
        required: true,
        secret: true,
        storage: "encrypted",
      },
    ],
    // The box is named by a connection row, not by a fixed vendor hostname, so
    // there is no static destination to register. Host safety on this track is
    // the operator's network, not an allowlist.
    egressHosts: [],
    datasets: PRACTICE_DATASETS,
    // No `catalog` block: the hub shows ONE "Eaglesoft" card, and the direct
    // track above carries it. Two cards for two transports of one vendor would
    // be a question no practice owner can answer.
  },
  {
    id: "quickbooks-online",
    displayName: "QuickBooks Online",
    category: "Accounting",
    track: "cloud",
    credentialFields: [
      {
        name: "realmId",
        label: "QuickBooks company id",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        // Deliberately NO `pattern`. Intuit's realm ids are opaque and their
        // documented format has changed; a regex here would reject companies
        // that work today for the sake of a validation nobody asked for.
        help: "Intuit calls this the realm id. It arrives with the OAuth grant.",
      },
      {
        name: "baseUrl",
        label: "API base URL",
        type: "string",
        required: false,
        secret: false,
        storage: "providerConfig",
        // Not validated here on purpose: `QBO_ALLOWED_API_HOSTS` +
        // UnsafeBaseUrlError refuse an unsafe host at DIAL time, where the
        // refusal is a blocked read the operator can act on. Rejecting it here
        // instead would turn that into an indistinguishable "not configured".
        help: "Leave blank for production. Set to Intuit's sandbox to rehearse.",
      },
      {
        name: "callCeiling",
        label: "Metered calls per 30 days",
        type: "positiveInteger",
        required: false,
        secret: false,
        storage: "providerConfig",
        help: "Overrides the default ceiling for this connection.",
      },
    ],
    egressHosts: [
      "quickbooks.api.intuit.com",
      "sandbox-quickbooks.api.intuit.com",
      // The OAuth token endpoint. Dialed by the orchestrator's OAuth wiring
      // rather than by the connector (which holds no token endpoint at all),
      // but it is this provider's egress and belongs in its declaration.
      "oauth.platform.intuit.com",
    ],
    datasets: ["invoice", "bill", "ap_summary"],
    rateLimit: {
      // Today's shipped `DEFAULT_CALL_CEILING`. 5,000 metered reads per 30 days
      // ≈ 166/day, which covers a daily sync plus an assistant answering
      // questions all day and puts ~100 boxes inside the free Builder pool.
      callCeiling: 5_000,
      periodMs: THIRTY_DAYS_MS,
      ceilingOverrideField: "callCeiling",
    },
    catalog: {
      id: "quickbooks",
      name: "QuickBooks",
      category: "Accounting",
      description:
        "Production, receivables, and deposits from your books — no export, no upload.",
      availability: "coming-soon",
      order: 2,
    },
  },
  {
    id: "dentrix-ascend",
    displayName: "Dentrix Ascend",
    category: "Practice management",
    track: "cloud",
    credentialFields: [
      {
        name: "organizationId",
        label: "Organization ID",
        type: "string",
        required: true,
        secret: false,
        storage: "providerConfig",
        help: "Issued by Henry Schein One at vendor enrolment.",
      },
      {
        name: "locationId",
        label: "Location ID",
        type: "string",
        // Optional BY DESIGN, and load-bearing: without a location the
        // connector still serves the schedule and patients and refuses only
        // the AR read, which is more useful than refusing the connection.
        required: false,
        secret: false,
        storage: "providerConfig",
      },
      {
        name: "baseUrl",
        label: "API base URL",
        type: "string",
        required: false,
        secret: false,
        storage: "providerConfig",
        help: "Leave blank for production. Set to the sandbox during enrolment.",
      },
    ],
    egressHosts: ["prod.hs1api.com", "test.hs1api.com"],
    datasets: PRACTICE_DATASETS,
    // No `rateLimit`, deliberately: Ascend's limits are per-endpoint and
    // dynamic, handled by reacting to a 429 where it arrives. A local ceiling
    // invented for it would be a guess wearing a policy's clothes.
    catalog: {
      id: "dentrix",
      name: "Dentrix",
      category: "Practice management",
      description: "Schedule, patients, and ledgers from Dentrix — read on your own network.",
      availability: "coming-soon",
      order: 1,
    },
  },
  {
    id: "opendental",
    displayName: "Open Dental",
    category: "Practice management",
    // A hub card with NO shipped track (WARP-1101 framework placeholder).
    // `catalog` says so explicitly rather than leaving it to be inferred from
    // an absent connector factory — absence is never a silent anything, and
    // this is what keeps it out of the buildable-provider list.
    track: "catalog",
    credentialFields: [],
    egressHosts: [],
    datasets: [],
    catalog: {
      id: "opendental",
      name: "Open Dental",
      category: "Practice management",
      description:
        "Read the schedule and patient records straight from your Open Dental database.",
      availability: "coming-soon",
      order: 3,
    },
  },
] as const satisfies readonly ProviderDescriptor[];

/**
 * Descriptors registered at runtime, on top of the built-in list.
 *
 * The extension seam AC #7 is about: a provider can be added without touching
 * the orchestrator's factory module at all. Used in-repo by the fixture
 * provider in `__tests__`, and by any future descriptor that ships outside this
 * file.
 */
const registered = new Map<string, ProviderDescriptor>();

/** Register a descriptor. Replaces an existing registration with the same id;
 *  built-in descriptors are never replaced (they are the shipped contract). */
export function registerProviderDescriptor(descriptor: ProviderDescriptor): void {
  if (BUILT_IN_PROVIDER_DESCRIPTORS.some((d) => d.id === descriptor.id)) {
    throw new Error(
      `cannot re-register built-in provider "${descriptor.id}" — edit its descriptor instead`,
    );
  }
  registered.set(descriptor.id, descriptor);
}

/** Drop every runtime registration. Test seam only. */
export function __resetRegisteredProvidersForTest(): void {
  registered.clear();
}

/** Every descriptor, built-in first then registered, in declaration order. */
export function providerDescriptors(): readonly ProviderDescriptor[] {
  return [...BUILT_IN_PROVIDER_DESCRIPTORS, ...registered.values()];
}

/**
 * The descriptor for a provider key, or undefined.
 *
 * Undefined here means "not a provider we know about" and is the ONLY place
 * that question is answered. Callers that cannot proceed without one throw;
 * callers describing a row degrade. Neither guesses.
 */
export function providerDescriptor(id: string): ProviderDescriptor | undefined {
  return (
    BUILT_IN_PROVIDER_DESCRIPTORS.find((d) => d.id === id) ?? registered.get(id)
  );
}

/**
 * Providers with a shipped transport — the descriptor-derived replacement for
 * the hand-maintained `KNOWN_ERP_PROVIDERS`.
 *
 * Excludes `catalog` tracks: a placeholder card is not something a connection
 * row may name.
 */
export function buildableProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track !== "catalog")
    .map((d) => d.id);
}

/**
 * The cloud tracks — the descriptor-derived replacement for the hand-maintained
 * `CLOUD_ERP_PROVIDERS`.
 *
 * Kept as a distinction rather than collapsed away: cloud rows take their
 * account identity from `providerConfig` and their credentials from
 * `providerTokensEnc`, so a caller genuinely needs to know which kind a row is.
 */
export function cloudProviderIds(): readonly string[] {
  return providerDescriptors()
    .filter((d) => d.track === "cloud")
    .map((d) => d.id);
}

/** Every descriptor that puts a card on the Integrations hub, in hub order. */
export function catalogDescriptors(): readonly ProviderDescriptor[] {
  return providerDescriptors()
    .filter((d) => d.catalog !== undefined)
    .slice()
    .sort((a, b) => (a.catalog?.order ?? 0) - (b.catalog?.order ?? 0));
}

/** The descriptor behind a hub card id (`quickbooks` → `quickbooks-online`).
 *  The hub's vocabulary is vendor-level; a descriptor's is track-level. */
export function descriptorForCatalogId(catalogId: string): ProviderDescriptor | undefined {
  return providerDescriptors().find((d) => d.catalog?.id === catalogId);
}
