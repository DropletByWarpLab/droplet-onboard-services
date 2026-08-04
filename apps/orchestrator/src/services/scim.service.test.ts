/**
 * WARP (SCIM directory sync) — provisioning service (the SCIM ↔ local-User
 * mapping + idempotency + soft-deactivation, DB boundary mocked).
 *
 * Surfaces under test (Prisma mocked in-memory):
 *   - provisionUser: create-or-update keyed by NORMALIZED email. Idempotent
 *     (Okta retries the same POST). New rows are least-privilege (family),
 *     ACTIVE, no passwordHash (SCIM users can't password-login), and linked
 *     via SsoIdentity(provider="okta", subject=externalId|User.id) — REUSING
 *     the existing identity table. Re-provisioning preserves User.id.
 *   - deactivateUser: SOFT — sets directoryStatus DEACTIVATED, never deletes.
 *     Idempotent. reactivate flips back to ACTIVE.
 *   - findUserById / findUserByUserName: resolve for GET-by-id + the
 *     `userName eq` filter.
 *   - provisionGroup: upsert ScimGroup (mappedRole from the name) and raise
 *     each listed member's role to at least the group's mapped role.
 *   - WARP-1568: those role writes run through the role-mutation guard, and
 *     the mapping is capped at `admin` — SCIM can never mint an owner.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  recordActivityMock,
  revokeAllSessionsMock,
  denylistUserMock,
  ncAddUserToGroupMock,
  ncRemoveUserFromGroupMock,
} = vi.hoisted(() => ({
  recordActivityMock: vi.fn().mockResolvedValue(undefined),
  revokeAllSessionsMock: vi.fn(async (_userId: string) => 1),
  denylistUserMock: vi.fn().mockResolvedValue(undefined),
  ncAddUserToGroupMock: vi.fn().mockResolvedValue(undefined),
  ncRemoveUserFromGroupMock: vi.fn().mockResolvedValue(undefined),
}));

// The role-mutation guard's rail-6 effect runners reach Redis and Nextcloud.
// Mocked at the leaf, the same way every other guard-driving suite does it
// (see __tests__/rbac-v2-guard-rails.e2e.test.ts).
vi.mock("./activity.singleton.js", () => ({ recordActivity: recordActivityMock }));
vi.mock("./session.service.js", () => ({ revokeAllSessions: revokeAllSessionsMock }));
vi.mock("./auth-denylist.service.js", () => ({
  denylistUser: denylistUserMock,
  isUserDenied: vi.fn().mockResolvedValue(false),
}));
vi.mock("./department-provisioner.service.js", () => ({
  adminBasicToken: vi.fn(() => "basic-token"),
  DROPLET_ADMINS_GROUP: "droplet-admins",
}));
vi.mock("./nextcloud-groups.client.js", () => ({
  ncAddUserToGroup: ncAddUserToGroupMock,
  ncRemoveUserFromGroup: ncRemoveUserFromGroupMock,
}));

import { readUserEmail } from "./user-directory.service.js";
import {
  provisionUser,
  deactivateUser,
  reactivateUser,
  findUserById,
  findUserByUserName,
  provisionGroup,
} from "./scim.service.js";
import {
  assertRoleChangeInvariantsTx,
  SERIALIZABLE_TX,
} from "./role-mutation-guard.service.js";
import {
  createTransactionSeam,
  expectAllTransactionsAt,
} from "../__tests__/helpers/prisma-tx-harness.js";

interface UserRow {
  id: string;
  username: string;
  nextcloudUsername: string | null;
  displayName: string;
  email: string | null;
  passwordHash: string | null;
  role: string;
  isLocal: boolean;
  directoryStatus: "ACTIVE" | "DEACTIVATED";
  createdAt: Date;
  updatedAt: Date;
}
interface IdentityRow {
  id: string;
  userId: string;
  provider: string;
  subject: string;
  email: string | null;
}
interface GroupRow {
  id: string;
  externalId: string | null;
  displayName: string;
  mappedRole: string;
  createdAt: Date;
  updatedAt: Date;
}

function createPrismaMock(seed: UserRow[] = []) {
  const self: any = {};
  self._users = [...seed];
  self._identities = [] as IdentityRow[];
  self._groups = [] as GroupRow[];
  let useq = self._users.length;

  // WARP-1570: the SHARED transaction seam, never a hand-rolled
  // `async (fn) => fn(self)` — scim.service.ts opens its guarded role write
  // at SERIALIZABLE_TX, and a stub that drops the options argument cannot
  // tell that apart from no isolation level at all. Also gives us rollback,
  // which is what makes "the rail refused, therefore nothing was written"
  // provable below.
  const seam = createTransactionSeam({
    client: () => self,
    stores: { users: self._users },
  });
  self._seam = seam;
  self.$transaction = seam.$transaction;

  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      // WARP-233: provisioning resolves users through the blind index.
      if (where.emailLookupHash !== undefined)
        return self._users.find((u: any) => u.emailLookupHash === where.emailLookupHash) ?? null;
      if (where.email !== undefined) return self._users.find((u: UserRow) => u.email === where.email) ?? null;
      if (where.id !== undefined) return self._users.find((u: UserRow) => u.id === where.id) ?? null;
      return null;
    }),
    // Rails 4 + 5 count surviving owners / non-disabled operators.
    count: vi.fn(async ({ where }: { where: any } = { where: {} }) =>
      self._users.filter((u: UserRow) => {
        if (typeof where?.role === "string" && u.role !== where.role) return false;
        if (Array.isArray(where?.role?.in) && !where.role.in.includes(u.role)) return false;
        if (where?.directoryStatus !== undefined && u.directoryStatus !== where.directoryStatus) {
          return false;
        }
        if (where?.id?.not !== undefined && u.id === where.id.not) return false;
        return true;
      }).length,
    ),
    // WARP-233 pre-backfill fallback probe (plaintext rows, no blind index).
    findFirst: vi.fn(async ({ where }: { where: any }) =>
      self._users.find((u: any) => u.email === where.email && u.emailLookupHash == null) ?? null,
    ),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: UserRow & { emailLookupHash?: string | null } = {
        id: data.id ?? `u-new-${++useq}`,
        username: data.username,
        nextcloudUsername: data.nextcloudUsername ?? null,
        displayName: data.displayName,
        email: data.email ?? null,
        emailLookupHash: data.emailLookupHash ?? null,
        passwordHash: data.passwordHash ?? null,
        role: data.role ?? "family",
        isLocal: data.isLocal ?? true,
        directoryStatus: data.directoryStatus ?? "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      self._users.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      // The guarded write pins `role` in its where-clause (optimistic
      // concurrency). A miss is Prisma's P2025, NOT a generic Error — the
      // service maps that code to "nothing was applied, retry".
      const u = self._users.find(
        (x: UserRow) => x.id === where.id && (where.role === undefined || x.role === where.role),
      );
      if (!u) {
        const err = new Error("Record to update not found") as Error & { code: string };
        err.code = "P2025";
        throw err;
      }
      Object.assign(u, data, { updatedAt: new Date() });
      return u;
    }),
  };

  self.ssoIdentity = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      const ps = where.provider_subject;
      return self._identities.find((i: IdentityRow) => i.provider === ps.provider && i.subject === ps.subject) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: IdentityRow = {
        id: `i-${self._identities.length + 1}`,
        userId: data.userId,
        provider: data.provider,
        subject: data.subject,
        email: data.email ?? null,
      };
      self._identities.push(row);
      return row;
    }),
  };

  self.scimGroup = {
    findFirst: vi.fn(async ({ where }: { where: any }) => {
      return (
        self._groups.find((g: GroupRow) => {
          if (where.OR) {
            return where.OR.some((c: any) =>
              (c.externalId !== undefined && c.externalId === g.externalId) ||
              (c.displayName !== undefined && c.displayName === g.displayName),
            );
          }
          return false;
        }) ?? null
      );
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: GroupRow = {
        id: data.id ?? `g-${self._groups.length + 1}`,
        externalId: data.externalId ?? null,
        displayName: data.displayName,
        mappedRole: data.mappedRole ?? "family",
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      self._groups.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      const g = self._groups.find((x: GroupRow) => x.id === where.id);
      if (!g) throw new Error("not found");
      Object.assign(g, data, { updatedAt: new Date() });
      return g;
    }),
  };

  return self;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("provisionUser — create-or-update by normalized email, idempotent", () => {
  it("CREATES a new directory user: least-privilege family, ACTIVE, no passwordHash", async () => {
    const prisma = createPrismaMock();
    const { user, created } = await provisionUser(prisma, {
      email: "newhire@acme.test",
      displayName: "New Hire",
      active: true,
      externalId: "okta-1",
    });
    expect(created).toBe(true);
    // WARP-233: stored as a dcv1 blob — decrypt for the assertion.
    expect(readUserEmail(user.email)).toBe("newhire@acme.test");
    expect(user.role).toBe("family"); // least privilege
    expect(user.directoryStatus).toBe("ACTIVE");
    // SCIM users cannot password-login.
    expect(prisma.user.create.mock.calls[0]![0].data.passwordHash ?? null).toBeNull();
    // Linked via the EXISTING SsoIdentity table under provider "okta".
    expect(prisma.ssoIdentity.create).toHaveBeenCalledTimes(1);
    const link = prisma.ssoIdentity.create.mock.calls[0]![0].data;
    expect(link.provider).toBe("okta");
    expect(link.subject).toBe("okta-1");
  });

  it("is IDEMPOTENT: re-POSTing the same user updates in place, no duplicate, User.id preserved", async () => {
    const prisma = createPrismaMock();
    const first = await provisionUser(prisma, { email: "p@acme.test", displayName: "P One", active: true, externalId: "okta-2" });
    const second = await provisionUser(prisma, { email: "p@acme.test", displayName: "P Renamed", active: true, externalId: "okta-2" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false); // existing → update, not create
    expect(second.user.id).toBe(first.user.id); // User.id preserved
    expect(prisma._users).toHaveLength(1); // no duplicate row
    expect(second.user.displayName).toBe("P Renamed");
    // No second identity link minted for the same (provider, subject).
    expect(prisma.ssoIdentity.create).toHaveBeenCalledTimes(1);
  });

  it("links to an EXISTING local user (e.g. a password/SSO owner) by email — preserves their id + role", async () => {
    const owner: UserRow = {
      id: "u-owner", username: "owner", nextcloudUsername: "owner", displayName: "Owner", email: "boss@acme.test",
      passwordHash: "$argon2id$x", role: "owner", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma = createPrismaMock([owner]);
    const { user, created } = await provisionUser(prisma, { email: "boss@acme.test", displayName: "Boss", active: true, externalId: "okta-3" });
    expect(created).toBe(false);
    expect(user.id).toBe("u-owner");
    expect(prisma.user.create).not.toHaveBeenCalled();
    // SCIM does not DEMOTE an existing owner to family.
    expect(user.role).toBe("owner");
  });

  it("provisioning with active:false creates the row already DEACTIVATED", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "disabled@acme.test", displayName: "D", active: false, externalId: "okta-4" });
    expect(user.directoryStatus).toBe("DEACTIVATED");
  });

  it("provisioning active:false for an existing ACTIVE user deactivates it (soft)", async () => {
    const prisma = createPrismaMock();
    await provisionUser(prisma, { email: "x@acme.test", displayName: "X", active: true, externalId: "okta-5" });
    const { user } = await provisionUser(prisma, { email: "x@acme.test", displayName: "X", active: false, externalId: "okta-5" });
    expect(user.directoryStatus).toBe("DEACTIVATED");
    expect(prisma._users).toHaveLength(1);
  });
});

describe("deactivateUser / reactivateUser — soft, idempotent", () => {
  it("deactivate sets DEACTIVATED, never deletes", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "z@acme.test", displayName: "Z", active: true, externalId: "okta-6" });
    const deactivated = await deactivateUser(prisma, user.id);
    expect(deactivated?.directoryStatus).toBe("DEACTIVATED");
    expect(prisma._users).toHaveLength(1); // row retained
  });

  it("deactivate is idempotent (DELETE retried by Okta)", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "z2@acme.test", displayName: "Z2", active: true, externalId: "okta-7" });
    await deactivateUser(prisma, user.id);
    const again = await deactivateUser(prisma, user.id);
    expect(again?.directoryStatus).toBe("DEACTIVATED");
  });

  it("deactivate of an unknown id returns null (404 surfaced by the route)", async () => {
    const prisma = createPrismaMock();
    expect(await deactivateUser(prisma, "nope")).toBeNull();
  });

  it("reactivate flips DEACTIVATED back to ACTIVE", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "z3@acme.test", displayName: "Z3", active: false, externalId: "okta-8" });
    const re = await reactivateUser(prisma, user.id);
    expect(re?.directoryStatus).toBe("ACTIVE");
  });
});

describe("findUserById / findUserByUserName", () => {
  it("findUserById resolves by local User.id (the SCIM resource id)", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "f@acme.test", displayName: "F", active: true, externalId: "okta-9" });
    expect(readUserEmail((await findUserById(prisma, user.id))?.email)).toBe("f@acme.test");
  });

  it("findUserByUserName resolves by normalized email", async () => {
    const prisma = createPrismaMock();
    await provisionUser(prisma, { email: "g@acme.test", displayName: "G", active: true, externalId: "okta-10" });
    expect((await findUserByUserName(prisma, "g@acme.test"))?.displayName).toBe("G");
    expect(await findUserByUserName(prisma, "missing@acme.test")).toBeNull();
  });
});

describe("provisionGroup — upsert + role mapping (highest-privilege-wins floor)", () => {
  it("creates the group with the mapped role from its display name", async () => {
    const prisma = createPrismaMock();
    const g = await provisionGroup(prisma, { displayName: "Droplet Admins", externalId: "okta-grp-1", memberUserIds: [] });
    expect(g.mappedRole).toBe("admin");
    expect(prisma.scimGroup.create).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: re-pushing the same group updates in place (no duplicate)", async () => {
    const prisma = createPrismaMock();
    await provisionGroup(prisma, { displayName: "Droplet Admins", externalId: "okta-grp-2", memberUserIds: [] });
    await provisionGroup(prisma, { displayName: "Droplet Admins", externalId: "okta-grp-2", memberUserIds: [] });
    expect(prisma._groups).toHaveLength(1);
  });

  it("RAISES a member's role to the group's mapped role (member of Admins → admin)", async () => {
    const prisma = createPrismaMock();
    const { user } = await provisionUser(prisma, { email: "m@acme.test", displayName: "M", active: true, externalId: "okta-11" });
    expect(user.role).toBe("family");
    await provisionGroup(prisma, { displayName: "Admins", externalId: "okta-grp-3", memberUserIds: [user.id] });
    const after = await findUserById(prisma, user.id);
    expect(after?.role).toBe("admin");
  });

  it("does NOT demote a higher-privileged member when added to a lower-privilege group", async () => {
    const prisma = createPrismaMock();
    // owner user added to a plain "Everyone" group (maps to family) must stay owner.
    const owner: UserRow = {
      id: "u-keepsowner", username: "ko", nextcloudUsername: "ko", displayName: "KO", email: "ko@acme.test",
      passwordHash: null, role: "owner", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma2 = createPrismaMock([owner]);
    await provisionGroup(prisma2, { displayName: "Everyone", externalId: "okta-grp-4", memberUserIds: ["u-keepsowner"] });
    const after = await findUserById(prisma2, "u-keepsowner");
    expect(after?.role).toBe("owner"); // not demoted to family
  });
});

/**
 * WARP-1568 — SCIM's role write goes through the role-mutation guard, and
 * `owner` is not an Okta-assignable role.
 *
 * Before this, `raiseUserRoleTo` wrote `User.role` directly: an Okta group
 * called "Business Owners" set `role: "owner"` on a provisioned user with no
 * rank cap, no assignable-enum narrowing, no owner immutability, no
 * last-owner / last-operator invariant, no transaction and no audit row —
 * every rail the interactive surfaces have run since WARP-1526.
 */
