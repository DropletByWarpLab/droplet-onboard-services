/**
 * CodeQL js/polynomial-redos — `baseUrl` trailing-slash normalization in
 * the SqlBridgeClient constructor. The client is otherwise exercised end to
 * end by sql-bridge.live.test.ts, which needs a running bridge; this pins
 * the constructor's normalization alone, with an injected fetch.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_BRIDGE_URL,
  SqlBridgeClient,
  type FetchLike,
} from "../src/sql-bridge-client.js";

function captureFetch(): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl: FetchLike = async (input) => {
    urls.push(input);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, urls };
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
