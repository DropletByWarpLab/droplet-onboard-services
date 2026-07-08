/**
 * WARP-1094 — SQL Anywhere connection-string builder (brief §7.2; corrected per
 * EAGLESOFT-DIRECT-SQL-RESEARCH-2026-07-07 §2 and brief-review finding C-1).
 *
 * PURE, no I/O. Builds the DSN-less connection string the driver will use once
 * the SAP SQL Anywhere client lands. Two corrections are baked in here:
 *
 *   1. Use `Host=<ip>:<port>` XOR `CommLinks=` — NEVER both. SAP rejects a
 *      string that sets both; `Host` is the recommended form and `CommLinks`
 *      is only for extra TCP options we do not need (review C-1). We always
 *      emit `Host` and never `CommLinks`.
 *
 *   2. Default transport `Encryption=NONE`. Eaglesoft ships plaintext on the
 *      LAN and forcing TLS needs a server restart we must never perform on a
 *      live practice box. Verify the negotiated level live via
 *      CONNECTION_PROPERTY('Encryption'); tunnel PHI over the appliance's own
 *      crypto if it comes back `None` (research §2, §7 HIPAA in-transit).
 *
 * Values that contain reserved characters are brace-quoted `{...}` per SAP's
 * connection-parameter rules; a value containing `}` cannot be encoded and is
 * a hard error (we never string-concatenate an un-encodable secret).
 */

export const DEFAULT_PORT = 2638;
export const DEFAULT_DATABASE_NAME = "PattersonPM";
export const DEFAULT_SERVER_NAME = "EAGLESOFT";

export interface ConnectionParams {
  /** Eaglesoft server IP or hostname (the single central DB server, research §2). */
  host: string;
  /** TCP port; SQL Anywhere default is 2638. */
  port?: number;
  /** Running engine name (default "EAGLESOFT"; read the office's real value). */
  serverName?: string;
  /** Database name; "PattersonPM" on ES16+, "Dental" pre-16. */
  databaseName?: string;
  /** Provisioned login, e.g. droplet_ro / droplet_rw. */
  userId: string;
  /** Resolved secret. NEVER logged; the caller pulls it from the secret store. */
  password: string;
  /** Transport encryption. "NONE" (default) or a passthrough like "TLS(...)". */
  encryption?: string;
}

export class ConnectionStringError extends Error {
  readonly code = "CONNECTION_STRING_ERROR";
  constructor(message: string) {
    super(message);
    this.name = "ConnectionStringError";
  }
}

/** Brace-quote a value if it contains a reserved connection-string character.
 *  A value containing `}` cannot be represented and is a hard error.
 *
 *  Only `;` (the parameter separator), whitespace (which would otherwise be
 *  trimmed), and a leading `{` require quoting. A `=` INSIDE a value must NOT
 *  trigger quoting — the parser splits each `;`-segment on its first `=`, so a
 *  value like `TLS(trusted_certificates=cert.pem)` is valid unquoted; quoting
 *  it would corrupt the TLS sub-parameters. */
function encodeValue(field: string, value: string): string {
  if (value.includes("}")) {
    throw new ConnectionStringError(
      `${field} contains a "}" which cannot be encoded in a SQL Anywhere connection string`,
    );
  }
  return /[;\s{]/.test(value) ? `{${value}}` : value;
}

function requireNonEmpty(field: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new ConnectionStringError(`${field} is required and must be non-empty`);
  }
  return value;
}

/**
 * Build the DSN-less SQL Anywhere connection string. The `Driver=` prefix is
 * added by the ODBC layer at connect time (it names the platform driver, e.g.
 * "SQL Anywhere 17" → libdbodbc17_r.so), so it is intentionally NOT included
 * here — this builder owns only the connection parameters.
 */
export function buildConnectionString(params: ConnectionParams): string {
  const host = requireNonEmpty("host", params.host);
  const userId = requireNonEmpty("userId", params.userId);
  const password = requireNonEmpty("password", params.password);

  const port = params.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConnectionStringError(`port must be a valid TCP port (1–65535), got ${port}`);
  }

  const serverName = params.serverName?.trim() || DEFAULT_SERVER_NAME;
  const databaseName = params.databaseName?.trim() || DEFAULT_DATABASE_NAME;
  const encryption = params.encryption?.trim() || "NONE";

  // Host XOR CommLinks — we always use Host and never emit CommLinks (C-1).
  const parts: Array<[string, string]> = [
    ["Host", `${host}:${port}`],
    ["ServerName", serverName],
    ["DatabaseName", databaseName],
    ["UID", userId],
    ["PWD", password],
    ["Encryption", encryption],
  ];
  return parts.map(([k, v]) => `${k}=${encodeValue(k, v)}`).join(";");
}
