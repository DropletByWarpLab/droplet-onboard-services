/**
 * WARP-1294 — dual-track ERP connector selection (the single place a provider
 * key maps to a concrete Connector).
 *
 *  - "eaglesoft"      → EaglesoftConnector    (direct SAP SQL Anywhere)
 *  - "eaglesoft-api"  → EaglesoftApiConnector (Patterson official REST API,
 *                       Innovation Connection, HTTPS :9888)
 *
 * Both implement the SAME `Connector` interface. integrations.service
 * (connect / test) selects the provider from the ConnectInput and persists it
 * on `IntegrationConnection.provider` (free-form TEXT — no migration).
 * erp.service (read / write) hands this factory `conn.provider` from the row it
 * resolves; in this slice that resolver is scoped to the SQL `"eaglesoft"` row,
 * so the `"eaglesoft-api"` branch here is reachable today via connect/test + the
 * factory unit tests, and via erp.service once its row-resolution is generalized
 * to the API provider (a follow-up, landing with the live API read path). The
 * SQL branch is byte-for-byte the prior behaviour; the API branch is
 * honest-blocked until Patterson vendor credentials + the discovered /help route
 * map are supplied (see @droplet/erp-connector/api-connector).
 */
import {
  EaglesoftConnector,
  EaglesoftApiConnector,
  DEFAULT_PORT,
  DEFAULT_DATABASE_NAME,
  DEFAULT_API_HTTPS_PORT,
  type Connector,
} from "@droplet/erp-connector";

/** The flagship direct-SQL provider (framework provider #1). */
export const EAGLESOFT_PROVIDER = "eaglesoft";
/** The dual-track official-REST-API provider. */
export const EAGLESOFT_API_PROVIDER = "eaglesoft-api";
/** Every provider key the control plane knows how to build a connector for. */
export const KNOWN_ERP_PROVIDERS: readonly string[] = [EAGLESOFT_PROVIDER, EAGLESOFT_API_PROVIDER];

/** True for a provider key this factory can build. */
export function isKnownErpProvider(provider: string): boolean {
  return KNOWN_ERP_PROVIDERS.includes(provider);
}

/** The connection facts both call sites share (a ConnectInput or a ConnRow).
 *  `secretRef` is a POINTER into the encrypted secret store — never cleartext. */
export interface ConnectorSelector {
  provider: string;
  host: string;
  /** SQL: TCP port (default 2638). API: HTTPS port (default 9888). */
  port?: number;
  serverName?: string;
  databaseName?: string;
  secretRef?: string;
}

/** Build the Connector for `sel.provider`. Unknown providers fall back to the
 *  SQL connector (the framework default) so a stray value can never route to a
 *  surprise transport. */
export function connectorForProvider(sel: ConnectorSelector): Connector {
  if (sel.provider === EAGLESOFT_API_PROVIDER) {
    return new EaglesoftApiConnector({
      host: sel.host,
      httpsPort: sel.port ?? DEFAULT_API_HTTPS_PORT,
      // Pointer only — the connector resolves CLIENTID/SERIALKEY + the Eaglesoft
      // Provider login against the secret store; nothing here is cleartext.
      credentialsSecretRef: sel.secretRef ?? "",
    });
  }
  return new EaglesoftConnector({
    host: sel.host,
    port: sel.port ?? DEFAULT_PORT,
    serverName: sel.serverName ?? sel.databaseName ?? DEFAULT_DATABASE_NAME,
    databaseName: sel.databaseName || DEFAULT_DATABASE_NAME,
    readSecretRef: sel.secretRef ?? "",
  });
}
