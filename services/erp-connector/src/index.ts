/**
 * @droplet/erp-connector — first-party ERP-connector framework (WARP-1094).
 *
 * DB-independent foundation: the schema map + drift fingerprint, the
 * introspection SQL constants, the parameterized read-query registry, the
 * write-command registry, and the provider abstraction with a stubbed
 * EaglesoftConnector. Every live-database path is blocked on the SAP SQL
 * Anywhere client + a restored copy of PattersonPM.db (see README).
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
  SQL_TRACK_REMEDIATION,
  fingerprintTables,
  type Connector,
  type ConnectorConfig,
  type IntrospectionResult,
} from "./connector.js";

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
