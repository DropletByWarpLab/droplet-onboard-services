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
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  provisionUser,
  deactivateUser,
  reactivateUser,
  findUserById,
  findUserByUserName,
  provisionGroup,
} from "./scim.service.js";

interface UserRow {
  id: string;
  username: string;
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

  self.user = {
    findUnique: vi.fn(async ({ where }: { where: any }) => {
      if (where.email !== undefined) return self._users.find((u: UserRow) => u.email === where.email) ?? null;
      if (where.id !== undefined) return self._users.find((u: UserRow) => u.id === where.id) ?? null;
      return null;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: UserRow = {
        id: data.id ?? `u-new-${++useq}`,
        username: data.username,
        displayName: data.displayName,
        email: data.email ?? null,
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
      const u = self._users.find((x: UserRow) => x.id === where.id);
      if (!u) throw new Error("not found");
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
    expect(user.email).toBe("newhire@acme.test");
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
      id: "u-owner", username: "owner", displayName: "Owner", email: "boss@acme.test",
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
    expect((await findUserById(prisma, user.id))?.email).toBe("f@acme.test");
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
      id: "u-keepsowner", username: "ko", displayName: "KO", email: "ko@acme.test",
      passwordHash: null, role: "owner", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma2 = createPrismaMock([owner]);
    await provisionGroup(prisma2, { displayName: "Everyone", externalId: "okta-grp-4", memberUserIds: ["u-keepsowner"] });
    const after = await findUserById(prisma2, "u-keepsowner");
    expect(after?.role).toBe("owner"); // not demoted to family
  });
});
