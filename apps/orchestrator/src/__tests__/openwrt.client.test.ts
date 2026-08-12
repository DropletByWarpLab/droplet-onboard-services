import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock config BEFORE importing the SUT so it picks up a stable BASE_URL and token.
// WARP-44: mutable config stub so a single test can flip ROUTING_MODE without
// reloading the module. `vi.hoisted` is required because `vi.mock` runs before
// regular top-level `const` initializers.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    ROUTING_SERVICE_URL: "http://routing.test",
    ROUTING_SERVICE_TOKEN: "test-token",
    ROUTING_MODE: "real" as "real" | "mock" | "disabled",
    DATABASE_URL: "postgresql://test:test@localhost:5432/test",
    REDIS_URL: "redis://localhost:6379",
    MQTT_BROKER: "mqtt://localhost:1883",
    AI_GATEWAY_URL: "http://localhost:8000",
    NEXTCLOUD_URL: "http://nextcloud.test",
    PORT: 3000,
    NODE_ENV: "test",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));

vi.mock("../config.js", () => ({
  config: mockConfig,
}));

import {
  routingFetch,
  fetchNetworkSummary,
  fetchOperation,
  blockDevice,
  healthCheck,
  hasReachedRouter,
  routerErrorLogLevel,
  ROUTER_COLDSTART_GRACE_MS,
  scanWireless,
  fetchWirelessClients,
  _resetRouterContactForTests,
  setRouterPortEnabled,
} from "../services/openwrt.client.js";
import { RouterError } from "../types/router-error.js";

function mockResponse(init: {
  ok: boolean;
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
}): Response {
  return {
    ok: init.ok,
    status: init.status,
    statusText: init.ok ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(init.json ?? {}),
    text: vi.fn().mockResolvedValue(""),
    headers: new Headers(init.headers ?? {}),
  } as unknown as Response;
}

// Sleep is swapped for a synchronous no-op via the retry.sleep override so tests
// don't burn wall-clock time. Random is pinned to 0.5 so jittered delays are stable.
const noSleep = vi.fn().mockResolvedValue(undefined);
const stableRandom = () => 0.5;

