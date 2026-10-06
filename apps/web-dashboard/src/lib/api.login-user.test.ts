import { beforeEach, describe, expect, it, vi } from "vitest";

const authFetch = vi.fn();
vi.mock("./auth", () => ({ authFetch: (...args: unknown[]) => authFetch(...args) }));
import { loginUser } from "./api";

describe("wizard login second factor contract", () => {
  beforeEach(() => authFetch.mockReset());

  it("preserves the typed second-factor challenge from the server", async () => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ error: "Two-factor required", code: "TOTP_REQUIRED" }), { status: 401 }));
    await expect(loginUser("owner@warp.test", "password")).rejects.toMatchObject({ code: "TOTP_REQUIRED" });
  });

  it.each([{ totp: "123456" }, { recoveryCode: "saved-code" }])("sends the chosen second factor with credentials: %j", async (factor) => {
    authFetch.mockResolvedValue(new Response(JSON.stringify({ user: { id: "owner" } }), { status: 200 }));
    await loginUser("owner@warp.test", "password", factor);
    const request = authFetch.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ email: "owner@warp.test", password: "password", ...factor });
  });
});
