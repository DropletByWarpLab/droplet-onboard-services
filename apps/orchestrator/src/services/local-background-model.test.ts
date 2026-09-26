/**
 * WARP-2979 (ADR-059 P4 §6.10, D19) — the ONE resolver for unattended model
 * work that must stay on the box: filing's pre-flight (WARP-2730), moved here
 * verbatim so Droplet's incident summaries use the same answer. Filing keeps
 * its name for it through a re-export (filing-loop.test.ts still runs its
 * own cases through `resolveFilingModel`, unchanged).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const gw = vi.hoisted(() => ({ listModels: vi.fn(), chat: vi.fn() }));
vi.mock("./ai-gateway.client.js", () => ({ listModels: gw.listModels, chat: gw.chat }));
const cloud = vi.hoisted(() => ({ resolveOffLanProvider: vi.fn() }));
vi.mock("./cloud-access.service.js", async (orig) => ({
  ...(await orig<typeof import("./cloud-access.service.js")>()),
  resolveOffLanProvider: cloud.resolveOffLanProvider,
}));

import { resolveLocalBackgroundModel } from "./local-background-model.js";
import { resolveFilingModel } from "./filing/extract.js";

const prismaWith = (stored: string | null) =>
  ({ workspaceSetting: { findUnique: async () => (stored === null ? null : { valueJson: stored }) } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  cloud.resolveOffLanProvider.mockResolvedValue(null);
});

describe("resolveLocalBackgroundModel", () => {
  it("is what filing calls resolveFilingModel — one resolver, not two", () => {
    expect(resolveFilingModel).toBe(resolveLocalBackgroundModel);
  });

  it("the active chat model, when it is an installed LOCAL model", async () => {
    gw.listModels.mockResolvedValue({ models: [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }] });
    expect(await resolveLocalBackgroundModel(prismaWith("gpt-oss:20b"))).toEqual({ ok: true, model: "gpt-oss:20b" });
    expect(cloud.resolveOffLanProvider).toHaveBeenCalledWith({ user: undefined, model: "gpt-oss:20b" });
  });

  it("a CLOUD active model resolves to 'no local model', never to itself — even with a local one installed", async () => {
    gw.listModels.mockResolvedValue({
      models: [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" },
      ],
    });
    const r = await resolveLocalBackgroundModel(prismaWith("claude-sonnet-4"));
    expect(r.ok === true && r.model === "claude-sonnet-4").toBe(false);
  });

  it("refuseCloudActive (the narrator's opt-in): a CATALOGUED cloud active model pauses the work instead of falling back to a local one", async () => {
    gw.listModels.mockResolvedValue({
      models: [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4", provider: "anthropic" },
        { id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" },
      ],
    });
    // Filing's behaviour is unchanged: the box's own fallback, a local model.
    expect(await resolveLocalBackgroundModel(prismaWith("claude-sonnet-4"))).toEqual({ ok: true, model: "gpt-oss:20b" });
    // The narrator's: the owner chose a cloud model for chat, so the local runtime may not hold one — Paused.
    expect(await resolveLocalBackgroundModel(prismaWith("claude-sonnet-4"), { refuseCloudActive: true })).toEqual({
      ok: false,
      reason: "cloud_model_refused",
      detail: "the active chat model is a cloud model",
    });
    // Matched by display name too (a legacy stored value).
    expect(await resolveLocalBackgroundModel(prismaWith("Claude Sonnet 4"), { refuseCloudActive: true })).toMatchObject({ ok: false });
    // A stale LOCAL tag is not a cloud choice: the box's fallback stands.
    expect(await resolveLocalBackgroundModel(prismaWith("llama3:8b"), { refuseCloudActive: true })).toEqual({ ok: true, model: "gpt-oss:20b" });
    expect(await resolveLocalBackgroundModel(prismaWith("gpt-oss:20b"), { refuseCloudActive: true })).toEqual({ ok: true, model: "gpt-oss:20b" });
  });

  it("a catalogue that disagrees with itself about locality is refused", async () => {
    gw.listModels.mockResolvedValue({ models: [{ id: "claude-distill:7b", name: "claude-distill:7b", provider: "local" }] });
    cloud.resolveOffLanProvider.mockResolvedValue("anthropic");
    expect(await resolveLocalBackgroundModel(prismaWith("claude-distill:7b"))).toEqual({
      ok: false,
      reason: "cloud_model_refused",
      detail: "anthropic",
    });
  });

  it.each([
    ["a degraded listing", { models: [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }], degraded: true }],
    ["a listing with a degraded provider", { models: [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }], degraded_providers: ["local"] }],
    ["no local model installed", { models: [] }],
  ])("%s → model_unreachable", async (_label, listing) => {
    gw.listModels.mockResolvedValue(listing);
    expect(await resolveLocalBackgroundModel(prismaWith("gpt-oss:20b"))).toMatchObject({ ok: false, reason: "model_unreachable" });
  });

  it("a gateway that cannot be listed → model_unreachable, never a hardcoded fallback", async () => {
    gw.listModels.mockRejectedValue(new Error("ECONNREFUSED"));
    expect(await resolveLocalBackgroundModel(prismaWith("gpt-oss:20b"))).toEqual({
      ok: false,
      reason: "model_unreachable",
      detail: "model listing failed",
    });
  });

  it("never sends a chat request itself", async () => {
    gw.listModels.mockResolvedValue({ models: [{ id: "gpt-oss:20b", name: "gpt-oss:20b", provider: "local" }] });
    await resolveLocalBackgroundModel(prismaWith("gpt-oss:20b"));
    expect(gw.chat).not.toHaveBeenCalled();
  });
});
