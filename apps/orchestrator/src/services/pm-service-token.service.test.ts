/**
 * WARP-860 — runtime provisioning of the Plane service API token.
 *
 * Ground truth (live-probed Plane CE v0.24.1, 2026-06-11):
 *   - `POST /api/workspaces/<slug>/service-api-tokens/` (session app
 *     API, `{}` body) answers 201 + `{"token":"plane_api_..."}` on the
 *     first call and 200 + the SAME token on every repeat — idempotent,
 *     so an in-memory cache re-provisioned per orchestrator boot is the
 *     whole persistence story (no DB, no env var).
 *   - Workspace discovery must use `GET /api/users/me/workspaces/`
 *     (the `/api/workspaces/` list 400s; `/api/v1/workspaces/` 404s).
 *
 * Strategy: mock the pm-bootstrap module (the single session/HTTP
 * funnel this service builds on), keeping the REAL PmBootstrapError so
 * the propagate-untouched contract is exercised faithfully.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockBootstrap = vi.hoisted(() => ({
  getAppSessionCookie: vi.fn(),
  planeAppApi: vi.fn(),
}));

vi.mock("./pm-bootstrap.service.js", async () => {
  const actual = await vi.importActual<
    typeof import("./pm-bootstrap.service.js")
  >("./pm-bootstrap.service.js");
  return {
    ...actual,
    getAppSessionCookie: mockBootstrap.getAppSessionCookie,
    planeAppApi: mockBootstrap.planeAppApi,
  };
});

import { PmBootstrapError } from "./pm-bootstrap.service.js";
import {
  getPmServiceToken,
  invalidatePmServiceToken,
  listPlaneWorkspaces,
  pmCallContextForTool,
  PmServiceTokenError,
  withPmServiceToken,
} from "./pm-service-token.service.js";

const SESSION = "session-id=test-session";
const WORKSPACE = { id: "w1", slug: "droplet-home", name: "Droplet Home" };
const TOKEN = "plane_api_0123456789abcdef0123456789abcdef01";

/**
 * Wire the planeAppApi mock: GET /api/users/me/workspaces/ answers
 * `workspaces`, POST .../service-api-tokens/ answers `post`.
 */
