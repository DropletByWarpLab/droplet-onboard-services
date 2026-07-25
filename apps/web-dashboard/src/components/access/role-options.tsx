"use client";

/**
 * WARP-1533 (RBAC v2 T9) — the ONE role-picker option builder.
 *
 * Extracted from PersonAccessSection's role select (WARP-1532) so the invite
 * modal renders the IDENTICAL control (design brief §7: "Assigning a custom
 * role at invite time uses the identical control the person editor uses — no
 * new pattern"). Both selects share:
 *
 *   - the `role:<id>` / `tier:<tier>` option-value scheme;
 *   - the grouping — `Your roles` (custom, when any) ABOVE `Built-in`
 *     (Admin / Staff / Guest — NEVER Owner or Service);
 *   - the WARP-623 rank gate: options above the acting admin's tier render
 *     disabled with the §12 rank-cap reason, never hidden.
 *
 * The person editor's one extra affordance (rendering the CURRENT owner
 * value read-only so a disabled select never shows empty) stays available
 * via `includeOwnerOption` — the invite modal never sets it.
 */
import type { AccessRole, AccessTier } from "@/lib/types";
import { TIER_RANK, tierLabel } from "@/lib/access";
import { ACCESS_COPY } from "./copy";

/** A role-select value: a custom role reference or a built-in tier. */
export type RoleOptionValue = `role:${string}` | `tier:${string}`;

/** The built-in tiers either picker may assign (never owner/service). */
export const ASSIGNABLE_TIERS = ["admin", "family", "guest"] as const;

/** The enforcement tier an option resolves to — a custom role's starting
 *  point, or the tier itself. Unknown role ids resolve to `guest`
 *  (fail-toward-least-privilege; the server re-validates regardless). */
export function roleOptionTier(value: string, roles: AccessRole[]): AccessTier {
  if (value.startsWith("tier:")) return value.slice(5) as AccessTier;
  const role = roles.find((r) => r.id === value.slice(5));
  return role?.startingPoint ?? "guest";
}

/** Split an option value into the wire pair the invite/assign calls send:
 *  the canonical tier plus the custom role id (null for built-in tiers). */
export function parseRoleOption(
  value: string,
  roles: AccessRole[],
): { tier: AccessTier; accessRoleId: string | null } {
  return {
    tier: roleOptionTier(value, roles),
    accessRoleId: value.startsWith("role:") ? value.slice(5) : null,
  };
}

/** WARP-623 — true when the option's tier outranks the acting admin's. */
export function roleOptionBlocked(
  value: string,
  roles: AccessRole[],
  actingTier: AccessTier,
): boolean {
  return TIER_RANK[roleOptionTier(value, roles)] > TIER_RANK[actingTier];
}

export interface RoleSelectOptionsProps {
  /** Active custom roles (empty array ⇒ the `Your roles` group is absent). */
  roles: AccessRole[];
  /** The acting admin's tier — options above it disable (WARP-623). */
  actingTier: AccessTier;
  /** Person editor only: render the read-only Owner value so a disabled
   *  select still shows the truth — never an empty control. */
  includeOwnerOption?: boolean;
}

/** The shared <optgroup> body for a role select. Render inside a <select>. */
export function RoleSelectOptions({
  roles,
  actingTier,
  includeOwnerOption = false,
}: RoleSelectOptionsProps) {
  return (
    <>
      {roles.length > 0 && (
        <optgroup label={ACCESS_COPY.yourRoles}>
          {roles.map((role) => (
            <option
              key={role.id}
              value={`role:${role.id}`}
              disabled={roleOptionBlocked(`role:${role.id}`, roles, actingTier)}
              title={
                roleOptionBlocked(`role:${role.id}`, roles, actingTier)
                  ? ACCESS_COPY.rankCap
                  : undefined
              }
            >
              {role.name}
            </option>
          ))}
        </optgroup>
      )}
      <optgroup label={ACCESS_COPY.builtIn}>
        {ASSIGNABLE_TIERS.map((tier) => (
          <option
            key={tier}
            value={`tier:${tier}`}
            disabled={roleOptionBlocked(`tier:${tier}`, roles, actingTier)}
            title={
              roleOptionBlocked(`tier:${tier}`, roles, actingTier)
                ? ACCESS_COPY.rankCap
                : undefined
            }
          >
            {tierLabel(tier)}
          </option>
        ))}
        {/* The current owner value renders (read-only) so the disabled
            select still shows the truth — never an empty control. */}
        {includeOwnerOption && <option value="tier:owner">{tierLabel("owner")}</option>}
      </optgroup>
    </>
  );
}
