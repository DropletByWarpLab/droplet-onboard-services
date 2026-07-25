/**
 * WARP-1526 (RBAC v2 T2) — role-mutation-guard.service unit tests.
 *
 * One service, six rails (ADR-032 draft §4), invoked by every person-mutation
 * path on BOTH user surfaces (/api/people/*, /api/auth/users*):
 *
 *   1. Owner untouchable  — 403 OWNER_IMMUTABLE (new)
 *   2. Self-action        — 409 SELF_ACTION_NOT_ALLOWED (WARP-480, moved here)
 *   3. Rank cap           — 403 ROLE_RANK_EXCEEDED (WARP-1523, moved here)
 *   4. Last-owner         — 409 LAST_OWNER_INVARIANT (WARP-480, moved here;
 *                           in-tx backstop — rail 1 shadows it at the routes)
 *   5. Last-operator      — 409 LAST_OPERATOR_INVARIANT (new; in-tx)
 *   7*. Assignable enum   — 403 ROLE_NOT_ASSIGNABLE (new; ticket comments —
 *                           people are {admin, family, guest}, never owner or
 *                           service; design brief §6.2)
 *   6. Post-commit effects — revokeAllSessions + Activity + NC droplet-admins
 *                           cascade, consolidated into runner functions.
 *
 * Rail ORDER inside the composites is contract (pinned here):
 *   pre-tx : self(2) → owner-target(1) → rank(3) → assignable(7)
 *   in-tx  : last-owner(4) → last-operator(5)
 * Rank runs BEFORE assignable so the WARP-1523 pins (admin→owner ⇒
 * ROLE_RANK_EXCEEDED) keep their exact code; assignable then bites only the
 * owner-actor cases the ticket consciously supersedes.
 *
 * The rails are pure (no prisma import); tx invariants take a tx handle so
 * they run inside the caller's serializable $transaction (the people.ts
 * LAST_OWNER_INVARIANT pattern). Post-effect runners are tested with the
 * same module mocks the route suites use.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  revokeAllSessionsMock,
  denylistUserMock,
  recordActivityMock,
  ncAddUserToGroupMock,
  ncRemoveUserFromGroupMock,
} = vi.hoisted(() => ({
  revokeAllSessionsMock: vi.fn().mockResolvedValue(0),
  denylistUserMock: vi.fn().mockResolvedValue(undefined),
  recordActivityMock: vi.fn().mockResolvedValue(null),
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./session.service.js", () => ({
  revokeAllSessions: revokeAllSessionsMock,
}));
vi.mock("./auth-denylist.service.js", () => ({
  denylistUser: denylistUserMock,
}));
vi.mock("./activity.singleton.js", () => ({
  recordActivity: recordActivityMock,
}));
vi.mock("./nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
}));
vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic:dGVzdDp0ZXN0"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));

import {
  RoleMutationRefusedError,
  ASSIGNABLE_ROLES,
  ADMIN_TIER_ROLES,
  assertNotSelf,
  assertTargetNotOwner,
  assertRankCap,
  assertRoleAssignable,
  assertRoleChangeAllowed,
  assertRemovalAllowed,
  assertDisableAllowed,
  assertUsageWriteAllowed,
  assertAssignableForCreate,
  assertRoleChangeInvariantsTx,
  assertRemovalInvariantsTx,
  assertDisableInvariantsTx,
  runRoleChangePostEffects,
  runRemovalPostEffects,
  runDisablePostEffects,
} from "./role-mutation-guard.service.js";

/** Catch helper — every rail throws RoleMutationRefusedError, never returns. */
function refusal(fn: () => unknown): RoleMutationRefusedError {
  try {
    fn();
  } catch (err) {
    if (err instanceof RoleMutationRefusedError) return err;
    throw err;
  }
  throw new Error("expected RoleMutationRefusedError, got a pass");
}

async function refusalAsync(
  fn: () => Promise<unknown>,
): Promise<RoleMutationRefusedError> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof RoleMutationRefusedError) return err;
    throw err;
  }
  throw new Error("expected RoleMutationRefusedError, got a pass");
}