function wirePlaneAppApi(opts: {
  workspaces?: { status: number; body: unknown };
  post?: { status: number; body: unknown } | (() => { status: number; body: unknown });
}) {
  mockBootstrap.planeAppApi.mockImplementation(
    async (path: string, _session: string, init?: { method?: string }) => {
      if (path === "/api/users/me/workspaces/" && (init?.method ?? "GET") === "GET") {
        return opts.workspaces ?? { status: 200, body: [WORKSPACE] };
      }
      if (/\/service-api-tokens\/$/.test(path) && init?.method === "POST") {
        const post = opts.post ?? { status: 201, body: { token: TOKEN } };
        return typeof post === "function" ? post() : post;
      }
      throw new Error(`unexpected planeAppApi call: ${init?.method ?? "GET"} ${path}`);
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  invalidatePmServiceToken();
  mockBootstrap.getAppSessionCookie.mockResolvedValue(SESSION);
});

describe("getPmServiceToken", () => {
  it("provisions via POST /api/workspaces/<slug>/service-api-tokens/ (201)", async () => {
    wirePlaneAppApi({});

    const token = await getPmServiceToken();

    expect(token).toBe(TOKEN);
    expect(mockBootstrap.planeAppApi).toHaveBeenCalledWith(
      "/api/workspaces/droplet-home/service-api-tokens/",
      SESSION,
      { method: "POST", body: {} },
    );
  });

  it("reuses ONE session for the workspace list and the token POST", async () => {
    wirePlaneAppApi({});

    await getPmServiceToken();

    expect(mockBootstrap.getAppSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("caches the token — the second call makes zero further HTTP calls", async () => {
    wirePlaneAppApi({});

    const first = await getPmServiceToken();
    const callsAfterFirst = mockBootstrap.planeAppApi.mock.calls.length;
    const second = await getPmServiceToken();

    expect(second).toBe(first);
    expect(mockBootstrap.planeAppApi.mock.calls.length).toBe(callsAfterFirst);
    expect(mockBootstrap.getAppSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("single-flights concurrent callers into one provisioning run", async () => {
    wirePlaneAppApi({});
    // Stall the session mint so both callers overlap inside provision().
    let release!: (v: string) => void;
    mockBootstrap.getAppSessionCookie.mockReturnValue(
      new Promise<string>((r) => {
        release = r;
      }),
    );

    const [a, b] = [getPmServiceToken(), getPmServiceToken()];
    release(SESSION);
    const [tokenA, tokenB] = await Promise.all([a, b]);

    expect(tokenA).toBe(TOKEN);
    expect(tokenB).toBe(TOKEN);
    expect(mockBootstrap.getAppSessionCookie).toHaveBeenCalledTimes(1);
  });

  it("accepts the 200 repeat-call shape (Plane re-returns the same token)", async () => {
    wirePlaneAppApi({ post: { status: 200, body: { token: TOKEN } } });

    await expect(getPmServiceToken()).resolves.toBe(TOKEN);
  });

  it("throws PM_NOT_ONBOARDED when Plane has zero workspaces", async () => {
    wirePlaneAppApi({ workspaces: { status: 200, body: [] } });

    const err = await getPmServiceToken().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PmServiceTokenError);
    expect((err as PmServiceTokenError).code).toBe("PM_NOT_ONBOARDED");
    expect((err as Error).message).toMatch(/pm\/onboard/i);
  });

  it("does NOT cache a failure — the next call provisions again", async () => {
    wirePlaneAppApi({ workspaces: { status: 200, body: [] } });
    await expect(getPmServiceToken()).rejects.toThrow(PmServiceTokenError);

    wirePlaneAppApi({});
    await expect(getPmServiceToken()).resolves.toBe(TOKEN);
    expect(mockBootstrap.getAppSessionCookie).toHaveBeenCalledTimes(2);
  });

  it("throws PROVISION_FAILED when the POST body has no token", async () => {
    wirePlaneAppApi({ post: { status: 201, body: {} } });

    const err = await getPmServiceToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmServiceTokenError);
    expect((err as PmServiceTokenError).code).toBe("PROVISION_FAILED");
  });

  it("throws PROVISION_FAILED when the POST body token is empty", async () => {
    wirePlaneAppApi({ post: { status: 200, body: { token: "" } } });

    const err = await getPmServiceToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmServiceTokenError);
    expect((err as PmServiceTokenError).code).toBe("PROVISION_FAILED");
  });

  it("throws PROVISION_FAILED on a non-2xx POST", async () => {
    wirePlaneAppApi({ post: { status: 403, body: { error: "nope" } } });

    const err = await getPmServiceToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmServiceTokenError);
    expect((err as PmServiceTokenError).code).toBe("PROVISION_FAILED");
  });

  it("re-provisions after invalidatePmServiceToken()", async () => {
    let mint = 0;
    wirePlaneAppApi({
      post: () => ({ status: mint++ === 0 ? 201 : 200, body: { token: `tok-${mint}` } }),
    });

    const first = await getPmServiceToken();
    invalidatePmServiceToken();
    const second = await getPmServiceToken();

    expect(first).toBe("tok-1");
    expect(second).toBe("tok-2");
    expect(mockBootstrap.getAppSessionCookie).toHaveBeenCalledTimes(2);
  });

  it("lets PmBootstrapError (sign-in / unreachable) propagate untouched", async () => {
    const bootErr = new PmBootstrapError("Plane sign-in rejected", "SIGN_IN_FAILED");
    mockBootstrap.getAppSessionCookie.mockRejectedValue(bootErr);

    const err = await getPmServiceToken().catch((e: unknown) => e);
    expect(err).toBe(bootErr);
  });
});

describe("listPlaneWorkspaces", () => {
  it("projects the bare-array shape to {id, slug, name}", async () => {
    wirePlaneAppApi({
      workspaces: {
        status: 200,
        body: [{ ...WORKSPACE, extra_field: "dropped" }],
      },
    });

    await expect(listPlaneWorkspaces()).resolves.toEqual([WORKSPACE]);
  });

  it("handles the {results: [...]} shape", async () => {
    wirePlaneAppApi({
      workspaces: { status: 200, body: { results: [WORKSPACE] } },
    });

    await expect(listPlaneWorkspaces()).resolves.toEqual([WORKSPACE]);
  });

  it("throws WORKSPACE_LIST_FAILED on a non-200", async () => {
    wirePlaneAppApi({ workspaces: { status: 500, body: {} } });

    const err = await listPlaneWorkspaces().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PmServiceTokenError);
    expect((err as PmServiceTokenError).code).toBe("WORKSPACE_LIST_FAILED");
  });
});

describe("pmCallContextForTool", () => {
  it("returns {} for non-pm tools without any HTTP traffic", async () => {
    wirePlaneAppApi({});

    await expect(pmCallContextForTool("search_content")).resolves.toEqual({});
    expect(mockBootstrap.planeAppApi).not.toHaveBeenCalled();
    expect(mockBootstrap.getAppSessionCookie).not.toHaveBeenCalled();
  });

  it("attaches pmToken (and nothing else) for a regular pm_* tool", async () => {
    wirePlaneAppApi({});

    await expect(pmCallContextForTool("pm_list_projects")).resolves.toEqual({
      pmToken: TOKEN,
    });
  });

  it("attaches pmToken + pmWorkspaces for pm_list_workspaces", async () => {
    wirePlaneAppApi({});

    await expect(pmCallContextForTool("pm_list_workspaces")).resolves.toEqual({
      pmToken: TOKEN,
      pmWorkspaces: [WORKSPACE],
    });
  });

  it("returns {} (never throws) when token provisioning fails", async () => {
    mockBootstrap.getAppSessionCookie.mockRejectedValue(
      new PmBootstrapError("Plane unreachable", "PM_UNREACHABLE"),
    );

    await expect(pmCallContextForTool("pm_get_work_item")).resolves.toEqual({});
  });

  it("still attaches pmToken when only the workspace list fails", async () => {
    // Token provisions from the cache; the fresh per-call workspace list
    // for pm_list_workspaces then fails — the token must still flow.
    wirePlaneAppApi({});
    await getPmServiceToken();
    wirePlaneAppApi({ workspaces: { status: 500, body: {} } });

    await expect(pmCallContextForTool("pm_list_workspaces")).resolves.toEqual({
      pmToken: TOKEN,
    });
  });
});

describe("withPmServiceToken", () => {
  const isAuthError = (e: unknown) =>
    e instanceof Error && e.message === "401-shaped";

  it("invalidates + re-provisions + retries EXACTLY once on an auth error", async () => {
    let mint = 0;
    wirePlaneAppApi({
      post: () => ({ status: mint++ === 0 ? 201 : 200, body: { token: `tok-${mint}` } }),
    });
    const seen: string[] = [];
    const fn = vi.fn(async (token: string) => {
      seen.push(token);
      if (seen.length === 1) throw new Error("401-shaped");
      return "ok";
    });

    const result = await withPmServiceToken(fn, isAuthError);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    // The retry must run with a FRESH token, not the cached rejected one.
    expect(seen).toEqual(["tok-1", "tok-2"]);
  });

  it("rethrows a non-auth error without retrying", async () => {
    wirePlaneAppApi({});
    const fn = vi.fn(async () => {
      throw new Error("boom");
    });

    await expect(withPmServiceToken(fn, isAuthError)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("rethrows when the retry fails too (no infinite re-provision loop)", async () => {
    wirePlaneAppApi({});
    const fn = vi.fn(async () => {
      throw new Error("401-shaped");
    });

    await expect(withPmServiceToken(fn, isAuthError)).rejects.toThrow("401-shaped");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
