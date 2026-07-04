/**
 * WARP-824 — API client: createUser carries the forced-change flag, and the
 * new changePassword() helper posts to /api/auth/change-password.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// auth.tsx is a module cycle with api.ts; stub authFetch so api.ts's import
// resolves without pulling the whole auth provider tree.
const authFetchMock = vi.fn();
vi.mock("@/lib/auth", () => ({
  authFetch: (...a: unknown[]) => authFetchMock(...a),
}));

import { createUser, changePassword } from "@/lib/api";

function okJson(body: unknown = { status: "ok" }) {
  return { ok: true, json: async () => body } as Response;
}
function errJson(status: number, body: unknown) {
  return { ok: false, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("createUser — mustChangePassword flag", () => {
  it("sends mustChangePassword in the POST body when provided", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "kid" }));

    await createUser("kid@warp.test", "Temp-secret123", "Kid", true);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toContain("/api/auth/users");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      email: "kid@warp.test",
      password: "Temp-secret123",
      displayName: "Kid",
      mustChangePassword: true,
    });
  });

  it("can send mustChangePassword=false (operator opted out)", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "kid" }));

    await createUser("kid@warp.test", "Temp-secret123", undefined, false);

    const [, init] = authFetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.mustChangePassword).toBe(false);
  });

  // WARP-1049: the wizard TeamStep picks the new member's household role,
  // so the client must thread `role` through to POST /auth/users.
  it("sends the chosen role in the POST body", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "kid" }));

    await createUser("kid@warp.test", "Temp-secret123", "Kid", true, "admin");

    const [, init] = authFetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.role).toBe("admin");
  });

  it("omits role when not provided (server defaults to family)", async () => {
    authFetchMock.mockResolvedValueOnce(okJson({ status: "ok", username: "kid" }));

    await createUser("kid@warp.test", "Temp-secret123");

    const [, init] = authFetchMock.mock.calls[0]!;
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.role).toBeUndefined();
  });
});

describe("changePassword", () => {
  it("POSTs current + new password to /api/auth/change-password", async () => {
    authFetchMock.mockResolvedValueOnce(okJson());

    await changePassword("Temp-secret123", "Brand-new-secret123");

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toContain("/api/auth/change-password");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      currentPassword: "Temp-secret123",
      newPassword: "Brand-new-secret123",
    });
  });

  it("throws with the server error code/message on failure", async () => {
    authFetchMock.mockResolvedValueOnce(
      errJson(400, { error: "Invalid current password", code: "INVALID_PASSWORD" }),
    );

    await expect(changePassword("wrong", "Brand-new-secret123")).rejects.toMatchObject({
      message: "Invalid current password",
      code: "INVALID_PASSWORD",
    });
  });
});
