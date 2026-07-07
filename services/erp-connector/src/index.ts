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
} from "./introspection.js";

export {
  READ_QUERIES,
  getReadQuery,
  buildReadStatement,
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
  fingerprintTables,
  type Connector,
  type ConnectorConfig,
  type IntrospectionResult,
} from "./connector.js";
