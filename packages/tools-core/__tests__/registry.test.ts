import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/index.js";

describe("TOOLS registry", () => {
  it("exposes the 5 vertical-slice tools by name", () => {
    expect(Array.from(TOOLS.keys()).sort()).toEqual([
      "block_network_device",
      "get_network_status",
      "list_files",
      "list_network_devices",
      "list_smart_home_devices",
    ]);
  });

  it("flags write+confirmation correctly per tool", () => {
    expect(TOOLS.get("block_network_device")?.requiresWrite).toBe(true);
    expect(TOOLS.get("block_network_device")?.requiresConfirmation).toBe(true);
    expect(TOOLS.get("list_files")?.requiresWrite).toBe(false);
  });
});
