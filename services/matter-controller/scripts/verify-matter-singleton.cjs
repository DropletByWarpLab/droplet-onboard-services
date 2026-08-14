#!/usr/bin/env node
/**
 * Build-time guard: assert the @matter/* set is a SINGLE flat instance.
 *
 * Why this exists (WARP-850). matter.js pins EXACT versions across its own
 * workspace. If our manifests let any one @matter/* package float (a caret
 * range is enough — 0.16.10 vs 0.16.11 did it), npm cannot dedupe the set and
 * nests a second copy of @matter/general and @matter/protocol under the odd
 * one out. Two copies of @matter/general means two `Environment.default`
 * singletons and two distinct `Ble` symbols, so `env.set(Ble, …)` registers
 * into one universe and `env.has(Ble)` is checked in the other. BLE
 * registration silently no-ops and the box ships degraded to IP-only, with a
 * green test suite and no error anywhere. A PATCH-level skew caused that.
 *
 * So this checks two things, and neither is optional:
 *
 *  1. VERSION LOCKSTEP — every package in the set resolves to EXPECTED.
 *     Catches lockfile drift the moment it appears.
 *
 *  2. SINGLE INSTANCE — @matter/general and @matter/protocol resolve to the
 *     SAME file path no matter which consumer asks. This is the invariant
 *     that actually matters: identical version strings in two nested copies
 *     would still be two module instances and would still break BLE. Version
 *     equality alone cannot see that; path identity can.
 *
 * Resolution is anchored at each consumer's own directory, so it reproduces
 * exactly what Node does at runtime from the service's working directory.
 *
 * NEVER relax or delete this guard to make a bump go green. Move the whole
 * set together instead: `@matter/main`, `@matter/nodejs-ble` and
 * `@project-chip/matter.js` in services/matter-controller, AND `@matter/main`
 * + `@project-chip/matter.js` in apps/orchestrator. All five, exact pins.
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const EXPECTED = "0.17.9";

/** Packages whose version must be exactly EXPECTED. */
const PINNED = ["@matter/main", "@matter/nodejs-ble", "@project-chip/matter.js"];

/** Packages that must be one shared instance across all consumers. */
const SHARED = ["@matter/general", "@matter/protocol"];

/** Consumers that each pull in the shared packages. */
const CONSUMERS = ["@matter/main", "@matter/nodejs-ble", "@project-chip/matter.js"];

const failures = [];

/**
 * Package ROOT directory as seen from `fromDir`.
 *
 * Most @matter/* packages do NOT list "./package.json" in their `exports`
 * map (only @matter/nodejs-ble and @project-chip/matter.js do), so the
 * obvious `require.resolve("<pkg>/package.json")` throws ERR_PACKAGE_PATH_NOT_
 * EXPORTED for @matter/main, @matter/general and @matter/protocol. Resolve the
 * package's "." entry instead — always exported — and walk up to the manifest.
 * This follows the same algorithm Node uses at runtime, so the answer is the
 * copy that would actually be loaded.
 */
function rootOf(pkg, fromDir) {
  let dir = path.dirname(require.resolve(pkg, { paths: [fromDir] }));
  const { root } = path.parse(dir);
  while (true) {
    if (fs.existsSync(path.join(dir, "package.json"))) {
      const name = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      ).name;
      // dist/ subdirectories can carry their own bare package.json (a
      // {"type":"module"} marker with no name) — keep walking past those.
      if (name === pkg) return dir;
    }
    if (dir === root) throw new Error(`no package.json for ${pkg} above ${dir}`);
    dir = path.dirname(dir);
  }
}

const here = __dirname;

// --- 1. version lockstep ---
for (const pkg of PINNED) {
  let version;
  try {
    version = JSON.parse(
      fs.readFileSync(path.join(rootOf(pkg, here), "package.json"), "utf8"),
    ).version;
  } catch (err) {
    failures.push(`${pkg}: cannot resolve from ${here} (${err.message})`);
    continue;
  }
  if (version !== EXPECTED) {
    failures.push(`version-skew: ${pkg} expected ${EXPECTED}, got ${version}`);
  }
}

// --- 2. single shared instance ---
for (const shared of SHARED) {
  /** @type {Map<string, string[]>} resolved path -> consumers that see it */
  const seen = new Map();

  for (const consumer of CONSUMERS) {
    let resolved;
    try {
      resolved = rootOf(shared, rootOf(consumer, here));
    } catch (err) {
      failures.push(`${shared}: cannot resolve from ${consumer} (${err.message})`);
      continue;
    }
    if (!seen.has(resolved)) seen.set(resolved, []);
    seen.get(resolved).push(consumer);
  }

  if (seen.size > 1) {
    const detail = [...seen.entries()]
      .map(([p, consumers]) => `    ${p}  <- ${consumers.join(", ")}`)
      .join("\n");
    failures.push(
      `split-instance: ${shared} resolves to ${seen.size} different copies —\n${detail}\n` +
        `  This is the WARP-850 failure: two Environment.default singletons, ` +
        `two Ble symbols, BLE silently disabled.`,
    );
  }
}

if (failures.length) {
  console.error(`\n@matter/* integrity check FAILED:\n`);
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    `\nDo not relax this guard. Move the whole @matter/* set to one exact ` +
      `version, in BOTH services/matter-controller and apps/orchestrator.\n`,
  );
  process.exit(1);
}

console.log(
  `@matter/* integrity OK — ${PINNED.join(", ")} all at ${EXPECTED}; ` +
    `${SHARED.join(" + ")} each a single shared instance.`,
);
