/**
 * Module-enablement service — resolves the two-axis model (availability ×
 * enablement → effective), applies business-type presets, and exposes the
 * effective set for the route guard + agent tool filtering.
 * Design: docs/superpowers/specs/2026-07-07-module-toggles-design.md.
 *
 * Enablement resolution per module:
 *   - core module            → enabled = true (always; not stored, not toggleable)
 *   - has a ModuleSetting row → enabled = row.enabled          (explicit operator choice)
 *   - no row                  → enabled = registry defaultEnabled (versioned default;
 *                               NOT inferred state — the default is explicit in code)
 * effective = available(config) && enabled.
 */
import type { ModuleId, BusinessType, Prisma, PrismaClient } from "@prisma/client";
import {
  MODULES,
  getModuleDef,
  BUSINESS_TYPE_BY_ID,
  satisfiedModuleIds,
  type AvailabilityConfig,
} from "../modules/module-registry.js";

export interface ModuleState {
  id: ModuleId;
  label: string;
  description: string;
  category: "workspace" | "operations";
  core: boolean;
  available: boolean;
  enabled: boolean;
  effective: boolean;
  /** WARP-1585 — the module this one declares it cannot function without. */
  requires?: ModuleId;
  /** WARP-1585 — `requires` is declared and that parent is NOT effective, so
   *  this module isn't either. Surfaced as its own field, separate from
   *  `available` and `enabled`, so an operator-facing view can say WHY rather
   *  than showing a module that silently refuses to come on. */
  requiresUnmet: boolean;
}

export interface ModulesView {
  businessType: BusinessType | null;
  modules: ModuleState[];
}

/** Error thrown for operator-correctable toggle rejections; the route maps
 *  `.status` to the HTTP code. */
export class ModuleToggleError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "ModuleToggleError";
  }
}

/**
 * A client that can read `ModuleSetting` — either the top-level
 * `PrismaClient` or an interactive transaction's `tx` handle (WARP-1583).
 *
 * The union is deliberate, and the OPPOSITE call from `GuardTx`
 * (role-mutation-guard.service.ts), which narrows to `Prisma.TransactionClient`
 * precisely so that passing the top-level client is a compile error. There
 * the invariant is "this must run inside a transaction". Here both are
 * legitimate and the caller's context decides: the module gate and
 * `GET /api/capabilities` resolve the workspace's module set on its own, so
 * a single self-consistent statement is all they need; the §3 effective-access
 * resolver composes this set WITH per-person grants read in the same
 * snapshot, so it must pass its `tx`. Naming both arms is what documents that
 * the parameter is a snapshot choice rather than an incidental type.
 */
export type ModuleReadClient = PrismaClient | Prisma.TransactionClient;

async function readEnablement(
  prisma: ModuleReadClient
): Promise<Map<ModuleId, boolean>> {
  const rows = await prisma.moduleSetting.findMany();
  return new Map(rows.map((r) => [r.moduleId, r.enabled]));
}

function resolveEnabled(id: ModuleId, overrides: Map<ModuleId, boolean>): boolean {
  const def = getModuleDef(id)!;
  if (def.core) return true;
  const row = overrides.get(id);
  return row !== undefined ? row : def.defaultEnabled;
}

/** PURE — the two-axis set BEFORE the WARP-1585 dependency closure. */
function computeSelfEffectiveIds(
  overrides: Map<ModuleId, boolean>,
  cfg: AvailabilityConfig
): Set<ModuleId> {
  const out = new Set<ModuleId>();
  for (const def of MODULES) {
    if (def.available(cfg) && resolveEnabled(def.id, overrides)) out.add(def.id);
  }
  return out;
}

/** PURE effective-state computation (no DB) — the async readers below just fetch
 *  the overrides + businessType and delegate here. Exported for unit testing. */
export function computeModuleStates(
  overrides: Map<ModuleId, boolean>,
  cfg: AvailabilityConfig
): ModuleState[] {
  const effectiveIds = computeEffectiveIds(overrides, cfg);
  return MODULES.map((def) => {
    const available = def.available(cfg);
    const enabled = resolveEnabled(def.id, overrides);
    return {
      id: def.id, label: def.label, description: def.description, category: def.category,
      core: def.core, available, enabled,
      effective: effectiveIds.has(def.id),
      // Reported, never folded into `enabled`: the operator's stored intent is
      // preserved, so re-enabling the parent restores this module exactly as
      // they left it. Same discipline as `available` — a module can be stored
      // ON and not be effective (WARP-1585).
      ...(def.requires ? { requires: def.requires } : {}),
      requiresUnmet: def.requires !== undefined && !effectiveIds.has(def.requires),
    };
  });
}

/**
 * PURE — effective module ids from overrides + config, narrowed by the
 * registry's declared dependencies (WARP-1585).
 *
 * The WORKSPACE half of the dependency rule: `docs` requires `files`, so a box
 * with Files off or unavailable has no document surface either — its editor
 * sessions are minted on Nextcloud paths. `knowledge` declares no parent and
 * is untouched by a Files toggle. `satisfiedModuleIds` is the one definition
 * of the rule; the per-person §9 half applies the same function in
 * effective-access.service.
 */