describe("openwrt.client routingFetch", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    noSleep.mockClear();
  });

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("returns immediately on 2xx — no retry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200, json: { hello: "world" } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await routingFetch("/network/summary", {
      retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("retries on 5xx then succeeds on second attempt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await routingFetch("/network/summary", {
      retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
    // stableRandom returns 0.5 → jitter = base * 0.2 * (2*0.5 - 1) = 0 → delay unchanged
    expect(noSleep).toHaveBeenCalledWith(100);
  });

  it("retries on thrown network error then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const res = await routingFetch("/network/summary", {
      retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
    });

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting all attempts on persistent 5xx", async () => {
    // 500, not 502: WARP-1673 reserves 502 for the routing↔router credential
    // rejection (AUTH — terminal, never retried). 500 is the generic transient
    // 5xx that exercises the retry-exhaustion path.
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      routingFetch("/network/summary", {
        retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
      }),
    ).rejects.toThrow(/500/);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Delays fire between attempts: 1→2 and 2→3, so 2 sleeps total.
    expect(noSleep).toHaveBeenCalledTimes(2);
    expect(noSleep).toHaveBeenNthCalledWith(1, 100);
    expect(noSleep).toHaveBeenNthCalledWith(2, 250);
  });

  it("throws immediately on 4xx — no retry, no sleep", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      routingFetch("/network/summary", {
        label: "summary",
        retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
      }),
    ).rejects.toThrow(/summary: 401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("throws immediately on AbortError without retrying (TIMEOUT code)", async () => {
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    const fetchMock = vi.fn().mockRejectedValue(abortErr);
    global.fetch = fetchMock as unknown as typeof fetch;

    // WARP-39: abort surfaces as RouterError(code=TIMEOUT).
    const { RouterError } = await import("../types/router-error.js");
    await expect(
      routingFetch("/network/summary", {
        retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
      }),
    ).rejects.toSatisfy((thrown) => thrown instanceof RouterError && thrown.code === "TIMEOUT");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(noSleep).not.toHaveBeenCalled();
  });

  it("attaches Authorization: Bearer header when token is configured", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await routingFetch("/network/summary", {
      retry: { attempts: 1, delaysMs: [], sleep: noSleep, random: stableRandom },
    });

    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://routing.test/network/summary");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-token");
  });

  // WARP-39: error classification tests — every failure goes through
  // routerErrorFromResponse / routerErrorFromThrown and surfaces a typed code.
  describe("RouterError classification (WARP-39)", () => {
    it("401 → AUTH, no retry", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 401 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/network/summary", {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy((e) => e instanceof RouterError && e.code === "AUTH" && e.status === 401);

      expect(fetchMock).toHaveBeenCalledTimes(1); // auth is terminal
      expect(noSleep).not.toHaveBeenCalled();
    });

    it("403 → AUTH, no retry", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 403 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/network/summary", {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy((e) => e instanceof RouterError && e.code === "AUTH");

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("persistent 5xx → UNREACHABLE after retry exhaustion", async () => {
      const { RouterError } = await import("../types/router-error.js");
      // 500, not 502 — 502 is the reserved AUTH signal (WARP-1673), tested below.
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 500 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/network/summary", {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy((e) => e instanceof RouterError && e.code === "UNREACHABLE");

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    // WARP-1673: the routing service reserves 502 for "the ROUTER rejected the
    // routing service's own rpcd credentials". That's AUTH — terminal — so the
    // retry loop must NOT spin on it: retrying can't fix a rotated credential,
    // and spinning would misreport a credential problem as an outage.
    it("502 → AUTH, no retry (WARP-1673: reserved for router credential rejection)", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: false, status: 502 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/network/summary", {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy(
        (e) => e instanceof RouterError && e.code === "AUTH" && e.status === 502,
      );

      expect(fetchMock).toHaveBeenCalledTimes(1); // terminal — no retry
      expect(noSleep).not.toHaveBeenCalled();
    });

    it("network error (fetch throws) → UNREACHABLE after retry exhaustion", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/network/summary", {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy((e) => e instanceof RouterError && e.code === "UNREACHABLE");

      expect(fetchMock).toHaveBeenCalledTimes(3); // network errors are retried
    });

    it("5xx with X-Operation-Id header → ROLLED_BACK (not retried past classification)", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          mockResponse({
            ok: false,
            status: 503,
            headers: { "X-Operation-Id": "abc123" },
          }),
        );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        routingFetch("/wireless/ssid", {
          method: "POST",
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy(
        (e) => e instanceof RouterError && e.code === "ROLLED_BACK" && e.status === 503,
      );
    });

    // WARP-44: ROUTING_MODE=disabled → short-circuit with DISABLED before any fetch.
    it("ROUTING_MODE=disabled throws DISABLED without hitting the network", async () => {
      const { RouterError } = await import("../types/router-error.js");
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      mockConfig.ROUTING_MODE = "disabled";
      try {
        await expect(
          routingFetch("/network/summary", {
            retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
          }),
        ).rejects.toSatisfy((e) => e instanceof RouterError && e.code === "DISABLED");

        expect(fetchMock).not.toHaveBeenCalled();
        expect(noSleep).not.toHaveBeenCalled();
      } finally {
        mockConfig.ROUTING_MODE = "real";
      }
    });

    it("ROUTING_MODE=real allows calls through", async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
      global.fetch = fetchMock as unknown as typeof fetch;

      mockConfig.ROUTING_MODE = "real";
      const res = await routingFetch("/network/summary", {
        retry: { attempts: 1, delaysMs: [], sleep: noSleep, random: stableRandom },
      });
      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  it("applies jitter — ±20% of base delay, bounded", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    // random=0 → jitter = 100 * 0.2 * (0 - 1) = -20 → delay = 80
    await routingFetch("/network/summary", {
      retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: () => 0 },
    });
    expect(noSleep).toHaveBeenLastCalledWith(80);

    noSleep.mockClear();
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }));
    fetchMock.mockResolvedValueOnce(mockResponse({ ok: true, status: 200 }));

    // random=1 → jitter = 100 * 0.2 * (2 - 1) = +20 → delay = 120
    await routingFetch("/network/summary", {
      retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: () => 1 },
    });
    expect(noSleep).toHaveBeenLastCalledWith(120);
  });
});

