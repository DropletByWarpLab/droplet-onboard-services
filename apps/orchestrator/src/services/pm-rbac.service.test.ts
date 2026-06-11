/**
 * WARP-860 — pm-rbac on the runtime-provisioned Plane service token.
 *
 * `syncPlaneUserRole` used to PATCH with `config.DROPLET_PM_ADMIN_TOKEN`
 * — a token registered nowhere in Plane (every call 401'd on a stock CE
 * box). It now resolves the token through `withPmServiceToken`,
 * treating a Plane 401 as the invalidate-and-retry-once signal, while
 * preserving the module's fail-closed PmRbacError contract on every
 * path (403 → RECONCILE_REQUIRED, timeout → PM_API_TIMEOUT, etc.).
 *
 * NOTE: the module has NO callers (the WARP-505 OIDC trigger is dead on
 * CE — no OIDC RP support — and `/api/v1/.../members/` 404s on CE
 * anyway). It stays as the WARP-543 V2 seam; these tests pin the
 * contract for that future.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockTokenSvc = vi.hoisted(() => ({
  getPmServiceToken: vi.fn(),
  invalidatePmServiceToken: vi.fn(),
}));

vi.mock("./pm-service-token.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("./pm-service-token.service.js")
  >("./pm-service-token.service.js");
  return {
    ...actual,
    getPmServiceToken: mockTokenSvc.getPmServiceToken,
    invalidatePmServiceToken: mockTokenSvc.invalidatePmServiceToken,
    withPmServiceToken: vi.fn(
      async (
        fn: (token: string) => Promise<unknown>,
        isAuthError: (err: unknown) => boolean,
      ) => {
        const token = (await mockTokenSvc.getPmServiceToken()) as string;
        try {
          return await fn(token);
        } catch (err) {
          if (!isAuthError(err)) throw err;
          mockTokenSvc.invalidatePmServiceToken();
          return fn((await mockTokenSvc.getPmServiceToken()) as string);
        }
      },
    ),
  };
});

import { PmServiceTokenError } from "./pm-service-token.service.js";
import { mapDropletRoleToPlane, PmRbacError, syncPlaneUserRole } from "./pm-rbac.service.js";

const TOKEN = "plane_api_provisioned";
const realFetch = globalThis.fetch;

function mockFetch(
  responder: (call: number, init?: RequestInit) => Response | Promise<Response>,
) {
  let calls = 0;
  const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) =>
    responder(++calls, init),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTokenSvc.getPmServiceToken.mockResolvedValue(TOKEN);
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("mapDropletRoleToPlane", () => {
  it("maps the ADR-004 taxonomy onto Plane workspace roles", () => {
    expect(mapDropletRoleToPlane("owner")).toBe("admin");
    expect(mapDropletRoleToPlane("admin")).toBe("admin");
    expect(mapDropletRoleToPlane("family")).toBe("member");
    expect(mapDropletRoleToPlane("guest")).toBe("guest");
    expect(mapDropletRoleToPlane("service")).toBeNull();
  });
});

describe("syncPlaneUserRole (WARP-860 token source)", () => {
  it("PATCHes the member with the PROVISIONED token as X-API-Key", async () => {
    const fetchMock = mockFetch(() => new Response("{}", { status: 200 }));

    const result = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "family",
    });

    expect(result).toEqual({ applied: "member" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/api\/v1\/workspaces\/droplet-home\/members\/pu1\/$/);
    expect((init.headers as Record<string, string>)["X-API-Key"]).toBe(TOKEN);
    expect(JSON.parse(init.body as string)).toEqual({ role: "member" });
  });

  it("skips service principals without provisioning anything", async () => {
    const fetchMock = mockFetch(() => new Response("{}", { status: 200 }));

    const result = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "svc",
      dropletRole: "service",
    });

    expect(result).toEqual({ applied: null });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockTokenSvc.getPmServiceToken).not.toHaveBeenCalled();
  });

  it("invalidate-and-retries ONCE with a fresh token on a Plane 401", async () => {
    mockTokenSvc.getPmServiceToken
      .mockResolvedValueOnce("stale-token")
      .mockResolvedValueOnce("fresh-token");
    const fetchMock = mockFetch((call) =>
      call === 1
        ? new Response("unauth", { status: 401 })
        : new Response("{}", { status: 200 }),
    );

    const result = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "guest",
    });

    expect(result).toEqual({ applied: "guest" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockTokenSvc.invalidatePmServiceToken).toHaveBeenCalledTimes(1);
    const [, init2] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect((init2.headers as Record<string, string>)["X-API-Key"]).toBe("fresh-token");
  });

  it("surfaces a second 401 as a fail-closed PmRbacError (no infinite loop)", async () => {
    const fetchMock = mockFetch(() => new Response("unauth", { status: 401 }));

    const err = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "family",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmRbacError);
    expect((err as PmRbacError).code).toBe("PM_API_ERROR");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the OQ5 fallback: 403 → RECONCILE_REQUIRED (no retry)", async () => {
    const fetchMock = mockFetch(() => new Response("forbidden", { status: 403 }));

    const err = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "owner-user",
      dropletRole: "family",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmRbacError);
    expect((err as PmRbacError).code).toBe("RECONCILE_REQUIRED");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps PM_API_ERROR for other upstream failures", async () => {
    mockFetch(() => new Response("boom", { status: 500 }));

    const err = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "family",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmRbacError);
    expect((err as PmRbacError).code).toBe("PM_API_ERROR");
  });

  it("keeps the AbortError → PM_API_TIMEOUT translation (Romain PR #322)", async () => {
    mockFetch(() => {
      throw new DOMException("aborted", "AbortError");
    });

    const err = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "family",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmRbacError);
    expect((err as PmRbacError).code).toBe("PM_API_TIMEOUT");
  });

  it("wraps a provisioning failure as a fail-closed PmRbacError", async () => {
    mockTokenSvc.getPmServiceToken.mockRejectedValue(
      new PmServiceTokenError("no workspace yet", "PM_NOT_ONBOARDED"),
    );
    const fetchMock = mockFetch(() => new Response("{}", { status: 200 }));

    const err = await syncPlaneUserRole({
      workspaceSlug: "droplet-home",
      planeUserId: "pu1",
      dropletRole: "family",
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmRbacError);
    expect((err as PmRbacError).code).toBe("PM_API_ERROR");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