/**
 * tx stub for the in-tx invariants. Pins the EXACT where-shapes the guard
 * may issue:
 *   - owner count      : { role: "owner" }  (byte-identical to the WARP-480
 *     people.ts count so existing route-suite prisma mocks keep working)
 *   - operator count   : { role: { in: ["owner","admin"] },
 *                          directoryStatus: "ACTIVE", id: { not: <target> } }
 */
function txStub(counts: { owners: number; activeOperatorsExcludingTarget: number }) {
  const count = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
    if (where.role === "owner" && where.id === undefined) return counts.owners;
    const roleIn = (where.role as { in?: string[] } | undefined)?.in;
    if (
      Array.isArray(roleIn) &&
      roleIn.length === 2 &&
      roleIn.includes("owner") &&
      roleIn.includes("admin") &&
      where.directoryStatus === "ACTIVE" &&
      typeof (where.id as { not?: string } | undefined)?.not === "string"
    ) {
      return counts.activeOperatorsExcludingTarget;
    }
    throw new Error(`unexpected count where-shape: ${JSON.stringify(where)}`);
  });
  return { user: { count } };
}

beforeEach(() => {
  revokeAllSessionsMock.mockClear().mockResolvedValue(0);
  denylistUserMock.mockClear().mockResolvedValue(undefined);
  recordActivityMock.mockClear().mockResolvedValue(null);
  ncAddUserToGroupMock.mockClear().mockResolvedValue(undefined);
  ncRemoveUserFromGroupMock.mockClear().mockResolvedValue(undefined);
});

describe("vocabulary constants", () => {
  it("ASSIGNABLE_ROLES is exactly {admin, family, guest} — never owner or service (design brief §6.2)", () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual(["admin", "family", "guest"]);
  });

  it("ADMIN_TIER_ROLES (the operator set / NC droplet-admins tier) is exactly {owner, admin}", () => {
    expect([...ADMIN_TIER_ROLES].sort()).toEqual(["admin", "owner"]);
  });
});

describe("rail 2 — assertNotSelf (SELF_ACTION_NOT_ALLOWED)", () => {
  it("throws 409 SELF_ACTION_NOT_ALLOWED with the shipped WARP-480 copy on a self-target", () => {
    const err = refusal(() => assertNotSelf("u1", "u1"));
    expect(err.status).toBe(409);
    expect(err.code).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(err.message).toBe("Cannot modify your own role, scope, or account");
    expect(err.toJSON()).toEqual({
      error: "Cannot modify your own role, scope, or account",
      code: "SELF_ACTION_NOT_ALLOWED",
    });
  });

  it("passes for a different target, and for a missing actor id (auth middleware owns presence)", () => {
    expect(() => assertNotSelf("u1", "u2")).not.toThrow();
    expect(() => assertNotSelf(undefined, "u2")).not.toThrow();
  });
});

