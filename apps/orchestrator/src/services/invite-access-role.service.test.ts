/**
 * WARP-1533 (RBAC v2 T9) — invite-time access-role validation + accept-time
 * resolution.
 *
 * Two boundaries, two failure postures:
 *   - `validateInviteAccessRole` — CREATE time, fail-CLOSED. Shared by
 *     POST /api/people/invite and the legacy POST /api/auth/invites so the
 *     two surfaces can never diverge (the WARP-1523 lesson). The role must
 *     exist, be active, carry an assignable startingPoint (admin|family|
 *     guest — never owner/service), sit at-or-below the inviter's tier
 *     (WARP-623 rank cap, same 403 shape as the tier cap), and AGREE with
 *     the invite's tier (tier == startingPoint — the invariant the accept
 *     path relies on).
 *   - `resolveInviteAccessRoleForAccept` — ACCEPT time, fail-OPEN toward
 *     least privilege. A role that vanished/archived between invite and
 *     accept must never fail the accept; it reports WHY so the route can
 *     log + Activity-note the fallback to the invite's plain tier.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../config.js", () => ({
  config: { AUTH_ENABLED: false, agentMaxIter: { defaultIter: 5, capIter: 10 } },
}));

import {
  ASSIGNABLE_STARTING_POINTS,
  InviteAccessRoleError,
  isAssignableStartingPoint,
  resolveInviteAccessRoleForAccept,
  validateInviteAccessRole,
  type ValidatedInviteAccessRole,
} from "./invite-access-role.service.js";
import type { TeamInviteInput } from "./onboarding-team-invite.service.js";
import type { AccessRole } from "@prisma/client";

function roleRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "ar-1",
    name: "Finance",
    slug: "finance",
    description: null,
    startingPoint: "family",
    state: "active",
    storageQuotaBytes: null,
    maxUploadSizeMb: null,
    llmDailyMessageCap: null,
    cloudModelsAllowed: false,
    mayOperateLocks: false,
    createdBy: "u-owner",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function prismaWith(role: Record<string, unknown> | null) {
  return {
    accessRole: {
      findUnique: vi.fn(async ({ where }: any) =>
        role && where?.id === (role as any).id ? role : null,
      ),
    },
  } as any;
}

async function captureError(promise: Promise<unknown>): Promise<InviteAccessRoleError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(InviteAccessRoleError);
    return err as InviteAccessRoleError;
  }
  throw new Error("expected validateInviteAccessRole to throw");
}

describe("assignable starting points", () => {
  it("admits exactly admin/family/guest — never owner or service", () => {
    expect([...ASSIGNABLE_STARTING_POINTS]).toEqual(["admin", "family", "guest"]);
    expect(isAssignableStartingPoint("admin")).toBe(true);
    expect(isAssignableStartingPoint("family")).toBe(true);
    expect(isAssignableStartingPoint("guest")).toBe(true);
    expect(isAssignableStartingPoint("owner")).toBe(false);
    expect(isAssignableStartingPoint("service")).toBe(false);
    expect(isAssignableStartingPoint(null)).toBe(false);
  });
});

describe("validateInviteAccessRole (create time, fail-closed)", () => {
  it("returns the role when active, assignable, rank-capped, and tier-agreeing", async () => {
    const role = roleRow();
    const prisma = prismaWith(role);
    const result = await validateInviteAccessRole(prisma, {
      accessRoleId: "ar-1",
      inviteTier: "family",
      inviterRole: "owner",
    });
    expect(result).toBe(role);
    expect(prisma.accessRole.findUnique).toHaveBeenCalledWith({ where: { id: "ar-1" } });
  });

  it("PIN — an admin MAY invite with an Admin-based role (≤ their own tier, WARP-623)", async () => {
    const role = roleRow({ startingPoint: "admin" });
    const result = await validateInviteAccessRole(prismaWith(role), {
      accessRoleId: "ar-1",
      inviteTier: "admin",
      inviterRole: "admin",
    });
    expect(result).toBe(role);
  });

  it("404-shaped 400 when the role does not exist", async () => {
    const err = await captureError(
      validateInviteAccessRole(prismaWith(null), {
        accessRoleId: "ar-missing",
        inviteTier: "family",
        inviterRole: "owner",
      }),
    );
    expect(err.code).toBe("ACCESS_ROLE_NOT_FOUND");
    expect(err.status).toBe(400);
  });

  it("400 when the role is archived (state !== active)", async () => {
    const err = await captureError(
      validateInviteAccessRole(prismaWith(roleRow({ state: "archived" })), {
        accessRoleId: "ar-1",
        inviteTier: "family",
        inviterRole: "owner",
      }),
    );
    expect(err.code).toBe("ACCESS_ROLE_NOT_ACTIVE");
    expect(err.status).toBe(400);
  });

  it("fail-closed 400 on a non-assignable startingPoint (owner) even for an owner inviter", async () => {
    // The service layer owns the admin|family|guest CHECK (schema comment on
    // AccessRole.startingPoint) — a hand-planted owner-based row must never
    // ride an invite, and this fires BEFORE the rank cap so an owner inviter
    // can't slip it through as "at my own level".
    const err = await captureError(
      validateInviteAccessRole(prismaWith(roleRow({ startingPoint: "owner" })), {
        accessRoleId: "ar-1",
        inviteTier: "owner",
        inviterRole: "owner",
      }),
    );
    expect(err.code).toBe("ACCESS_ROLE_NOT_ASSIGNABLE");
    expect(err.status).toBe(400);
  });

  it("403 ROLE_RANK_EXCEEDED when the startingPoint outranks the inviter (same shape as the tier cap)", async () => {
    // Unreachable via the routes today (requireRole floors the caller at
    // admin; assignable startingPoints ceiling at admin) — this pins the
    // defense-in-depth for any future caller below the admin tier.
    const err = await captureError(
      validateInviteAccessRole(prismaWith(roleRow({ startingPoint: "admin" })), {
        accessRoleId: "ar-1",
        inviteTier: "admin",
        inviterRole: "family",
      }),
    );
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
    expect(err.status).toBe(403);
    expect(err.message).toBe("You cannot invite someone to a role higher than your own");
  });

  it("fails closed (403) when the inviter role claim is absent", async () => {
    const err = await captureError(
      validateInviteAccessRole(prismaWith(roleRow()), {
        accessRoleId: "ar-1",
        inviteTier: "family",
        inviterRole: undefined,
      }),
    );
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
    expect(err.status).toBe(403);
  });

  it("400 ROLE_TIER_MISMATCH when the invite tier disagrees with the startingPoint", async () => {
    const err = await captureError(
      validateInviteAccessRole(prismaWith(roleRow({ startingPoint: "family" })), {
        accessRoleId: "ar-1",
        inviteTier: "guest",
        inviterRole: "owner",
      }),
    );
    expect(err.code).toBe("ROLE_TIER_MISMATCH");
    expect(err.status).toBe(400);
  });
});

describe("the validated-role handoff is enforced by the TYPE (review F4)", () => {
  // These assertions are checked by `tsc --noEmit`, not at runtime: if the
  // brand ever weakens, the @ts-expect-error lines stop erroring and the
  // TYPECHECK fails (vitest would still report this file green).
  it("rejects a bare prisma AccessRole row at the createTeamInvite seam", () => {
    // The privesc path this closes: an unvalidated Admin-based role riding a
    // `role: "guest"` invite grants ADMIN on accept, because the accept path
    // re-checks role STATE but not the rank cap, then sets
    // `User.role = accessRole.startingPoint`.
    const fromPrisma = roleRow({ startingPoint: "admin" }) as unknown as AccessRole;
    const build = (): TeamInviteInput => ({
      email: "sneaky@acme.co",
      role: "guest",
      createdBy: "admin1",
      // @ts-expect-error — an unvalidated AccessRole (e.g. straight from
      // prisma.accessRole.findUnique) is NOT a ValidatedInviteAccessRole:
      // only validateInviteAccessRole mints the brand.
      accessRole: fromPrisma,
    });
    expect(build().email).toBe("sneaky@acme.co");
  });

  it("accepts the validator's own output", async () => {
    const role = roleRow();
    const validated: ValidatedInviteAccessRole = await validateInviteAccessRole(
      prismaWith(role),
      { accessRoleId: "ar-1", inviteTier: "family", inviterRole: "owner" },
    );
    // Type-level: assignable with no cast — the seam's whole contract.
    const input: TeamInviteInput = {
      email: "reception@acme.co",
      role: "family",
      createdBy: "owner1",
      accessRole: validated,
    };
    expect(input.accessRole?.id).toBe("ar-1");
  });
});

describe("resolveInviteAccessRoleForAccept (accept time, fail-open)", () => {
  it("resolves an active assignable role", async () => {
    const role = roleRow();
    const resolution = await resolveInviteAccessRoleForAccept(prismaWith(role), "ar-1");
    expect(resolution).toEqual({ role, fallback: null });
  });

  it("falls back (missing) when the role row is gone — never throws", async () => {
    const resolution = await resolveInviteAccessRoleForAccept(prismaWith(null), "ar-1");
    expect(resolution).toEqual({ role: null, fallback: "missing" });
  });

  it("falls back (archived) when the role was archived between invite and accept", async () => {
    const resolution = await resolveInviteAccessRoleForAccept(
      prismaWith(roleRow({ state: "archived" })),
      "ar-1",
    );
    expect(resolution).toEqual({ role: null, fallback: "archived" });
  });

  it("falls back (not_assignable) on a corrupt startingPoint — least privilege wins", async () => {
    const resolution = await resolveInviteAccessRoleForAccept(
      prismaWith(roleRow({ startingPoint: "service" })),
      "ar-1",
    );
    expect(resolution).toEqual({ role: null, fallback: "not_assignable" });
  });

  it("PROPAGATES an infra error instead of failing open to a fallback (review F1)", async () => {
    // The tolerance above is scoped to role STATE. A DB/query failure is NOT
    // a state verdict: swallowing it would silently turn "we couldn't read
    // the role" into the authorization decision "plain tier", and the audit
    // trail could not tell the two apart. The throw is the contract — a
    // future defensive catch here must fail this test.
    const prisma = {
      accessRole: {
        findUnique: vi.fn(async () => {
          throw new Error("connection terminated unexpectedly");
        }),
      },
    } as never;
    await expect(resolveInviteAccessRoleForAccept(prisma, "ar-1")).rejects.toThrow(
      "connection terminated unexpectedly",
    );
  });
});
