/**
 * Unit tests for the display-client `pushClaimCode` helper (WARP-632 / ADR-017).
 *
 * `pushClaimCode(code, setupUrl)` posts the claim screen to the display
 * service's NEW `POST /display/claim` endpoint (NOT the preview-only
 * `/display/custom` image path). It mirrors the other display.client helpers:
 *   - JSON body `{ code, setup_url }`;
 *   - `Authorization: Bearer <SERVICE_TOKEN_DISPLAY>` when the secret is set;
 *   - a bounded timeout so a stalled display service can't pin the event loop;
 *   - returns true on 2xx, false on any non-2xx or thrown error (never throws).
 *
 * Only `pushClaimCode` is under test here — the pre-existing helpers are
 * exercised elsewhere / on the device and are out of scope for this ticket.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// display.client.ts reads SERVICE_TOKEN_DISPLAY at MODULE-LOAD time, so the
// bearer secret must be in the env BEFORE the import below is evaluated. ESM
// import statements are hoisted above top-level code; `vi.hoisted` runs even
// earlier, so this seeds the env in time for the static import to capture it.
vi.hoisted(() => {
  process.env.SERVICE_TOKEN_DISPLAY = "display-secret";
});

import { pushClaimCode } from "./display.client.js";

describe("pushClaimCode (WARP-632)", () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("POSTs to /display/claim with the code + setup_url as JSON", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) =>
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const ok = await pushClaimCode("DRPL-7K2Q-9F4M", "https://192.168.1.87/setup");

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toMatch(/\/display\/claim$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    // Backward-compatible (WARP-819): omitting the optional `wifi` arg must
    // still produce EXACTLY the original claim-only payload — no empty/null
    // wifi_* keys leaking onto the wire for older render paths.
    expect(body).toEqual({ code: "DRPL-7K2Q-9F4M", setup_url: "https://192.168.1.87/setup" });
  });

  it("includes wifi_qr_matrix / wifi_ssid / wifi_psk when a wifi arg is supplied (WARP-819)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const matrix = [
      [1, 0, 1],
      [0, 1, 0],
      [1, 0, 1],
    ];
    const ok = await pushClaimCode("DRPL-7K2Q-9F4M", "https://192.168.1.87/setup", {
      matrix,
      ssid: "Droplet",
      psk: "7gpz4k9m2njq8wxr",
    });

    expect(ok).toBe(true);
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      code: "DRPL-7K2Q-9F4M",
      setup_url: "https://192.168.1.87/setup",
      wifi_qr_matrix: matrix,
      wifi_ssid: "Droplet",
      wifi_psk: "7gpz4k9m2njq8wxr",
    });
  });

  it("omits wifi_* keys entirely when the wifi arg is undefined (graceful degradation)", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await pushClaimCode("DRPL-7K2Q-9F4M", "https://host/setup", undefined);

    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse(init.body as string);
    expect(body).not.toHaveProperty("wifi_qr_matrix");
    expect(body).not.toHaveProperty("wifi_ssid");
    expect(body).not.toHaveProperty("wifi_psk");
  });

  it("sends the SERVICE_TOKEN_DISPLAY bearer token", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await pushClaimCode("DRPL-7K2Q-9F4M", "https://host/setup");

    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer display-secret");
  });

  it("passes an abort signal so a stalled display service can't pin the event loop", async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init: RequestInit) => new Response("{}", { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await pushClaimCode("DRPL-7K2Q-9F4M", "https://host/setup");

    const [, init] = fetchMock.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns false on a non-2xx response", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("unauthorized", { status: 401 }),
    ) as unknown as typeof fetch;

    const ok = await pushClaimCode("DRPL-7K2Q-9F4M", "https://host/setup");
    expect(ok).toBe(false);
  });

  it("returns false (never throws) when fetch rejects", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const ok = await pushClaimCode("DRPL-7K2Q-9F4M", "https://host/setup");
    expect(ok).toBe(false);
  });
});