describe("rail 1 — assertTargetNotOwner (OWNER_IMMUTABLE)", () => {
  it("throws 403 OWNER_IMMUTABLE with the design-brief §12 copy when the target row is an owner", () => {
    const err = refusal(() => assertTargetNotOwner("owner"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("OWNER_IMMUTABLE");
    expect(err.message).toBe(
      "The owner has full control and can't be changed here.",
    );
  });

  it("passes for every non-owner tier", () => {
    for (const role of ["admin", "family", "guest", "service"] as const) {
      expect(() => assertTargetNotOwner(role)).not.toThrow();
    }
  });
});

describe("rail 3 — assertRankCap (ROLE_RANK_EXCEEDED)", () => {
  it("throws 403 ROLE_RANK_EXCEEDED when the requested role outranks the actor (admin → owner)", () => {
    const err = refusal(() =>
      assertRankCap("admin", "owner", "You cannot assign a role higher than your own"),
    );
    expect(err.status).toBe(403);
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
    expect(err.message).toBe("You cannot assign a role higher than your own");
  });

  it("fails CLOSED when the actor role claim is absent", () => {
    const err = refusal(() =>
      assertRankCap(undefined, "guest", "You cannot assign a role higher than your own"),
    );
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
  });

  it("equal rank passes (admin→admin — last-admin recovery keeps working; WARP-1523 <= semantics)", () => {
    expect(() =>
      assertRankCap("admin", "admin", "You cannot assign a role higher than your own"),
    ).not.toThrow();
  });

  it("carries the per-site message verbatim (invite sites keep their shipped copy)", () => {
    const err = refusal(() =>
      assertRankCap("admin", "owner", "You cannot invite someone to a role higher than your own"),
    );
    expect(err.message).toBe(
      "You cannot invite someone to a role higher than your own",
    );
  });
});

describe("rail 7 — assertRoleAssignable (ROLE_NOT_ASSIGNABLE)", () => {
  it("throws 403 ROLE_NOT_ASSIGNABLE for owner — exactly one owner by design; ownership transfer is a future dedicated flow", () => {
    const err = refusal(() => assertRoleAssignable("owner"));
    expect(err.status).toBe(403);
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
    expect(err.message).toBe("This role can't be assigned to a person.");
  });

  it("throws 403 ROLE_NOT_ASSIGNABLE for service — rank −1, env-var-only principal (jwt.service doc)", () => {
    const err = refusal(() => assertRoleAssignable("service"));
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
  });

  it("passes for the three human-assignable tiers", () => {
    for (const role of ASSIGNABLE_ROLES) {
      expect(() => assertRoleAssignable(role)).not.toThrow();
    }
  });
});

describe("composite — assertRoleChangeAllowed (pre-tx order: self → owner → rank → assignable)", () => {
  const actor = { id: "adm-1", role: "admin" as const };

  it("self beats owner-target (actor editing their own owner row → 409 SELF, matching the shipped people-surface order)", () => {
    const err = refusal(() =>
      assertRoleChangeAllowed({
        actor: { id: "own-1", role: "owner" },
        target: { id: "own-1", role: "owner" },
        requestedRole: "admin",
      }),
    );
    expect(err.code).toBe("SELF_ACTION_NOT_ALLOWED");
  });

  it("owner-target beats rank (admin demoting the owner → OWNER_IMMUTABLE, not RANK/LAST_OWNER)", () => {
    const err = refusal(() =>
      assertRoleChangeAllowed({
        actor,
        target: { id: "own-1", role: "owner" },
        requestedRole: "family",
      }),
    );
    expect(err.code).toBe("OWNER_IMMUTABLE");
  });

  it("rank beats assignable (admin → owner on a family target keeps the exact WARP-1523 ROLE_RANK_EXCEEDED pin)", () => {
    const err = refusal(() =>
      assertRoleChangeAllowed({
        actor,
        target: { id: "u1", role: "family" },
        requestedRole: "owner",
      }),
    );
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
  });

  it("owner actor requesting owner → ROLE_NOT_ASSIGNABLE (the conscious WARP-1526 supersession of the #1221 owner→owner pin)", () => {
    const err = refusal(() =>
      assertRoleChangeAllowed({
        actor: { id: "own-1", role: "owner" },
        target: { id: "u1", role: "admin" },
        requestedRole: "owner",
      }),
    );
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
  });

  it("service is refused even though its rank (−1) clears the cap", () => {
    const err = refusal(() =>
      assertRoleChangeAllowed({
        actor,
        target: { id: "u1", role: "family" },
        requestedRole: "service",
      }),
    );
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
  });

  it("a plain allowed change passes (admin assigns family → guest)", () => {
    expect(() =>
      assertRoleChangeAllowed({
        actor,
        target: { id: "u1", role: "family" },
        requestedRole: "guest",
      }),
    ).not.toThrow();
  });
});

describe("composites — assertRemovalAllowed / assertDisableAllowed / assertUsageWriteAllowed", () => {
  it("removal: self first, then owner-target", () => {
    expect(
      refusal(() =>
        assertRemovalAllowed({
          actor: { id: "u1", role: "admin" },
          target: { id: "u1", role: "admin" },
        }),
      ).code,
    ).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(
      refusal(() =>
        assertRemovalAllowed({
          actor: { id: "adm-1", role: "admin" },
          target: { id: "own-1", role: "owner" },
        }),
      ).code,
    ).toBe("OWNER_IMMUTABLE");
    expect(() =>
      assertRemovalAllowed({
        actor: { id: "adm-1", role: "admin" },
        target: { id: "u1", role: "family" },
      }),
    ).not.toThrow();
  });

  it("disable: same two rails, same order", () => {
    expect(
      refusal(() =>
        assertDisableAllowed({
          actor: { id: "u1", role: "admin" },
          target: { id: "u1", role: "admin" },
        }),
      ).code,
    ).toBe("SELF_ACTION_NOT_ALLOWED");
    expect(
      refusal(() =>
        assertDisableAllowed({
          actor: { id: "adm-1", role: "admin" },
          target: { id: "own-1", role: "owner" },
        }),
      ).code,
    ).toBe("OWNER_IMMUTABLE");
  });

  it("usage write: owner-target only (self-edit of one's own usage stays allowed — it can't lock anyone out)", () => {
    expect(
      refusal(() => assertUsageWriteAllowed({ target: { id: "own-1", role: "owner" } }))
        .code,
    ).toBe("OWNER_IMMUTABLE");
    expect(() =>
      assertUsageWriteAllowed({ target: { id: "u1", role: "family" } }),
    ).not.toThrow();
  });
});

describe("composite — assertAssignableForCreate (create/invite sites: rank → assignable)", () => {
  it("admin minting an owner → ROLE_RANK_EXCEEDED with the site's own message (pins preserved)", () => {
    const err = refusal(() =>
      assertAssignableForCreate({
        actorRole: "admin",
        requestedRole: "owner",
        rankMessage: "You cannot create an account with a role higher than your own",
      }),
    );
    expect(err.code).toBe("ROLE_RANK_EXCEEDED");
    expect(err.message).toBe(
      "You cannot create an account with a role higher than your own",
    );
  });

  it("owner minting an owner → ROLE_NOT_ASSIGNABLE (supersedes the three owner→owner create/invite pins)", () => {
    const err = refusal(() =>
      assertAssignableForCreate({
        actorRole: "owner",
        requestedRole: "owner",
        rankMessage: "You cannot create an account with a role higher than your own",
      }),
    );
    expect(err.code).toBe("ROLE_NOT_ASSIGNABLE");
  });

  it("owner/admin creating within the assignable set passes", () => {
    expect(() =>
      assertAssignableForCreate({
        actorRole: "owner",
        requestedRole: "admin",
        rankMessage: "x",
      }),
    ).not.toThrow();
    expect(() =>
      assertAssignableForCreate({
        actorRole: "admin",
        requestedRole: "guest",
        rankMessage: "x",
      }),
    ).not.toThrow();
  });
});

describe("rail 4 (in-tx backstop) — last-owner invariant", () => {
  it("demoting the only owner throws 409 LAST_OWNER_INVARIANT with the shipped copy", async () => {
    const tx = txStub({ owners: 1, activeOperatorsExcludingTarget: 5 });
    const err = await refusalAsync(() =>
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "own-1", role: "owner" },
        requestedRole: "family",
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("LAST_OWNER_INVARIANT");
    expect(err.message).toBe(
      "Cannot remove the only owner. Promote another user to owner first.",
    );
  });

  it("removing the only owner throws LAST_OWNER_INVARIANT (removal variant)", async () => {
    const tx = txStub({ owners: 1, activeOperatorsExcludingTarget: 5 });
    const err = await refusalAsync(() =>
      assertRemovalInvariantsTx(tx, { target: { id: "own-1", role: "owner" } }),
    );
    expect(err.code).toBe("LAST_OWNER_INVARIANT");
  });

  it("owner→owner-count 2 passes the owner rail (invariant fires at count <= 1 only)", async () => {
    const tx = txStub({ owners: 2, activeOperatorsExcludingTarget: 5 });
    await expect(
      assertRemovalInvariantsTx(tx, { target: { id: "own-2", role: "owner" } }),
    ).resolves.toBeUndefined();
  });

  it("non-owner mutations never touch the owner count", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 5 });
    await expect(
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "u1", role: "family" },
        requestedRole: "guest",
      }),
    ).resolves.toBeUndefined();
  });
});