describe("WARP-1568 — SCIM role writes are guarded and capped at admin", () => {
  const member = (id: string, role = "family"): UserRow => ({
    id,
    username: id,
    nextcloudUsername: id,
    displayName: id.toUpperCase(),
    email: `${id}@acme.test`,
    passwordHash: null,
    role,
    isLocal: true,
    directoryStatus: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  it("an Okta group naming the OWNER role cannot mint an owner — the member lands at the admin ceiling", async () => {
    const prisma = createPrismaMock([member("u-target")]);
    const group = await provisionGroup(prisma, {
      displayName: "Business Owners",
      externalId: "okta-grp-owner",
      memberUserIds: ["u-target"],
    });

    // The stored group mapping is capped too — not just the member write, so
    // a later re-application of the same row cannot re-open the hole.
    expect(group.mappedRole).toBe("admin");
    const after = await findUserById(prisma, "u-target");
    expect(after?.role).toBe("admin");
    expect(prisma._users.some((u: UserRow) => u.role === "owner")).toBe(false);
  });

  it("no group name whatsoever can produce an owner row", async () => {
    for (const displayName of ["Owners", "owner", "Owners and Admins", "co-owner"]) {
      const prisma = createPrismaMock([member("u-x")]);
      await provisionGroup(prisma, { displayName, externalId: undefined, memberUserIds: ["u-x"] });
      expect(
        (await findUserById(prisma, "u-x"))?.role,
        `group "${displayName}" escalated past the ceiling`,
      ).toBe("admin");
    }
  });

  it("the role write runs in ONE explicitly SERIALIZABLE transaction", async () => {
    const prisma = createPrismaMock([member("u-tx")]);
    await provisionGroup(prisma, { displayName: "Admins", memberUserIds: ["u-tx"] });
    // Fails if the write ever drops back to a bare $transaction (READ
    // COMMITTED), which is invisible to Postgres SSI and defeats rails 4/5.
    expectAllTransactionsAt(prisma._seam, SERIALIZABLE_TX);
  });

  it("emits the SAME audit row as the interactive surfaces, attributed to the SCIM principal", async () => {
    const prisma = createPrismaMock([member("u-audit")]);
    await provisionGroup(prisma, { displayName: "Droplet Admins", memberUserIds: ["u-audit"] });

    // Rail 6, byte-identical to people.ts / access.ts: kind "system",
    // "Role changed", previous → next in `sub`, and the actor is the box
    // itself (an IdP is not a person), with `scim:okta` provenance in refs.
    expect(recordActivityMock).toHaveBeenCalledTimes(1);
    expect(recordActivityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "system",
        what: "Role changed",
        sub: "u-audit: family → admin",
        actor: { type: "system", id: null },
        refs: expect.objectContaining({
          actor: "scim:okta",
          targetUserId: "u-audit",
          previousRole: "family",
          nextRole: "admin",
        }),
      }),
    );
    // …and the rest of rail 6: the new role only takes effect on the next
    // request if the old sessions are revoked, and the operator tier is
    // mirrored into the box-wide Nextcloud group.
    expect(revokeAllSessionsMock).toHaveBeenCalledWith("u-audit");
    expect(ncAddUserToGroupMock).toHaveBeenCalledWith("basic-token", "u-audit", "droplet-admins");
  });

  it("a no-op mapping (already at or above the group's role) writes nothing and audits nothing", async () => {
    const prisma = createPrismaMock([member("u-noop", "admin")]);
    await provisionGroup(prisma, { displayName: "Everyone", memberUserIds: ["u-noop"] });
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("a promotion racing the mapping makes the write a no-op, never a demotion", async () => {
    // The window the in-transaction re-read exists for: the pre-transaction
    // snapshot says `guest`, so "raise to family" looks like a raise — but by
    // the time the transaction opens another writer has made this row an
    // admin. Re-evaluating the raise-only rule on the FRESH row is what stops
    // SCIM from writing `family` over it.
    const prisma = createPrismaMock([member("u-race", "guest")]);
    const seam = createTransactionSeam({
      client: () => prisma,
      stores: { users: prisma._users },
      onEnter: () => {
        prisma._users[0].role = "admin";
      },
    });
    prisma.$transaction = seam.$transaction;
    prisma._seam = seam;

    await provisionGroup(prisma, { displayName: "Everyone", memberUserIds: ["u-race"] });

    expect((await findUserById(prisma, "u-race"))?.role).toBe("admin");
    expect(recordActivityMock).not.toHaveBeenCalled();
  });

  it("the last-operator invariant the guarded write carries refuses a demotion that would empty owner ∪ admin", async () => {
    // The invariant SCIM's transaction now runs (rails 4 + 5), exercised
    // against this suite's directory. It cannot be reached THROUGH
    // provisionGroup today because the mapping is raise-only — every write
    // SCIM performs moves INTO the operator tier, never out of it — so this
    // asserts the backstop the path carries for the day group membership
    // becomes authoritative (leaving a group lowers a role). Without it, an
    // Okta push could leave the box with nobody able to manage access.
    const prisma = createPrismaMock([
      member("u-lastadmin", "admin"),
      member("u-family"),
    ]);
    await expect(
      prisma.$transaction(
        (tx: any) =>
          assertRoleChangeInvariantsTx(tx, {
            target: { id: "u-lastadmin", role: "admin", directoryStatus: "ACTIVE" },
            requestedRole: "family",
          }),
        SERIALIZABLE_TX,
      ),
    ).rejects.toMatchObject({ code: "LAST_OPERATOR_INVARIANT", status: 409 });

    // A second operator makes the same demotion legal — proving the refusal
    // above was the invariant firing, not the mock counting nothing.
    const ok = createPrismaMock([member("u-a", "admin"), member("u-b", "owner")]);
    await expect(
      ok.$transaction(
        (tx: any) =>
          assertRoleChangeInvariantsTx(tx, {
            target: { id: "u-a", role: "admin", directoryStatus: "ACTIVE" },
            requestedRole: "family",
          }),
        SERIALIZABLE_TX,
      ),
    ).resolves.toBeUndefined();
  });
});
