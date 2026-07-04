/**
 * WARP-1042 — API client: createUser() carries the optional role so the
 * People-page "Create local account" dialog can assign one. Kept separate
 * from api.change-password.test.ts (that suite is pinned as-is by the
 * password-change gate work).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// auth.tsx is a module cycle with api.ts; stub authFetch so api.ts's import
// resolves without pulling the whole auth provider tree.
const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

import { createUser } from "@/lib/api";

function okJson(body: unknown = { status: "ok" }) {
  return { ok: true, json: async () => body } as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createUser — role param (WARP-1042)", () => {
  it("sends the role in the POST body when provided", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "bob" }));

    await createUser("bob@warp.test", "Temp-secret123", "Bob", true, "admin");

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toContain("/api/auth/users");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      email: "bob@warp.test",
      password: "Temp-secret123",
      displayName: "Bob",
      mustChangePassword: true,
      role: "admin",
    });
  });

  it("omits role from the body when not provided (server defaults to family)", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "kid" }));

    await createUser("kid@warp.test", "Temp-secret123");

    const [, init] = authFetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect("role" in body).toBe(false);
    expect(body.mustChangePassword).toBe(true);
  });
});
