import { describe, it, expect, vi } from "vitest";
import type { Mock } from "vitest";
import sendNotification from "../../../src/handlers/notifications/send-notification.js";
import type { ToolContext } from "../../../src/types.js";

/** Any touch of `ctx.prisma` is a failure: the tool never writes the row itself (WARP-3060). */
const NO_PRISMA = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`send_notification touched ctx.prisma.${String(prop)} — delivery belongs to the orchestrator`);
    },
  },
) as ToolContext["prisma"];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ctxWith(post: Mock, userId: string | null = "alice"): ToolContext {
  return {
    prisma: NO_PRISMA,
    http: {
      orchestrator: { get: vi.fn(), post, patch: vi.fn(), delete: vi.fn() },
    } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId ?? undefined,
    signal: new AbortController().signal,
  };
}

const DELIVERED = { id: "n1", channels: ["toast", "push"], delivered: true };

describe("send_notification", () => {
  it("rejects empty title", async () => {
    const post = vi.fn();
    const r = await sendNotification.handler({ title: "" }, ctxWith(post));
    expect(r.ok).toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it("rejects a body the route would refuse (over 2000 chars), without a hop", async () => {
    const post = vi.fn();
    const r = await sendNotification.handler({ title: "t", body: "x".repeat(2001) }, ctxWith(post));
    expect(r).toMatchObject({ ok: false, error: { code: "INVALID_ARGS" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("needs the person it acts for", async () => {
    const post = vi.fn();
    const r = await sendNotification.handler({ title: "t" }, ctxWith(post, null));
    expect(r).toMatchObject({ ok: false, error: { code: "AUTH_REQUIRED" } });
    expect(post).not.toHaveBeenCalled();
  });

  it("🔴 WARP-3060 hands the notification to the orchestrator, kind ai, and never writes a row itself", async () => {
    const post = vi.fn().mockResolvedValue(json(202, DELIVERED));
    const r = await sendNotification.handler({ title: "Pop!", body: "Done." }, ctxWith(post));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith(
      "/api/notifications/send",
      { kind: "ai", title: "Pop!", body: "Done." },
      expect.anything(),
    );
    // No recipient in the request: the orchestrator resolves the acting user.
    expect(post.mock.calls[0]![1]).not.toHaveProperty("username");
    expect(r).toEqual({ ok: true, data: { id: "n1", delivered: true, channels: ["toast", "push"] } });
  });

  it("says so when nothing carried it, so the model cannot claim it notified anyone", async () => {
    const post = vi.fn().mockResolvedValue(json(202, { id: "n2", channels: [], delivered: false, error: "toast: mqtt_unavailable" }));
    const r = await sendNotification.handler({ title: "t" }, ctxWith(post));
    expect(r.ok).toBe(true);
    expect(r).toMatchObject({ data: { id: "n2", delivered: false, channels: [] } });
    expect((r as { data: { note?: string } }).data.note).toMatch(/not delivered/i);
  });

  it("maps a 403 to FORBIDDEN", async () => {
    const post = vi.fn().mockResolvedValue(json(403, { error: "forbidden_tool_for_role" }));
    const r = await sendNotification.handler({ title: "t" }, ctxWith(post));
    expect(r).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
  });

  it("maps any other failure to NOTIFICATION_FAILED", async () => {
    const post = vi.fn().mockResolvedValue(json(500, { error: "boom" }));
    const r = await sendNotification.handler({ title: "t" }, ctxWith(post));
    expect(r).toMatchObject({ ok: false, error: { code: "NOTIFICATION_FAILED" } });
  });
});
