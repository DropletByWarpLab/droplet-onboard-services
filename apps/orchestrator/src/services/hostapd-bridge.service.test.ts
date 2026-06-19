/**
 * WARP-808 — hostapd-bridge.service: the orchestrator side of the single-box
 * Wi-Fi write. Reuses the storage.ts device-bridge pattern (DEVICE_BRIDGE_URL +
 * the BRIDGE_AUTH_TOKEN/SERVICE_TOKEN_DISPLAY precedence, X-Droplet-Auth header,
 * fail-closed on an empty token).
 *
 * Contract under test:
 *   - stageSsid() just records the SSID in memory (no fetch).
 *   - applyWifi(psk) POSTs { ssid, psk } to POST /openwrt/wifi/hostapd with the
 *     X-Droplet-Auth header; uses the staged SSID, falling back to the bridge's
 *     current SSID when nothing was staged (a password-only change).
 *   - FAIL CLOSED: with no bridge token, applyWifi throws BRIDGE_AUTH_UNCONFIGURED
 *     and never sends the request (we cannot safely mutate the host AP).
 *   - A non-ok bridge reply throws so the route surfaces it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../config.js", () => ({
  config: { DEVICE_BRIDGE_URL: "http://bridge.test:9090" },
}));

import {
  stageSsid,
  applyWifi,
  applyGuestWifi,
  removeGuestWifi,
  guestStatusFromBridge,
  _resetForTests,
} from "./hostapd-bridge.service.js";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  _resetForTests();
  process.env.BRIDGE_AUTH_TOKEN = "tok-123";
  delete process.env.SERVICE_TOKEN_DISPLAY;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function mockFetchOnce(status: number, body: unknown) {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
  return fetchSpy;
}

describe("applyWifi — happy path", () => {
  it("POSTs staged SSID + PSK to /openwrt/wifi/hostapd with the auth header", async () => {
    const fetchSpy = mockFetchOnce(200, { ok: true, ssid: "HomeNet" });
    stageSsid("HomeNet");
    const res = await applyWifi("supersecret1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/openwrt/wifi/hostapd");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("tok-123");
    const sent = JSON.parse(String(init?.body));
    expect(sent).toEqual({ ssid: "HomeNet", psk: "supersecret1" });
    // hostapd has no safe-apply/rollback operation record.
    expect(res).toEqual({ operationId: null });
  });

  it("clears the staged SSID after a successful apply (no leak into the next submit)", async () => {
    mockFetchOnce(200, { ok: true });
    stageSsid("HomeNet");
    await applyWifi("supersecret1");

    // Second apply with nothing staged → must fetch the current SSID.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      // first call: GET /openwrt/qr (current SSID), second: the POST
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ssid: "HomeNet", payload: "x" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    await applyWifi("newsecret9");
    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/openwrt/qr"))).toBe(true);
  });
});

describe("applyWifi — current-SSID fallback (password-only change)", () => {
  it("fetches the live SSID from the bridge when none was staged", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ssid: "ExistingNet", payload: "x" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const res = await applyWifi("supersecret1");
    expect(res).toEqual({ operationId: null });
    // Second call is the POST carrying the fetched SSID.
    const postCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    expect(postCall).toBeTruthy();
    const sent = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(sent).toEqual({ ssid: "ExistingNet", psk: "supersecret1" });
  });
});

describe("applyWifi — FAIL CLOSED on missing bridge token", () => {
  it("throws BRIDGE_AUTH_UNCONFIGURED and never sends the request", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    stageSsid("HomeNet");
    await expect(applyWifi("supersecret1")).rejects.toMatchObject({
      code: "BRIDGE_AUTH_UNCONFIGURED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("treats a whitespace-only token as unconfigured", async () => {
    process.env.BRIDGE_AUTH_TOKEN = "   ";
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    stageSsid("HomeNet");
    await expect(applyWifi("supersecret1")).rejects.toMatchObject({
      code: "BRIDGE_AUTH_UNCONFIGURED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("honors SERVICE_TOKEN_DISPLAY when BRIDGE_AUTH_TOKEN is unset", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    process.env.SERVICE_TOKEN_DISPLAY = "display-tok";
    const fetchSpy = mockFetchOnce(200, { ok: true });
    stageSsid("HomeNet");
    await applyWifi("supersecret1");
    const [, init] = fetchSpy.mock.calls[0];
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("display-tok");
  });
});

describe("applyWifi — surfaces a bridge refusal", () => {
  it("throws when the bridge returns a non-ok status (e.g. 422 validation)", async () => {
    mockFetchOnce(422, { ok: false, error: "Wi-Fi password must be 8-63 characters" });
    stageSsid("HomeNet");
    await expect(applyWifi("short")).rejects.toThrow(/8-63|password/i);
  });

  it("throws not_hostapd_mode when the bridge says 409 (defense in depth)", async () => {
    mockFetchOnce(409, { ok: false, error: "not_hostapd_mode" });
    stageSsid("HomeNet");
    await expect(applyWifi("supersecret1")).rejects.toThrow(/not_hostapd_mode/i);
  });
});

describe("applyWifi — per-user staging (review #2: no shared global slot)", () => {
  it("isolates concurrent sessions — one user's stage never feeds another's apply", async () => {
    // Two wizard sessions stage different SSIDs at the "same time". Each apply
    // must POST its OWN user's SSID; with the old single global, user-B's stage
    // would clobber user-A's.
    stageSsid("NetA", "user-A");
    stageSsid("NetB", "user-B");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await applyWifi("secretAAAA", "user-A");
    await applyWifi("secretBBBB", "user-B");

    const posts = fetchSpy.mock.calls
      .filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)));
    expect(posts).toEqual([
      { ssid: "NetA", psk: "secretAAAA" },
      { ssid: "NetB", psk: "secretBBBB" },
    ]);
  });

  it("CONSUMES the staged SSID even when the bridge POST throws — no stale reuse", async () => {
    // A first apply staged-then-errors. The staged value must be cleared so a
    // LATER unrelated apply (nothing staged) does NOT silently reuse it; it
    // should fall back to the live AP SSID instead.
    stageSsid("StaleNet", "user-A");

    // First apply: connection refused → throws UNREACHABLE.
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    await expect(applyWifi("firstsecret", "user-A")).rejects.toMatchObject({
      code: "UNREACHABLE",
    });

    // Second apply for the SAME user with nothing newly staged: must NOT reuse
    // "StaleNet" — it has to ask the bridge for the current SSID.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ssid: "LiveNet" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await applyWifi("secondsecret", "user-A");

    const urls = fetchSpy.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.endsWith("/openwrt/qr"))).toBe(true); // fell back
    const postCall = fetchSpy.mock.calls.find(
      (c) => (c[1] as RequestInit | undefined)?.method === "POST",
    );
    const sent = JSON.parse(String((postCall![1] as RequestInit).body));
    expect(sent.ssid).toBe("LiveNet"); // the live SSID, NOT the stale staged one
    expect(sent.ssid).not.toBe("StaleNet");
  });
});

describe("applyWifi — timeout/abort classification (review #6)", () => {
  it.each(["AbortError", "TimeoutError"])(
    "maps a %s to UNREACHABLE (not a generic unknown error)",
    async (errName) => {
      stageSsid("HomeNet");
      vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
        Object.assign(new Error("aborted"), { name: errName }),
      );
      await expect(applyWifi("supersecret1")).rejects.toMatchObject({
        code: "UNREACHABLE",
      });
    },
  );
});

describe("applyWifi — SSID-read failure classification (WARP-836)", () => {
  it.each([401, 403])(
    "maps a %s from the bridge SSID read to AUTH (stale token), not UNREACHABLE",
    async (status) => {
      // Nothing staged → applyWifi reads the current SSID from GET /openwrt/qr.
      // A 401/403 means the bridge IS reachable but rejected our token — that
      // must surface as an auth problem, NOT "device not reachable".
      const fetchSpy = mockFetchOnce(status, { ok: false, error: "unauthorized" });
      await expect(applyWifi("supersecret1")).rejects.toMatchObject({ code: "AUTH" });
      // It must NOT fall through to the POST write.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toMatch(/\/openwrt\/qr$/);
    },
  );

  it("maps a transport failure on the SSID read to UNREACHABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    await expect(applyWifi("supersecret1")).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });

  it("treats a reachable bridge with no SSID in the body as a 422 precondition, NOT UNREACHABLE", async () => {
    // 200 OK but the AP reports no SSID → the bridge IS reachable; the AP just
    // has no network name yet (a password-only apply before any SSID was set).
    // Classifying this UNREACHABLE wrongly fired the wizard's "device not
    // reachable, finish later" notice and pointed triage at the network
    // (pr-reviewer #563 finding). It must surface as an actionable 422, and we
    // still must not POST an empty SSID (hostapd would reject it).
    const fetchSpy = mockFetchOnce(200, { ok: true });
    await expect(applyWifi("supersecret1")).rejects.toMatchObject({
      code: "UNKNOWN",
      status: 422,
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // never reached the POST
  });
});

// ---------------------------------------------------------------------------
// Guest Wi-Fi (single-box second BSS) — POST/DELETE/GET /openwrt/wifi/guest
// ---------------------------------------------------------------------------

describe("applyGuestWifi", () => {
  it("POSTs { ssid, psk } to /openwrt/wifi/guest with the auth header", async () => {
    const fetchSpy = mockFetchOnce(200, { ok: true, enabled: true, ssid: "Visitors" });
    const res = await applyGuestWifi("Visitors", "guestpass1");

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/openwrt/wifi/guest");
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("tok-123");
    expect(JSON.parse(String(init?.body))).toEqual({ ssid: "Visitors", psk: "guestpass1" });
    // No UCI safe-apply/rollback record on the hostapd shape.
    expect(res).toEqual({ operationId: null });
  });

  it("FAILS CLOSED with no bridge token (never sends the request)", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(applyGuestWifi("Visitors", "guestpass1")).rejects.toMatchObject({
      code: "BRIDGE_AUTH_UNCONFIGURED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("surfaces a 422 validation refusal from the host script", async () => {
    mockFetchOnce(422, { ok: false, error: "guest Wi-Fi password must be 8-63 characters" });
    await expect(applyGuestWifi("Visitors", "short")).rejects.toThrow(/8-63|password/i);
  });

  it("surfaces not_hostapd_mode when the bridge says 409 (defense in depth)", async () => {
    mockFetchOnce(409, { ok: false, error: "not_hostapd_mode" });
    await expect(applyGuestWifi("Visitors", "guestpass1")).rejects.toThrow(/not_hostapd_mode/i);
  });

  it("maps a transport failure to UNREACHABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    await expect(applyGuestWifi("Visitors", "guestpass1")).rejects.toMatchObject({
      code: "UNREACHABLE",
    });
  });
});

describe("removeGuestWifi", () => {
  it("DELETEs /openwrt/wifi/guest with the auth header", async () => {
    const fetchSpy = mockFetchOnce(200, { ok: true, enabled: false, removed: true });
    const res = await removeGuestWifi();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/openwrt/wifi/guest");
    expect(init?.method).toBe("DELETE");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("tok-123");
    // DELETE carries no body (no PSK on the wire for a teardown).
    expect(init?.body).toBeUndefined();
    expect(res).toEqual({ operationId: null });
  });

  it("FAILS CLOSED with no bridge token", async () => {
    delete process.env.BRIDGE_AUTH_TOKEN;
    delete process.env.SERVICE_TOKEN_DISPLAY;
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(removeGuestWifi()).rejects.toMatchObject({
      code: "BRIDGE_AUTH_UNCONFIGURED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("guestStatusFromBridge", () => {
  it("GETs /openwrt/wifi/guest and returns the parsed status", async () => {
    const fetchSpy = mockFetchOnce(200, {
      configured: true,
      enabled: true,
      ssid: "Visitors",
      password: "guestpass1",
    });
    const status = await guestStatusFromBridge();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe("http://bridge.test:9090/openwrt/wifi/guest");
    expect(init?.method ?? "GET").toBe("GET");
    expect((init?.headers as Record<string, string>)["X-Droplet-Auth"]).toBe("tok-123");
    expect(status).toEqual({
      configured: true,
      enabled: true,
      ssid: "Visitors",
      password: "guestpass1",
    });
  });

  it("coerces a not-configured body to safe defaults", async () => {
    mockFetchOnce(200, { configured: false, enabled: false, ssid: null, password: null });
    const status = await guestStatusFromBridge();
    expect(status).toEqual({
      configured: false,
      enabled: false,
      ssid: null,
      password: null,
    });
  });

  it.each([401, 403])("maps a %s to AUTH (stale token), not UNREACHABLE", async (status) => {
    mockFetchOnce(status, { error: "unauthorized" });
    await expect(guestStatusFromBridge()).rejects.toMatchObject({ code: "AUTH" });
  });

  it("maps a transport failure to UNREACHABLE", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }),
    );
    await expect(guestStatusFromBridge()).rejects.toMatchObject({ code: "UNREACHABLE" });
  });
});
