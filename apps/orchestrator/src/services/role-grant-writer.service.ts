/**
 * WARP-2897 (ADR-056 slice I-0) — the ONE writer of `AccessRoleToolGrant`.
 *
 * Tool grants were written inline in routes/access.ts (create and PATCH),
 * validated by a zod enum over the COMPILED grantable domains. That had two
 * problems once runtime tools exist:
 *
 *   1. a runtime-only domain (an extension's, once slice H names them) could
 *      never be granted — the enum 400'd it — so a role grant could never
 *      admit an extension's tools to a scoped person;
 *   2. every future writer (slice I-1's toolset promotion, an extension
 *      uninstall) would have had to re-implement the validation, and the one
 *      that forgot would store a standing grant on something nobody reviewed.
 *
 * So the rows are written here and nowhere else —
 * `__tests__/tool-grant-write-path.guard.test.ts` scans the tree, direct and
 * nested writes alike, and fails on a second writer — and this file owns the
 * grantability rule (`assertGrantableToolDomains`).
 *
 * ## Introduce vs keep
 *
 * A grant is refused when it INTRODUCES a domain that is not grantable now
 * (`isGrantableDomain`: erp never; a compiled grantable domain always; a
 * runtime-only domain only while some runtime tool carries it). A domain the
 * role ALREADY holds may stay even if it has gone dead since — an extension
 * disabled, a remote server detached. Dead grants are MARKED
 * ({@link toolGrantStates}, surfaced on GET /api/access/roles), never
 * force-dropped: the dashboard re-emits a role's untouched rows verbatim on
 * every save, so refusing a held dead row would make that role uneditable,
 * and deleting it would silently undo an operator's decision the moment an
 * extension is restarted. `erp` is refused even when held.
 *
 * Uninstall-time removal and toolset-promotion merges (`removeDomainGrantsTx`,
 * `addToolGrantsTx`) land with slice I-1, where their callers are.
 */
import type { Prisma } from "@prisma/client";
import { TOOL_DOMAINS } from "@droplet/tools-core";
import { isGrantableDomain } from "./access-catalog.js";
import { populatedDomains, type ToolLayers } from "./tool-layers.service.js";

export interface ToolGrantInput {
  domain: string;
  level: "view" | "use";
}

/** The Prisma surface this module writes through — a transaction handle. */
export type ToolGrantTx = Pick<Prisma.TransactionClient, "accessRoleToolGrant">;

export interface GrantabilityContext {
  /** Both tool layers, loaded by the caller (tool-layers.service.ts). */
  layers: ToolLayers;
  /** Domains the role already holds; kept even when no longer grantable. */
  alreadyHeld?: Iterable<string>;
}

/** Refusal for a write that introduces a domain nothing on this box provides
 *  (or `erp`). Machine-readable `code`; `domains` names every offender. */
export class UngrantableToolDomainError extends Error {
  readonly status = 400;
  readonly code = "TOOL_DOMAIN_NOT_GRANTABLE";
  readonly domains: string[];

  constructor(domains: string[]) {
    super(
      `These tool domains cannot be granted: ${domains.join(", ")}. ` +
        "A tool grant must name a domain some tool on this box provides " +
        "(the compiled catalog or an attached server), and never erp — " +
        "connector access is set under Data connectors.",
    );
    this.name = "UngrantableToolDomainError";
    this.domains = domains;
  }

  toJSON(): { error: string; code: string; domains: string[] } {
    return { error: this.message, code: this.code, domains: this.domains };
  }
}

export function isUngrantableToolDomainError(err: unknown): err is UngrantableToolDomainError {
  return err instanceof UngrantableToolDomainError;
}

/** Throw {@link UngrantableToolDomainError} naming every grant that may not
 *  be written. Pure. */
export function assertGrantableToolDomains(
  grants: readonly ToolGrantInput[],
  ctx: GrantabilityContext,
): void {
  const held = new Set(ctx.alreadyHeld ?? []);
  const refused = grants
    .map((g) => g.domain)
    .filter((domain) => {
      if (domain === "erp") return true;
      if (held.has(domain)) return false;
      return !isGrantableDomain(domain, ctx.layers);
    });
  if (refused.length > 0) throw new UngrantableToolDomainError([...new Set(refused)]);
}

/** Grant rows for a role that has none yet (the create path). */
export async function createToolGrantsTx(
  tx: ToolGrantTx,
  roleId: string,
  grants: readonly ToolGrantInput[],
  ctx: GrantabilityContext,
): Promise<void> {
  assertGrantableToolDomains(grants, ctx);
  if (grants.length === 0) return;
  await tx.accessRoleToolGrant.createMany({
    data: grants.map((g) => ({ roleId, domain: g.domain, level: g.level })),
  });
}

/**
 * Replace a role's grant rows wholesale (PATCH with `toolGrants`). The role's
 * current domains are read INSIDE the transaction, so "already held" is the
 * committed state this write serializes against, not a pre-transaction read.
 */
export async function replaceToolGrantsTx(
  tx: ToolGrantTx,
  roleId: string,
  grants: readonly ToolGrantInput[],
  ctx: { layers: ToolLayers },
): Promise<void> {
  const current = await tx.accessRoleToolGrant.findMany({
    where: { roleId },
    select: { domain: true },
  });
  assertGrantableToolDomains(grants, {
    layers: ctx.layers,
    alreadyHeld: current.map((r) => r.domain),
  });
  await tx.accessRoleToolGrant.deleteMany({ where: { roleId } });
  if (grants.length === 0) return;
  await tx.accessRoleToolGrant.createMany({
    data: grants.map((g) => ({ roleId, domain: g.domain, level: g.level })),
  });
}

// ── dead-grant marking (read side) ───────────────────────────────

/**
 * Why a grant reaches nothing.
 *   - `empty_domain`: a compiled domain that holds no tool — today `crm` and
 *     `pm`, the landing slots ADR-045 left for a remote catalog. Expected;
 *     the dashboard does not badge these.
 *   - `not_provided`: a domain the compiled vocabulary does not declare and
 *     no attached runtime tool carries — an extension's domain after its
 *     extension was disabled, or a remote server's after it detached.
 */
export type ToolGrantDeadReason = "empty_domain" | "not_provided";

export interface ToolGrantState extends ToolGrantInput {
  state: "live" | "dead";
  deadReason: ToolGrantDeadReason | null;
}

const COMPILED: ReadonlySet<string> = new Set<string>(TOOL_DOMAINS);

/** Mark each grant live or dead against both tool layers. Rows are never
 *  deleted for being dead; this is a statement about reach, not a cleanup. */
export function toolGrantStates(
  grants: ReadonlyArray<{ domain: string; level: string }>,
  layers: ToolLayers,
): ToolGrantState[] {
  const populated = populatedDomains(layers);
  return grants.map((g) => {
    const live = populated.has(g.domain);
    return {
      domain: g.domain,
      level: g.level as ToolGrantInput["level"],
      state: live ? "live" : "dead",
      deadReason: live ? null : COMPILED.has(g.domain) ? "empty_domain" : "not_provided",
    };
  });
}
