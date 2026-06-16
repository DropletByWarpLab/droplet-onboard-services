/**
 * BUG-3 / ADR-019: tools-core storage-pool surface.
 *
 * The one read-only tool (`list_storage_pools`) is safe for the AI — reading
 * array health answers "is my storage healthy?". It MUST be read-only
 * (requiresWrite=false, requiresConfirmation=false).
 *
 * The DESTRUCTIVE storage ops (create/destroy/format/set-level/add-spare/
 * remove-disk) must NOT be in the registry at all — exactly as factory_reset /
 * reboot are absent. This test is the AI-block proof: if anyone ever registers
 * a destructive storage tool, this fails before it can reach an LLM.
 */

import { describe, it, expect } from "vitest";
import { TOOLS } from "../src/registry.js";

describe("storage pool tools-core surface (ADR-019 D5)", () => {
  it("registers a read-only list_storage_pools tool", () => {
    const tool = TOOLS.get("list_storage_pools");
    expect(tool, "list_storage_pools must be registered").toBeDefined();
    expect(tool!.requiresWrite).toBe(false);
    expect(tool!.requiresConfirmation).toBe(false);
  });

  it("does NOT register ANY destructive storage operation (AI-blocked entirely)", () => {
    const forbidden = [
      "pool_create",
      "pool_destroy",
      "pool_format",
      "pool_set_level",
      "pool_add_spare",
      "pool_remove_disk",
      // also the dashboard-route service names, in case someone maps them 1:1
      "storage_pool_create",
      "storage_pool_destroy",
      "create_storage_pool",
      "destroy_storage_pool",
      "format_storage_pool",
    ];
    for (const name of forbidden) {
      expect(TOOLS.has(name), `${name} must NEVER be an AI tool`).toBe(false);
    }
  });

  it("has no registered storage tool that is a write/confirm op", () => {
    // Defensive: scan the whole registry for any tool whose name mentions a
    // pool/raid/format destructive verb AND is a write op. There should be
    // none — the only storage-pool tool is the read-only list.
    const destructiveVerb = /(create|destroy|format|wipe|delete|remove|grow|set[_-]?level)/i;
    const poolish = /(pool|raid|mdadm|array)/i;
    for (const [name, tool] of TOOLS) {
      if (poolish.test(name) && destructiveVerb.test(name)) {
        expect.fail(`destructive storage tool '${name}' must not be registered`);
      }
      if (poolish.test(name) && tool.requiresWrite) {
        expect.fail(`storage-pool tool '${name}' is a write op — must not be AI-callable`);
      }
    }
  });
});
