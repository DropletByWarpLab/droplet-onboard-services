/**
 * @droplet/erp-connector — first-party ERP-connector framework (WARP-1094).
 *
 * The DB-independent foundation — the schema map + drift fingerprint, the
 * introspection SQL constants, the parameterized read-query registry, the
 * write-command registry — plus both concrete providers:
 *
 *   EaglesoftConnector     direct SQL, via the `erp-sql-bridge` sidecar
 *                          (WARP-1106). Blocked until a bridge is configured
 *                          AND an operator has vendored the license-gated SAP
 *                          SQL Anywhere client into its image.
 *   EaglesoftApiConnector  Patterson's official REST API (WARP-1294). Blocked
 *                          until a route map, credentials, and CA are on the
 *                          connection row.
 *
 * Both implement the same `Connector` interface and both degrade honestly:
 * an unconfigured track throws ConnectorBlockedError (→ ERP_NOT_CONNECTED)
 * rather than pretending. See README.
 */
export {
  computeSchemaFingerprint,
  buildSchemaMap,
  resolveTable,
  resolveColumn,
  SchemaResolutionError,
  type IntrospectedTable,
  type IntrospectedColumn,
  type SchemaMap,
} from "./schema-map.js";

export {
  LIST_TABLES_SQL,
  LIST_COLUMNS_SQL,
  LIST_INDEXES_SQL,
  LEGACY_LIST_TABLES_SQL,
  LEGACY_LIST_COLUMNS_SQL,
  LIST_TRIGGERS_SQL,
  LIST_FOREIGN_KEYS_SQL,
  FIND_WATERMARK_COLUMNS_SQL,
  catalogQueriesFor,
  type CatalogQuerySet,
} from "./introspection.js";

export {
  buildConnectionString,
  ConnectionStringError,
  DEFAULT_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_SERVER_NAME,
  type ConnectionParams,
} from "./connection-string.js";

export {
  parseEngineVersion,
  eaglesoftBandForEngine,
  EngineVersionError,
  PRODUCT_VERSION_SQL,
  type EngineVersion,
  type CatalogDialect,
} from "./version-detect.js";

export {
  READ_QUERIES,
  getReadQuery,
  buildReadStatement,
  scheduleDayBounds,
  escapeLike,
  UnknownReadQueryError,
  type ReadQuery,
  type BuiltStatement,
} from "./read-queries.js";

export {
  WRITE_COMMANDS,
  getWriteCommand,
  assertTargetAllowed,
  FORBIDDEN_WRITE_TABLES,
  UnknownWriteCommandError,
  DisallowedColumnError,
  ForbiddenTargetError,
  MissingParamError,
  type WriteCommand,
} from "./write-commands.js";

export {
  EaglesoftConnector,
  ConnectorBlockedError,
  DatasetNotServedError,
  PRACTICE_DATASETS,
  assertDatasetsServed,
  SQL_TRACK_REMEDIATION,
  fingerprintTables,
  type Connector,
  type ConnectorConfig,
  type EaglesoftConnectorDeps,
  type IntrospectionResult,
} from "./connector.js";

// WARP-1106 — the direct-SQL track's I/O seam: an HTTP client for the
// `erp-sql-bridge` sidecar (unixODBC + pyodbc), which owns the SAP SQL
// Anywhere driver because no viable modern Node driver for it exists.
export {
  SqlBridgeClient,
  SqlBridgeError,
  DEFAULT_BRIDGE_URL,
  type BridgeTarget,
  type BridgeStatement,
  type SqlBridgeOptions,
} from "./sql-bridge-client.js";

// WARP-1294 — dual-track official-REST-API provider (Patterson Eaglesoft
// Innovation Connection). Same Connector interface as the SQL connector.
export {
  EaglesoftApiConnector,
  DEFAULT_API_HTTPS_PORT,
  API_TRACK_REMEDIATION,
  type EaglesoftApiConfig,
  type EaglesoftApiDeps,
} from "./api-connector.js";

export {
  KNOWN_ROUTE_SKELETON,
  requiredRouteOps,
  isRouteDiscovered,
  routeMapFingerprint,
  RouteNotDiscoveredError,
  type EaglesoftApiRouteMap,
  type RouteSpec,
  type AuthRouteSpec,
  type HttpVerb,
} from "./api-route-map.js";

export {
  authenticate,
  apiRequest,
  buildBaseUrl,
  blockedSecretResolver,
  EaglesoftApiError,
  type SecretResolver,
  type ResolvedCredentials,
  type ApiTransport,
} from "./api-auth.js";