describe("rail 5 (in-tx) — last-operator invariant", () => {
  it("demoting the sole ACTIVE admin (no owner in the directory) throws 409 LAST_OPERATOR_INVARIANT with the design copy", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 0 });
    const err = await refusalAsync(() =>
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "adm-1", role: "admin" },
        requestedRole: "family",
      }),
    );
    expect(err.status).toBe(409);
    expect(err.code).toBe("LAST_OPERATOR_INVARIANT");
    expect(err.message).toBe(
      "This is the last person who can manage access — give someone else an admin role first.",
    );
  });

  it("demoting one of two admins passes (a peer operator remains)", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 1 });
    await expect(
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "adm-1", role: "admin" },
        requestedRole: "family",
      }),
    ).resolves.toBeUndefined();
  });

  it("an ACTIVE owner counts as the remaining operator — demoting the only admin under an owner passes", async () => {
    // The owner can never be demoted/disabled/removed (rail 1), so their
    // presence permanently satisfies the invariant. This is the
    // "owner-never-counts-as-removable" behavior from the ticket.
    const tx = txStub({ owners: 1, activeOperatorsExcludingTarget: 1 });
    await expect(
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "adm-1", role: "admin" },
        requestedRole: "guest",
      }),
    ).resolves.toBeUndefined();
  });

  it("disabling the sole ACTIVE operator throws; disabling an already-DEACTIVATED row is a pass (idempotent)", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 0 });
    const err = await refusalAsync(() =>
      assertDisableInvariantsTx(tx, {
        target: { id: "adm-1", role: "admin", directoryStatus: "ACTIVE" },
      }),
    );
    expect(err.code).toBe("LAST_OPERATOR_INVARIANT");

    await expect(
      assertDisableInvariantsTx(tx, {
        target: { id: "adm-1", role: "admin", directoryStatus: "DEACTIVATED" },
      }),
    ).resolves.toBeUndefined();
  });

  it("disabling / demoting a non-operator (family, guest) never counts operators", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 0 });
    await expect(
      assertDisableInvariantsTx(tx, {
        target: { id: "u1", role: "family", directoryStatus: "ACTIVE" },
      }),
    ).resolves.toBeUndefined();
    await expect(
      assertRoleChangeInvariantsTx(tx, {
        target: { id: "u1", role: "guest" },
        requestedRole: "family",
      }),
    ).resolves.toBeUndefined();
  });

  it("removing the sole ACTIVE admin (no owner) throws LAST_OPERATOR_INVARIANT (removal variant)", async () => {
    const tx = txStub({ owners: 0, activeOperatorsExcludingTarget: 0 });
    const err = await refusalAsync(() =>
      assertRemovalInvariantsTx(tx, { target: { id: "adm-1", role: "admin" } }),
    );
    expect(err.code).toBe("LAST_OPERATOR_INVARIANT");
  });
});

