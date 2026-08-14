/**
 * WARP-2002 — registry-level invariant: `requiresConfirmation: true` may never
 * again be enforced by a boolean the MODEL sets.
 *
 * This is the guard that stops a twelfth tool reintroducing the pattern. It
 * runs over the canonical `TOOLS` registry rather than a hand-kept list, so a
 * newly registered tool is covered the moment it lands.
 *
 * Two shapes are legitimate for a Tier-2 tool:
 *
 *   1. **Token-gated** (what WARP-2002 converts everything to): the handler
 *      calls `consumeToolConfirmation`, and its schema exposes
 *      `confirmation_token`, never `confirmed`.
 *   2. **Route-gated**: the handler forwards an orchestrator `202` through
 *      `passThroughConfirmation`, so the real gate lives server-side on the
 *      route. These still accept a `confirmed` flag, but it is not the only
 *      thing standing between the model and the side effect.
 *
 * Anything else is self-attestation. The allowlists below are deliberately
 * split so that route-gated tools and KNOWN DEBT cannot be confused for each
 * other — an allowlist that lumps them together would quietly bless the bug.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { TOOLS } from "../src/registry.js";

const HANDLERS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../src/handlers");

/**
 * Tools whose confirmation is genuinely enforced by an orchestrator route
 * returning 202, surfaced via `passThroughConfirmation`. Membership is VERIFIED
 * below against the handler source — this list cannot silently go stale.
 */
const ROUTE_GATED = new Set([
  "set_wifi_ssid",
  "set_wifi_password",
  "set_wifi_channel",
]);

/**
 * Known debt, tracked, NOT blessed. `set_camera_detection`'s route-level Tier-2
 * handshake is `disable`-only (see the handler's own header), so its
 * `enabled: true` path has no server-side gate and the model can still
 * self-approve it. It is less severe than the eleven WARP-2002 converts —
 * re-enabling recording is not destructive — but it is the same defect class.
 *
 * This set must only ever shrink. Adding to it requires a filed ticket.
 */
const SELF_ATTESTING_DEBT = new Set(["set_camera_detection"]);

/** Source text of the handler that backs a tool, located by its schema shape. */
function handlerSourceFor(name: string): string | null {
  // The registry does not record file paths, so find the handler by searching
  // the tree for the file that registers this exact tool name.
  const candidates = globSync(HANDLERS_DIR);
  for (const file of candidates) {
    const src = readFileSync(file, "utf8");
    if (new RegExp(`name:\\s*"${name}"`).test(src)) return src;
  }
  return null;
}

