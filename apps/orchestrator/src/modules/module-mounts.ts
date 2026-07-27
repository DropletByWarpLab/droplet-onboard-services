/**
 * WARP-1585 — registry-driven composition of the two module gate layers.
 *
 * This used to be two inline loops in app.ts. It is a module now for one
 * reason: the bug it fixes lived in the COMPOSITION, not in either gate, and a
 * bug in composition can only be tested by driving the composition. app.ts
 * calls `mountModuleGates`; module-mounts.test.ts calls the same function
 * against a bare Express app, so a regression is caught by a test rather than
 * by an operator noticing their Knowledge grant does nothing.
 *
 * The two layers, unchanged in meaning:
 *   layer 1  requireModuleEnabled   — the WORKSPACE capability gate
 *   layer 2  requireFeatureAccess   — the PERSON's ADR-032 §9 grant level
 * Both mount off the registry's `routePrefixes` — one vocabulary, no parallel
 * list — and both deny with the identical 404, so a narrowed person sees a
 * smaller Droplet rather than a wall of locked doors.
 *
 * What changed: each gate is now SCOPED TO THE PATHS ITS MODULE OWNS. Express
 * `app.use(prefix, handler)` is a prefix mount, and three of this catalog's
 * prefixes nest:
 *
 *     files      /api/files
 *     knowledge  /api/files/knowledge
 *     docs       /api/files/docs
 *
 * so every gate registered for `files` also fired on the two siblings. The
 * Access & Roles panel offers three independent toggles; the box enforced one,
 * and enforced it under the wrong module's name. Turning Files off silently
 * removed Knowledge and Documents, and — the mirror-image failure — neither
 * sibling was feature-gated at all, so a Files grant on its own opened the
 * knowledge base whatever the Knowledge switch said.
 *
 * The two siblings are not the same case, and the fix does not treat them as
 * one (see the registry's `requires` field):
 *   - `knowledge` is genuinely separable and now enforces its own toggle;
 *   - `docs` genuinely depends on `files`, and that dependency is now
 *     DECLARED (`requires: "files"`) and enforced by the effective-set
 *     computation, so the dashboard can render Documents as blocked with the
 *     reason rather than presenting a toggle that quietly does nothing.
 *
 * The split is by PATH, not by prefix, and that distinction is load-bearing.
 * `/api/files` serves wildcard routes whose middle is user data —
 * `/api/files/:filePath(*)/editor-session` and its comments/citations/tags
 * siblings — so a Nextcloud file stored under a folder called `docs` or
 * `knowledge` produces a FILES request that lands inside a SIBLING's
 * namespace. Handing the whole sub-tree to the sibling would move real file
 * operations onto the wrong toggle in both directions at once: a person
 * holding Knowledge but no Files could mint an editor session for anything
 * under `knowledge/`, and it would keep serving after Files was switched off
 * box-wide — while a Files holder without Knowledge would 404 on their own
 * file. So the nested modules declare the paths they own (registry
 * `ownedPaths`) and the enclosing module keeps everything else.
 */
import type { RequestHandler } from "express";
import type { ModuleId } from "@prisma/client";
import { MODULES, gateScopeFor } from "./module-registry.js";
import type { ModuleGate } from "../middleware/module-gate.js";
import {
  requireFeatureAccess,
  type EffectiveAccessResolver,
} from "../middleware/feature-gate.js";
import { resolveEffectiveAccess } from "../services/effective-access.service.js";

/** The `app.use(path, handler)` surface — structural so tests can pass a bare
 *  Express app or a Router without pulling the whole app type in. */
export interface ModuleGateMountTarget {
  use(path: string, handler: RequestHandler): unknown;
}

/**
 * ADR-032 §3(a) — the modules whose layer-2 (per-person) gate is mounted.
 *
 * Deliberately not app-wide. WARP-1528 shipped the four surfaces the design
 * brief's §9 catalog treats as load-bearing (Files, Cameras, Network,
 * Devices/smart-home); the rest follow once the roster has roles in the wild.
 *
 * WARP-1585 adds `knowledge` and `docs`. They are not a widening of that
 * roll-out — they were ALREADY being feature-gated, by `files`, because its
 * prefix swallowed them. Scoping the files gate to its own namespace without
 * adding these two would have opened both surfaces to anyone, which is the
 * wrong direction to be honest in. The Access panel already offers all three
 * toggles, so this is the enforcement catching up to a promise the UI has been
 * making since T8.
 *
 * Note smart_home's prefix is `/api/matter`, NOT `/api/devices` (the registry
 * comment: /api/devices hosts appliance pairing + push, which must never 404
 * behind a smart-home grant).
 */
export const FEATURE_GATED_MODULES: ReadonlySet<ModuleId> = new Set<ModuleId>([
  "files",
  "knowledge",
  "docs",
  "cameras",
  "network",
  "smart_home",
]);

/**
 * Wrap `handler` so it only runs on the paths this module OWNS — every other
 * request under the mount falls straight through, because a different
 * module's gate is the authority for it.
 *
 * The ownership rule itself is the registry's (`gateScopeFor`); this is only
 * the Express plumbing for it. Note it is asymmetric, deliberately: a nested
 * module owns its declared routes and nothing else, and the enclosing module
 * keeps the rest of its sub-tree — including the wildcard Nextcloud paths
 * (`/api/files/:filePath(*)/editor-session`) that a file stored under a folder
 * named `docs` or `knowledge` pushes into a sibling's namespace.
 *
 * `req.baseUrl + req.path` reconstructs the full pathname from inside a
 * prefix mount (Express rewrites `req.url` to the remainder and puts the
 * matched prefix in `baseUrl`), which keeps this correct if the gates are ever
 * mounted under a Router rather than directly on the app.
 */
function scopeToOwnedPaths(
  handler: RequestHandler,
  applies: ((fullPath: string) => boolean) | null,
): RequestHandler {
  if (applies === null) return handler;
  return function pathScopedGate(req, res, next) {
    if (!applies(`${req.baseUrl}${req.path}`)) {
      next();
      return;
    }
    handler(req, res, next);
  };
}

/**
 * Register both gate layers for every non-core module, in the order app.ts
 * needs them: the workspace gate first (does this box serve the module), the
 * per-person gate immediately behind it (may THIS PERSON open it).
 *
 * Must be called after `authMiddleware` (so `req.user` is populated) and
 * before the module routers it guards.
 *
 * @param resolve injectable effective-access resolver — the same seam
 *                `requireFeatureAccess` exposes, so the composition can be
 *                driven in tests without a database.
 */
export function mountModuleGates(
  app: ModuleGateMountTarget,
  moduleGate: ModuleGate,
  resolve: EffectiveAccessResolver = resolveEffectiveAccess,
): void {
  for (const def of MODULES) {
    // Core modules are never toggleable (a Droplet with no assistant isn't a
    // Droplet) and never per-person gated.
    if (def.core) continue;
    const featureGated = FEATURE_GATED_MODULES.has(def.id);
    for (const prefix of def.routePrefixes) {
      const applies = gateScopeFor(def, prefix);
      app.use(prefix, scopeToOwnedPaths(moduleGate.requireModuleEnabled(def.id), applies));
      if (featureGated) {
        app.use(
          prefix,
          scopeToOwnedPaths(requireFeatureAccess(def.id, "view", resolve), applies),
        );
      }
    }
  }
}
