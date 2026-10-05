import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { patchSetupReady, patchSetupStep, patchTourCompleted, postOrg } from "@/lib/api";

describe("setup progress persistence before provider consent", () => {
  beforeEach(() => window.history.replaceState(null, "", "/setup"));
  afterEach(() => vi.unstubAllGlobals());

  it("awaits the actual request and sends the owner session", async () => {
    let finish!: (response: Response) => void;
    const fetch = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    vi.stubGlobal("fetch", fetch);
    let saved = false;
    const pending = patchSetupStep("accounts", { requireSuccess: true }).then(() => { saved = true; });
    await Promise.resolve();
    expect(saved).toBe(false);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/setup/state"), expect.objectContaining({
      method: "PATCH", credentials: "same-origin", body: JSON.stringify({ setup_step: "accounts" }),
    }));
    finish(new Response("{}", { status: 200 }));
    await pending;
    expect(saved).toBe(true);
  });

  it("rejects a denied save so the connection UI can prevent navigation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 403 })));
    await expect(patchSetupStep("accounts", { requireSuccess: true })).rejects.toThrow(/save setup progress/i);
  });

  it("rejects a failed network save in the required mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(patchSetupStep("accounts", { requireSuccess: true })).rejects.toThrow("Network unavailable");
  });

  it.each([false, true])("renews an expired access cookie for later progress (required=%s)", async (requireSuccess) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await expect(patchSetupStep("accounts", { requireSuccess })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/auth/refresh", expect.objectContaining({
      method: "POST", credentials: "same-origin",
    }));
    for (const attempt of [1, 3]) {
      expect(fetch).toHaveBeenNthCalledWith(attempt, expect.stringContaining("/api/setup/state"), expect.objectContaining({
        method: "PATCH", credentials: "same-origin", body: JSON.stringify({ setup_step: "accounts" }),
      }));
    }
  });

  it("still rejects the save if session renewal is unavailable", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    await expect(patchSetupStep("accounts", { requireSuccess: true })).rejects.toThrow(/save setup progress/i);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    { name: "workspace", path: "/api/setup/org", method: "POST", body: { name: "Fixture workspace", slug: "fixture" }, save: () => postOrg({ name: "Fixture workspace", slug: "fixture" }) },
    { name: "completion", path: "/api/setup/state", method: "PATCH", body: { appliance: "ready" }, save: patchSetupReady },
    { name: "tour", path: "/api/setup/state", method: "PATCH", body: { user_tour_completed: true }, save: patchTourCompleted },
  ])("renews the session before the $name write", async ({ path, method, body, save }) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await save();
    expect(fetch).toHaveBeenNthCalledWith(2, "/api/auth/refresh", expect.objectContaining({ method: "POST" }));
    expect(fetch).toHaveBeenNthCalledWith(3, expect.stringContaining(path), expect.objectContaining({
      method, credentials: "same-origin", body: JSON.stringify(body),
    }));
  });

  it("keeps ordinary wizard navigation best effort", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(patchSetupStep("team")).resolves.toBeUndefined();
  });

  it("keeps pre-account progress public without attempting session renewal", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await expect(patchSetupStep("claim")).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
