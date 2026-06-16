/**
 * switch.client.ts service-to-service auth header.
 *
 * The switch service 403s every authenticated endpoint unless the
 * orchestrator presents the bearer its SERVICE_SECRET is wired to.
 * Compose wires both ends to ${SERVICE_TOKEN_SWITCH}; SERVICE_SECRET
 * remains the legacy shared-secret fallback for installs whose .env
 * predates the dedicated token. These tests pin the header derivation —
 * the bug this fixes was the orchestrator sending no bearer at all
 * (dashboard Network page → "Router unavailable").
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    SWITCH_SERVICE_URL: "http://switch.test:8081",
    SERVICE_TOKEN_SWITCH: "",
    SERVICE_SECRET: "",
  },
}));
vi.mock("../config.js", () => ({ config: mockConfig }));

import { fetchPorts } from "../services/switch.client.js";

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("switch.client authHeaders", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValue(okJson({ ports: [] }));
    vi.stubGlobal("fetch", fetchSpy);
    mockConfig.SERVICE_TOKEN_SWITCH = "";
    mockConfig.SERVICE_SECRET = "";
  });

  function sentAuthHeader(): string | undefined {
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    return (init?.headers as Record<string, string> | undefined)?.[
      "Authorization"
    ];
  }

  it("sends the dedicated SERVICE_TOKEN_SWITCH bearer when set", async () => {
    mockConfig.SERVICE_TOKEN_SWITCH = "dedicated-token";
    await fetchPorts();
    expect(sentAuthHeader()).toBe("Bearer dedicated-token");
  });

  it("falls back to the legacy SERVICE_SECRET when no dedicated token", async () => {
    mockConfig.SERVICE_SECRET = "legacy-shared";
    await fetchPorts();
    expect(sentAuthHeader()).toBe("Bearer legacy-shared");
  });

  it("prefers the dedicated token when both are set", async () => {
    mockConfig.SERVICE_TOKEN_SWITCH = "dedicated-token";
    mockConfig.SERVICE_SECRET = "legacy-shared";
    await fetchPorts();
    expect(sentAuthHeader()).toBe("Bearer dedicated-token");
  });

  it("sends no Authorization header when neither is configured", async () => {
    await fetchPorts();
    expect(sentAuthHeader()).toBeUndefined();
  });
});
