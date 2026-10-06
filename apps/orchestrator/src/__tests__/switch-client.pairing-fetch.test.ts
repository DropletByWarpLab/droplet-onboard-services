/**
 * switch.client.ts `switchServiceFetch` — the fetch the shared device-pairing
 * service uses against the switch service (ADR-071 slice C).
 *
 * Unlike the `throwIfNotOk` readers, a refusal must come back as a Response: the
 * typed reason (`SWITCH_PAIRED_ELSEWHERE`, `PAIR_WINDOW_CLOSED`) is in the body.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    SWITCH_SERVICE_URL: "http://switch.test:8081",
    SERVICE_TOKEN_SWITCH: "dedicated-token",
    SERVICE_SECRET: "",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  },
}));
vi.mock("../config.js", () => ({ config: mockConfig }));

import { switchServiceFetch } from "../services/switch.client.js";

describe("switchServiceFetch", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("sends the service bearer, the method and the body to the switch service", async () => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const res = await switchServiceFetch("/pairing/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ box_fingerprint: "ab".repeat(32) }),
    });
    expect(res.status).toBe(200);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://switch.test:8081/pairing/claim");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ box_fingerprint: "ab".repeat(32) }));
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer dedicated-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("defaults to GET", async () => {
    fetchSpy.mockResolvedValue(new Response("{}", { status: 200 }));
    await switchServiceFetch("/health");
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("GET");
  });

  it.each([400, 403, 404, 409, 502, 503])("hands a %i back as a Response instead of throwing", async (status) => {
    fetchSpy.mockResolvedValue(new Response(JSON.stringify({ code: "PAIR_WINDOW_CLOSED" }), { status }));
    const res = await switchServiceFetch("/pairing/claim", { method: "POST", body: "{}" });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ code: "PAIR_WINDOW_CLOSED" });
  });

  it("a transport failure still throws (the service maps it to 'service unavailable')", async () => {
    fetchSpy.mockRejectedValue(new TypeError("fetch failed"));
    await expect(switchServiceFetch("/health")).rejects.toThrow();
  });
});
