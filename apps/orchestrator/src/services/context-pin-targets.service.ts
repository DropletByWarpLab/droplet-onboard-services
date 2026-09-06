/**
 * WARP-2582 (ADR-045 slice E) - resolving a business pin's target.
 *
 * A `customer` pin's `ref` is a `CrmCompany.id`. Prepending that uuid to the
 * system prompt is worse than prepending nothing: the model spends a turn
 * guessing what it names, or invents one. So every business pin is resolved
 * to a NAME before it is rendered, on every turn.
 *
 * TWO AXES COMPOSE HERE, and both have to, because `/api/llm/*` sits behind
 * neither of the gates that protect the records themselves:
 *
 *   1. THE WORKSPACE MODULE GATE. `/api/crm` is gated on the `crm` ModuleId
 *      and `/api/pm/projects` on `projects` (module-registry.ts), both
 *      `defaultEnabled: false`. `/api/llm` is gated on `chat`. Without this
 *      check a pin created while the CRM was on would keep naming a customer
 *      after an operator turned the CRM off - a module gate bypassed through
 *      a chat prompt. Checked PER TURN, not once at create, for exactly that
 *      reason: enablement changes under a live pin.
 *
 *   2. THE PER-PERSON TOOL-DOMAIN GRANT (ADR-032 s3). `toolAccessScope` is
 *      already resolved once per turn in routes/llm.ts and is `null` for the
 *      owner and for everyone with no AccessRole - which is every user on a
 *      box today, so this axis narrows nothing until somebody assigns a role,
 *      and then it narrows exactly as the tool catalog does. Reused rather
 *      than re-resolved: `resolveEffectiveAccess` opens a REPEATABLE READ
 *      transaction, and paying for a second one on the chat critical path to
 *      re-derive a value already in hand would be a latency bug.
 *
 * HONEST LIMIT ON AXIS 2, stated rather than implied: today the CRM and PM
 * READ routes carry no `requireRole` at all (crm.ts and pm/native.ts gate
 * writes only, and say so in their headers). So on a box with no AccessRoles,
 * this composition denies nothing that the HTTP surface would have allowed.
 * It is here so the pin path cannot become the ONE surface that keeps
 * answering after RBAC v2 narrows the others, not because it closes a hole
 * that is open today.
 *
 * COST. Zero added queries when a session has no business pin - the common
 * turn returns before touching the database. With business pins: one module
 * read (5s-cached upstream by the module gate on other routes; uncached here)
 * plus at most one batched `findMany` per kind, on primary keys.
 *
 * NO FOREIGN KEY, deliberately. `ContextPin.ref` is polymorphic across six
 * pre-existing kinds (a path, a Frigate camera name, a mail thread id), and
 * giving four of the ten kinds real FK columns would need four nullable
 * columns plus an exactly-one-of CHECK that Prisma cannot express - a lot of
 * schema to buy a cascade whose absence is already handled. The precedent is
 * camera-pins.service.ts: pins are low-stakes preferences, so a dangling one
 * is FILTERED ON READ rather than cascaded. Here it reports `missing`, which
 * is strictly more useful than vanishing - the user gets a row they can
 * remove instead of a pin that quietly stopped working.
 */
import type { ModuleId, PrismaClient } from "@prisma/client";

import { config } from "../config.js";
import { getEffectiveModuleIds } from "./modules.service.js";
import type { ToolAccessScope } from "./tool-access.service.js";
import {
  BUSINESS_PIN_KINDS,
  PIN_KIND_TOOL_DOMAIN,
  isBusinessPinKind,
  type BusinessPinKind,
  type ContextPinTarget,
  type RenderablePin,
} from "./context-pin-prompt.js";

/** Pin kind -> the ModuleId whose toggle gates it. Note `project` and
 *  `work_item` map to `projects`, whose TOOL domain is `pm` - the two
 *  vocabularies differ and are kept as two explicit maps rather than one
 *  lookup that would have to know which axis it is on. */
const PIN_KIND_MODULE: Readonly<Record<BusinessPinKind, ModuleId>> = {
  customer: "crm",
  deal: "crm",
  project: "projects",
  work_item: "projects",
};

const UNAVAILABLE: ContextPinTarget = Object.freeze({
  state: "unavailable",
  label: null,
  sublabel: null,
});

const MISSING: ContextPinTarget = Object.freeze({
  state: "missing",
  label: null,
  sublabel: null,
});

export interface PinResolveContext {
  /** The caller's s3 tool reach for this turn. `null` = nothing narrows
   *  (owner, service principal, or no AccessRole). */
  scope: ToolAccessScope | null;
}

/** The prisma surface this module needs. Narrowed so unit tests can hand in a
 *  four-model stub instead of a whole client. */
export type PinTargetReadClient = Pick<
  PrismaClient,
  "crmCompany" | "crmDeal" | "pmProject" | "pmWorkItem"
>;

function kindPermitted(
  kind: BusinessPinKind,
  modules: ReadonlySet<ModuleId>,
  scope: ToolAccessScope | null,
): boolean {
  if (!modules.has(PIN_KIND_MODULE[kind])) return false;
  if (scope === null) return true;
  return scope.domains.has(PIN_KIND_TOOL_DOMAIN[kind]);
}

/**
 * Which of the four kinds this caller may resolve at all.
 *
 * Fails CLOSED on a module-read error, matching `requireModuleEnabled`'s own
 * read-error posture: we cannot confirm the module is on, so we treat it as
 * absent rather than name records on a box that may have turned it off.
 */