describe("rail 6 — runRoleChangePostEffects (revoke → NC droplet-admins cascade → Activity)", () => {
  const base = {
    target: {
      id: "u1",
      username: "alice",
      nextcloudUsername: "alice" as string | null,
    },
    previousRole: "family" as const,
    nextRole: "admin" as const,
    actorUsername: "stefan" as string | null,
    actor: { type: "user", id: "owner-id" } as const,
  };

  it("revokes the target's sessions, adds to droplet-admins on a family→admin crossing, and emits the pinned 'Role changed' row", async () => {
    await runRoleChangePostEffects(base);

    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith(
      "basic:dGVzdDp0ZXN0",
      "alice",
      "droplet-admins",
    );
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        severity: "ok",
        sourceIcon: "shield",
        what: "Role changed",
        sub: "alice: family → admin",
        refs: {
          actor: "stefan",
          targetUserId: "u1",
          targetUsername: "alice",
          previousRole: "family",
          nextRole: "admin",
        },
      }),
    );
  });

  it("removes from droplet-admins on admin→family; no NC call on a non-crossing change or a null nextcloudUsername", async () => {
    await runRoleChangePostEffects({
      ...base,
      previousRole: "admin",
      nextRole: "family",
    });
    expect(ncRemoveUserFromGroupMock).toHaveBeenCalledTimes(1);

    ncAddUserToGroupMock.mockClear();
    ncRemoveUserFromGroupMock.mockClear();
    await runRoleChangePostEffects({
      ...base,
      previousRole: "admin",
      nextRole: "owner",
    });
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
    expect(ncRemoveUserFromGroupMock).not.toHaveBeenCalled();

    await runRoleChangePostEffects({
      ...base,
      target: { ...base.target, nextcloudUsername: null },
    });
    expect(ncAddUserToGroupMock).not.toHaveBeenCalled();
  });

  it("NC cascade failure is non-blocking (logged, still emits Activity)", async () => {
    ncAddUserToGroupMock.mockRejectedValueOnce(new Error("nc unreachable"));
    await expect(runRoleChangePostEffects(base)).resolves.toBeUndefined();
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
  });
});

