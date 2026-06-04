/**
 * §7 aggregation orchestration — disconnected-switch tolerance (PR #494 review).
 *
 * The switch service raises 503 (an HTTPException, NOT a SwitchError) on the
 * hardware reads (/poe, /ports, /port_status, /vlans, /system/info) when no
 * switch is attached. The §7 reads must still answer so the dashboard shows its
 * calm "no managed switch" empty state, never an error card / 500:
 *   - GET /api/switch/status → connected:false (from health + provision-config)
 *   - GET /api/switch/ports  → []
 *   - GET /api/switch/vlans  → []
 *
 * Mocks switchClient with rejecting hardware reads + a disconnect-safe
 * health(false)/provision-config, and exercises the REAL fetchSwitch*
 * orchestration (the routes test mocks the aggregation away, so this is the
 * only place the safe()-wrapper glue is covered). No live switch.
 */
import { describe, it, expect, vi } from "vitest";

// All values are defined INSIDE the factory — vi.mock is hoisted above the
// module's top-level consts, so referencing an outer const here throws
// "Cannot access before initialization".
vi.mock("../services/switch.client.js", () => {
  const reject503 = () => vi.fn().mockRejectedValue(new Error("Switch unavailable: 503"));
  return {
    // Disconnect-safe by design — these resolve.
    healthCheck: vi.fn().mockResolvedValue(false),
    fetchProvisionConfig: vi.fn().mockResolvedValue({
      vlan_profile: "flat-lan",
      auto_managed: false,
      protected_port: 9,
      camera_ports: [],
      ap_ports: [],
      client_ports: [],
      poe_budget_w: 130,
      last_provisioned_at: null,
    }),
    // Hardware reads raise 503 on a disconnected driver.
    fetchSystemInfo: reject503(),
    fetchPoeStatus: reject503(),
    fetchPorts: reject503(),
    fetchPortStatus: reject503(),
    fetchVlans: reject503(),
  };
});

import {
  fetchSwitchStatus,
  fetchSwitchPorts,
  fetchSwitchVlans,
} from "../services/switch-aggregation.service.js";

describe("§7 aggregation — disconnected switch tolerance", () => {
  it("fetchSwitchStatus resolves connected:false (not 500) when /poe + /system raise 503", async () => {
    const status = await fetchSwitchStatus();
    expect(status.connected).toBe(false);
    expect(status.poe_used_w).toBe(0);
    expect(status.poe_ports_active).toBe(0);
  });

  it("fetchSwitchPorts resolves [] when the hardware reads raise 503", async () => {
    await expect(fetchSwitchPorts()).resolves.toEqual([]);
  });

  it("fetchSwitchVlans resolves [] when /vlans raises 503", async () => {
    await expect(fetchSwitchVlans()).resolves.toEqual([]);
  });
});