describe("openwrt.client public wrappers", () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  // WARP-40: write helpers surface X-Operation-Id so the dashboard can poll.
  it("write helpers return the X-Operation-Id header when present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        headers: { "X-Operation-Id": "abc123" },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await blockDevice("aa:bb:cc:dd:ee:ff", "Test");

    expect(result.operationId).toBe("abc123");
  });

  it("write helpers return null operationId when the header is missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, status: 200 })); // no X-Operation-Id
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await blockDevice("aa:bb:cc:dd:ee:ff");

    expect(result.operationId).toBeNull();
  });

  it("fetchOperation parses the operation payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      mockResponse({
        ok: true,
        status: 200,
        json: {
          id: "abc123",
          state: "applied",
          startedAt: 100,
          finishedAt: 101,
          reason: null,
        },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const op = await fetchOperation("abc123");

    expect(op.id).toBe("abc123");
    expect(op.state).toBe("applied");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://routing.test/operations/abc123");
  });

  it("fetchOperation bubbles 404 errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: false, status: 404 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchOperation("missing")).rejects.toThrow(/404/);
    // 404 is a 4xx — retry policy must NOT retry.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fetchNetworkSummary uses real retry path (retry once on 5xx)", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(mockResponse({ ok: false, status: 503 }))
      .mockResolvedValueOnce(mockResponse({ ok: true, status: 200, json: { router_host: "x" } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = fetchNetworkSummary();
    // Let the retry path advance through its 100ms default backoff.
    await vi.advanceTimersByTimeAsync(200);
    await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  // WARP-815 (K4): the orchestrator must NOT bake a host-specific Wi-Fi radio
  // name into the scan/clients query string. The single-box radio is `wlp14s0`,
  // not `wlan0`; the routing service already resolves the radio from
  // DROPLET_WIFI_SCAN_DEVICE (services/routing/droplet_openwrt_sdk.py) when the
  // `device` query param is absent. A hardcoded default here ALWAYS sends
  // `device=wlan0`, overriding that env fallback and scanning a radio the box
  // doesn't have. So: omit `device` when the caller doesn't pass one; forward it
  // verbatim when they do (explicit-device callers keep working). Rule 12 — no
  // host-specific defaults.
  describe("wireless scan/clients device wiring (WARP-815 K4)", () => {
    it("scanWireless() with no device sends NO device query param (routing resolves the env)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { results: [] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await scanWireless();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://routing.test/wireless/scan");
      expect(url).not.toContain("device=");
      expect(url).not.toContain("wlan0");
    });

    it("scanWireless(device) forwards an explicitly-provided device verbatim", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { results: [] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await scanWireless("wlp14s0");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://routing.test/wireless/scan?device=wlp14s0");
    });

    it("fetchWirelessClients() with no device sends NO device query param", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { clients: [] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await fetchWirelessClients();

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://routing.test/wireless/clients");
      expect(url).not.toContain("device=");
      expect(url).not.toContain("wlan0");
    });

    it("fetchWirelessClients(device) forwards an explicitly-provided device verbatim", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { clients: [] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await fetchWirelessClients("phy1-ap0");

      const [url] = fetchMock.mock.calls[0] as [string];
      expect(url).toBe("http://routing.test/wireless/clients?device=phy1-ap0");
    });
  });

  // WARP-816: the routing service returns 409 + `{ code: "SCAN_UNSUPPORTED" }`
  // when the radio is in AP/Master mode and can't station-scan (single-box).
  // scanWireless() maps it to a typed RouterError (code SCAN_UNSUPPORTED) so the
  // dashboard renders calm copy instead of an empty list — mirroring the
  // UNREACHABLE/DISABLED precedent (WARP-807). It is NOT retried (terminal 4xx)
  // and is DISTINCT from a 200 empty scan, which still returns [].
  describe("scanWireless SCAN_UNSUPPORTED mapping (WARP-816)", () => {
    it("409 with code SCAN_UNSUPPORTED → RouterError.scanUnsupported, no retry", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 409,
          json: { code: "SCAN_UNSUPPORTED", message: "Wi-Fi scan is not available on wlp14s0" },
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        scanWireless(undefined, {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy(
        (e) =>
          e instanceof RouterError && e.code === "SCAN_UNSUPPORTED" && e.status === 409,
      );

      // Terminal — a 4xx capability fact, never retried.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(noSleep).not.toHaveBeenCalled();
    });

    it("carries the orchestrator's user-facing message (no raw code/status leak)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({
          ok: false,
          status: 409,
          json: { code: "SCAN_UNSUPPORTED", message: "Wi-Fi scan is not available on wlp14s0" },
        }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(scanWireless()).rejects.toSatisfy(
        (e) =>
          e instanceof RouterError &&
          e.code === "SCAN_UNSUPPORTED" &&
          typeof e.message === "string" &&
          e.message.length > 0 &&
          // the user-facing message must be prose, not the bare machine code or
          // the routerErrorFromResponse "… 409 Error" stub the generic path emits
          e.message !== "SCAN_UNSUPPORTED" &&
          !e.message.includes("409"),
      );
    });

    it("a 200 empty scan is NOT unsupported — returns [] (distinct from the 409 signal)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: true, status: 200, json: { results: [] } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(scanWireless()).resolves.toEqual([]);
    });

    it("a non-409 4xx is left as its normal classification (not coerced to SCAN_UNSUPPORTED)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(
        mockResponse({ ok: false, status: 400, json: { error: "bad request" } }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(
        scanWireless(undefined, {
          retry: { attempts: 3, delaysMs: [100, 250], sleep: noSleep, random: stableRandom },
        }),
      ).rejects.toSatisfy(
        (e) => e instanceof RouterError && e.code !== "SCAN_UNSUPPORTED",
      );
    });
  });
});

