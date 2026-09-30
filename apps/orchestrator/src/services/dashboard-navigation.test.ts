import { describe, it, expect } from "vitest";
import { TOOLS } from "@droplet/tools-core";
import {
  DASHBOARD_NAVIGATION_TOOLS,
  navigationToolsWithheld,
} from "./dashboard-navigation.js";

describe("navigationToolsWithheld (WARP-3116)", () => {
  it("names tools that exist in the registry", () => {
    // A rename in tools-core must not leave this set withholding nothing.
    for (const name of DASHBOARD_NAVIGATION_TOOLS) {
      expect(TOOLS.has(name), name).toBe(true);
    }
  });

  it("withholds both navigation tools from a turn with no page list", () => {
    expect([...navigationToolsWithheld(false)].sort()).toEqual([
      "find_dashboard_page",
      "open_dashboard_page",
    ]);
  });

  it("withholds nothing from a dashboard turn", () => {
    expect(navigationToolsWithheld(true).size).toBe(0);
  });
});
