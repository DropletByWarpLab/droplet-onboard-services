/**
 * WARP-2472 — the ownership drift gate.
 *
 * `confirmationOwner: "route"` is a claim about a file in a DIFFERENT
 * package: "the orchestrator route this tool calls already confirms this
 * operation itself". Nothing in `packages/tools-core` can check that, and
 * nothing in `apps/orchestrator` knows which tool calls which route. The
 * claim can therefore rot from either end:
 *
 *   - a tier changes here (an operation joins or leaves Tier 2/3) and the
 *     tool descriptor keeps yesterday's answer, or
 *   - a new pass-through tool ships without declaring anything and
 *     silently inherits `"interceptor"` against a route that also gates.
 *
 * Either way the user is asked twice, and the second ask carries the
 * route's dashboard-only token — the WARP-2472 defect, which shipped and
 * reached chat. So the three inputs are all read AT RUNTIME:
 *
 *   1. `requiresConfirmation` — off the live registry, never a name list.
 *   2. `passThroughConfirmation` — off `handler.toString()`, i.e. the
 *      COMPILED call site, so a handler that only mentions the helper in
 *      a comment (`apply_update`) is correctly excluded.
 *   3. the safety tier — through `classifyNetworkCommand`, the same
 *      function the routes call, so `TIER_2_OPERATIONS` is consulted and
 *      never restated.
 *
 * The only declared thing is the tool → operation link, which no runtime
 * value carries (the operation literal lives inside the route handler,
 * behind a path the tool assembles at call time). It is kept honest by
 * two guards: the map must cover EXACTLY the runtime pass-through set,
 * and every operation it names must actually appear in the route sources.
 *
 * Mutations this file is written to catch:
 *   - add a Tier-2 route to a tool that has not declared `"route"`
 *     (e.g. add `set_ssid` to `TIER_2_OPERATIONS`) → red
 *   - remove `confirmationOwner: "route"` from any class-(a) tool → red
 *   - add `"route"` to a tool whose route never 202s → red
 *   - add a 16th pass-through tool without classifying it → red
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, confirmationOwnerOf } from "@droplet/tools-core";
import type { Tool } from "@droplet/tools-core";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS,
// where tsc rejects import.meta outright (TS1470). Same resolution
// confirm-dispatcher-coverage.guard.test.ts uses.
const ROUTES_DIR = join(__dirname, "..", "routes");

/** INPUT 1 — derived from the flag, on the live registry. */
const CONFIRMING: Tool[] = [...TOOLS.values()].filter((t) => t.requiresConfirmation === true);

/**
 * INPUT 2 — derived from the shipped handler's own compiled body. A tool
 * that relays a `202` is one that calls this helper; there is no more
 * authoritative source for "does this tool defer to a route's gate".
 */
const PASS_THROUGH: Tool[] = CONFIRMING.filter((t) =>
  t.handler.toString().includes("passThroughConfirmation"),
);

/**
 * The tool → safety-operation link.
 *
 * DECLARED, because it is the one fact no runtime value carries: the
 * operation literal is chosen inside the route handler, and the tool only
 * knows a URL path it may assemble from arguments. An empty array means
 * "this tool's route(s) call no safety evaluator at all" — the class-(c)
 * tools, where the interceptor is the only gate there has ever been.
 *
 * Two guards below stop this map becoming the stale list it looks like.
 */
const SAFETY_OPERATIONS: Record<string, readonly string[]> = {
  // ── routes that evaluate a safety operation ──────────────────────────
  add_port_forward: ["add_port_forward"],
  block_network_device: ["block_device"],
  unblock_network_device: ["unblock_device"],
  set_wifi_password: ["set_wifi_password"],
  restart_router: ["reboot"],
  set_port_vlan: ["switch_set_vlan_membership"],
  set_port_poe: ["switch_poe_enable", "switch_poe_disable"],
  setup_camera_ports: ["switch_setup_cameras"],
  share_clip: ["share_clip"],
  detect_wan_port: ["switch_wan_detect"],

  // ── routes with no safety evaluator on the path these tools take ─────
  // `set_ssid` / `set_channel` ARE evaluated, but deliberately as Tier 1
  // (network-safety-rules.ts:21-27, the setup-wizard contract), so no 202
  // is ever emitted and the route cannot own the confirmation. Listed with
  // their operations rather than as `[]` so the tier stays the thing that
  // decides, exactly as DYNAMIC_MINT_SITES does in the sibling guard.
  set_wifi_ssid: ["set_ssid"],
  set_wifi_channel: ["set_channel"],
  // aps.ts:173/213 never call the evaluator.
  approve_ap: [],
  decommission_ap: [],
  // network-phone-home.routes.ts says so in its own header: "No Tier-2
  // confirmation token: the settings write is the user's confirmation."
  set_phone_home_blocking: [],
};

