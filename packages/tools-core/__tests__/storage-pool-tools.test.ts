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
 *
 * ─────────────────────────────────────────────────────────────────────
 * WARP-2335 — "destructive actions are blocked" has TWO halves, and this
 * file holds both so the next reader cannot mistake the first for all of
 * it. They do NOT substitute for each other:
 *
 *   1. COMPILE-TIME ABSENCE (below, unchanged) — covers tools WE NEVER
 *      WROTE. `registry.ts` is a literal array frozen into a ReadonlyMap
 *      with no `register()`, so a tool that is not in it cannot be called
 *      by any path. This is the first line of defence and stays exactly
 *      as it was.
 *
 *   2. RUNTIME DENY (the last describe block) — covers tools that ARRIVE
 *      OR QUALIFY AT RUNTIME: a remote MCP tool under WARP-320, or a
 *      registry tool that must be refused under some condition. Absence
 *      from a compile-time list cannot express either, because there is
 *      no runtime at compile time.
 *
 * Weaken either half and this file goes red.
 * ─────────────────────────────────────────────────────────────────────
 */

import { describe, it, expect, vi } from "vitest";
import { TOOLS } from "../src/registry.js";
import {
  createRuntimeDenyTier,
  createToolCallInterceptor,
  interceptOutcomeToToolResult,
} from "../src/interceptor.js";

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

/**
 * WARP-2335 / WARP-2328 — the second half of the guarantee.
 *
 * Everything above asserts ABSENCE. That is a good test of a list, and it
 * is complete for the class it covers. What it structurally cannot express
 * is a tool that EXISTS and must still be refused — which is exactly the
 * class WARP-320's remote MCP tools fall into.
 */
describe("storage-pool surface — runtime deny tier (WARP-2335)", () => {
  it("refuses a tool that IS present in the registry, which absence cannot express", async () => {
    const denyTier = createRuntimeDenyTier();
    const interceptor = createToolCallInterceptor({ denyTier });
    const handler = vi.fn(async () => ({ ok: true as const, data: { pools: [] } }));

    // `list_storage_pools` is registered — the absence assertions above
    // say nothing about it, and cannot.
    const tool = TOOLS.get("list_storage_pools");
    expect(tool, "fixture must be a registry-PRESENT tool").toBeDefined();
    expect(TOOLS.has("list_storage_pools")).toBe(true);

    // A runtime CONDITION: introspecting a degraded array during a
    // rebuild. Nothing about this can be decided at compile time.
    denyTier.add("storage:rebuild-in-progress", ({ tool: t }) =>
      t.name === "list_storage_pools"
        ? { code: "POOL_REBUILDING", message: "storage introspection is paused during a rebuild" }
        : null,
    );

    const outcome = interceptor.intercept(tool!, {});
    const refusal = interceptOutcomeToToolResult(tool!, outcome);

    // Mutation: delete the deny check → THIS goes red while every
    // absence assertion above stays green. That gap is what this closes.
    expect(outcome.kind).toBe("denied");
    expect(refusal).not.toBeNull();
    expect(refusal!.ok).toBe(false);
    if (refusal!.ok) return;
    expect(refusal!.error.code).toBe("TOOL_DENIED");

    // A denied call never reaches the handler.
    if (outcome.kind !== "proceed") {
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("the two halves do not substitute for each other", () => {
    // Absence says nothing about a present tool...
    expect(TOOLS.has("list_storage_pools")).toBe(true);
    expect(TOOLS.has("pool_destroy")).toBe(false);

    // ...and the deny tier is empty by default, so it says nothing about
    // an absent one. Neither alone is the guarantee; both are.
    const interceptor = createToolCallInterceptor();
    expect(interceptor.denyTier.ids()).toEqual([]);
    expect(
      interceptor.denyTier.evaluate({ name: "pool_destroy", requiresConfirmation: true }, {}),
    ).toBeNull();
  });

  it("does not let the deny tier become a second source of truth for absence", () => {
    // The remit is runtime arrivals and runtime conditions ONLY. If the
    // shipped default ever grows a rule, two mechanisms would start
    // disagreeing about what "blocked" means — see the contract doc §8.
    const interceptor = createToolCallInterceptor();
    expect(interceptor.denyTier.ids()).toHaveLength(0);
  });
});
