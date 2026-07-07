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
import type { ModuleId, BusinessType, PrismaClient } from "@prisma/client";
import {
  MODULES,
  getModuleDef,
  BUSINESS_TYPE_BY_ID,
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

async function readEnablement(
  prisma: PrismaClient
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

/** PURE effective-state computation (no DB) — the async readers below just fetch
 *  the overrides + businessType and delegate here. Exported for unit testing. */
export function computeModuleStates(
  overrides: Map<ModuleId, boolean>,
  cfg: AvailabilityConfig
): ModuleState[] {
  return MODULES.map((def) => {
    const available = def.available(cfg);
    const enabled = resolveEnabled(def.id, overrides);
    return {
      id: def.id, label: def.label, description: def.description, category: def.category,
      core: def.core, available, enabled, effective: available && enabled,
    };
  });
}

/** PURE — effective module ids from overrides + config. */
export function computeEffectiveIds(
  overrides: Map<ModuleId, boolean>,
  cfg: AvailabilityConfig
): Set<ModuleId> {
  const out = new Set<ModuleId>();
  for (const def of MODULES) {
    if (def.available(cfg) && resolveEnabled(def.id, overrides)) out.add(def.id);
  }
  return out;
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

/** Set of module ids that are EFFECTIVE (available && enabled) — the guard +
 *  tool filter read this. */
export async function getEffectiveModuleIds(
  prisma: PrismaClient,
  cfg: AvailabilityConfig
): Promise<Set<ModuleId>> {
  const overrides = await readEnablement(prisma);
  return computeEffectiveIds(overrides, cfg);
}

/** tools-core handler domains belonging to an effective module — the agent's
 *  tool list is filtered to these so a disabled module's tools disappear. */
export async function getEnabledToolDomains(
  prisma: PrismaClient,
  cfg: AvailabilityConfig
): Promise<Set<string>> {
  const effective = await getEffectiveModuleIds(prisma, cfg);
  const domains = new Set<string>();
  for (const def of MODULES) {
    if (effective.has(def.id)) for (const d of def.toolDomains) domains.add(d);
  }
  return domains;
}

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

  return {
    id: def.id, label: def.label, description: def.description, category: def.category,
    core: def.core, available, enabled, effective: available && enabled,
  };
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
