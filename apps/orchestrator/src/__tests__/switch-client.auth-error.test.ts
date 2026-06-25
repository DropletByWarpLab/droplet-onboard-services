/**
 * switch.client.ts — 403 → SwitchAuthError propagation (PR #709 DECISION 1/3).
 *
 * The switch service returns 403 on every non-/health route when its
 * SERVICE_SECRET is unset (fail-closed) or the orchestrator's bearer is
 * missing/wrong. The client must surface that as a DISTINCT typed error
 * (SwitchAuthError), not the generic `Error` it throws for other non-ok
 * statuses — otherwise the §7 aggregation's safe() wrapper swallows it exactly
 * like the 503 a genuinely-absent switch raises, hiding a misconfigured deploy
 * as "no switch present".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    SWITCH_SERVICE_URL: "http://switch.test:8081",
    SERVICE_TOKEN_SWITCH: "tok",
    SERVICE_SECRET: "",
  },
}));
vi.mock("../config.js", () => ({ config: mockConfig }));

import {
  fetchPorts,
  fetchPortStatus,
  fetchPoeStatus,
  fetchVlans,
  fetchSystemInfo,
  fetchProvisionConfig,
} from "../services/switch.client.js";
import { SwitchAuthError } from "../types/switch-error.js";

function resp(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("switch.client 403 → SwitchAuthError", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  const reads: [string, () => Promise<unknown>][] = [
    ["fetchPorts", fetchPorts],
    ["fetchPortStatus", fetchPortStatus],
    ["fetchPoeStatus", fetchPoeStatus],
    ["fetchVlans", fetchVlans],
    ["fetchSystemInfo", fetchSystemInfo],
    ["fetchProvisionConfig", fetchProvisionConfig],
  ];

  for (const [name, fn] of reads) {
    it(`${name} throws SwitchAuthError on 403`, async () => {
      fetchSpy.mockResolvedValue(resp(403, { error: "auth not configured" }));
      await expect(fn()).rejects.toBeInstanceOf(SwitchAuthError);
    });
  }

  it("503 (absent hardware) stays a generic Error, NOT SwitchAuthError", async () => {
    fetchSpy.mockResolvedValue(resp(503, { detail: "Switch not connected" }));
    const err = await fetchPoeStatus().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SwitchAuthError);
  });

  it("carries the call label on the error", async () => {
    fetchSpy.mockResolvedValue(resp(403));
    const err = (await fetchPorts().catch((e) => e)) as SwitchAuthError;
    expect(err).toBeInstanceOf(SwitchAuthError);
    expect(err.status).toBe(403);
    expect(err.label).toBe("Switch ports");
  });
});
