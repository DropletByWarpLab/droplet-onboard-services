/**
 * Every confirm-gated operation a route can MINT must have somewhere to be
 * REDEEMED (WARP-1984 class guard).
 *
 * `set_ssh_access` shipped as a Tier-3 operation with a live dashboard toggle,
 * blast-radius copy, a mint route — and no dispatcher case. Both halves passed
 * their own tests; the token simply had no consumer, so the control answered
 * "Unknown operation" forever. Nothing in the suite could see it, because the
 * gap was *between* two individually correct files.
 *
 * This walks the actual sources rather than a hand-maintained list: a list
 * would need the same update the dispatcher needs, so it would go stale in
 * exactly the case it exists to catch.
 *
 * NOT a style rule. Reaching Tier 2 or 3 means a human is asked to confirm the
 * write. Minting a token nobody can redeem turns that prompt into a dead end —
 * and on `set_ssh_access` the dead end removed the appliance's only management
 * shell, on a box whose sshd is stopped at every boot by design.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { classifyNetworkCommand } from "../config/network-safety-rules.js";

// `__dirname`, not `import.meta.url`: this package builds to CommonJS, where
// tsc rejects import.meta outright (TS1470). Same resolution the sibling
// ssh-access.host-script.guard.test.ts uses.
const ROUTES_DIR = join(__dirname, "..", "routes");

/** The files holding a `switch (confirmedOp)` redemption dispatcher. */
const DISPATCHER_FILES = ["network-status.routes.ts", "cameras.ts", "switch.ts"];

/**
 * Mint sites that pass the operation as a VARIABLE rather than a literal, with
 * the operations that variable can hold. An undeclared dynamic site FAILS this
 * test rather than slipping past the scanner as "nothing to check" — the only
 * way a source-scanning guard stays honest about what it could not read.
 */
const DYNAMIC_MINT_SITES: Record<string, string[]> = {
  // WARP-1907 — POST /network/ports/:port/{enable,disable} picks the operation
  // from the verb before minting.
  "network-status.routes.ts": ["router_port_enable", "router_port_disable"],
  // WARP-1712 — PUT /network/wifi/ap mints set_ap_wifi_password when the save
  // carries a passphrase and set_ap_wifi_ssid when it does not. Only the former
  // is confirm-gated; the SSID-only save is Tier 1 and never reaches the
  // dispatcher. Both are listed so the tier config stays the thing that decides
  // that, not this file.
  "network-wifi.routes.ts": ["set_ap_wifi_password", "set_ap_wifi_ssid"],
  // POST /switch/ports/:port and /switch/poe/:port pick the operation from the
  // `enabled` body flag. (The protected-port case is minted as a literal on the
  // branch above each of these, so it is already covered.)
  "switch.ts": [
    "switch_poe_enable",
    "switch_poe_disable",
    "switch_port_enable",
    "switch_port_disable",
  ],
};

/**
 * Files that mint through a LOCAL WRAPPER instead of calling the safety service
 * directly. Naming the wrapper — rather than the operations it forwards — is
 * what keeps this guard self-maintaining: a new switch operation added through
 * `evalSwitchCommand` is picked up automatically, where a hand-written list
 * would silently not cover it.
 */
const MINT_WRAPPERS: Record<string, { fn: string; opIndex: number }> = {
  // switch.ts routes every operation through one helper: (prisma, operation, …).
  "switch.ts": { fn: "evalSwitchCommand", opIndex: 1 },
};

/**
 * Operations redeemed INLINE by their own route rather than by a shared
 * dispatcher: the route accepts `confirmation_token` in its own body and calls
 * `confirmNetworkCommand` itself. Legitimately covered, just not by a `case`.
 */
const INLINE_CONFIRM_OPERATIONS = new Set([
  // cameras.ts — POST /cameras/clips/share re-posts with `confirmation_token`
  // and confirms in place, pinned to entityId "camera.clip.share". Inline
  // because the second call also needs the clip path and TTL, which a generic
  // dispatcher does not carry.
  "share_clip",
]);

/**
 * ⚠️ A BUG LIST, NOT AN APPROVAL LIST.
 *
 * Operations that mint a confirmation token nothing can redeem — the same
 * defect as WARP-1984, still live. Listed so this guard can be green about the
 * gaps it already knows while failing on any NEW one. The assertion below is an
 * exact match, so fixing an entry without deleting it here also fails: the list
 * can only shrink, and it is never evidence that the behaviour is acceptable.
 */
const UNREDEEMABLE_TODAY: string[] = [
  // (empty — WARP-2122 fixed set_ssh_access, WARP-2125 dropped
  // switch_wan_detect to Tier 1: detectWanPort() is a pure read, so it no
  // longer mints anything. Keep the list and its exact-match assertion: the
  // next mint-without-redeemer lands HERE, not in a green suite.)
];

const QUOTES = new Set(['"', "'", "`"]);
const IDENT_CHAR = /[A-Za-z0-9_$.]/;
const OPERATION_LITERAL = /^"([a-z0-9_]+)"$/;
/** `function foo(` / `const foo = (` — a definition, never a call. */
const DECLARATION_BEFORE = /\b(?:function|const|let|var)\s+$/;

