/**
 * WARP (SCIM directory sync) — SCIM 2.0 server route (Okta provisioning).
 *
 * Drives the REAL router via supertest with the SCIM bearer guard active and
 * an in-memory Prisma mock (no live DB, no live Okta — the AC's LOCAL-only
 * constraint). Covers the endpoints Okta calls:
 *
 *   POST   /scim/v2/Users               → 201 create (idempotent on retry)
 *   GET    /scim/v2/Users?filter=...     → ListResponse (the userName-eq probe)
 *   GET    /scim/v2/Users/:id            → 200 single | 404
 *   PUT    /scim/v2/Users/:id            → 200 replace (active toggle)
 *   PATCH  /scim/v2/Users/:id            → 200 (active:false → soft-deactivate)
 *   DELETE /scim/v2/Users/:id            → 204 soft-deactivate (no hard delete)
 *   POST   /scim/v2/Groups              → 201 group + role mapping
 *
 * Auth: every route requires the SCIM bearer; one unauthorized check proves
 * the guard is mounted (the exhaustive bearer matrix lives in
 * middleware/scim-auth.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import express from "express";

// vi.hoisted so the object exists before the hoisted vi.mock factory runs —
// middleware/auth.ts (pulled in by scim-auth.ts for the WARP-1062 deny-row
// helper) reads config keys at module-evaluation time, which would otherwise
// hit the TDZ on a plain `const`.
const { mockConfig } = vi.hoisted(() => ({
  mockConfig: {
    DROPLET_SCIM_BEARER_TOKEN: "scim-token",
    agentMaxIter: { defaultIter: 5, capIter: 10 },
  } as Record<string, unknown>,
}));
vi.mock("../config.js", () => ({
  get config() {
    return mockConfig;
  },
}));

// WARP-1568: the guarded role write runs rail 6, whose first step is the
// WARP-247 session revocation — Redis-backed, and there is no Redis here.
// Mocked at the leaf like every other guard-driving route suite.
vi.mock("../services/session.service.js", () => ({
  revokeAllSessions: vi.fn(async () => 0),
}));

import { createScimRouter } from "./scim.js";
import { createTransactionSeam } from "../__tests__/helpers/prisma-tx-harness.js";
import { _setActivityRecorderForTests } from "../services/activity.singleton.js";
import type { RecordParams } from "../services/activity.service.js";

// WARP-237: capture audit rows so SCIM provisioning / deactivation emits
// can be asserted.
const recordedScim: RecordParams[] = [];
import {
  SCIM_USER_SCHEMA,
  SCIM_LIST_RESPONSE_SCHEMA,
} from "../services/scim-resource.js";

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

function createPrismaMock(seed: UserRow[] = []) {
  const self: any = {};
  self._users = [...seed];
  self._identities = [] as any[];
  self._groups = [] as any[];
  let useq = self._users.length;

  // WARP-1568: the group→role write now runs through the role-mutation guard
  // in a SERIALIZABLE transaction, so this stub needs a $transaction — and
  // per WARP-1570 it must be the SHARED seam, which records the isolation
  // option and rolls back on a refusal rather than dropping both.
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
    // WARP-233 pre-backfill fallback probe (plaintext rows, no blind index).
    findFirst: vi.fn(async ({ where }: { where: any }) =>
      self._users.find((u: UserRow) => u.email === where.email) ?? null,
    ),
    // WARP-1568: rails 4 + 5 count surviving owners / non-disabled operators.
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
    create: vi.fn(async ({ data }: { data: any }) => {
      const row: UserRow & { emailLookupHash?: string | null } = {
        id: data.id ?? `u-${++useq}`,
        username: data.username,
        displayName: data.displayName,
        email: data.email ?? null,
        emailLookupHash: data.emailLookupHash ?? null,
        passwordHash: data.passwordHash ?? null,
        role: data.role ?? "family",
        isLocal: data.isLocal ?? true,
        directoryStatus: data.directoryStatus ?? "ACTIVE",
        createdAt: new Date("2026-05-31T00:00:00Z"),
        updatedAt: new Date("2026-05-31T00:00:00Z"),
      };
      self._users.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      // WARP-1568: the guarded role write pins `role` in its where-clause; a
      // miss is Prisma's P2025 ("nothing applied, retry"), not a 500.
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
      return self._identities.find((i: any) => i.provider === ps.provider && i.subject === ps.subject) ?? null;
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row = { id: `i-${self._identities.length + 1}`, ...data };
      self._identities.push(row);
      return row;
    }),
  };
  self.scimGroup = {
    findFirst: vi.fn(async ({ where }: { where: any }) => {
      return (
        self._groups.find((g: any) =>
          where.OR?.some((c: any) =>
            (c.externalId !== undefined && c.externalId === g.externalId) ||
            (c.displayName !== undefined && c.displayName === g.displayName),
          ),
        ) ?? null
      );
    }),
    create: vi.fn(async ({ data }: { data: any }) => {
      const row = { id: `g-${self._groups.length + 1}`, externalId: null, mappedRole: "family", createdAt: new Date(), updatedAt: new Date(), ...data };
      self._groups.push(row);
      return row;
    }),
    update: vi.fn(async ({ where, data }: { where: any; data: any }) => {
      const g = self._groups.find((x: any) => x.id === where.id);
      Object.assign(g, data, { updatedAt: new Date() });
      return g;
    }),
  };
  return self;
}

function buildApp(prisma: any) {
  const app = express();
  app.use(express.json({ type: ["application/json", "application/scim+json"] }));
  app.use(createScimRouter(prisma));
  return app;
}

const AUTH = ["Authorization", "Bearer scim-token"] as const;

beforeEach(() => {
  for (const k of Object.keys(mockConfig)) delete mockConfig[k];
  mockConfig.DROPLET_SCIM_BEARER_TOKEN = "scim-token";
  mockConfig.agentMaxIter = { defaultIter: 5, capIter: 10 };
  recordedScim.length = 0;
  _setActivityRecorderForTests(
    {
      record: async (p) => {
        recordedScim.push(p);
        return {} as never;
      },
    },
    null,
  );
});

afterEach(() => {
  _setActivityRecorderForTests(null, null);
});

describe("SCIM auth guard is mounted", () => {
  it("rejects an unauthenticated request to /scim/v2/Users (401, SCIM error)", async () => {
    const res = await request(buildApp(createPrismaMock())).get("/scim/v2/Users");
    expect(res.status).toBe(401);
    expect(res.body.status).toBe("401");
  });

  // WARP-1062 (audit item B): a rejected SCIM bearer emits the WARP-237
  // "Access denied" policy-violation row (path/method/reason only — never
  // the presented token).
  it("emits the Access denied audit row on a rejected bearer (WARP-1062)", async () => {
    const res = await request(buildApp(createPrismaMock()))
      .get("/scim/v2/Users")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    const denied = recordedScim.filter((p) => p.what === "Access denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]).toMatchObject({
      kind: "auth",
      severity: "warn",
      refs: expect.objectContaining({ reason: "scim-bearer-invalid" }),
      actor: { type: "anonymous" },
    });
    expect(JSON.stringify(denied[0])).not.toContain("wrong-token");
  });
});

describe("POST /scim/v2/Users — create + idempotency", () => {
  it("creates a user → 201 with the SCIM User body + Location, least-privilege family", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/scim/v2/Users")
      .set(...AUTH)
      .send({
        schemas: [SCIM_USER_SCHEMA],
        userName: "Newhire@Acme.test",
        name: { givenName: "New", familyName: "Hire" },
        active: true,
        externalId: "okta-1",
      });
    expect(res.status).toBe(201);
    expect(res.body.schemas).toEqual([SCIM_USER_SCHEMA]);
    expect(res.body.userName).toBe("newhire@acme.test"); // normalized
    expect(res.body.active).toBe(true);
    expect(res.body.id).toBeTruthy();
    expect(res.headers.location).toContain(`/scim/v2/Users/${res.body.id}`);
    // SCIM users can't password-login.
    expect(prisma.user.create.mock.calls[0]![0].data.passwordHash ?? null).toBeNull();
    // WARP-237: provisioning emits a system-actor audit row.
    expect(recordedScim).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        what: "SCIM user provisioned",
        actor: { type: "system", id: null },
        refs: expect.objectContaining({ via: "scim" }),
      }),
    );
  });

  it("re-POSTing the same user is idempotent (Okta retry) — 200/201, no duplicate row", async () => {
    const prisma = createPrismaMock();
    const body = { schemas: [SCIM_USER_SCHEMA], userName: "dup@acme.test", active: true, externalId: "okta-2" };
    const first = await request(buildApp(prisma)).post("/scim/v2/Users").set(...AUTH).send(body);
    const second = await request(buildApp(prisma)).post("/scim/v2/Users").set(...AUTH).send(body);
    expect(first.status).toBe(201);
    // A retry of an existing user is not an error — 200 (updated in place).
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    expect(prisma._users).toHaveLength(1);
  });

  it("rejects a payload with no userName → 400 SCIM error", async () => {
    const prisma = createPrismaMock();
    const res = await request(buildApp(prisma))
      .post("/scim/v2/Users")
      .set(...AUTH)
      .send({ schemas: [SCIM_USER_SCHEMA], name: { givenName: "No" } });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/userName/i);
  });
});

describe("GET /scim/v2/Users — filter + by-id", () => {
  const jane: UserRow = {
    id: "u-jane", username: "jane", displayName: "Jane Doe", email: "jane@acme.test",
    passwordHash: null, role: "family", isLocal: true, directoryStatus: "ACTIVE",
    createdAt: new Date("2026-05-31T00:00:00Z"), updatedAt: new Date("2026-05-31T00:00:00Z"),
  };

  it("filter userName eq → ListResponse with the one match (Okta's existence probe)", async () => {
    const prisma = createPrismaMock([jane]);
    const res = await request(buildApp(prisma))
      .get('/scim/v2/Users?filter=' + encodeURIComponent('userName eq "jane@acme.test"'))
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.schemas).toEqual([SCIM_LIST_RESPONSE_SCHEMA]);
    expect(res.body.totalResults).toBe(1);
    expect(res.body.Resources[0].userName).toBe("jane@acme.test");
  });

  it("filter userName eq with NO match → empty ListResponse (totalResults 0), NOT 404", async () => {
    const prisma = createPrismaMock([jane]);
    const res = await request(buildApp(prisma))
      .get('/scim/v2/Users?filter=' + encodeURIComponent('userName eq "ghost@acme.test"'))
      .set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.totalResults).toBe(0);
    expect(res.body.Resources).toEqual([]);
  });

  it("GET by id → 200 single user", async () => {
    const prisma = createPrismaMock([jane]);
    const res = await request(buildApp(prisma)).get("/scim/v2/Users/u-jane").set(...AUTH);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe("u-jane");
    expect(res.body.userName).toBe("jane@acme.test");
  });

  it("GET by unknown id → 404 SCIM error", async () => {
    const prisma = createPrismaMock([jane]);
    const res = await request(buildApp(prisma)).get("/scim/v2/Users/missing").set(...AUTH);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe("404");
  });
});

describe("PUT / PATCH / DELETE /scim/v2/Users/:id — update + soft-deactivation", () => {
  function seedActive(): UserRow {
    return {
      id: "u-emp", username: "emp", displayName: "Emp Loyee", email: "emp@acme.test",
      passwordHash: null, role: "family", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date("2026-05-31T00:00:00Z"), updatedAt: new Date("2026-05-31T00:00:00Z"),
    };
  }

  it("PUT replace with active:false → 200 and the row is soft-DEACTIVATED (not deleted)", async () => {
    const prisma = createPrismaMock([seedActive()]);
    const res = await request(buildApp(prisma))
      .put("/scim/v2/Users/u-emp")
      .set(...AUTH)
      .send({ schemas: [SCIM_USER_SCHEMA], userName: "emp@acme.test", active: false });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(prisma._users.find((u: UserRow) => u.id === "u-emp")!.directoryStatus).toBe("DEACTIVATED");
    expect(prisma._users).toHaveLength(1); // not deleted
  });

  it("PATCH active:false (Okta's deactivate op) → 200 soft-DEACTIVATE", async () => {
    const prisma = createPrismaMock([seedActive()]);
    const res = await request(buildApp(prisma))
      .patch("/scim/v2/Users/u-emp")
      .set(...AUTH)
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: false }],
      });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
    expect(prisma._users.find((u: UserRow) => u.id === "u-emp")!.directoryStatus).toBe("DEACTIVATED");
  });

  it("PATCH active:false expressed as a value object {active:false} also deactivates", async () => {
    const prisma = createPrismaMock([seedActive()]);
    const res = await request(buildApp(prisma))
      .patch("/scim/v2/Users/u-emp")
      .set(...AUTH)
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", value: { active: false } }],
      });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(false);
  });

  it("PATCH active:true RE-activates a deactivated user", async () => {
    const deactivated = { ...seedActive(), directoryStatus: "DEACTIVATED" as const };
    const prisma = createPrismaMock([deactivated]);
    const res = await request(buildApp(prisma))
      .patch("/scim/v2/Users/u-emp")
      .set(...AUTH)
      .send({
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "replace", path: "active", value: true }],
      });
    expect(res.status).toBe(200);
    expect(res.body.active).toBe(true);
  });

  it("DELETE → 204 and the row is soft-DEACTIVATED, NOT removed", async () => {
    const prisma = createPrismaMock([seedActive()]);
    const res = await request(buildApp(prisma)).delete("/scim/v2/Users/u-emp").set(...AUTH);
    expect(res.status).toBe(204);
    expect(prisma._users).toHaveLength(1); // retained
    expect(prisma._users[0].directoryStatus).toBe("DEACTIVATED");
    // WARP-237: de-provision emits a warn-severity deactivation row.
    expect(recordedScim).toContainEqual(
      expect.objectContaining({
        kind: "auth",
        severity: "warn",
        what: "SCIM user deactivated",
        actor: { type: "system", id: null },
      }),
    );
  });

  it("DELETE is idempotent (Okta retry) — second DELETE still 204", async () => {
    const prisma = createPrismaMock([seedActive()]);
    await request(buildApp(prisma)).delete("/scim/v2/Users/u-emp").set(...AUTH);
    const again = await request(buildApp(prisma)).delete("/scim/v2/Users/u-emp").set(...AUTH);
    expect(again.status).toBe(204);
  });

  it("PATCH/PUT/DELETE of an unknown id → 404", async () => {
    const prisma = createPrismaMock([]);
    const put = await request(buildApp(prisma)).put("/scim/v2/Users/nope").set(...AUTH).send({ userName: "x@y.com" });
    const del = await request(buildApp(prisma)).delete("/scim/v2/Users/nope").set(...AUTH);
    expect(put.status).toBe(404);
    expect(del.status).toBe(404);
  });
});

describe("POST /scim/v2/Groups — group + role mapping", () => {
  it("creates a group, maps the role, raises a member to admin (201)", async () => {
    const member: UserRow = {
      id: "u-mem", username: "mem", displayName: "Mem Ber", email: "mem@acme.test",
      passwordHash: null, role: "family", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma = createPrismaMock([member]);
    const res = await request(buildApp(prisma))
      .post("/scim/v2/Groups")
      .set(...AUTH)
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Droplet Admins",
        externalId: "okta-grp-1",
        members: [{ value: "u-mem" }],
      });
    expect(res.status).toBe(201);
    expect(res.body.displayName).toBe("Droplet Admins");
    // The member was raised to admin.
    expect(prisma._users.find((u: UserRow) => u.id === "u-mem")!.role).toBe("admin");
  });

  it("WARP-1568: an OWNER-named Okta group cannot mint an owner over the wire", async () => {
    // The end-to-end shape of the escalation: Okta pushes a group whose name
    // says "owner", the box hands the IdP its root of trust. The push still
    // succeeds (Okta must not retry-loop) — the member lands at the ceiling.
    const member: UserRow = {
      id: "u-esc", username: "esc", displayName: "Esc Alate", email: "esc@acme.test",
      passwordHash: null, role: "family", isLocal: true, directoryStatus: "ACTIVE",
      createdAt: new Date(), updatedAt: new Date(),
    };
    const prisma = createPrismaMock([member]);
    const res = await request(buildApp(prisma))
      .post("/scim/v2/Groups")
      .set(...AUTH)
      .send({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:Group"],
        displayName: "Business Owners",
        externalId: "okta-grp-owner",
        members: [{ value: "u-esc" }],
      });

    expect(res.status).toBe(201);
    expect(prisma._users.find((u: UserRow) => u.id === "u-esc")!.role).toBe("admin");
    expect(prisma._users.some((u: UserRow) => u.role === "owner")).toBe(false);
    expect(prisma._groups[0].mappedRole).toBe("admin");

    // …and the change is audited like every other role change, attributed to
    // the SCIM principal rather than to a person.
    expect(recordedScim).toContainEqual(
      expect.objectContaining({
        kind: "system",
        what: "Role changed",
        sub: "esc: family → admin",
        actor: { type: "system", id: null },
        refs: expect.objectContaining({ actor: "scim:okta", nextRole: "admin" }),
      }),
    );
  });
});