// WARP-1964 — vendor-agnostic export-drop track: read the report files a
// practice exports from its own PMS, off a read-only share on the practice LAN.
// Same Connector interface, same read registry, same blocked-error contract as
// the other two tracks; read-only by construction, and the only track that
// needs neither a licence-gated driver nor vendor enrolment.
export {
  ExportDropConnector,
  EXPORT_DROP_TRACK_REMEDIATION,
  EXPORT_PROVIDER_SUFFIX,
  exportProviderFor,
  exportProviders,
  vendorFromExportProvider,
  type ExportDropConfig,
  type ExportDropDeps,
  type ExportDropStatus,
  type DatasetStatus,
} from "./export-drop/connector.js";

export {
  BUILT_IN_PROFILES,
  CANONICAL_COLUMNS,
  COLUMN_KIND,
  DATASETS,
  DATASET_CATEGORY,
  GENERIC_VENDOR,
  NAME_ONLY_VENDORS,
  REQUIRED_CANONICAL,
  SINGLE_CURRENCY_LEDGER_DATASETS,
  assertValidProfile,
  isDatasetName,
  knownVendors,
  matchDataset,
  normalizeHeader,
  parseProfileJson,
  profilesForVendor,
  ProfileError,
  type DatasetCategory,
  type DatasetName,
  type DatasetProfile,
  type ExportProfile,
  type MatchResult,
} from "./export-drop/profiles.js";

export {
  DEFAULT_SCAN_LIMITS,
  DropRootError,
  isInsideRoot,
  resolveDropDirectory,
  scanDropDirectory,
  snapshotTables,
  type FileDiagnostic,
  type ScanLimits,
  type Snapshot,
  type SnapshotDataset,
} from "./export-drop/scan.js";

export {
  decodeExportBytes,
  parseDelimited,
  sniffDelimiter,
  DelimitedLimitError,
  type DelimitedTable,
} from "./export-drop/csv.js";

export {
  normalizeText,
  parseExportTimestamp,
  parseMoney,
} from "./export-drop/values.js";

// WARP-2107 — money aggregation shared by every track, so a total is a currency
// figure rather than an accumulation of doubles.
export { roundCents, sumMoney, sumMoneyWithGaps } from "./api-dto.js";

// WARP-2109 — QuickBooks Online: the accounting REST track, and the only
// connector that leaves the practice LAN. Read-only, metered, and inert until
// an operator configures a company — see the module docstring for why the
// budget guard is a v1 requirement rather than an optimisation.
export {
  QuickBooksOnlineConnector,
  CallBudget,
  QuotaExhaustedError,
  ReauthorizationRequiredError,
  blockedTokenResolver,
  DEFAULT_CALL_CEILING,
  QBO_DATASETS,
  QBO_MAX_PAGES,
  QBO_MAX_READ_WALL_MS,
  QBO_MINOR_VERSION,
  QBO_PRODUCTION_BASE_URL,
  QBO_SANDBOX_BASE_URL,
  QBO_TRACK_REMEDIATION,
  QUICKBOOKS_ONLINE_PROVIDER,
  QBO_ALLOWED_API_HOSTS,
  UnsafeBaseUrlError,
  assertSafeBaseUrl,
  type CloudConnectionState,
  type QboStatus,
  type QboTokens,
  type QuickBooksOnlineConfig,
  type QuickBooksOnlineDeps,
  type TokenPersister,
  type TokenResolver,
} from "./quickbooks/online-connector.js";

// WARP-2215 — Stripe: the payments track. Read-through over a merchant-created
// RESTRICTED key (never a secret key), with the pinned Stripe-Version on every
// request, a 900s poll floor, and no money-movement surface at any tier.
export {
  StripeConnector,
  ReadAllocationMeter,
  InvalidStripeCredentialError,
  StripeAccessPolicyError,
  StripeEventGapError,
  StripePollIntervalError,
  StripeQuotaExhaustedError,
  StripeReauthorizationRequiredError,
  UnsafeStripeBaseUrlError,
  assertReadableStripeCollection,
  assertSafeStripeBaseUrl,
  assertStripePollIntervalSeconds,
  assertStripeRestrictedKey,
  blockedStripeKeyResolver,
  majorUnits as stripeMajorUnits,
  EVENT_OBJECT_ROUTES as STRIPE_EVENT_OBJECT_ROUTES,
  STRIPE_ALLOWED_API_HOSTS,
  STRIPE_API_VERSION,
  STRIPE_BACKFILL_MAX_ATTEMPTS,
  STRIPE_BACKOFF_BASE_MS,
  STRIPE_DATASETS,
  STRIPE_DEFAULT_MONTHLY_READ_ALLOCATION,
  STRIPE_EVENT_CURSOR_LAG_MS,
  STRIPE_EVENT_RETENTION_MS,
  STRIPE_IP_POLICY_REMEDIATION,
  STRIPE_MAX_PAGES,
  STRIPE_MAX_RATE_LIMIT_RETRIES,
  STRIPE_MIN_POLL_INTERVAL_SECONDS,
  STRIPE_PRODUCTION_BASE_URL,
  STRIPE_PROVIDER,
  STRIPE_READABLE_COLLECTIONS,
  STRIPE_RESTRICTED_KEY_PATTERN,
  STRIPE_TRACK_REMEDIATION,
  type StripeBackfillResult,
  type StripeBalanceTransactionRow,
  type StripeChangeRecord,
  type StripeConnectionState,
  type StripeConnectorConfig,
  type StripeConnectorDeps,
  type StripeCredentialRejection,
  type StripeEventPollResult,
  type StripeKeyResolver,
  type StripeStatus,
} from "./stripe/connector.js";

