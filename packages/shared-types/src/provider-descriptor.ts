/**
 * WARP-2217 — the declarative provider descriptor.
 *
 * Adding a cloud provider used to mean hand-editing four independent sites: a
 * `ProviderConfig` union arm, a `parseProviderConfig` switch case, a
 * `connectorForProvider` if-branch, and — in a different app entirely — the
 * dashboard's own hand-written connector catalog, which had a structurally
 * unrelated idea of what credentials a provider needs. Five vendors times four
 * sites is a serialised merge queue on three regions of one file, which is the
 * throttle on the integrations programme that adding engineers cannot fix.
 *
 * A descriptor makes provider addition DATA. One object per provider carries
 * everything both apps need to know about it: identity, how the hub presents
 * it, what fields it needs and where each is stored, which hosts it dials,
 * which datasets it can serve, and what its metered-call policy is. The
 * orchestrator drives validation, connector dispatch and budget policy off it;
 * the dashboard drives its catalog and its credential form off the SAME object,
 * so the two can no longer disagree.
 *
 * Deliberately PURE DATA AND PURE FUNCTIONS — no Node imports, no I/O, no
 * `@droplet/erp-connector` dependency. This module is imported by the Next.js
 * dashboard, and a runtime dependency on the connector package would drag a
 * server-only package across the RSC boundary (a break `tsc` and `vitest` both
 * miss; only `next build` catches it).
 *
 * What a descriptor is NOT:
 *  • It is not a secret store. `CredentialFieldDef` describes the SHAPE of a
 *    field, never its value; a field marked `secret` still has its value
 *    encrypted at rest by the orchestrator's column crypto.
 *  • It does not replace the connectors' own exact-host guards
 *    (`QBO_ALLOWED_API_HOSTS` / `assertSafeAscendBaseUrl`). `egressHosts` is a
 *    declaration for the CI drift gate; the code-side refusal is what actually
 *    stops a token being sent somewhere. Both must exist.
 */

/**
 * The logical datasets a track can serve.
 *
 * MIRRORS `services/erp-connector/src/export-drop/profiles.ts` `DATASETS`, and
 * is mirrored rather than imported ON PURPOSE: this module is bundled into the
 * dashboard, and `@droplet/erp-connector` is a server-only package that must
 * not cross that boundary. The mirror is not trusted — it is GATED. The
 * orchestrator (which imports both) carries a drift test asserting the two
 * vocabularies are set-equal AND mutually assignable at compile time, so a
 * dataset added on one side and not the other goes red rather than silently
 * splitting the vocabulary in two.
 *
 * Widened six → twenty alongside WARP-2280, then twenty → twenty-three by
 * WARP-2466's reconciliation, with that drift test as the guard throughout.
 */
export const DATASET_NAMES = [
  // practice-management (WARP-1964)
  "appointment",
  "patient",
  "account",
  // accounting (WARP-2107)
  "invoice",
  "bill",
  "ap_summary",
  // payments — Stripe (WARP-2280)
  "charge",
  "refund",
  "payout",
  "balance_transaction",
  "subscription",
  // CRM — HubSpot (WARP-2280; `engagement` added by WARP-2466)
  "contact",
  "company",
  "deal",
  "ticket",
  "engagement",
  // commerce — Shopify (WARP-2280)
  "order",
  "product",
  "customer",
  // marketing — Mailchimp (WARP-2280; the two below added by WARP-2466)
  "campaign",
  "audience",
  "audience_member",
  "ecommerce_order",
] as const;

/**
 * The closed union of twenty-three. A descriptor's `datasets` is typed with THIS, never
 * `string[]`: the exhaustive `Record`s keyed by it (`DATASET_CATEGORY`,
 * `CANONICAL_COLUMNS`) only buy exhaustiveness while the union stays closed,
 * and a widened `string[]` throws that away silently.
 */
export type DatasetName = (typeof DATASET_NAMES)[number];

/**
 * How a field's value is persisted — which decides who validates it.
 *
 *  • `providerConfig` — a non-secret connection fact stored in the row's
 *    free-text `providerConfig` JSON. These, and ONLY these, are what
 *    `parseProviderConfig` validates.
 *  • `encrypted` — a credential, stored in an `*Enc` column under the
 *    orchestrator's column crypto. Never in `providerConfig`, never logged.
 *  • `column` — a first-class column on `IntegrationConnection` that predates
 *    this descriptor (`host`, `port`, `databaseName`).
 */
export type CredentialFieldStorage = "providerConfig" | "encrypted" | "column";

/**
 * A field's value type.
 *
 * `positiveInteger` is its own type rather than "number with a min" because
 * the one shipped instance (QuickBooks' `callCeiling`) has a load-bearing
 * reason to reject zero and negatives *without* rejecting the connection: a
 * ceiling of 0 would block every read, and a falsy-read ceiling would silently
 * restore the default while the row looked configured.
 */
export type CredentialFieldType = "string" | "positiveInteger";

/**
 * One field a provider needs, described once for both apps.
 *
 * The dashboard renders it (label, type, secret, required); the orchestrator
 * validates against it. Before this existed the dashboard held no field
 * definitions at all, so the admin form and the validator could not even be
 * compared, let alone kept in agreement.
 */