// WARP cold-start log hygiene: on a fresh boot the in-container OpenWrt is
// unreachable for ~1 min while it provisions. UNREACHABLE errors during that
// window are EXPECTED warmup, not an outage — they must log at `debug`, not
// `warn`. The decision is gated on an explicit "first successful contact" flag
// (never inferred from absence) AND a bounded uptime grace, so a genuinely-down
// router still escalates to `warn` once the grace expires.
describe("openwrt.client cold-start log hygiene", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    // Reset to the cold-start baseline: never contacted, start reference = now.
    _resetRouterContactForTests();
  });

  afterEach(() => {
    global.fetch = realFetch;
    _resetRouterContactForTests();
    vi.restoreAllMocks();
  });

  it("starts in the not-yet-contacted state", () => {
    expect(hasReachedRouter()).toBe(false);
  });

  it("flips hasReachedRouter() to true after the first successful routingFetch (res.ok)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(hasReachedRouter()).toBe(false);
    await routingFetch("/network/summary", {
      retry: { attempts: 1, delaysMs: [], sleep: noSleep, random: stableRandom },
    });
    expect(hasReachedRouter()).toBe(true);
  });

  it("does NOT mark contact when every attempt fails (UNREACHABLE)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      routingFetch("/network/summary", {
        retry: { attempts: 1, delaysMs: [], sleep: noSleep, random: stableRandom },
      }),
    ).rejects.toBeInstanceOf(RouterError);
    expect(hasReachedRouter()).toBe(false);
  });

  // AC #6(a): cold start, not yet contacted, within grace + UNREACHABLE → debug.
  it("UNREACHABLE within the grace window, never contacted → debug", () => {
    _resetRouterContactForTests({ startRef: 0 });
    const err = RouterError.unreachable("router warming up");
    // now = grace - 1ms → still inside the window.
    const now = () => ROUTER_COLDSTART_GRACE_MS - 1;
    expect(routerErrorLogLevel(err, now)).toBe("debug");
  });

  // AC #6(b): after a prior success, UNREACHABLE → warn (a real blip, not warmup).
  it("UNREACHABLE after a prior successful contact → warn (even within grace)", async () => {
    _resetRouterContactForTests({ startRef: 0 });
    const okFetch = vi.fn().mockResolvedValue(mockResponse({ ok: true, status: 200 }));
    global.fetch = okFetch as unknown as typeof fetch;
    await routingFetch("/network/summary", {
      retry: { attempts: 1, delaysMs: [], sleep: noSleep, random: stableRandom },
    });
    expect(hasReachedRouter()).toBe(true);

    const err = RouterError.unreachable("router blip");
    const now = () => ROUTER_COLDSTART_GRACE_MS - 1; // still inside grace
    expect(routerErrorLogLevel(err, now)).toBe("warn");
  });

  // AC #6(c) / AC #5: never contacted but uptime exceeded the grace → warn.
  // A genuinely-down router must not be silently hidden forever.
  it("UNREACHABLE after the grace window expires, never contacted → warn", () => {
    _resetRouterContactForTests({ startRef: 0 });
    const err = RouterError.unreachable("router still down");
    const now = () => ROUTER_COLDSTART_GRACE_MS + 1; // past the window
    expect(routerErrorLogLevel(err, now)).toBe("warn");
  });

  // Boundary: exactly at the grace edge is NOT "less than" → warn.
  it("UNREACHABLE exactly at the grace boundary → warn", () => {
    _resetRouterContactForTests({ startRef: 0 });
    const err = RouterError.unreachable("router at edge");
    const now = () => ROUTER_COLDSTART_GRACE_MS;
    expect(routerErrorLogLevel(err, now)).toBe("warn");
  });

  // AC #6(d): a non-UNREACHABLE RouterError is never warmup → always warn.
  it("AUTH within the grace window, never contacted → warn", () => {
    _resetRouterContactForTests({ startRef: 0 });
    const err = RouterError.auth("bad token", { status: 401 });
    const now = () => 0; // freshest possible cold start
    expect(routerErrorLogLevel(err, now)).toBe("warn");
  });

  it.each(["TIMEOUT", "DISABLED", "ROLLED_BACK", "UNKNOWN"] as const)(
    "%s within the grace window, never contacted → warn",
    (code) => {
      _resetRouterContactForTests({ startRef: 0 });
      const err = new RouterError(code, `code ${code}`);
      expect(routerErrorLogLevel(err, () => 0)).toBe("warn");
    },
  );

  // A non-RouterError (e.g. a bare TypeError, schema parse blowup) → warn.
  it("a non-RouterError thrown value → warn regardless of uptime", () => {
    _resetRouterContactForTests({ startRef: 0 });
    expect(routerErrorLogLevel(new Error("schema parse failed"), () => 0)).toBe("warn");
    expect(routerErrorLogLevel("a string", () => 0)).toBe("warn");
    expect(routerErrorLogLevel(undefined, () => 0)).toBe("warn");
  });

  it("defaults the clock to Date.now() when no clock is injected", () => {
    // Fresh cold start (startRef = now); an immediate UNREACHABLE must be debug
    // because real wall-clock uptime is ~0ms, well inside the grace.
    _resetRouterContactForTests();
    const err = RouterError.unreachable("just booted");
    expect(routerErrorLogLevel(err)).toBe("debug");
  });

  it("exposes the grace window as a plain const default of 120_000ms", () => {
    expect(ROUTER_COLDSTART_GRACE_MS).toBe(120_000);
  });

  // healthCheck must not prematurely flip routerContacted when the routing
  // service returns HTTP 200 with connected:false (OpenWrt still provisioning).
  it("healthCheck with connected:false does NOT flip hasReachedRouter()", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, status: 200, json: { connected: false } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(hasReachedRouter()).toBe(false);
    const result = await healthCheck();
    expect(result).toBe(false);
    expect(hasReachedRouter()).toBe(false);
  });

  it("healthCheck with connected:true DOES flip hasReachedRouter()", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(mockResponse({ ok: true, status: 200, json: { connected: true } }));
    global.fetch = fetchMock as unknown as typeof fetch;

    expect(hasReachedRouter()).toBe(false);
    const result = await healthCheck();
    expect(result).toBe(true);
    expect(hasReachedRouter()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WARP-1907 — the router-jack write, and the four refusals it must not lose
// ---------------------------------------------------------------------------
describe("setRouterPortEnabled", () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function stub(res: Response) {
    const fetchMock = vi.fn().mockResolvedValue(res);
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it("POSTs enabled + force to the per-port path and returns the operation id", async () => {
    const fetchMock = stub(
      mockResponse({ ok: true, status: 200, headers: { "X-Operation-Id": "op-77" } }),
    );
    const result = await setRouterPortEnabled("p5", false, true);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://routing.test/network/ports/p5/enable");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ enabled: false, force: true });
    expect(result).toEqual({ operationId: "op-77" });
  });

  it("defaults force to false on the wire", async () => {
    const fetchMock = stub(mockResponse({ ok: true, status: 200 }));
    await setRouterPortEnabled("p5", false);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      enabled: false,
      force: false,
    });
  });

  it("percent-encodes a port name so it cannot escape the path", async () => {
    const fetchMock = stub(mockResponse({ ok: true, status: 200 }));
    await setRouterPortEnabled("br-lan.30", true);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://routing.test/network/ports/br-lan.30/enable",
    );
  });

  it("null operation id when the routing service emitted no header", async () => {
    stub(mockResponse({ ok: true, status: 200 }));
    expect(await setRouterPortEnabled("p5", true)).toEqual({ operationId: null });
  });

  it("maps 502 PORT_WRITE_NOT_APPLIED to its own code — NOT auth", async () => {
    /* 🔴 routerErrorFromResponse maps EVERY 502 to AUTH on the WARP-1673
       invariant ("nothing sits between the orchestrator and routing to mint a
       502"). This route broke that invariant, so it reads its own body rather
       than weakening a rule a real credential rejection depends on. Reported as
       AUTH, a port that silently didn't move would render as "check your router
       password". */
    stub(
      mockResponse({
        ok: false,
        status: 502,
        json: { code: "PORT_WRITE_NOT_APPLIED", error: "the port didn't move" },
      }),
    );
    const err = await setRouterPortEnabled("p5", false).catch((e) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err.code).toBe("PORT_WRITE_NOT_APPLIED");
    expect(err.code).not.toBe("AUTH");
    expect(err.status).toBe(502);
    expect(err.message).toBe("the port didn't move");
  });

  it("a 502 that is NOT ours still classifies as AUTH", async () => {
    /* The WARP-1673 contract, unbroken: a credential rejection carries
       ROUTER_AUTH, and must keep reaching the dashboard as AUTH. */
    stub(mockResponse({ ok: false, status: 502, json: { code: "ROUTER_AUTH" } }));
    const err = await setRouterPortEnabled("p5", false).catch((e) => e);
    expect(err.code).toBe("AUTH");
  });

  it("maps 409 WAN_PORT to a refusal carrying the guard verbatim", async () => {
    /* The race the cached `disable_guard` cannot cover: a jack that was empty at
       poll time gained a cable before the click. Without the guard on the error
       the dashboard has no escalation to offer and the user sees "409". */
    stub(
      mockResponse({
        ok: false,
        status: 409,
        json: { code: "WAN_PORT", error: "This is the jack your internet comes in on." },
      }),
    );
    const err = await setRouterPortEnabled("p1", false).catch((e) => e);
    expect(err.code).toBe("PORT_WRITE_REFUSED");
    expect(err.status).toBe(409);
    expect(err.detail).toEqual({
      code: "WAN_PORT",
      reason: "This is the jack your internet comes in on.",
    });
    expect(err.message).toBe("This is the jack your internet comes in on.");
  });

  it("maps 409 MANAGEMENT_PORT the same way, keeping the codes apart", async () => {
    stub(
      mockResponse({
        ok: false,
        status: 409,
        json: { code: "MANAGEMENT_PORT", error: "reaches your appliance through" },
      }),
    );
    const err = await setRouterPortEnabled("p2", false).catch((e) => e);
    expect(err.detail.code).toBe("MANAGEMENT_PORT");
  });

  it("does not invent a guard from a 409 whose body it cannot read", async () => {
    /* A body we can't parse is not a reason to fabricate one — fall through to
       the shared classifier rather than escalate on a guess. */
    stub(mockResponse({ ok: false, status: 409, json: { code: "SOMETHING_ELSE" } }));
    const err = await setRouterPortEnabled("p2", false).catch((e) => e);
    expect(err.code).toBe("UNKNOWN");
    expect(err.detail).toBeUndefined();
  });

  it("maps 404 PORT_NOT_FOUND with the server's sentence, not '404 Error'", async () => {
    stub(
      mockResponse({
        ok: false,
        status: 404,
        json: { code: "PORT_NOT_FOUND", error: "This router has no physical port called 'p9'." },
      }),
    );
    const err = await setRouterPortEnabled("p9", false).catch((e) => e);
    expect(err.code).toBe("PORT_NOT_FOUND");
    expect(err.status).toBe(404);
    expect(err.message).toBe("This router has no physical port called 'p9'.");
  });

  it("maps 422 PORT_MAP_UNSUPPORTED with the server's sentence", async () => {
    stub(
      mockResponse({
        ok: false,
        status: 422,
        json: { code: "PORT_MAP_UNSUPPORTED", error: "no port map on this shape" },
      }),
    );
    const err = await setRouterPortEnabled("p5", false).catch((e) => e);
    expect(err.code).toBe("PORT_MAP_UNSUPPORTED");
    expect(err.status).toBe(422);
    expect(err.message).toBe("no port map on this shape");
  });

  it("leaves 503 rollback_pending to the shared classifier", async () => {
    /* Already correct, and correctness here is load-bearing: a safe-apply
       rollback must keep reading ROLLED_BACK. */
    stub(
      mockResponse({
        ok: false,
        status: 503,
        headers: { "X-Operation-Id": "op-9" },
        json: { rollback_pending: true },
      }),
    );
    const err = await setRouterPortEnabled("p2", false, true).catch((e) => e);
    expect(err.code).toBe("ROLLED_BACK");
  });

  it("does NOT retry a refusal — it is a terminal answer, not a transient fault", async () => {
    const fetchMock = stub(
      mockResponse({ ok: false, status: 502, json: { code: "PORT_WRITE_NOT_APPLIED", error: "x" } }),
    );
    await setRouterPortEnabled("p5", false).catch(() => {});
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
