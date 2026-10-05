/**
 * WARP-3511 — the Frigate reads behind the camera list's recording block and
 * the PTZ probe.
 *
 * Source of truth for the shapes below is Frigate 0.17.2's own API code:
 *   - `/api/<camera>/recordings?after&before` returns the rows overlapping
 *     the window ordered by start_time; its defaults are evaluated ONCE at
 *     import, so both bounds must always be sent.
 *   - `/api/<camera>/ptz/info` is a camera's ONVIF probe. A camera with no
 *     `onvif:` block answers `{}` (and the box has been seen answering 500).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { FRIGATE_URL: "http://frigate:5000", agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import {
  fetchLastRecordingEnd,
  fetchPtzCapabilities,
  fetchRecordingsStorage,
} from "./frigate.client.js";

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => handler(String(url)));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchPtzCapabilities — anything that is not a usable answer is 'no PTZ'", () => {
  const NO_PTZ = { supported: false, supportsPanTilt: false, supportsZoom: false, presets: [] };

  it("reads a PTZ camera's features and presets", async () => {
    stubFetch(() => json({ features: ["pt", "zoom"], presets: ["door", "gate"] }));
    expect(await fetchPtzCapabilities("front_door")).toEqual({
      supported: true,
      supportsPanTilt: true,
      supportsZoom: true,
      presets: ["door", "gate"],
    });
  });

  it("a camera with no onvif block answers {} → no PTZ", async () => {
    stubFetch(() => json({}));
    expect(await fetchPtzCapabilities("front_door")).toEqual(NO_PTZ);
  });

  it("404 → no PTZ (unchanged)", async () => {
    stubFetch(() => json({ success: false }, 404));
    expect(await fetchPtzCapabilities("front_door")).toEqual(NO_PTZ);
  });

  it("500 → no PTZ, not an error — the box answered this for a camera with no onvif block", async () => {
    stubFetch(() => new Response("Internal Server Error", { status: 500 }));
    expect(await fetchPtzCapabilities("front_door")).toEqual(NO_PTZ);
  });

  it("any other non-2xx → no PTZ", async () => {
    for (const status of [400, 401, 403]) {
      stubFetch(() => new Response("nope", { status }));
      expect(await fetchPtzCapabilities("front_door")).toEqual(NO_PTZ);
    }
  });

  it("a gateway-class answer (502, 503, 504) is the service being sick, not a camera without PTZ — it throws", async () => {
    // Reporting "no PTZ" here would be remembered for a camera that has PTZ.
    for (const status of [502, 503, 504]) {
      stubFetch(() => new Response("bad gateway", { status }));
      await expect(fetchPtzCapabilities("front_door")).rejects.toThrow(`PTZ info: ${status}`);
    }
  });

  it("a 2xx body that is not JSON → no PTZ", async () => {
    stubFetch(() => new Response("<html>proxy error</html>", { status: 200 }));
    expect(await fetchPtzCapabilities("front_door")).toEqual(NO_PTZ);
  });

  it("is supported with presets alone", async () => {
    stubFetch(() => json({ features: [], presets: ["door"] }));
    expect((await fetchPtzCapabilities("front_door")).supported).toBe(true);
  });

  it("a transport failure still throws, so the route can tell an outage from 'no PTZ'", async () => {
    stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(fetchPtzCapabilities("front_door")).rejects.toThrow("fetch failed");
  });
});

describe("fetchLastRecordingEnd — one bounded window, newest segment end", () => {
  it("sends both bounds, so Frigate's import-time defaults can never apply", async () => {
    const fetchMock = stubFetch(() => json([]));
    await fetchLastRecordingEnd("front_door", { nowSec: 10_000, lookbackSec: 600 });

    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.pathname).toBe("/api/front_door/recordings");
    expect(url.searchParams.get("after")).toBe("9400");
    expect(url.searchParams.get("before")).toBe("10000");
  });

  it("returns the latest end_time, whatever order the rows arrive in", async () => {
    stubFetch(() =>
      json([
        { id: "a", start_time: 9500, end_time: 9510 },
        { id: "c", start_time: 9520, end_time: 9530.5 },
        { id: "b", start_time: 9510, end_time: 9520 },
      ]),
    );
    expect(await fetchLastRecordingEnd("front_door", { nowSec: 10_000 })).toBe(9530.5);
  });

  it("null when nothing was saved in the window — unknown, not 'epoch'", async () => {
    stubFetch(() => json([]));
    expect(await fetchLastRecordingEnd("front_door", { nowSec: 10_000 })).toBeNull();
  });

  it("ignores rows without a usable end_time", async () => {
    stubFetch(() => json([{ id: "x", end_time: null }, { id: "y" }, { id: "z", end_time: "soon" }]));
    expect(await fetchLastRecordingEnd("front_door", { nowSec: 10_000 })).toBeNull();
  });

  it("a non-2xx answer throws, so the caller can leave the time unknown", async () => {
    stubFetch(() => new Response("boom", { status: 500 }));
    await expect(fetchLastRecordingEnd("front_door", { nowSec: 10_000 })).rejects.toThrow(
      "Frigate recordings: 500",
    );
  });

  it("encodes the camera name into the path", async () => {
    const fetchMock = stubFetch(() => json([]));
    await fetchLastRecordingEnd("a b/c", { nowSec: 10_000 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/api/a%20b%2Fc/recordings?");
  });

  it("uses the caller's timeout so a slow Frigate cannot stall the camera list", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => json([]));
    await fetchLastRecordingEnd("front_door", { nowSec: 10_000, timeoutMs: 1500 });
    expect(timeoutSpy).toHaveBeenCalledWith(1500);
  });
});

describe("fetchRecordingsStorage — optional timeout", () => {
  it("keeps the default behaviour with no options", async () => {
    stubFetch(() => json({ front_door: { usage: 1, bandwidth: 2 } }));
    expect(await fetchRecordingsStorage()).toEqual({ front_door: { usage: 1, bandwidth: 2 } });
  });

  it("honours a shorter timeout", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    stubFetch(() => json({}));
    await fetchRecordingsStorage({ timeoutMs: 2000 });
    expect(timeoutSpy).toHaveBeenCalledWith(2000);
  });
});