export interface CredentialFieldDef {
  /** Key in `providerConfig` / the connect payload. */
  readonly name: string;
  /** Human label for the admin form. */
  readonly label: string;
  readonly type: CredentialFieldType;
  /**
   * Required fields are the ones the track cannot address an account without.
   * A missing or blank required field REJECTS the whole config — the connector
   * is then constructed blocked and the connection degrades to
   * ERP_NOT_CONNECTED, rather than reaching a vendor with an empty identifier.
   */
  readonly required: boolean;
  /** True when the value is a credential: masked in the form, encrypted at
   *  rest, and never written into `providerConfig` or a log. */
  readonly secret: boolean;
  readonly storage: CredentialFieldStorage;
  /**
   * Optional validation regex, as a SOURCE STRING (not a `RegExp`), so a
   * descriptor stays JSON-serialisable and can be shipped to the browser.
   * Applied to `string` fields only, and only after the non-blank check. A
   * non-matching value is treated exactly like an absent one: dropped when
   * optional, rejecting when required.
   *
   * No shipped provider declares one today — the two cloud tracks accept any
   * non-blank identifier, and narrowing that here would reject realm ids
   * Intuit considers valid. It exists because the vendor stories landing on
   * these rails (WARP-2214) have fields that genuinely are format-constrained.
   */
  readonly pattern?: string;
  /** One line of help text for the admin form. */
  readonly help?: string;
}

/**
 * A track's metered-call policy.
 *
 * Present only where the vendor actually meters us. Dentrix Ascend deliberately
 * has none: its limits are per-endpoint and dynamic, handled by reacting to a
 * 429 where it arrives rather than by a local budget. Inventing a ceiling for
 * it would be a guess presented as a policy.
 */
export interface ProviderRateLimit {
  /** Metered calls allowed per connection per period. */
  readonly callCeiling: number;
  /** Length of a budget period in ms. */
  readonly periodMs: number;
  /**
   * A `providerConfig` field an operator may override the ceiling with. Named
   * rather than assumed, so the override cannot drift away from the field
   * definition that validates it.
   */
  readonly ceilingOverrideField?: string;
}

/** Which transport class the orchestrator builds for this provider. */
export type ProviderTrack =
  /** Reaches a system of record on the practice LAN. */
  | "lan"
  /** Reaches a vendor SaaS (ADR-041). Takes its account identity from
   *  `providerConfig` and its credentials from `providerTokensEnc`, so the LAN
   *  columns are unused. */
  | "cloud"
  /** A hub catalog card with NO shipped track. Never buildable, never a valid
   *  `IntegrationConnection.provider`. Explicit rather than inferred from an
   *  absent factory — absence is never a silent anything. */
  | "catalog"
  /**
   * WARP-2650 — reaches a vendor's hosted MCP server through `services/mcp-bridge`
   * (ADR-043). Takes its account identity from `providerConfig` and its
   * credential from `providerTokensEnc`, exactly like `cloud` — and NOTHING
   * else like it.
   *
   * The difference that earns a fourth track rather than a flag on `cloud`:
   * there is no `Connector`, no dataset, and no sync. A cloud track's whole
   * contract is "this vendor's rows arrive as canonical datasets a connector
   * produces on a schedule"; an MCP track's is "this vendor's own tools become
   * callable, one at a time, through the multiplexer, under an operator-owned
   * classification table". Reusing `cloud` would have made `datasets: []` mean
   * two different things — "this cloud track serves nothing" (a bug) and "this
   * track has no dataset concept" (the truth) — and every reader that resolves
   * a dataset, registers a sync cursor or builds a connector would have had to
   * learn a vendor exception instead of reading the track.
   */
  | "mcp";

export type ProviderAvailability = "available" | "coming-soon";

/**
 * How the Integrations hub presents a provider (the WARP-1101 catalog).
 *
 * Optional, because the catalog is VENDOR-level while descriptors are
 * TRACK-level: `eaglesoft` (direct SQL) and `eaglesoft-api` (Patterson REST)
 * are two tracks behind one "Eaglesoft" card, so only one of them carries the
 * card. A descriptor with no `catalog` block simply does not add a row to the
 * hub.
 */
export interface ProviderCatalogMeta {
  /** The card's id. The hub keys live connection status on it. */
  readonly id: string;
  readonly name: string;
  /** e.g. "Practice management", "Accounting". */
  readonly category: string;
  /** One line: what connecting it does. */
  readonly description: string;
  readonly availability: ProviderAvailability;
  /** Sort position in the hub, pinned so the order survives a reordering of
   *  the descriptor declarations. */
  readonly order: number;
  /**
   * WARP-2342 — where the customer reads how to produce this provider's
   * credential.
   *
   * Rendered by the hub card AND by the connect wizard at the credential-entry
   * step, which is the moment the reader actually needs it. A guide the
   * customer cannot find is a guide they will not read, and for a cloud
   * provider the credential is created in a vendor console Warp Lab does not
   * control — so an unreachable click-path is the connector being unusable,
   * not a documentation nit.
   *
   * Declared `?` HERE but REQUIRED by the type below for a cloud track whose
   * card is `available`; see {@link CloudProviderCatalogMeta}. Keeping the
   * property optional on the base is what lets every reader say
   * `catalog?.setupGuideHref` without narrowing first.
   */
  readonly setupGuideHref?: string;
}

