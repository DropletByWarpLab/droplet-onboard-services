import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import setPhoneHomeBlocking from "../../../src/handlers/network/set-phone-home-blocking.js";
import type { ToolContext } from "../../../src/types.js";

function ctxWithPatch(patch: Mock): ToolContext {
  // The handler must use ctx.http.orchestrator (not routing) — give routing a
  // throwing patch so a regression to the wrong client fails loudly.
  const routingPatch = vi.fn(() => {
    throw new Error("handler must use ctx.http.orchestrator, not routing");
  });
  return {
    http: {
      routing: { get: vi.fn(), post: vi.fn(), patch: routingPatch, delete: vi.fn() },
      orchestrator: { get: vi.fn(), post: vi.fn(), patch, delete: vi.fn() },
      cameras: {} as ToolContext["http"]["cameras"],
      switchSvc: {} as ToolContext["http"]["switchSvc"],
      fileIndexer: {} as ToolContext["http"]["fileIndexer"],
      nextcloud: {} as ToolContext["http"]["nextcloud"],
    },
    prisma: {} as ToolContext["prisma"],
    matter: {} as ToolContext["matter"],
    signal: new AbortController().signal,
  };
}

const ok = (body: unknown) =>
  vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));

describe("set_phone_home_blocking", () => {
  it("is a write tool that requires confirmation", () => {
    expect(setPhoneHomeBlocking.requiresWrite).toBe(true);
    expect(setPhoneHomeBlocking.requiresConfirmation).toBe(true);
  });

  it("master scope PATCHes /phone-home with { enabled }", async () => {
    const patch = ok({ status: "ok", enabled: true, cameras: false });
    const r = await setPhoneHomeBlocking.handler({ scope: "master", enabled: true }, ctxWithPatch(patch));
    expect(r.ok).toBe(true);
    expect(patch).toHaveBeenCalledWith("/api/network/phone-home", { enabled: true });
  });

  it("cameras scope PATCHes /phone-home with { cameras }", async () => {
    const patch = ok({ status: "ok", enabled: false, cameras: true });
    await setPhoneHomeBlocking.handler({ scope: "cameras", enabled: true }, ctxWithPatch(patch));
    expect(patch).toHaveBeenCalledWith("/api/network/phone-home", { cameras: true });
  });

  it("group scope PATCHes /groups/:id with { blockPhoneHome }", async () => {
    const patch = ok({ group: { id: "grp1", blockPhoneHome: true } });
    await setPhoneHomeBlocking.handler(
      { scope: "group", enabled: true, groupId: "grp1" },
      ctxWithPatch(patch),
    );
    expect(patch).toHaveBeenCalledWith("/api/network/groups/grp1", { blockPhoneHome: true });
  });

  it("rejects group scope without groupId", async () => {
    const patch = vi.fn();
    const r = await setPhoneHomeBlocking.handler({ scope: "group", enabled: true }, ctxWithPatch(patch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
    expect(patch).not.toHaveBeenCalled();
  });

  it("rejects an unknown scope", async () => {
    const r = await setPhoneHomeBlocking.handler({ scope: "everything", enabled: true }, ctxWithPatch(vi.fn()));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("INVALID_ARGS");
  });

  it("passes through a 202 confirmation response", async () => {
    const patch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ reason: "needs confirmation" }), { status: 202 }),
    );
    const r = await setPhoneHomeBlocking.handler({ scope: "master", enabled: true }, ctxWithPatch(patch));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe("confirmation_required");
  });
});