async function permittedKinds(
  prisma: unknown,
  scope: ToolAccessScope | null,
): Promise<ReadonlySet<BusinessPinKind>> {
  let modules: ReadonlySet<ModuleId>;
  try {
    modules = await getEffectiveModuleIds(
      prisma as Parameters<typeof getEffectiveModuleIds>[0],
      config,
    );
  } catch {
    return new Set();
  }
  return new Set(BUSINESS_PIN_KINDS.filter((k) => kindPermitted(k, modules, scope)));
}

/**
 * Resolve every business pin in `pins`. Keyed by pin id; non-business pins are
 * absent from the map (they need no resolution and
 * `renderContextPinBlock` renders them from `ref` alone).
 */
export async function resolveBusinessPinTargets(
  prisma: PinTargetReadClient,
  pins: readonly RenderablePin[],
  ctx: PinResolveContext,
): Promise<Map<string, ContextPinTarget>> {
  const out = new Map<string, ContextPinTarget>();

  const byKind = new Map<BusinessPinKind, RenderablePin[]>();
  for (const p of pins) {
    if (!isBusinessPinKind(p.kind)) continue;
    const list = byKind.get(p.kind);
    if (list) list.push(p);
    else byKind.set(p.kind, [p]);
  }
  // THE ZERO-COST PATH. Nearly every turn takes it, which is what makes it
  // safe to do this work inline on the chat request rather than out of band.
  if (byKind.size === 0) return out;

  const allowed = await permittedKinds(prisma, ctx.scope);

  const denied: RenderablePin[] = [];
  for (const [kind, list] of byKind) {
    if (!allowed.has(kind)) {
      denied.push(...list);
      byKind.delete(kind);
    }
  }
  for (const p of denied) out.set(p.id, UNAVAILABLE);
  if (byKind.size === 0) return out;

  const idsFor = (k: BusinessPinKind): string[] => (byKind.get(k) ?? []).map((p) => p.ref);

  // One batched read per kind, all on primary keys. `select` is narrow on
  // purpose: a deal's `amountMinor` is a BigInt, and pulling money into a
  // prompt-rendering path would put a BigInt on a JSON path for no benefit -
  // the model has business_find for the figure.
  const [companies, deals, projects, workItems] = await Promise.all([
    byKind.has("customer")
      ? prisma.crmCompany.findMany({
          where: { id: { in: idsFor("customer") } },
          select: { id: true, name: true, isArchived: true },
        })
      : Promise.resolve([]),
    byKind.has("deal")
      ? prisma.crmDeal.findMany({
          where: { id: { in: idsFor("deal") } },
          select: {
            id: true,
            title: true,
            isArchived: true,
            company: { select: { name: true } },
          },
        })
      : Promise.resolve([]),
    byKind.has("project")
      ? prisma.pmProject.findMany({
          where: { id: { in: idsFor("project") } },
          select: { id: true, name: true, identifier: true, isArchived: true },
        })
      : Promise.resolve([]),
    byKind.has("work_item")
      ? prisma.pmWorkItem.findMany({
          where: { id: { in: idsFor("work_item") } },
          select: {
            id: true,
            name: true,
            sequenceId: true,
            isArchived: true,
            project: { select: { identifier: true, name: true } },
          },
        })
      : Promise.resolve([]),
  ]);

  const state = (isArchived: boolean): "active" | "archived" =>
    isArchived ? "archived" : "active";

  const rows = new Map<string, ContextPinTarget>();
  for (const c of companies) {
    rows.set(c.id, { state: state(c.isArchived), label: c.name, sublabel: null });
  }
  for (const d of deals) {
    rows.set(d.id, {
      state: state(d.isArchived),
      label: d.title,
      sublabel: d.company?.name ?? null,
    });
  }
  for (const p of projects) {
    rows.set(p.id, {
      state: state(p.isArchived),
      label: p.name,
      sublabel: p.identifier,
    });
  }
  for (const w of workItems) {
    // `PmProject.identifier` + `sequenceId` is the key humans use for a work
    // item ("NW-14"); the raw uuid is meaningless to everyone including the
    // model, which already has it in brackets.
    rows.set(w.id, {
      state: state(w.isArchived),
      label: w.name,
      sublabel: `${w.project.identifier}-${w.sequenceId}`,
    });
  }

  for (const list of byKind.values()) {
    for (const p of list) out.set(p.id, rows.get(p.ref) ?? MISSING);
  }
  return out;
}

export type PinTargetCheck =
  | { ok: true }
  | { ok: false; reason: "module_disabled"; module: ModuleId }
  | { ok: false; reason: "not_found" };

/**
 * The CREATE-time half. A pin is only accepted for a record the caller can
 * read RIGHT NOW.
 *
 * This does not make the per-turn check redundant and is not meant to: a
 * module can be turned off, or a record deleted, between the pin being made
 * and the next turn. Create-time validation is here so the failure surfaces
 * where the user can act on it - a 422 on the button they pressed - instead of
 * as a pin that silently never worked.
 */
export async function checkBusinessPinTarget(
  prisma: PinTargetReadClient,
  kind: BusinessPinKind,
  ref: string,
  ctx: PinResolveContext,
): Promise<PinTargetCheck> {
  const allowed = await permittedKinds(prisma, ctx.scope);
  if (!allowed.has(kind)) {
    return { ok: false, reason: "module_disabled", module: PIN_KIND_MODULE[kind] };
  }
  const found =
    kind === "customer"
      ? await prisma.crmCompany.findUnique({ where: { id: ref }, select: { id: true } })
      : kind === "deal"
        ? await prisma.crmDeal.findUnique({ where: { id: ref }, select: { id: true } })
        : kind === "project"
          ? await prisma.pmProject.findUnique({ where: { id: ref }, select: { id: true } })
          : await prisma.pmWorkItem.findUnique({ where: { id: ref }, select: { id: true } });
  return found ? { ok: true } : { ok: false, reason: "not_found" };
}
