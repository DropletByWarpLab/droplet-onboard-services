/**
 * WARP-1532 (RBAC v2 T8) — Access & Roles api helpers.
 *
 * Pins the ADR-032 §5 wire contract the UI codes against while the backend
 * (T3+) builds in parallel:
 *   - GET/POST /api/access/roles · GET/PATCH/DELETE /api/access/roles/:id
 *   - duplicate = POST with sourceRoleId · archive = PATCH { state }
 *   - POST /api/access/roles/:id/assign { userIds } → { syncState }
 *   - PATCH /api/people/:id/access { accessRoleId | tier }
 *   - GET /api/people/:id/effective-access
 *   - PUT /api/people/:id/access-exceptions { exceptions }
 * BigInt fields pass through as strings, untouched.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  listAccessRoles,
  getAccessRole,
  createAccessRole,
  duplicateAccessRole,
  listRoleTemplates,
  createRoleFromTemplate,
  updateAccessRole,
  archiveAccessRole,
  restoreAccessRole,
  deleteAccessRole,
  assignAccessRole,
  setPersonAccess,
  fetchEffectiveAccess,
  putAccessExceptions,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("WARP-1532 — roles CRUD", () => {
  it("listAccessRoles reads GET /api/access/roles", async () => {
    authFetchMock.mockResolvedValue(res({ roles: [] }));
    const out = await listAccessRoles();
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toMatch(/\/api\/access\/roles$/);
    expect(out.roles).toEqual([]);
  });

  it("getAccessRole reads GET /api/access/roles/:id", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r1" } }));
    await getAccessRole("r1");
    expect(authFetchMock.mock.calls[0][0]).toMatch(/\/api\/access\/roles\/r1$/);
  });

  it("createAccessRole POSTs the payload with BigInt strings untouched", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r1" }, syncState: "pending" }));
    await createAccessRole({
      name: "Finance",
      description: null,
      startingPoint: "family",
      storageQuotaBytes: "26843545600",
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      featureGrants: [{ moduleId: "files", level: "act" }],
      toolGrants: [],
      connectorGrants: [],
    });
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles$/);
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body.storageQuotaBytes).toBe("26843545600");
    expect(typeof body.storageQuotaBytes).toBe("string");
  });

  it("duplicateAccessRole POSTs { sourceRoleId }", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r2" } }));
    await duplicateAccessRole("r1");
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles$/);
    expect(JSON.parse(init.body as string)).toEqual({ sourceRoleId: "r1" });
  });

  it("archiveAccessRole PATCHes { state: 'archived' }", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r1", state: "archived" } }));
    await archiveAccessRole("r1");
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles\/r1$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "archived" });
  });

  it("restoreAccessRole PATCHes { state: 'active' } (WARP-1560)", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r1", state: "active" }, syncState: "pending" }));
    const out = await restoreAccessRole("r1");
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles\/r1$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ state: "active" });
    expect(out.syncState).toBe("pending");
  });

  it("updateAccessRole passes retainedQuotaCount straight through (WARP-1576)", async () => {
    authFetchMock.mockResolvedValue(
      res({ role: { id: "r1" }, syncState: "synced", retainedQuotaCount: 3 }),
    );
    const out = await updateAccessRole("r1", { storageQuotaBytes: null });
    expect(out.retainedQuotaCount).toBe(3);
  });

  it("deleteAccessRole DELETEs and surfaces the server error body", async () => {
    authFetchMock.mockResolvedValue(
      res({ error: "In use by 4 people — reassign them first." }, false, 409),
    );
    await expect(deleteAccessRole("r1")).rejects.toThrow(/reassign them first/);
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles\/r1$/);
    expect(init.method).toBe("DELETE");
  });
});

describe("WARP-1532 — assignment + person access", () => {
  it("assignAccessRole POSTs userIds and returns the syncState", async () => {
    authFetchMock.mockResolvedValue(res({ syncState: "pending" }));
    const out = await assignAccessRole("r1", ["u1", "u2"]);
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles\/r1\/assign$/);
    expect(JSON.parse(init.body as string)).toEqual({ userIds: ["u1", "u2"] });
    expect(out.syncState).toBe("pending");
  });

  it("setPersonAccess PATCHes a custom-role assignment by LOCAL user UUID", async () => {
    authFetchMock.mockResolvedValue(res({ syncState: "pending" }));
    await setPersonAccess("uuid-1", { accessRoleId: "r1" });
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/people\/uuid-1\/access$/);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body as string)).toEqual({ accessRoleId: "r1" });
  });

  it("setPersonAccess PATCHes a built-in tier as { accessRoleId: null, tier }", async () => {
    authFetchMock.mockResolvedValue(res({ syncState: "pending" }));
    await setPersonAccess("uuid-1", { accessRoleId: null, tier: "admin" });
    const [, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ accessRoleId: null, tier: "admin" });
  });

  it("fetchEffectiveAccess reads GET /api/people/:id/effective-access", async () => {
    authFetchMock.mockResolvedValue(
      res({ tier: "family", features: [], toolDomains: [], locks: false, cloud: false, connectors: {}, usage: { storageQuotaBytes: null, maxUploadSizeMb: null, llmDailyMessageCap: null }, deptRights: [] }),
    );
    const out = await fetchEffectiveAccess("uuid-1");
    expect(authFetchMock.mock.calls[0][0]).toMatch(/\/api\/people\/uuid-1\/effective-access$/);
    expect(out.tier).toBe("family");
  });

  it("putAccessExceptions PUTs the full (small) list", async () => {
    authFetchMock.mockResolvedValue(res({ exceptions: [] }));
    await putAccessExceptions("uuid-1", [{ moduleId: "cameras", effect: "allow", level: "act" }]);
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/people\/uuid-1\/access-exceptions$/);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      exceptions: [{ moduleId: "cameras", effect: "allow", level: "act" }],
    });
  });
});

describe("WARP-2738 — role templates", () => {
  it("listRoleTemplates reads GET /api/access/role-templates", async () => {
    // `enforcedModuleIds` passes through UNTOUCHED — it is derived server-side
    // from the live layer-2 gate roster and is the only honest source for
    // which grants actually narrow what a person reaches. Never sorted, never
    // reconstructed here.
    authFetchMock.mockResolvedValue(
      res({
        roleTemplates: [{ id: "front-desk" }],
        enforcedModuleIds: ["files", "knowledge", "docs", "cameras"],
      }),
    );
    const out = await listRoleTemplates();
    expect(authFetchMock.mock.calls[0][0]).toMatch(/\/api\/access\/role-templates$/);
    expect(out.enforcedModuleIds).toEqual(["files", "knowledge", "docs", "cameras"]);
    expect(out.roleTemplates[0].id).toBe("front-desk");
  });

  it("createRoleFromTemplate POSTs { templateId } and never a slug", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r9" }, syncState: "synced" }));
    const out = await createRoleFromTemplate("front-desk");
    const [url, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/access\/roles$/);
    expect(init.method).toBe("POST");
    // No `name` key at all when there is no rename — the server takes the
    // template's own name, and the slug is always derived server-side.
    expect(JSON.parse(init.body as string)).toEqual({ templateId: "front-desk" });
    expect(out.syncState).toBe("synced");
  });

  it("createRoleFromTemplate sends the optional rename when one is given", async () => {
    authFetchMock.mockResolvedValue(res({ role: { id: "r9" } }));
    await createRoleFromTemplate("front-desk", "Reception");
    const [, init] = authFetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      templateId: "front-desk",
      name: "Reception",
    });
  });

  it("a 409 CONCURRENT_MUTATION carries status + code so the caller can RETRY", async () => {
    // The refusal this ticket makes routine: two operators clicking the same
    // card derive the same slug base, one loses the SERIALIZABLE race, and
    // NOTHING was applied. A panel that could only read `message` would render
    // a retryable race as a failure.
    authFetchMock.mockResolvedValue(
      res({ error: "Another change landed first — try again.", code: "CONCURRENT_MUTATION" }, false, 409),
    );
    const err = await createRoleFromTemplate("front-desk").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { status?: number }).status).toBe(409);
    expect((err as Error & { code?: string }).code).toBe("CONCURRENT_MUTATION");
    expect((err as Error).message).toMatch(/try again/);
  });

  it("a well-formed id naming no template surfaces the server's 404", async () => {
    authFetchMock.mockResolvedValue(res({ error: "Role template not found" }, false, 404));
    const err = await createRoleFromTemplate("no-such-template").catch((e) => e);
    expect((err as Error).message).toBe("Role template not found");
    expect((err as Error & { status?: number }).status).toBe(404);
    // No `code` on this one — terminal, and there is nothing to dispatch on.
    expect((err as Error & { code?: string }).code).toBeUndefined();
  });

  it("createAccessRole carries the same 409 shape (one handler for both paths)", async () => {
    // The hand-authored create races on the same derived slug base, so the
    // panel's retry has to work there too — otherwise "customize, then create"
    // is the one path where a retryable race reads as an error.
    authFetchMock.mockResolvedValue(
      res({ error: "Another change landed first — try again.", code: "CONCURRENT_MUTATION" }, false, 409),
    );
    const err = await createAccessRole({
      name: "Front Desk",
      description: null,
      startingPoint: "family",
      storageQuotaBytes: null,
      maxUploadSizeMb: null,
      llmDailyMessageCap: null,
      cloudModelsAllowed: false,
      mayOperateLocks: false,
      featureGrants: [],
      toolGrants: [],
      connectorGrants: [],
    }).catch((e) => e);
    expect((err as Error & { status?: number }).status).toBe(409);
    expect((err as Error & { code?: string }).code).toBe("CONCURRENT_MUTATION");
  });
});