/**
 * The catalog block a CLOUD track may carry.
 *
 * A cloud provider's credential is created by the customer in a vendor console
 * (ADR-042 §2), so `available` means "an SMB owner without an IT department is
 * being asked to go and make one" — and that is not shippable without a guide.
 * The union makes it a `tsc` error rather than a review note.
 *
 * `coming-soon` is deliberately exempt: such a card has no connect flow at all
 * (the hub renders it disabled), so there is no moment of use to link from, and
 * requiring a href would mean pointing at a guide that has not been written.
 * `scripts/check-setup-guides.sh` owns the other half — that the guide named
 * here exists and carries its six sections.
 */
export type CloudProviderCatalogMeta =
  | (ProviderCatalogMeta & { readonly availability: "coming-soon" })
  | (ProviderCatalogMeta & {
      readonly availability: "available";
      readonly setupGuideHref: string;
    });

/**
 * The payload/`providerConfig` key the chosen credential variant travels under.
 *
 * Named ONCE, here, because three independent readers have to agree about it:
 * the connect wizard writes it into the PATCH body, the credential service
 * validates it and persists it, and the read view reopens the form on it. It
 * was a private const in `ConnectWizard.tsx` while only the wizard used it
 * (WARP-2451); the moment the orchestrator started reading it, a second literal
 * would have been the drift.
 *
 * It is a RESERVED field name: no descriptor may declare a credential field
 * called this, and `erp-provider.descriptor.test.ts` gates that over every
 * shipped descriptor — a collision would let a vendor field overwrite the
 * record of which authentication path the row is on.
 */
export const CREDENTIAL_VARIANT_FIELD = "credentialVariant";

/**
 * The storages a field INSIDE a variant may declare.
 *
 * `column` is excluded, and that exclusion is the point: the first-class
 * columns (`host`, `port`, `databaseName`) are LAN connection facts owned by
 * the ERP wizard's schema, and the flat parse path routes a `column` field to
 * none of the places a variant's value can go. A variant field declaring one
 * would be collected by the form and then written nowhere — the exact silent
 * drop this whole story exists to close, reintroduced one level down.
 *
 * Making it a type rather than a runtime check means the refusal lands at the
 * declaration site, in `tsc`, before any descriptor ships.
 */
export type VariantFieldStorage = Exclude<CredentialFieldStorage, "column">;

/**
 * A field belonging to one authentication path.
 *
 * Identical to {@link CredentialFieldDef} except that its `storage` is narrowed
 * to what the variant-aware parse can actually persist. Assignable to
 * `CredentialFieldDef`, so every reader that walks a merged field list stays
 * unchanged.
 */
export interface VariantCredentialFieldDef extends Omit<CredentialFieldDef, "storage"> {
  readonly storage: VariantFieldStorage;
}

/**
 * One mutually exclusive way of authenticating a provider.
 *
 * Some vendors offer genuinely different credential shapes for the same
 * account — Xero's Custom Connection versus a customer-owned PKCE app are
 * different flows with different fields, not one flow with optional extras.
 * Rendering the union of both paths' fields would ask for values that cannot
 * exist together; rendering only the first would hide the other entirely.
 *
 * Variant fields are declared HERE, not in `credentialFields`: a field that is
 * required on one path and meaningless on the other cannot be described by a
 * single `required` flag. Read the two together through
 * {@link credentialFieldsFor}.
 */
export interface CredentialVariant {
  /** Stable id, persisted alongside the credential so a later edit reopens the
   *  same path. Never derived from the label. */
  readonly id: string;
  readonly label: string;
  /** One line telling the owner which path is theirs. */
  readonly description?: string;
  readonly fields: readonly VariantCredentialFieldDef[];
}

/** One read scope the owner may grant on a LAN-database track. */
export interface LanReadScope {
  readonly id: string;
  readonly label: string;
  /** Short tag rendered beside the label — "PHI", "financial". */
  readonly tag?: string;
}

/**
 * How a LAN-database track provisions its own least-privilege account.
 *
 * PRESENCE of this block is what selects the connect wizard's LAN flow: find
 * the server, run the one-off DBA script, choose read scopes, confirm. Absent,
 * the wizard renders the generic credential form. It is a capability
 * declaration, in the same shape as `rateLimit` and `catalog` above — not a
 * status inferred from a missing row.
 *
 * Every string a person reads in that flow is here or on `displayName`, so a
 * second LAN vendor is a descriptor, not a second wizard.
 */
export interface LanProvisioning {
  /** The read-only database account Droplet creates, e.g. `droplet_ro`. */
  readonly accountName: string;
  /** The database the connection names, shown on the confirm step. */
  readonly databaseName: string;
  /** Port offered before the owner opens Advanced. */
  readonly defaultPort: number;
  /** Placeholder for the host field — an example, never a default. */
  readonly hostPlaceholder: string;
  /**
   * The noun phrase used in the reachability result, e.g. `an Eaglesoft
   * database`. Carried as data because the article is part of it and no
   * template built from `displayName` gets "an" right for every vendor.
   */
  readonly reachableLabel: string;
  /** The one-off DBA script, one line per array entry. Contains a PLACEHOLDER
   *  where the generated password goes — never a credential. */
  readonly script: readonly string[];
  /** Read scopes offered on the scopes step, in render order. */
  readonly scopes: readonly LanReadScope[];
  /** The write opt-in, or absent when the track offers none. */
  readonly writeOptIn?: {
    readonly label: string;
    /** The caution shown under the toggle. Off by default, always. */
    readonly caution: string;
  };
}

