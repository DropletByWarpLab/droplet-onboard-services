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
  REQUIRED_CANONICAL,
  assertValidProfile,
  knownVendors,
  matchDataset,
  normalizeHeader,
  parseProfileJson,
  profilesForVendor,
  ProfileError,
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