/** Every orchestrator route source, concatenated, read at runtime. */
function routeSources(): string {
  return readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => readFileSync(join(ROUTES_DIR, f), "utf8"))
    .join("\n");
}

/** INPUT 3 — the live tier, via the function the routes themselves call. */
function routeConfirmsFor(tool: Tool): boolean {
  return (SAFETY_OPERATIONS[tool.name] ?? []).some(
    (op) => classifyNetworkCommand(op).requiresConfirmation,
  );
}

describe("WARP-2472 — confirmationOwner cannot drift from the safety tier", () => {
  it("finds the pass-through roster at runtime, and it is not empty", () => {
    // A floor rather than an equality on CONFIRMING, so a 37th confirming
    // tool is covered automatically — but silently DROPPING the flag to
    // make something pass still fails here.
    //
    // Re-baselined 38 → 36 by ADR-045 slice D, which is the first change to
    // move this floor DOWNWARD. Seven confirming tools collapsed into three
    // (40 − 7 + 3 = 36); the capability is unchanged and every one of the
    // three replacements still declares the flag. `PASS_THROUGH` is the half
    // of this assertion that carries the WARP-2472 guarantee, and it does
    // not move: none of the ten tools involved relays a route's 202.
    expect(CONFIRMING.length).toBeGreaterThanOrEqual(36);
    expect(PASS_THROUGH.length).toBe(15);
  });

  it("classifies EXACTLY the runtime pass-through set — no more, no less", () => {
    // The map's completeness guard. A 16th pass-through tool goes red here
    // until someone says which operations its route evaluates, which is the
    // moment the ownership question has to be answered.
    expect(Object.keys(SAFETY_OPERATIONS).sort()).toEqual(
      PASS_THROUGH.map((t) => t.name).sort(),
    );
  });

  it("names only operations that really appear in the route sources", () => {
    // The map's correctness guard. A renamed or mistyped operation would
    // otherwise fall through `classifyNetworkCommand` as Tier 1 and quietly
    // turn a route-owned tool into an interceptor-owned one.
    const sources = routeSources();
    const missing = Object.values(SAFETY_OPERATIONS)
      .flat()
      .filter((op) => !sources.includes(`"${op}"`));
    expect(missing).toEqual([]);
  });

  it("declares the owner the safety tier implies, for every pass-through tool", () => {
    // THE GATE. Expected owner is computed, never asserted from a list.
    const wrong: string[] = [];
    for (const tool of PASS_THROUGH) {
      const expected = routeConfirmsFor(tool) ? "route" : "interceptor";
      const actual = confirmationOwnerOf(tool);
      if (actual !== expected) {
        wrong.push(
          `${tool.name}: declares "${actual}", but its route ` +
            `${expected === "route" ? "DOES" : "does NOT"} confirm the operation`,
        );
      }
    }
    expect(wrong, `confirmationOwner drift:\n${wrong.join("\n")}`).toEqual([]);
  });

  it("splits the pass-through roster into both classes, so the gate is not vacuous", () => {
    // If every pass-through tool landed on one side, the assertion above
    // would pass without testing anything. 10 route-owned, 5 not.
    const routeOwned = PASS_THROUGH.filter(routeConfirmsFor);
    expect(routeOwned).toHaveLength(10);
    expect(PASS_THROUGH.length - routeOwned.length).toBe(5);
  });

  it("lets no tool claim `route` unless it relays a route's confirmation", () => {
    // The other direction: `"route"` means "some route already asks". A
    // tool that never relays a 202 declaring it would be delegating its
    // gate to nothing at all.
    const passThroughNames = new Set(PASS_THROUGH.map((t) => t.name));
    const bogus = [...TOOLS.values()]
      .filter((t) => confirmationOwnerOf(t) === "route" && !passThroughNames.has(t.name))
      .map((t) => t.name);
    expect(bogus).toEqual([]);
  });
});
