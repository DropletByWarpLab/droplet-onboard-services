/**
 * §7 aggregation — auth-not-configured surfacing (PR #709 DECISION 1).
 *
 * When the switch service fails closed (403) because SERVICE_SECRET is unset (or
 * the orchestrator's bearer is missing/wrong), the §7 status must surface a
 * DISTINCT `auth_not_configured: true` flag instead of degrading to the calm
 * "no managed switch" empty state — which is what a genuinely-absent switch
 * (503, swallowed by safe()) produces. The dashboard can then show a "Switch
 * auth not configured" banner rather than hiding a misconfigured deploy.
 *
 * No live switch — switchClient is mocked at the boundary.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { SwitchAuthError } from "../types/switch-error.js";

vi.mock("../services/switch.client.js", () => ({
  healthCheck: vi.fn(),
  fetchProvisionConfig: vi.fn(),
  fetchSystemInfo: vi.fn(),
  fetchPoeStatus: vi.fn(),
  fetchPorts: vi.fn(),
  fetchPortStatus: vi.fn(),
  fetchVlans: vi.fn(),
}));

import * as switchClient from "../services/switch.client.js";
import {
  fetchSwitchStatus,
  fetchSwitchPorts,
  fetchSwitchVlans,
} from "../services/switch-aggregation.service.js";

const authError = () => new SwitchAuthError("Switch ports: 403", { status: 403, label: "Switch ports" });

const goodConfig = {
  vlan_profile: "flat-lan",
  auto_managed: false,
  protected_port: 9,
  camera_ports: [],
  ap_ports: [],
  client_ports: [],
  poe_budget_w: 130,
  last_provisioned_at: null,
};

describe("§7 aggregation — auth-not-configured surfacing", () => {
  beforeEach(() => {
    vi.mocked(switchClient.healthCheck).mockResolvedValue(false);
    vi.mocked(switchClient.fetchProvisionConfig).mockResolvedValue(goodConfig as any);
    vi.mocked(switchClient.fetchSystemInfo).mockResolvedValue(null as any);
    vi.mocked(switchClient.fetchPoeStatus).mockResolvedValue([] as any);
    vi.mocked(switchClient.fetchPorts).mockResolvedValue([] as any);
    vi.mocked(switchClient.fetchPortStatus).mockResolvedValue([] as any);
    vi.mocked(switchClient.fetchVlans).mockResolvedValue([] as any);
  });

  it("status: auth_not_configured=true when a read 403s, NOT a 500", async () => {
    vi.mocked(switchClient.fetchProvisionConfig).mockRejectedValue(authError());
    const status = await fetchSwitchStatus();
    expect(status.auth_not_configured).toBe(true);
    expect(status.connected).toBe(false);
  });

  it("status: auth_not_configured set when /poe 403s (not just provision-config)", async () => {
    vi.mocked(switchClient.fetchPoeStatus).mockRejectedValue(authError());
    const status = await fetchSwitchStatus();
    expect(status.auth_not_configured).toBe(true);
  });

  it("status: auth_not_configured falsy on the happy path", async () => {
    vi.mocked(switchClient.healthCheck).mockResolvedValue(true);
    const status = await fetchSwitchStatus();
    expect(status.auth_not_configured).toBeFalsy();
    expect(status.connected).toBe(true);
  });

  it("status: a 503 (absent hardware) does NOT set auth_not_configured", async () => {
    vi.mocked(switchClient.fetchPoeStatus).mockRejectedValue(new Error("Switch PoE: 503"));
    const status = await fetchSwitchStatus();
    expect(status.auth_not_configured).toBeFalsy();
    expect(status.connected).toBe(false);
  });

  it("ports: still degrades to [] on a 403 (no 500), aggregation tolerant", async () => {
    vi.mocked(switchClient.fetchPorts).mockRejectedValue(authError());
    await expect(fetchSwitchPorts()).resolves.toEqual([]);
  });

  it("vlans: still degrades to [] on a 403 (no 500)", async () => {
    vi.mocked(switchClient.fetchVlans).mockRejectedValue(authError());
    vi.mocked(switchClient.fetchProvisionConfig).mockRejectedValue(authError());
    await expect(fetchSwitchVlans()).resolves.toEqual([]);
  });
});