describe("rail 6 — runRemovalPostEffects (revoke + denylist + 'User removed' Activity)", () => {
  it("hard-revokes credentials and emits the WARP-490-shaped row", async () => {
    await runRemovalPostEffects({
      targetUserId: "u1",
      targetUsername: "alice",
      targetRole: "family",
      actorUsername: "stefan",
      actor: { type: "user", id: "owner-id" },
    });
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u1");
    expect(denylistUserMock).toHaveBeenCalledWith("u1", expect.any(Number));
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        sourceIcon: "user-x",
        what: "User removed",
        sub: "alice",
        refs: expect.objectContaining({
          actor: "stefan",
          targetUserId: "u1",
          targetUsername: "alice",
          role: "family",
        }),
      }),
    );
  });

  it("legacy NC-only removal (no local row): skips revoke/denylist, still emits the audit row with targetUserId null", async () => {
    await runRemovalPostEffects({
      targetUserId: null,
      targetUsername: "legacy",
      targetRole: null,
      actorUsername: "stefan",
      actor: { type: "user", id: "owner-id" },
    });
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(denylistUserMock).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        what: "User removed",
        refs: expect.objectContaining({ targetUserId: null }),
      }),
    );
  });
});

describe("rail 6 — runDisablePostEffects (revoke + pinned 'User disabled' Activity)", () => {
  it("revokes by id and emits the WARP-1062 row with the revoked count", async () => {
    revokeAllSessionsMock.mockResolvedValueOnce(2);
    await runDisablePostEffects({
      targetUserId: "u-alice",
      username: "alice",
      actor: { type: "user", id: "owner-id" },
    });
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-alice");
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        sourceIcon: "shield-off",
        what: "User disabled",
        sub: "alice",
        refs: { username: "alice", targetUserId: "u-alice", sessionsRevoked: 2 },
      }),
    );
  });

  it("legacy NC-only disable: no revoke, row still emitted with targetUserId null / 0 revoked", async () => {
    await runDisablePostEffects({
      targetUserId: null,
      username: "legacy",
      actor: { type: "user", id: "owner-id" },
    });
    expect(revokeAllSessionsMock).not.toHaveBeenCalled();
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        refs: { username: "legacy", targetUserId: null, sessionsRevoked: 0 },
      }),
    );
  });
});
