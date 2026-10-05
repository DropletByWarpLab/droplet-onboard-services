import { afterEach, describe, expect, it, vi } from "vitest";
import { patchSetupStep } from "@/lib/api";

describe("setup progress persistence before provider consent", () => {
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

  it("keeps ordinary wizard navigation best effort", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Network unavailable"); }));
    await expect(patchSetupStep("team")).resolves.toBeUndefined();
  });
});