/** Everything both apps need to know about one provider, minus the two fields
 *  whose legality depends on the track — see {@link ProviderDescriptor}. */
interface ProviderDescriptorBase {
  /** The provider key persisted on `IntegrationConnection.provider` (free-text
   *  TEXT — a new key needs no migration; this registry is the only gate). */
  readonly id: string;
  readonly displayName: string;
  readonly category: string;
  readonly credentialFields: readonly CredentialFieldDef[];
  /**
   * Mutually exclusive authentication paths, when the vendor offers more than
   * one. Absent on every shipped provider — one credential shape is the normal
   * case, and an empty single-variant array would be ceremony.
   */
  readonly credentialVariants?: readonly CredentialVariant[];
  /**
   * Hostnames this track dials, as BARE HOSTS.
   *
   * Declared so a CI gate can prove each one is registered in
   * `docs/security/allowed-egress.yaml`. Bare rather than full URLs on purpose:
   * a full-URL literal here would be a second extraction site for the egress
   * scanner competing with the connectors' own base-URL literals, which are
   * full strings precisely so the scanner can read them.
   */
  readonly egressHosts: readonly string[];
  /**
   * Present when this track's host is ASSEMBLED AT RUNTIME and therefore
   * cannot appear in {@link egressHosts} at all.
   *
   * Mailchimp is the shipped case (WARP-2379): the customer's API key carries
   * a `-us14` datacentre suffix that SELECTS the host, so there is no literal
   * for the CI scanner to find and no fixed name to register. Its
   * `allowed-egress.yaml` entry is `kind: dynamic` with a `config_key`, and
   * this field is the descriptor's half of that registration.
   *
   * It exists so an empty `egressHosts` stays UNAMBIGUOUS. Without it, "this
   * track never leaves the LAN" (Eaglesoft) and "this track's host is
   * per-connection" (Mailchimp) are the same empty array — and reading the
   * second as the first is how a cloud track quietly acquires a LAN-only
   * guarantee it does not have. Absence is never a silent anything.
   *
   * The code-side exact-host guard is the enforcement, not this declaration:
   * `assertSafeMailchimpBaseUrl` is what refuses a host the key did not name.
   */
  readonly dynamicEgress?: {
    /** Mirrors the YAML entry's `config_key`: where the host comes from. */
    readonly configKey: string;
    /** The `allowed-egress.yaml` entry id this pairs with, so the two cannot
     *  drift apart without a test noticing. */
    readonly registryId: string;
  };
  /** Datasets this track can serve. Reconciled against what the connector
   *  reports at runtime (`Connector.servesDatasets`) rather than trusted. */
  readonly datasets: readonly DatasetName[];
  readonly rateLimit?: ProviderRateLimit;
  /**
   * Minimum interval a scheduled sync of this provider may run at.
   *
   * Optional and UNSET on every shipped track: nothing schedules an ERP sync
   * today (reads are on demand), and no vendor-documented floor has been
   * sourced for either cloud track. It is declared because the sync-scheduler
   * work needs a per-provider home for it and a descriptor is that home — but
   * a number invented here would be a guess wearing a policy's clothes.
   */
  readonly pollIntervalFloorMs?: number;
  /** Declared by a LAN track that provisions its own database account. */
  readonly lanProvisioning?: LanProvisioning;
  /**
   * Declared by a track whose credential has a HARD expiry the customer must
   * act on before it passes.
   *
   * Optional because most credentials have none: a Stripe restricted key, a
   * HubSpot private-app token and a Mailchimp key all live until somebody
   * revokes them, so there is nothing to warn about and inventing a window for
   * them would be a guess wearing a policy's clothes — the same reason
   * `rateLimit` is absent on Dentrix Ascend.
   *
   * PRESENCE is what says "this connection can expire". Its absence is not an
   * optimistic "it never expires" inferred from silence; it is the track
   * declaring it has no expiry concept, which is why
   * {@link credentialExpiryVerdict} returns `undefined` rather than a status
   * for such a provider.
   */
  readonly credentialExpiry?: CredentialExpiryPolicy;
}

/**
 * A credential with a hard stop, and the window in which an owner is told.
 *
 * Atlassian is the shipped case (WARP-2353): an API token lasts at most 365
 * days, the vendor sends no reminder, there is no refresh and no grace period,
 * and the box cannot mint a replacement — only the customer can, in their own
 * console. So the expiry has to become a STATUS a person sees, ahead of time,
 * rather than an outage that arrives as "the integration stopped working".
 */
export interface CredentialExpiryPolicy {
  /**
   * The `providerConfig` field carrying the expiry date, as `YYYY-MM-DD`.
   *
   * Named rather than assumed so the declaration and the field definition
   * cannot drift: `provider-registry.test.ts` asserts the named field is one
   * the descriptor actually declares, with `storage: "providerConfig"`.
   */
  readonly field: string;
  /** How far ahead a pending expiry becomes a status rather than a footnote. */
  readonly warningDays: number;
  /** The vendor's maximum lifetime, for the guide and the rotation copy. */
  readonly maxLifetimeDays: number;
}