// WARP-2127 — Dentrix Ascend: the cloud dental PMS, read over Henry Schein
// One's published Public API. This is the Dentrix surface that CAN be written
// honestly — the on-premise Developer Program withholds its schema as policy,
// so a connector for that one would invent every field reference (WARP-2126).
export {
  DentrixAscendConnector,
  AscendAuthorizationError,
  UnsafeAscendBaseUrlError,
  assertSafeAscendBaseUrl,
  blockedAscendTokenResolver,
  ASCEND_ALLOWED_HOST_SUFFIX,
  ASCEND_DATASETS,
  ASCEND_PRODUCTION_BASE_URL,
  ASCEND_SANDBOX_BASE_URL,
  ASCEND_SPEC_VERSION,
  ASCEND_TRACK_REMEDIATION,
  DENTRIX_ASCEND_PROVIDER,
  type AscendConnectionState,
  type AscendStatus,
  type AscendToken,
  type AscendTokenResolver,
  type DentrixAscendConfig,
  type DentrixAscendDeps,
} from "./dentrix/ascend-connector.js";

// WARP-2108 — QuickBooks Desktop: the track where the practice's machine calls
// US. Intuit's Web Connector polls outward, so data flows machine -> box with
// no inbound socket into the customer's finance workstation and nothing leaving
// the LAN. Free from Intuit: no SDK fee, no app review, no royalty.
export {
  QuickBooksDesktopConnector,
  QbdSnapshotStore,
  QbwcSession,
  QBD_DATASETS,
  QBD_TRACK_REMEDIATION,
  QUICKBOOKS_DESKTOP_PROVIDER,
  type AuthenticateResult,
  type QbdSnapshot,
  type QbdStatus,
  type QbwcCredentials,
  type QbwcSessionDeps,
  type QuickBooksDesktopConfig,
  type QuickBooksDesktopDeps,
} from "./quickbooks/desktop-connector.js";

export {
  QBXML_STEPS,
  QBXML_VERSION,
  QbxmlStatusError,
  buildRequest as buildQbxmlRequest,
  parseResponse as parseQbxmlResponse,
  type QbxmlStep,
} from "./quickbooks/qbxml.js";

export {
  DEFAULT_XML_LIMITS,
  XmlError,
  decodeEntities,
  escapeXml,
  parseXml,
  textAt,
  type XmlElement,
  type XmlLimits,
} from "./quickbooks/xml.js";

