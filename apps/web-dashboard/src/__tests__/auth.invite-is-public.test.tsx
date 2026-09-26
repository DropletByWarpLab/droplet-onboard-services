// @vitest-environment jsdom
/**
 * An invitee opening `/invite/<token>` has no session, so AuthProvider's
 * boot probe (`/api/auth/me`) 401s and the refresh answers NO_REFRESH_TOKEN —
 * a confirmed-dead verdict. authFetch must NOT hard-navigate to /login from
 * there: that bounce landed a few seconds after the password form painted, so
 * the invitee could never set a password. AuthGate already treated /invite as
 * public; authFetch kept its own list without it. Both now read PUBLIC_PATHS.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { authFetch } from "@/lib/auth";

const realLocation = window.location;

function stubLocation(pathname: string) {
  const assign = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: { ...realLocation, pathname, search: "", assign },
  });
  return assign;
}

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  Object.defineProperty(window, "location", {
    configurable: true,
    writable: true,
    value: realLocation,
  });
});

function stubAnonymousBox() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url === "/api/auth/refresh"
        ? json({ code: "NO_REFRESH_TOKEN" }, 401)
        : json({ error: "Unauthorized" }, 401),
    ),
  );
}

describe("authFetch dead-session bounce spares public pages", () => {
  it("does not navigate an anonymous invitee off /invite/<token>", async () => {
    const assign = stubLocation("/invite/abc123");
    stubAnonymousBox();

    const res = await authFetch("/api/auth/me");

    expect(res.status).toBe(401);
    expect(assign).not.toHaveBeenCalled();
  });

  it("still bounces a protected page to /login", async () => {
    const assign = stubLocation("/network");
    stubAnonymousBox();

    await authFetch("/api/auth/me");

    expect(assign).toHaveBeenCalledWith("/login?next=%2Fnetwork");
  });
});
