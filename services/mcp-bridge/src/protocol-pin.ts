/**
 * WARP-2326 — pin the MCP protocol version, and stop the SDK echoing the
 * server's.
 *
 * ## The behaviour this exists to override
 *
 * `@modelcontextprotocol/sdk@1.30.0`'s `Client.connect()` does three things
 * in order (`dist/esm/client/index.js:285,293,299`):
 *
 *   1. sends `initialize` with its own `LATEST_PROTOCOL_VERSION`;
 *   2. checks the server's answer is somewhere in `SUPPORTED_PROTOCOL_VERSIONS`
 *      — a FIVE-element list reaching back to `2024-10-07`;
 *   3. calls `transport.setProtocolVersion(result.protocolVersion)`, so every
 *      subsequent request carries the `MCP-Protocol-Version` header the SERVER
 *      chose.
 *
 * Step 3 is the problem. Under the SDK's default an Atlassian server that
 * answered `2024-11-05` would be accepted silently and we would then speak
 * 2024-11-05 for the life of the session — a downgrade the caller cannot see,
 * negotiated by the counterparty, on a wire whose tool surface we have
 * classified against one version's semantics.
 *
 * Atlassian makes this concrete rather than theoretical: the server
 * self-reports `atlassian-mcp-server 1.0.0` while its published `server.json`
 * says `1.1.3`, so there is **no server version to pin a contract to**. The
 * protocol version is the only stable identifier in the handshake, which is
 * exactly why it must not be the server's to choose.
 *
 * ## What this module does
 *
 * Refuse anything but the pin, then re-assert the pin on the transport so the
 * header is ours. Both halves matter: without the refusal we accept a
 * downgrade; without the re-assert we accept the pin's value but keep sending
 * whatever `setProtocolVersion` already stored.
 *
 * The refusal is shaped so `classifyRemoteMcpError` lands it on
 * `protocol_mismatch` / `protocol_version_unsupported` — an SDK decision, not
 * an operator action, and never a retry (re-dialling cannot change a version).
 */

/** Thrown when a server negotiated a protocol version we do not pin. */
export class ProtocolVersionMismatchError extends Error {
  readonly code = "MCP_PROTOCOL_VERSION_MISMATCH";
  constructor(
    readonly pinned: string,
    readonly negotiated: string | undefined,
  ) {
    super(
      // "protocol version" appears verbatim because `classifyRemoteMcpError`
      // falls back to that substring; the shape-based branches above it see
      // no HTTP status on a locally-raised error.
      `refusing the session: this client pins MCP protocol version ${pinned}, ` +
        `the server negotiated ${negotiated ?? "nothing at all"}`,
    );
    this.name = "ProtocolVersionMismatchError";
  }
}

/** The subset of a transport this module touches. Declared structurally so
 *  the guard is testable without constructing an SDK transport (nothing in
 *  this workspace's tests opens a socket). */
export interface ProtocolVersionedTransport {
  readonly protocolVersion?: string | undefined;
  setProtocolVersion(version: string): void;
}

/**
 * Refuse a negotiated version that is not the pin.
 *
 * `undefined` is refused too. It means the SDK never reached step 3 — the
 * handshake did not complete, or completed against something that is not an
 * MCP server — and treating "we do not know" as "it matched" is the guessing
 * the repo rule forbids.
 */
export function assertPinnedProtocolVersion(
  negotiated: string | undefined,
  pinned: string,
): void {
  if (negotiated !== pinned) {
    throw new ProtocolVersionMismatchError(pinned, negotiated);
  }
}

/**
 * Check the negotiated version and re-assert the pin on the transport.
 *
 * Call this immediately after `client.connect(transport)`. The re-assert is
 * NOT redundant with the check: the check reads what the SDK stored, and the
 * re-assert is what guarantees the value the transport keeps sending is a
 * literal from this repo rather than a string that arrived over the wire.
 */
export function pinTransportProtocolVersion(
  transport: ProtocolVersionedTransport,
  pinned: string,
): void {
  assertPinnedProtocolVersion(transport.protocolVersion, pinned);
  transport.setProtocolVersion(pinned);
}