/** Minimal recursive .ts walk — no dependency needed for one directory tree. */
function globSync(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...globSync(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Tool-layer gate: a server-minted token consumed before the side effect. */
function hasTokenGate(src: string): boolean {
  // The CALL, not the identifier — a bare `includes("consumeToolConfirmation")`
  // is satisfied by the import statement alone. (Caught by mutation.)
  return src.includes("consumeToolConfirmation(");
}

/**
 * Route-layer gate: something downstream refuses, and the handler surfaces the
 * refusal. Three shapes ship today:
 *
 *   - `passThroughConfirmation(res)` — the wifi and network tools, on a 202.
 *   - an explicit 202 branch re-wrapping the route's token (`run_scene`).
 *   - the Matter service itself answering `status: "confirmation_required"`,
 *     which `control_device` passes through (it also hard-refuses lock-like
 *     commands outright).
 */
function hasRouteGate(src: string): boolean {
  if (src.includes("passThroughConfirmation(")) return true;
  if (src.includes("202") && src.includes("confirmationRequired(")) return true;
  return src.includes('"confirmation_required"') && src.includes("confirmationRequired(");
}

/**
 * Declared Tier-2 but with no live side effect to gate. `erp_schedule_appointment`
 * returns `erpNotConnected()` unconditionally — there is nothing to confirm
 * until the ERP write path is built, and WARP-2008 excludes it explicitly:
 * it must be gated as part of whichever change makes it live (WARP-1095+).
 *
 * Verified below to still have no side effect, so it cannot quietly go live
 * while sitting on this list.
 */
const NO_SIDE_EFFECT = new Set(["erp_schedule_appointment"]);

function isGated(src: string): boolean {
  return hasTokenGate(src) || hasRouteGate(src);
}

function confirmationTools() {
  return [...TOOLS.values()].filter((t) => t.requiresConfirmation === true);
}

function schemaProps(tool: { inputSchema: unknown }): Record<string, unknown> {
  const schema = tool.inputSchema as { properties?: Record<string, unknown> };
  return schema.properties ?? {};
}

describe("confirmation contract", () => {
  it("the registry actually has Tier-2 tools to check", () => {
    // Guards against this whole suite passing vacuously if the flag is renamed.
    expect(confirmationTools().length).toBeGreaterThan(10);
  });

  it("no Tier-2 tool gates on a model-settable `confirmed` flag", () => {
    const offenders = confirmationTools()
      .filter((t) => "confirmed" in schemaProps(t))
      .map((t) => t.name)
      .filter((n) => !ROUTE_GATED.has(n) && !SELF_ATTESTING_DEBT.has(n));
    expect(offenders).toEqual([]);
  });

  it("no tool declares both `confirmed` and `confirmation_token`", () => {
    // A tool accepting both would let the model pick the weaker path.
    const both = confirmationTools()
      .filter((t) => {
        const p = schemaProps(t);
        return "confirmed" in p && "confirmation_token" in p;
      })
      .map((t) => t.name);
    expect(both).toEqual([]);
  });

  it("every token-gated Tier-2 tool actually consumes a token", () => {
    // The schema change alone proves nothing — a handler could expose
    // `confirmation_token` and never check it.
    const missing = confirmationTools()
      .filter((t) => "confirmation_token" in schemaProps(t))
      .filter((t) => {
        const src = handlerSourceFor(t.name);
        return src === null || !hasTokenGate(src);
      })
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("every Tier-2 tool has SOME gate — declared-and-unenforced is the worst case", () => {
    // WARP-2008's defect class: six tools declared `requiresConfirmation: true`
    // with no gate at ANY layer — no `confirmed` read, no token, no route 202.
    // The other checks all passed them, because each only inspects tools that
    // already opted into one mechanism. A tool with NOTHING is strictly worse
    // than self-attestation: self-attestation at least forces a second model
    // turn and surfaces a chip the human can see.
    //
    // Gating is detected from the SOURCE rather than a hand-kept list, so a new
    // tool is judged on what it does, not on whether someone remembered to add
    // it here.
    const ungated = confirmationTools()
      .filter((t) => !SELF_ATTESTING_DEBT.has(t.name) && !NO_SIDE_EFFECT.has(t.name))
      .filter((t) => {
        const src = handlerSourceFor(t.name);
        return src === null || !isGated(src);
      })
      .map((t) => t.name);
    expect(ungated).toEqual([]);
  });

  it("the NO_SIDE_EFFECT exemption still describes a tool with no side effect", () => {
    // The exemption is only defensible while the handler cannot do anything.
    // If the ERP write path goes live and this stays green, the tool would be
    // an ungated Tier-2 write — so pin the thing that makes it safe.
    for (const name of NO_SIDE_EFFECT) {
      const src = handlerSourceFor(name);
      expect(src, `${name} handler not found`).not.toBeNull();
      expect(src, `${name} no longer looks like an unconditional stub`).toContain(
        "erpNotConnected()",
      );
    }
  });

  it("every ROUTE_GATED tool really does forward a route-side 202", () => {
    // Keeps the allowlist honest: these are the only tools still permitted to
    // expose a `confirmed` flag, and that permission is only defensible while
    // a real server-side gate stands behind them. If one stops forwarding its
    // 202 it becomes purely self-attesting, and must fail here rather than sit
    // on an allowlist that no longer describes it.
    const notActuallyGated = [...ROUTE_GATED].filter((name) => {
      const src = handlerSourceFor(name);
      return src === null || !hasRouteGate(src);
    });
    expect(notActuallyGated).toEqual([]);
  });

  it("the known-debt list has not grown", () => {
    // This set must only ever shrink. If a new self-attesting tool appears,
    // fix it — do not add it here without a ticket.
    expect([...SELF_ATTESTING_DEBT]).toEqual(["set_camera_detection"]);
  });

  it("every tool on an allowlist is still registered", () => {
    const registered = new Set([...TOOLS.keys()]);
    for (const name of [...ROUTE_GATED, ...SELF_ATTESTING_DEBT]) {
      expect(registered.has(name), `${name} is allowlisted but not registered`).toBe(true);
    }
  });
});