// WARP-2317 — HubSpot: the CRM track. Read-through over a customer-created
// PRIVATE APP token (never OAuth — HubSpot has no PKCE), pinned to the
// date-based API version on v3 CRM object routes, with an ACCOUNT-keyed 5 req/s
// Search governor, watermark re-anchoring at the 10,000-record cap, Exports for
// bulk history, and writes limited to confirmed notes and tasks.
export {
  HubSpotConnector,
  SearchRateGovernor,
  HubSpotBackfillInProgressError,
  HubSpotCapabilityUnavailableError,
  HubSpotConfirmationRequiredError,
  HubSpotQuotaExhaustedError,
  HubSpotReauthorizationRequiredError,
  HubSpotSearchRateLimitedError,
  HubSpotSuperAdminRevokedError,
  HubSpotWatermarkStallError,
  InvalidHubspotCredentialError,
  UnsafeHubspotBaseUrlError,
  assertHubspotPrivateAppToken,
  assertReadableHubspotObject,
  assertSafeHubspotBaseUrl,
  assertWritableHubspotObject,
  blockedHubspotTokenResolver,
  hubspotPath,
  hubspotResourceOf,
  resetSearchGovernors,
  searchGovernorForPortal,
  HUBSPOT_ALLOWED_API_HOSTS,
  HUBSPOT_API_VERSION,
  HUBSPOT_BACKFILL_MAX_ATTEMPTS,
  HUBSPOT_BACKOFF_BASE_MS,
  HUBSPOT_DATASETS,
  HUBSPOT_MAX_RATE_LIMIT_RETRIES,
  HUBSPOT_MAX_REANCHORS,
  HUBSPOT_PRIVATE_APP_TOKEN_PATTERN,
  HUBSPOT_PRODUCTION_BASE_URL,
  HUBSPOT_PROVIDER,
  HUBSPOT_READABLE_RESOURCES,
  HUBSPOT_SEARCH_CONSISTENCY_OVERLAP_MS,
  HUBSPOT_SEARCH_MAX_REQUESTS_PER_SECOND,
  HUBSPOT_SEARCH_PAGE_SIZE,
  HUBSPOT_SEARCH_RESULT_CAP,
  HUBSPOT_SUPER_ADMIN_REMEDIATION,
  HUBSPOT_TIER_GATED_RESOURCES,
  HUBSPOT_TRACK_REMEDIATION,
  HUBSPOT_WRITABLE_OBJECTS,
  type HubSpotBackfillResult,
  type HubSpotConnectionState,
  type HubSpotConnectorConfig,
  type HubSpotConnectorDeps,
  type HubSpotDeltaPollResult,
  type HubSpotRecord,
  type HubSpotStatus,
  type HubspotCredentialRejection,
  type HubspotTokenResolver,
} from "./hubspot/connector.js";

// WARP-2379 — Mailchimp: the audience-and-campaign track. Read-through over a
// customer-created Marketing API key whose "-us14" suffix SELECTS THE HOST, so
// the base URL is assembled at runtime and the egress CI scanner cannot see it.
// `assertSafeMailchimpBaseUrl` is therefore the enforcement, not defence in
// depth — see the module docstring. E-commerce orders are declared full-scan
// only because that endpoint has no date filter of any kind.
export {
  MailchimpConnector,
  ConnectionSemaphore,
  InvalidMailchimpCredentialError,
  MailchimpCapabilityMissingError,
  MailchimpReauthorizationRequiredError,
  MailchimpTimeoutError,
  UnsafeMailchimpBaseUrlError,
  assertEcommerceOrderParams,
  assertMailchimpDatacenter,
  assertReadableMailchimpResource,
  assertSafeMailchimpBaseUrl,
  blockedMailchimpKeyResolver,
  escapeRegExpLiteral as escapeMailchimpRegExpLiteral,
  mailchimpBaseUrlFor,
  parseMailchimpApiKey,
  subscriberHash as mailchimpSubscriberHash,
  MAILCHIMP_ALLOWED_HOST_PATTERN,
  MAILCHIMP_API_BASE_PATH,
  MAILCHIMP_API_HOST_SUFFIX,
  MAILCHIMP_API_KEY_PATTERN,
  MAILCHIMP_API_USE_POLICY_OBLIGATIONS,
  MAILCHIMP_CAMPAIGN_DELTA_PARAMS,
  MAILCHIMP_DATACENTER_PATTERN,
  MAILCHIMP_DATASETS,
  MAILCHIMP_ECOMMERCE_ORDER_PARAMS,
  MAILCHIMP_FORBIDDEN_PATH_SEGMENT,
  MAILCHIMP_MAX_CONCURRENT_CONNECTIONS,
  MAILCHIMP_MAX_PAGES,
  MAILCHIMP_MAX_PAGE_SIZE,
  MAILCHIMP_MEMBER_DELTA_PARAMS,
  MAILCHIMP_PLAN_PREREQUISITE,
  MAILCHIMP_PROVIDER,
  MAILCHIMP_READABLE_RESOURCES,
  MAILCHIMP_REQUEST_TIMEOUT_MS,
  MAILCHIMP_SCAN_MODE,
  MAILCHIMP_TRACK_REMEDIATION,
  type MailchimpAuditRecorder,
  type MailchimpConnectionState,
  type MailchimpConnectorConfig,
  type MailchimpConnectorDeps,
  type MailchimpCredentialRejection,
  type MailchimpKeyResolver,
  type MailchimpMemberPage,
  type MailchimpPlanProbe,
  type MailchimpPurgeResult,
  type MailchimpPurgeStore,
  type MailchimpStatus,
} from "./mailchimp/connector.js";
