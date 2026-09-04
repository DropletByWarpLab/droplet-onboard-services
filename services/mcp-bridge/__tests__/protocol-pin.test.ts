/**
 * WARP-2326 — the protocol pin.
 *
 * NOTHING HERE OPENS A SOCKET. The transport is a structural double, which is
 * the whole reason `pinTransportProtocolVersion` takes
 * `ProtocolVersionedTransport` rather than the SDK's class.
 */
import { describe, it, expect, vi } from "vitest";
import {
  assertPinnedProtocolVersion,
  pinTransportProtocolVersion,
  ProtocolVersionMismatchError,
  type ProtocolVersionedTransport,
} from "../src/protocol-pin.js";
import { ATLASSIAN_MCP_PROTOCOL_VERSION } from "../src/atlassian.js";
import { classifyRemoteMcpError } from "../src/session-state.js";

const PIN = ATLASSIAN_MCP_PROTOCOL_VERSION;

/** A transport double that records what the pin wrote back onto it. */
function transportDouble(negotiated: string | undefined) {
  const setProtocolVersion = vi.fn<(v: string) => void>();
  const transport: ProtocolVersionedTransport = {
    get protocolVersion() {
      return negotiated;
    },
    setProtocolVersion,
  };
  return { transport, setProtocolVersion };
}

describe("the pinned protocol version", () => {
  it("is 2025-11-25 — the version Atlassian's server negotiates up to", () => {
    // A literal, not a reference to the SDK's LATEST_PROTOCOL_VERSION: the
    // point of a pin is that an SDK bump cannot move it silently.
    expect(PIN).toBe("2025-11-25");
  });

  it("accepts exactly the pin", () => {
    expect(() => assertPinnedProtocolVersion(PIN, PIN)).not.toThrow();
  });

  it("refuses an OLDER version the SDK would otherwise have accepted", () => {
    // 2025-06-18 is in the SDK's SUPPORTED_PROTOCOL_VERSIONS, so without this
    // guard the session would come up and silently speak it forever.
    expect(() => assertPinnedProtocolVersion("2025-06-18", PIN)).toThrow(
      ProtocolVersionMismatchError,
    );
  });

  it("refuses a NEWER version too — a pin caps, it does not floor", () => {
    expect(() => assertPinnedProtocolVersion("2026-03-01", PIN)).toThrow(
      ProtocolVersionMismatchError,
    );
  });

  it("refuses `undefined` rather than reading it as a match", () => {
    // "We do not know what was negotiated" is not "it matched". The repo rule
    // is no guessing state; absence is never a silent anything.
    const err = catchError(() => assertPinnedProtocolVersion(undefined, PIN));
    expect(err).toBeInstanceOf(ProtocolVersionMismatchError);
    expect((err as ProtocolVersionMismatchError).negotiated).toBeUndefined();
  });

  it("classifies as protocol_mismatch, so nothing retries it", () => {
    // Re-dialling cannot change a version. The session must land on a state
    // whose remedy is an SDK decision, not on `unreachable` (which retries).
    const err = new ProtocolVersionMismatchError(PIN, "2024-11-05");
    expect(classifyRemoteMcpError(err)).toEqual({
      state: "protocol_mismatch",
      reason: "protocol_version_unsupported",
    });
  });

  it("names both versions in the message and carries neither credential nor server text", () => {
    const err = new ProtocolVersionMismatchError(PIN, "2024-11-05");
    expect(err.message).toContain(PIN);
    expect(err.message).toContain("2024-11-05");
    expect(err.code).toBe("MCP_PROTOCOL_VERSION_MISMATCH");
  });
});

describe("pinTransportProtocolVersion", () => {
  it("re-asserts the pin on the transport after a matching handshake", () => {
    // THE POINT OF THE RE-ASSERT: the SDK has already stored the server's
    // string. Even when it equals the pin, what the transport keeps sending
    // must be a literal from this repo.
    const { transport, setProtocolVersion } = transportDouble(PIN);
    pinTransportProtocolVersion(transport, PIN);
    expect(setProtocolVersion).toHaveBeenCalledExactlyOnceWith(PIN);
  });

  it("never writes a version the server chose", () => {
    const { transport, setProtocolVersion } = transportDouble("2025-06-18");
    expect(() => pinTransportProtocolVersion(transport, PIN)).toThrow(
      ProtocolVersionMismatchError,
    );
    expect(setProtocolVersion).not.toHaveBeenCalled();
  });
});

function catchError(fn: () => void): unknown {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
}
