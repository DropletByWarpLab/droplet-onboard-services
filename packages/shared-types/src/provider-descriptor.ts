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
] as const;

/**
 * The closed union of six. A descriptor's `datasets` is typed with THIS, never
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
  | "catalog";

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
}

/** Everything both apps need to know about one provider. */
export interface ProviderDescriptor {
  /** The provider key persisted on `IntegrationConnection.provider` (free-text
   *  TEXT — a new key needs no migration; this registry is the only gate). */
  readonly id: string;
  readonly displayName: string;
  readonly category: string;
  readonly track: ProviderTrack;
  readonly credentialFields: readonly CredentialFieldDef[];
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
  readonly catalog?: ProviderCatalogMeta;
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
 * The generic, descriptor-driven replacement for the per-provider
 * `parseProviderConfig` switch.
 *
 * Structural check, not a cast — a row written by an older build, by hand, or
 * for a different provider must not be handed to a connector as though it were
 * a contract.
 *
 * Returns undefined when:
 *  • the value is absent, not an object, or an array;
 *  • the descriptor declares no `providerConfig`-stored fields, i.e. this
 *    provider has no `providerConfig` concept at all (every LAN track: its
 *    connection facts live in real columns). This is what keeps a well-formed
 *    QuickBooks config on an Eaglesoft row from half-configuring anything;
 *  • any REQUIRED field is absent, blank, or the wrong type.
 *
 * Emits every declared field as a KEY, in declaration order, present even when
 * its value is undefined. Both are load-bearing: a persisted config is JSON, so
 * insertion order is what `JSON.stringify` writes, and `"baseUrl" in cfg` is a
 * question a caller can ask.
 */
export function parseProviderConfigWith(
  descriptor: ProviderDescriptor | undefined,
  value: unknown,
): ProviderConfig | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!descriptor) return undefined;

  const fields = descriptor.credentialFields.filter((f) => f.storage === "providerConfig");
  if (fields.length === 0) return undefined;

  const raw = value as Record<string, unknown>;
  const out: Record<string, string | number | undefined> = { provider: descriptor.id };

  for (const field of fields) {
    const parsed = validateCredentialFieldValue(field, raw[field.name]);
    if (field.required && parsed === undefined) return undefined;
    out[field.name] = parsed;
  }

  return out as ProviderConfig;
}