/** Split a call's argument list on top-level commas. `open` is the `(` index. */
function splitArgs(src: string, open: number): string[] | null {
  let depth = 0;
  let quote: string | null = null;
  const args: string[] = [];
  let current = "";

  for (let i = open; i < src.length; i++) {
    const ch = src[i];

    if (quote !== null) {
      current += ch;
      if (ch === quote && src[i - 1] !== "\\") quote = null;
      continue;
    }
    if (QUOTES.has(ch)) {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (!(depth === 1 && ch === "(")) current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return null; // unbalanced — treated as a parse failure by the caller
}

interface MintSite {
  file: string;
  /** null = the operation was passed as a variable, not a literal. */
  operation: string | null;
}

function collectMintSites(): MintSite[] {
  const sites: MintSite[] = [];
  const files = readdirSync(ROUTES_DIR).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  for (const file of files) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    // A file with a local wrapper is scanned at the WRAPPER's call sites; its
    // own single `evaluateNetworkCommand` call is the wrapper body, where the
    // operation is necessarily a variable and carries no information.
    const wrapper = MINT_WRAPPERS[file];
    const fn = wrapper?.fn ?? "evaluateNetworkCommand";
    // (prisma, entityId, operation, …) direct; (prisma, operation, …) wrapped.
    const opIndex = wrapper?.opIndex ?? 2;

    // Plain indexOf rather than a constructed regex: the token is a fixed
    // identifier, and a hand-escaped dynamic pattern is one backslash away from
    // matching nothing — which would make this guard pass by finding no work.
    const needle = `${fn}(`;
    for (
      let at = src.indexOf(needle);
      at !== -1;
      at = src.indexOf(needle, at + needle.length)
    ) {
      // Skip `something.evaluateNetworkCommand(` and identifier lookalikes.
      if (IDENT_CHAR.test(src[at - 1] ?? " ")) continue;
      // Skip the wrapper's own DECLARATION: `function evalSwitchCommand(` is a
      // parameter list, not a mint, and its `operation: string` would otherwise
      // read as an undeclared dynamic site.
      if (DECLARATION_BEFORE.test(src.slice(Math.max(0, at - 24), at))) continue;

      const args = splitArgs(src, at + needle.length - 1);
      const raw = args?.[opIndex];
      if (raw === undefined) {
        const line = src.slice(0, at).split("\n").length;
        throw new Error(
          `Could not parse the ${fn} call at ${file}:${line} — this guard must ` +
            `be able to see the operation argument.`,
        );
      }
      const literal = OPERATION_LITERAL.exec(raw);
      sites.push({ file, operation: literal ? literal[1] : null });
    }
  }
  return sites;
}

function collectDispatchedOperations(): Set<string> {
  const dispatched = new Set<string>();
  for (const file of DISPATCHER_FILES) {
    const src = readFileSync(join(ROUTES_DIR, file), "utf8");
    for (const m of src.matchAll(/case\s+"([a-z0-9_]+)"\s*:/g)) {
      dispatched.add(m[1]);
    }
  }
  return dispatched;
}

describe("confirm-token dispatcher coverage", () => {
  const sites = collectMintSites();
  const dispatched = collectDispatchedOperations();

  it("finds mint sites and dispatcher cases at all — a silent zero would make this guard vacuous", () => {
    expect(sites.length).toBeGreaterThan(15);
    expect(dispatched.size).toBeGreaterThan(15);
    // At least one literal operation resolved, i.e. the arg splitter works.
    expect(sites.filter((s) => s.operation !== null).length).toBeGreaterThan(15);
  });

  it("every Tier-2/3 operation minted by a route can be redeemed", () => {
    const minted = new Set<string>();

    for (const site of sites) {
      if (site.operation !== null) {
        minted.add(site.operation);
        continue;
      }
      const declared = DYNAMIC_MINT_SITES[site.file];
      expect(
        declared,
        `${site.file} mints an operation from a variable but is not listed in ` +
          `DYNAMIC_MINT_SITES — add it with the operations it can produce.`,
      ).toBeDefined();
      declared.forEach((op) => minted.add(op));
    }

    const orphans = [...minted]
      .filter((op) => classifyNetworkCommand(op).requiresConfirmation)
      .filter((op) => !dispatched.has(op))
      .filter((op) => !INLINE_CONFIRM_OPERATIONS.has(op))
      .sort();

    expect(
      orphans,
      `Confirm-token coverage changed. Anything here that is NOT in ` +
        `UNREDEEMABLE_TODAY mints a token no dispatcher case can redeem, so ` +
        `confirming it returns "Unknown operation" and the write never ` +
        `happens — add a case to the confirm dispatcher, or drop the ` +
        `operation below Tier 2. If you FIXED a listed one, delete it from ` +
        `UNREDEEMABLE_TODAY. Found: ${orphans.join(", ") || "(none)"}.`,
    ).toEqual([...UNREDEEMABLE_TODAY].sort());
  });

  it("set_ssh_access specifically — the operation this guard was written for", () => {
    expect(classifyNetworkCommand("set_ssh_access").requiresConfirmation).toBe(true);
    expect(dispatched.has("set_ssh_access")).toBe(true);
  });
});
