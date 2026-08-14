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
        // Match the CALL, not the identifier: `includes("consumeToolConfirmation")`
        // is satisfied by the import statement alone, so it stays green even
        // when the gate itself is deleted. (Caught by mutation.)
        return src === null || !src.includes("consumeToolConfirmation(");
      })
      .map((t) => t.name);
    expect(missing).toEqual([]);
  });

  it("every ROUTE_GATED tool really does forward a route-side 202", () => {
    // Keeps the allowlist honest: if one of these stops using
    // passThroughConfirmation, it becomes self-attesting and must fail here
    // rather than sitting on an allowlist that no longer describes it.
    const notActuallyGated = [...ROUTE_GATED].filter((name) => {
      const src = handlerSourceFor(name);
      // Again the CALL form: a bare identifier check is also satisfied by any
      // longer name containing it (`passThroughConfirmationX`). (Caught by
      // mutation.)
      return src === null || !src.includes("passThroughConfirmation(");
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