/**
 * What a person is told about a credential's expiry.
 *
 * A closed union, and `EXPIRY_UNKNOWN` is a member rather than a `null`: "a
 * credential is stored and no expiry date was recorded" is a real state with
 * its own remedy (go and record one), and it is emphatically not `VALID`. The
 * repo rule that persistent state is never derived from an absent value applies
 * to what is SHOWN as much as to what is stored.
 */
export type CredentialExpiryStatus =
  | "VALID"
  | "EXPIRING_SOON"
  | "EXPIRED"
  | "EXPIRY_UNKNOWN";

export interface CredentialExpiryVerdict {
  readonly status: CredentialExpiryStatus;
  /** Whole days until expiry, FLOORED; negative once past. `null` when no date
   *  is recorded — never 0 standing in for "unknown". */
  readonly daysRemaining: number | null;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Classify a connection's credential expiry, or `undefined` when the provider
 * declares no {@link CredentialExpiryPolicy}.
 *
 * Pure, and deliberately in this module rather than beside a vendor: the
 * dashboard renders the verdict and cannot import a server-only package, and
 * the orchestrator's credential service is generic by doctrine — a comparison
 * of `provider` against a vendor key there *is* the defect it exists to
 * prevent.
 *
 * Two rules, and each is the safe direction for a HARD stop:
 *
 *  • Days are **floored**, never rounded. Rounding puts 30.6 days at 31 and
 *    keeps a connection green on the first day it should have been warning.
 *    `atlassian-token-expiry.ts` (WARP-2353) states the same rule for the same
 *    reason, and `atlassian-provider.test.ts` asserts the two agree across the
 *    boundary rather than trusting them to.
 *  • A bare `YYYY-MM-DD` parses as **midnight UTC**, i.e. the START of the
 *    stated day. The customer transcribes a date, not an instant, and the
 *    vendor's actual cut-off within that day is unknown — so the connection
 *    reads EXPIRED from the beginning of its last day rather than at some hour
 *    nobody can predict. Warning early costs a person one unnecessary token
 *    rotation; warning late costs them an outage they were promised notice of.
 */
export function credentialExpiryVerdict(
  descriptor: ProviderDescriptor | undefined,
  config: ProviderConfig | undefined,
  now: Date,
): CredentialExpiryVerdict | undefined {
  const policy = descriptor?.credentialExpiry;
  if (!policy) return undefined;
  const raw = providerConfigString(config, policy.field);
  const at = raw === undefined ? Number.NaN : Date.parse(raw);
  if (Number.isNaN(at)) return { status: "EXPIRY_UNKNOWN", daysRemaining: null };
  const daysRemaining = Math.floor((at - now.getTime()) / MS_PER_DAY);
  if (daysRemaining < 0) return { status: "EXPIRED", daysRemaining };
  if (daysRemaining <= policy.warningDays) {
    return { status: "EXPIRING_SOON", daysRemaining };
  }
  return { status: "VALID", daysRemaining };
}

/**
 * Everything both apps need to know about one provider.
 *
 * A union on `track` rather than a flat interface, for exactly one reason: a
 * cloud provider offered on the hub must carry a setup-guide link, and that is
 * a rule `tsc` can enforce at the declaration site. Every other property is
 * shared, so readers still write `descriptor.egressHosts` without narrowing.
 */
export type ProviderDescriptor =
  | (ProviderDescriptorBase & {
      readonly track: "lan" | "catalog";
      readonly catalog?: ProviderCatalogMeta;
    })
  | (ProviderDescriptorBase & {
      readonly track: "cloud";
      readonly catalog?: CloudProviderCatalogMeta;
    })
  | McpProviderDescriptor;

/**
 * WARP-2650 — a provider reached through a vendor's hosted MCP server.
 *
 * Four properties of the base are CLOSED OFF rather than left merely optional,
 * and each is the point of having a separate arm at all — an `mcp` descriptor
 * that tried to declare one would not compile, which is a stronger statement
 * than a review note or a runtime check. `?: never` rather than `Omit`, so that
 * the union's shared readers keep writing `descriptor.rateLimit` without
 * narrowing first (the property the base's own docstring is built around) while
 * the DECLARATION site is still refused:
 *
 *  • **`datasets` is the empty tuple, by construction.** Not `readonly
 *    DatasetName[]` that happens to be empty today. An MCP track has no
 *    canonical-dataset concept at all: `cloudRowForDataset` resolves a dataset
 *    to a connection through the registry, and a future author adding one name
 *    here would make an MCP row answer a `cloud_query_dataset` call that no
 *    connector can serve.
 *  • **`pollIntervalFloorMs` is gone**, not set to a magic `0`. A floor is the
 *    minimum interval a SCHEDULED SYNC may run at, and there is no scheduled
 *    sync for this track — an MCP tool is called when the model calls it. `0`
 *    would read as "no floor, poll as fast as you like", which is a different
 *    and wrong claim.
 *  • **`lanProvisioning` is gone.** Its own docstring makes PRESENCE select the
 *    connect wizard's LAN flow; a hosted vendor endpoint has no database
 *    account to provision.
 *  • **`rateLimit` is gone.** `ProviderRateLimit` is a call ceiling over a
 *    period, and Atlassian's documented limiter is neither: upstream #171
 *    reports 429s at a CONCURRENCY depth with no volume threshold, which is why
 *    `services/mcp-bridge/src/call-scheduler.ts` enforces a depth of 4. A
 *    monthly number invented here would be a guess wearing a policy's clothes.
 */
export type McpProviderDescriptor = Omit<ProviderDescriptorBase, "datasets"> & {
  readonly track: "mcp";
  /** @see McpProviderDescriptor — never declarable on this track. */
  readonly pollIntervalFloorMs?: never;
  /** @see McpProviderDescriptor — never declarable on this track. */
  readonly lanProvisioning?: never;
  /** @see McpProviderDescriptor — never declarable on this track. */
  readonly rateLimit?: never;
  /**
   * The server id `services/mcp-bridge`'s CLOSED registry serves
   * (`session-profiles.ts` `SESSION_FACTORIES`), and the id the orchestrator
   * attaches under.
   *
   * A FOURTH declaration of a literal that already exists three times, and it
   * is gated rather than trusted: `adr-043-boundary.test.ts` reads the bridge's
   * own source as text and fails when any of the four diverge. The alternative
   * — importing the bridge's constant — would pull
   * `StreamableHTTPClientTransport` into this module, which is bundled into the
   * Next.js dashboard, across the very line ADR-043 §5 draws.
   */
  readonly mcpServerId: string;
  readonly datasets: readonly [];
  /**
   * WARP-2659 — the hub card's one line: what connecting this does.
   *
   * REQUIRED, and it lives here for the same reason {@link setupGuideHref}
   * does: `catalog` is closed off on this arm, so the property every other
   * card reads (`ProviderCatalogMeta.description`) has no home on an MCP
   * track. The dashboard derives the card from the TRACK instead
   * (`lib/connectors.ts` `hubCardFor`), and this is the only field of a card
   * that cannot be computed from what the descriptor already declares —
   * `displayName` is the name, `category` is the category, and
   * `setupGuideHrefFor` is the guide.
   *
   * Required rather than optional so the next MCP provider is refused by
   * `tsc` until somebody writes the sentence a customer reads on the tile.
   * The alternative — a generic per-track sentence in the dashboard — would
   * put vendor copy in the app that `descriptorForReportedProvider`'s own
   * docstring says must not invent any.
   */
  readonly description: string;
  /**
   * Where the customer reads how to produce this credential. REQUIRED, not
   * optional, for the same reason {@link CloudProviderCatalogMeta} makes it
   * required for an `available` cloud card: the credential is minted in a
   * vendor console Warp Lab does not control, so shipping the track without the
   * click-path is shipping an unusable integration.
   *
   * Declared HERE rather than inside `catalog` because an MCP track puts no
   * card on the Integrations hub (see `catalog` below) and would otherwise have
   * nowhere to carry it. Read both homes through {@link setupGuideHrefFor}.
   */
  readonly setupGuideHref: string;
  /**
   * An MCP track declares NO `catalog` block, and `never` says so at the
   * declaration site rather than leaving it to be discovered.
   *
   * WARP-2650 wrote this as "an MCP track puts no card on the hub", and
   * WARP-2659 changed that half: Atlassian DOES have a tile now. What has not
   * changed — and is what `never` actually protects — is that the tile is not
   * a CATALOG-BLOCK card. Those carry a {@link ProviderCatalogMeta.id} from
   * the dashboard's closed `ConnectorId` union and a connect flow that is the
   * ERP wizard: it probes a transport, offers read scopes and starts a dataset
   * sync, none of which exists on this track. Declaring `catalog` here would
   * put an MCP provider into that vocabulary and hand it that wizard.
   *
   * The tile is derived from the TRACK instead (`lib/connectors.ts`
   * `hubCardFor`), keyed on the descriptor id, and both its actions route to
   * the credential configurator at `/integrations/credentials`. So a future
   * MCP provider gets a card for free and needs no new `ConnectorId` literal.
   */
  readonly catalog?: never;
};

/**
 * Where a provider's customer setup guide lives — the ONE read path.
 *
 * Two homes exist and neither is redundant: a hub card carries the href because
 * the tile and the connect wizard both render it (WARP-2342), and an `mcp`
 * track carries it directly because it has no card. A caller reaching into
 * either home itself is how the two surfaces end up linking different places,
 * which is precisely what `connectorSetupGuideHref`'s docstring already argues
 * — so that function, and the credential configurator's view, both come here.
 */
export function setupGuideHrefFor(
  descriptor: ProviderDescriptor | undefined,
): string | undefined {
  if (!descriptor) return undefined;
  return descriptor.track === "mcp"
    ? descriptor.setupGuideHref
    : descriptor.catalog?.setupGuideHref;
}

/**
 * The variant a form is currently on, or `undefined` for a provider that
 * declares none.
 *
 * An unknown id falls back to the FIRST variant rather than to nothing: a
 * persisted variant id that no longer exists must still render a usable form,
 * and an empty form would look like a provider that needs no credentials.
 */
export function credentialVariantFor(
  descriptor: ProviderDescriptor | undefined,
  variantId?: string,
): CredentialVariant | undefined {
  const variants = descriptor?.credentialVariants;
  if (!variants || variants.length === 0) return undefined;
  return variants.find((v) => v.id === variantId) ?? variants[0];
}

/**
 * Every field a form must collect for one authentication path: the provider's
 * common fields, then the chosen variant's.
 *
 * The ONLY function that answers "what does this form ask for". Rendering
 * `credentialFields` directly is correct for a provider with no variants and
 * silently wrong for one with them, which is why the read goes through here.
 */
export function credentialFieldsFor(
  descriptor: ProviderDescriptor | undefined,
  variantId?: string,
): readonly CredentialFieldDef[] {
  if (!descriptor) return [];
  const variant = credentialVariantFor(descriptor, variantId);
  return variant
    ? [...descriptor.credentialFields, ...variant.fields]
    : descriptor.credentialFields;
}

/**
 * The validated shape of `IntegrationConnection.providerConfig`.
 *
 * Flat and open rather than a per-provider union arm: the union was one of the
 * four sites a new vendor had to edit. `provider` is always present and is
 * always the key the config was parsed FOR — never a `provider` key that
 * happened to be in the stored value.
 *
 * Read fields through {@link providerConfigString} /
 * {@link providerConfigNumber} rather than casting: the values are whatever a
 * persisted row carried, and a cast would be exactly the "structural check, not
 * a cast" rule this module exists to keep.
 */
export interface ProviderConfig {
  readonly provider: string;
  readonly [field: string]: string | number | undefined;
}

/** Read a string field off a parsed config. Undefined when absent or not a
 *  string — never a coerced value. */
export function providerConfigString(
  cfg: ProviderConfig | undefined,
  name: string,
): string | undefined {
  const v = cfg?.[name];
  return typeof v === "string" ? v : undefined;
}

/** Read a numeric field off a parsed config. Undefined when absent or not a
 *  number — never a coerced value. */
export function providerConfigNumber(
  cfg: ProviderConfig | undefined,
  name: string,
): number | undefined {
  const v = cfg?.[name];
  return typeof v === "number" ? v : undefined;
}

/**
 * Validate one field's raw value.
 *
 * Returns `undefined` for anything unusable, which the caller reads as "absent"
 * — rejecting when the field is required, dropped when it is not. That split is
 * the whole of the pre-descriptor switch's behaviour: a missing identifier
 * fails the connection closed, while a nonsense optional value is ignored
 * rather than being allowed to block a connection that is otherwise fine.
 *
 * Strings are returned UNTRIMMED. The blank check trims, the value does not:
 * the pre-change switch never normalised a stored identifier, and starting to
 * would rewrite realm ids on rows that work today.
 */
export function validateCredentialFieldValue(
  field: CredentialFieldDef,
  raw: unknown,
): string | number | undefined {
  if (field.type === "positiveInteger") {
    return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
  }
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  if (field.pattern && !new RegExp(field.pattern).test(raw)) return undefined;
  return raw;
}

/**
 * Why a `providerConfig` could not be parsed.
 *
 * A REASON rather than a bare `undefined`, because the two audiences differ:
 * the read path treats an unusable stored row as "absent" and moves on, while
 * the write path owes the person a 400 that says what was wrong with what they
 * just submitted. Collapsing both into `undefined` is what let a variant
 * provider's fields vanish silently (WARP-2491) — the caller could not tell
 * "this provider has no config concept" from "you did not say which
 * authentication path this is".
 */
export type ProviderConfigParseFailure =
  /** Not an object, or an array. A row written by hand or by an older build. */
  | "not-an-object"
  /** No descriptor — the provider key names nothing this appliance knows. */
  | "unknown-provider"
  /** The descriptor declares no `providerConfig`-stored fields and no
   *  variants, i.e. it has no `providerConfig` concept at all (every LAN
   *  track). This is what keeps a well-formed QuickBooks config on an
   *  Eaglesoft row from half-configuring anything. */
  | "no-provider-config-fields"
  /** The descriptor declares variants and the value named none. NEVER treated
   *  as "use the first one": which credential path a connection is on is
   *  persisted state, and guessing it is the house rule this violates. */
  | "missing-variant"
  /** The value named a variant this descriptor does not declare. */
  | "unknown-variant"
  /** A REQUIRED field was absent, blank, or the wrong type. */
  | "missing-required-field";

/** The outcome of a variant-aware parse. */
export type ProviderConfigParseResult =
  | { readonly ok: true; readonly config: ProviderConfig }
  | {
      readonly ok: false;
      readonly reason: ProviderConfigParseFailure;
      /** The offending field, for `missing-required-field`. */
      readonly field?: string;
      /** The variant id that was named, for `unknown-variant`. */
      readonly variant?: string;
    };

/** Options for the variant-aware parse. */
export interface ParseProviderConfigOptions {
  /**
   * The authentication path this parse is for, from the submitted body.
   *
   * When absent, the variant is read from the value's own
   * {@link CREDENTIAL_VARIANT_FIELD} key — which is how re-parsing a STORED row
   * finds the path it was saved on. Absent from both, on a descriptor that
   * declares variants, is `missing-variant` and never a default.
   */
  readonly variant?: string;
}

/**
 * The variant id a stored `providerConfig` explicitly records, if it is one the
 * descriptor still declares.
 *
 * Reads the persisted key — it does not infer the path from WHICH fields are
 * present. Two variants can share a field name, and "whichever variant's fields
 * I can see" is precisely the guessed state the explicit-enum rule forbids.
 *
 * Returns undefined for a descriptor with no variants, an unparseable value, or
 * an id that no longer exists. The last is deliberate and is NOT the same call
 * as {@link credentialVariantFor}'s first-variant fallback: a form must still
 * render something, while a validator must not silently relabel a row.
 */
export function providerConfigVariantId(
  descriptor: ProviderDescriptor | undefined,
  value: unknown,
): string | undefined {
  const variants = descriptor?.credentialVariants;
  if (!variants || variants.length === 0) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = (value as Record<string, unknown>)[CREDENTIAL_VARIANT_FIELD];
  if (typeof raw !== "string") return undefined;
  return variants.some((v) => v.id === raw) ? raw : undefined;
}

/**
 * Every SECRET field one authentication path needs — the provider's own, then
 * the chosen variant's.
 *
 * The companion to {@link credentialFieldsFor} for the questions the credential
 * service asks: "is this connection usable" and "which secrets does a write
 * touch". Reading `credentialFields.filter(f => f.secret)` directly is correct
 * for a provider with no variants and silently wrong for one with them.
 */
export function credentialSecretFieldsFor(
  descriptor: ProviderDescriptor | undefined,
  variantId?: string,
): readonly CredentialFieldDef[] {
  return credentialFieldsFor(descriptor, variantId).filter((f) => f.secret);
}

/**
 * The generic, descriptor-driven replacement for the per-provider
 * `parseProviderConfig` switch — the full form, reporting WHY it refused.
 *
 * Structural check, not a cast — a row written by an older build, by hand, or
 * for a different provider must not be handed to a connector as though it were
 * a contract.
 *
 * WARP-2491 made it variant-aware. Before, it walked `credentialFields` only,
 * so a provider declaring `credentialVariants` (Xero: Custom Connection vs a
 * customer-owned PKCE app) had the chosen path's fields DROPPED here while the
 * wizard collected them — the row then looked configured with half its
 * credential missing. The variant's fields are now parsed IN ADDITION to the
 * shared ones, and a value that names no variant is refused rather than
 * half-parsed.
 *
 * Emits every declared field as a KEY, in declaration order, present even when
 * its value is undefined. Both are load-bearing: a persisted config is JSON, so
 * insertion order is what `JSON.stringify` writes, and `"baseUrl" in cfg` is a
 * question a caller can ask. The variant id is emitted right after `provider`,
 * before any field, so the path a row is on is readable without knowing which
 * fields belong to which variant.
 */
export function parseProviderConfigResult(
  descriptor: ProviderDescriptor | undefined,
  value: unknown,
  options: ParseProviderConfigOptions = {},
): ProviderConfigParseResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not-an-object" };
  }
  if (!descriptor) return { ok: false, reason: "unknown-provider" };

  const raw = value as Record<string, unknown>;
  const variants = descriptor.credentialVariants;
  const hasVariants = Boolean(variants && variants.length > 0);

  let chosen: CredentialVariant | undefined;
  if (hasVariants) {
    // The submitted discriminator wins; a stored row falls back to the id it
    // recorded for itself. Neither is a guess — both are values somebody wrote.
    const stored = raw[CREDENTIAL_VARIANT_FIELD];
    const named = options.variant ?? (typeof stored === "string" ? stored : undefined);
    if (named === undefined) return { ok: false, reason: "missing-variant" };
    chosen = variants?.find((v) => v.id === named);
    if (!chosen) return { ok: false, reason: "unknown-variant", variant: named };
  }

  const fields = [...descriptor.credentialFields, ...(chosen?.fields ?? [])].filter(
    (f) => f.storage === "providerConfig",
  );

  // A variants-declaring provider ALWAYS has a `providerConfig` concept, even
  // with zero config-stored fields: the chosen path itself has to be recorded
  // somewhere, and that somewhere is this object.
  if (fields.length === 0 && !hasVariants) {
    return { ok: false, reason: "no-provider-config-fields" };
  }

  const out: Record<string, string | number | undefined> = { provider: descriptor.id };
  if (chosen) out[CREDENTIAL_VARIANT_FIELD] = chosen.id;

  for (const field of fields) {
    const parsed = validateCredentialFieldValue(field, raw[field.name]);
    if (field.required && parsed === undefined) {
      return { ok: false, reason: "missing-required-field", field: field.name };
    }
    out[field.name] = parsed;
  }

  return { ok: true, config: out as ProviderConfig };
}

/**
 * The read-path form: a usable config, or `undefined`.
 *
 * Every refusal collapses to `undefined` here, which is the RIGHT contract for
 * a reader projecting a stored row — an unusable config and an absent one lead
 * to the same screen. A caller that owes the person an explanation (the PATCH
 * route) must use {@link parseProviderConfigResult} instead; this wrapper
 * cannot tell it what to say.
 *
 * What it never does, since WARP-2491, is return a SUCCESS that is missing the
 * variant's fields. A variants-declaring descriptor either parses the named
 * path in full or fails — the half-parsed config was the defect.
 */
export function parseProviderConfigWith(
  descriptor: ProviderDescriptor | undefined,
  value: unknown,
  options: ParseProviderConfigOptions = {},
): ProviderConfig | undefined {
  const result = parseProviderConfigResult(descriptor, value, options);
  return result.ok ? result.config : undefined;
}
