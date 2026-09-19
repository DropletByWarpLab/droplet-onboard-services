/**
 * CodeQL js/polynomial-redos — `baseUrl` trailing-slash normalization in
 * the SqlBridgeClient constructor — plus the WARP-2590 service bearer.
 *
 * The client is otherwise exercised end to end by sql-bridge.live.test.ts,
 * which needs a running bridge, so it is SKIPPED in default CI. That left the
 * bearer with no coverage on the lane that actually gates merges: the helper
 * here recorded only the URL and threw `init` away, so a client that sent no
 * `Authorization` header at all would have passed every assertion in this
 * file. Capturing `init` is what closes that hole.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_BRIDGE_URL,
  SqlBridgeClient,
  type FetchLike,
} from "../src/sql-bridge-client.js";

/** One recorded call: the URL and the `init` the client actually passed. */
interface Call {
  url: string;
  init?: RequestInit;
}

function captureFetch(): { fetchImpl: FetchLike; urls: string[]; calls: Call[] } {
  const urls: string[] = [];
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    urls.push(input);
    calls.push({ url: input, init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, urls, calls };
}

/** The client builds `headers` as a plain object literal, so read it as one
 *  rather than through `new Headers()` — that would silently normalise a
 *  missing header into an empty string and hide the case we care about. */
function headersOf(call: Call | undefined): Record<string, string> {
  return (call?.init?.headers ?? {}) as Record<string, string>;
}

describe("SqlBridgeClient — baseUrl normalization", () => {
  it("strips any number of trailing slashes before joining the route", async () => {
    for (const baseUrl of ["http://bridge:9095", "http://bridge:9095/", "http://bridge:9095///"]) {
      const { fetchImpl, urls } = captureFetch();
      await new SqlBridgeClient({ baseUrl, fetchImpl }).health();
      expect(urls).toEqual(["http://bridge:9095/health"]);
    }
  });

  it("falls back to the compose-internal default", async () => {
    const { fetchImpl, urls } = captureFetch();
    await new SqlBridgeClient({ fetchImpl }).health();
    expect(urls).toEqual([`${DEFAULT_BRIDGE_URL}/health`]);
  });

  it("normalizes a 5,000-slash run in well under 100 ms, wherever the run sits", async () => {
    const run = "/".repeat(5000);
    // Trailing run: trimmed away. Interior run (followed by a non-slash):
    // nothing to trim — the shape that made `/\/+$/` re-scan every offset.
    const cases: Array<[string, string]> = [
      [`http://bridge:9095${run}`, "http://bridge:9095"],
      [`http://bridge${run}x`, `http://bridge${run}x`],
    ];
    for (const [baseUrl, expected] of cases) {
      const { fetchImpl, urls } = captureFetch();
      const started = performance.now();
      const client = new SqlBridgeClient({ baseUrl, fetchImpl });
      expect(performance.now() - started).toBeLessThan(100);
      await client.health();
      expect(urls).toEqual([`${expected}/health`]);
    }
  });
});

describe("SqlBridgeClient — WARP-2590 service bearer", () => {
  const TOKEN = "test-erp-bridge-token";
  const STATEMENT = { sql: "SELECT 1", params: [] };

  it("sends the bearer on every route the bridge gates", async () => {
    // /health is the one route the bridge exempts, but the client sends the
    // header there too — the exemption is the bridge's business, and a client
    // that special-cased it would be one edit away from omitting it elsewhere.
    const routes: Array<[string, (c: SqlBridgeClient) => Promise<unknown>]> = [
      ["/health", (c) => c.health()],
      ["/read/get_patient", (c) => c.runRead("get_patient", STATEMENT)],
      ["/write/reschedule", (c) => c.applyWrite("reschedule", STATEMENT)],
      ["/introspect", (c) => c.introspect({ tables: STATEMENT })],
    ];
    for (const [path, drive] of routes) {
      const { fetchImpl, calls } = captureFetch();
      await drive(new SqlBridgeClient({ baseUrl: "http://bridge:9095", fetchImpl, authToken: TOKEN }));
      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe(`http://bridge:9095${path}`);
      expect(headersOf(calls[0]).authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("sends the token verbatim — no re-encoding, no truncation", async () => {
    // secrets.sh mints hex, but a hand-set token may carry punctuation. The
    // bridge compares the WHOLE header byte for byte, so any mangling here
    // reads as a wrong credential rather than as a client bug.
    const awkward = "aB3-_.~+/=abc123";
    const { fetchImpl, calls } = captureFetch();
    await new SqlBridgeClient({ fetchImpl, authToken: awkward }).health();
    expect(headersOf(calls[0]).authorization).toBe(`Bearer ${awkward}`);
  });

  it("still sends content-type and accept alongside the bearer", async () => {
    const { fetchImpl, calls } = captureFetch();
    await new SqlBridgeClient({ fetchImpl, authToken: TOKEN }).runRead("get_patient", STATEMENT);
    expect(headersOf(calls[0])).toEqual({
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${TOKEN}`,
    });
  });

  it.each([
    ["omitted", undefined],
    ["empty", ""],
    ["whitespace only", "   "],
  ])("sends NO authorization header when the token is %s", async (_label, authToken) => {
    // An `Authorization: Bearer ` with nothing after it is not a weaker
    // credential, it is a malformed one — and it reads as an ATTEMPT in the
    // bridge's logs rather than as an unprovisioned caller. Assert the key is
    // absent, not that it is falsy: `{ authorization: "" }` would satisfy a
    // truthiness check while sending exactly the header we are excluding.
    const { fetchImpl, calls } = captureFetch();
    await new SqlBridgeClient({ fetchImpl, authToken }).health();
    expect(headersOf(calls[0])).not.toHaveProperty("authorization");
    expect(Object.keys(headersOf(calls[0])).map((k) => k.toLowerCase())).not.toContain(
      "authorization",
    );
  });

  it("trims surrounding whitespace off a padded token", async () => {
    const { fetchImpl, calls } = captureFetch();
    await new SqlBridgeClient({ fetchImpl, authToken: `  ${TOKEN}  ` }).health();
    expect(headersOf(calls[0]).authorization).toBe(`Bearer ${TOKEN}`);
  });
});