export function computeEffectiveIds(
  overrides: Map<ModuleId, boolean>,
  cfg: AvailabilityConfig
): Set<ModuleId> {
  return satisfiedModuleIds(computeSelfEffectiveIds(overrides, cfg));
}

/** Full view for GET /api/modules and the settings page. */
export async function getModulesView(
  prisma: PrismaClient,
  cfg: AvailabilityConfig
): Promise<ModulesView> {
  const overrides = await readEnablement(prisma);
  const ws = await prisma.workspace.findUnique({ where: { id: 1 } });
  return { businessType: ws?.businessType ?? null, modules: computeModuleStates(overrides, cfg) };
}

/**
 * Set of module ids that are EFFECTIVE (available && enabled) — the guard +
 * tool filter read this.
 *
 * WARP-1583: takes a `ModuleReadClient`, so a caller that is composing this
 * set with other reads can hand in its transaction handle and get all of it
 * from one snapshot. Passing the top-level client from INSIDE a transaction
 * would silently take a second snapshot — the array form of `$transaction`
 * has the same problem, and is why it is not a fix either.
 */
export async function getEffectiveModuleIds(
  prisma: ModuleReadClient,
  cfg: AvailabilityConfig
): Promise<Set<ModuleId>> {
  const overrides = await readEnablement(prisma);
  return computeEffectiveIds(overrides, cfg);
}

// WARP-1529: `getEnabledToolDomains` was removed here. It walked
// `MODULES[].toolDomains` directly to build the module→tool-domain join — a
// SECOND derivation of the mapping that `access-catalog.ts` already owns
// (MODULE_BY_DOMAIN / domainsForFeatures, which also decides which domains are
// unclaimed and therefore never module-gated). It had no callers, so nothing
// ever enforced the two copies agreeing. The agent's per-turn tool filtering
// now goes through the ADR-032 §3 resolver (effective-access.service.ts →
// domainsForFeatures) instead: ONE derivation, module axis and role axis
// composed in the same place. Need the effective module ids? Use
// getEffectiveModuleIds above and hand them to domainsForFeatures.

/** Toggle one module. Throws ModuleToggleError (→ HTTP) on invalid transitions. */
export async function setModuleEnabled(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
  id: ModuleId,
  enabled: boolean,
  setBy: string | null
): Promise<ModuleState> {
  const def = getModuleDef(id);
  if (!def) throw new ModuleToggleError(`unknown module '${id}'`, 400, "unknown_module");
  if (def.core)
    throw new ModuleToggleError(
      `'${id}' is a core module and can't be disabled`,
      409,
      "core_module"
    );
  const available = def.available(cfg);
  if (enabled && !available)
    throw new ModuleToggleError(
      `'${id}' is not deployed on this box and can't be enabled`,
      409,
      "module_unavailable"
    );

  await prisma.moduleSetting.upsert({
    where: { moduleId: id },
    update: { enabled, setBy },
    create: { moduleId: id, enabled, setBy },
  });

  // WARP-1585: re-derive from the stored set rather than answering
  // `available && enabled` locally. That shortcut was correct while a module's
  // effectiveness depended only on itself; with declared dependencies it would
  // report a Documents toggle as effective on a box whose Files module is off.
  // The extra read is on a rare operator write path, and it means the row the
  // dashboard renders after a toggle is the same row `GET /api/modules`
  // returns — one answer, not two that can disagree.
  const states = computeModuleStates(await readEnablement(prisma), cfg);
  return states.find((s) => s.id === id)!;
}

/** Apply a business-type preset: materialize an explicit ModuleSetting row for
 *  every non-core module (enabled iff in the preset) and record the choice on the
 *  Workspace singleton. `custom` is a no-op on the toggles (only records the type).
 *  Preset enablement is NOT clamped to availability — an unavailable-but-preset
 *  module is stored enabled so it flips on automatically once its backend is
 *  deployed; `effective` still requires availability. */
export async function applyBusinessType(
  prisma: PrismaClient,
  cfg: AvailabilityConfig,
  type: BusinessType,
  setBy: string | null
): Promise<ModulesView> {
  const preset = BUSINESS_TYPE_BY_ID.get(type);
  if (!preset)
    throw new ModuleToggleError(`unknown business type '${type}'`, 400, "unknown_business_type");

  await prisma.$transaction(async (tx) => {
    if (type !== "custom") {
      const on = new Set<ModuleId>(preset.modules);
      for (const def of MODULES) {
        if (def.core) continue;
        const enabled = on.has(def.id);
        await tx.moduleSetting.upsert({
          where: { moduleId: def.id },
          update: { enabled, setBy },
          create: { moduleId: def.id, enabled, setBy },
        });
      }
    }
    await tx.workspace.upsert({
      where: { id: 1 },
      update: { businessType: type, businessTypeSetBy: setBy, businessTypeSetAt: new Date() },
      create: { id: 1, businessType: type, businessTypeSetBy: setBy, businessTypeSetAt: new Date() },
    });
  });

  return getModulesView(prisma, cfg);
}
