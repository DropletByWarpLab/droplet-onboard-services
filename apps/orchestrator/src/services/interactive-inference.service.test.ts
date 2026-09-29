/**
 * WARP-2979 (ADR-059 P4 §6.9.2) — how the box knows chat is busy: an
 * in-flight counter on the two interactive LLM routes, over a mini app with
 * the real middleware. The narrator reads `interactiveInferenceIdle` before
 * it starts a call and aborts its call from `onInteractiveInferenceStart`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import http from "node:http";
import type { AddressInfo } from "node:net";

import {
  INTERACTIVE_QUIET_MS,
  _resetInteractiveInferenceForTests,
  interactiveInferenceIdle,
  interactiveInferenceState,
  onInteractiveInferenceStart,
  trackInteractiveInference,
} from "./interactive-inference.service.js";

afterEach(() => {
  _resetInteractiveInferenceForTests();
  vi.useRealTimers();
});

/** The shape app.ts mounts: the tracker on the two paths, then the routes. */
function miniApp(handlers: {
  chat?: (req: Request, res: Response, next: NextFunction) => void;
  guard?: (req: Request, res: Response, next: NextFunction) => void;
}) {
  const app = express();
  app.use(express.json());
  app.use(["/api/llm/chat", "/api/llm/complete"], trackInteractiveInference);
  if (handlers.guard) app.use("/api", handlers.guard);
  app.post("/api/llm/chat", handlers.chat ?? ((_req, res) => res.json({ ok: true })));
  app.post("/api/llm/complete", (_req, res) => res.json({ ok: true }));
  app.get("/api/llm/chat", (_req, res) => res.json({ ok: true }));
  app.post("/api/llm/models", (_req, res) => res.json({ ok: true }));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    res.status(500).json({ error: "INTERNAL_ERROR" });
  });
  return app;
}

describe("trackInteractiveInference", () => {
  it("a streaming chat is in flight while it streams and not after; the start listener fires synchronously", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const seen: number[] = [];
    const starts = vi.fn(() => seen.push(interactiveInferenceState().inFlight));
    const off = onInteractiveInferenceStart(starts);
    const app = miniApp({
      chat: async (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: one\n\n");
        seen.push(interactiveInferenceState().inFlight);
        await gate;
        res.end("data: [DONE]\n\n");
      },
    });
    const pending = request(app).post("/api/llm/chat").send({ messages: [] });
    const done = pending.then((r) => r);
    await vi.waitFor(() => expect(interactiveInferenceState().inFlight).toBe(1));
    expect(interactiveInferenceIdle(Date.now())).toBe(false);
    release();
    const res = await done;
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(interactiveInferenceState().inFlight).toBe(0));
    expect(starts).toHaveBeenCalledTimes(1);
    // The listener ran when the request STARTED (the counter already counted it), before the handler wrote.
    expect(seen).toEqual([1, 1]);
    expect(interactiveInferenceState().lastEndedAt).not.toBeNull();
    off();
  });

  it("counts /llm/complete too, and only POSTs — a GET and another /llm route are not chat", async () => {
    const starts = vi.fn();
    onInteractiveInferenceStart(starts);
    const app = miniApp({});
    await request(app).post("/api/llm/complete").send({});
    await request(app).get("/api/llm/chat");
    await request(app).post("/api/llm/models").send({});
    expect(starts).toHaveBeenCalledTimes(1);
    expect(interactiveInferenceState()).toMatchObject({ inFlight: 0 });
  });

  it("a client that aborts mid-stream leaves the counter at 0", async () => {
    let ended = false;
    const app = miniApp({
      chat: (_req, res) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.write("data: one\n\n");
        // Never ends on its own: only the client's disconnect closes it.
        res.on("close", () => (ended = true));
      },
    });
    const server = http.createServer(app).listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.request({ port, method: "POST", path: "/api/llm/chat", headers: { "content-type": "application/json" } }, (res) => {
          res.once("data", () => {
            expect(interactiveInferenceState().inFlight).toBe(1);
            req.destroy();
            resolve();
          });
        });
        req.on("error", () => undefined);
        req.end("{}");
        setTimeout(() => reject(new Error("no first chunk")), 5_000);
      });
      await vi.waitFor(() => expect(ended).toBe(true));
      await vi.waitFor(() => expect(interactiveInferenceState().inFlight).toBe(0));
    } finally {
      server.close();
    }
  });

  it("an error through next(err) and a 401 before the handler both leave it at 0", async () => {
    const failing = miniApp({ chat: (_req, _res, next) => next(new Error("boom")) });
    expect((await request(failing).post("/api/llm/chat").send({})).status).toBe(500);
    expect(interactiveInferenceState().inFlight).toBe(0);

    const refused = miniApp({ guard: (_req, res) => void res.status(401).json({ error: "UNAUTHORIZED" }) });
    expect((await request(refused).post("/api/llm/chat").send({})).status).toBe(401);
    expect(interactiveInferenceState().inFlight).toBe(0);
  });

  it("'finish' and 'close' both firing decrement exactly once", () => {
    const listeners = new Map<string, Array<() => void>>();
    const res = {
      on: (ev: string, fn: () => void) => void listeners.set(ev, [...(listeners.get(ev) ?? []), fn]),
    } as unknown as Response;
    const next = vi.fn();
    trackInteractiveInference({ method: "POST" } as Request, res, next);
    trackInteractiveInference({ method: "POST" } as Request, res, next);
    // Two requests share this fake response's listeners: each registers its own once-only release.
    expect(interactiveInferenceState().inFlight).toBe(2);
    for (const fn of listeners.get("finish") ?? []) fn();
    for (const fn of listeners.get("close") ?? []) fn();
    for (const fn of listeners.get("close") ?? []) fn();
    expect(interactiveInferenceState().inFlight).toBe(0);
    expect(next).toHaveBeenCalledTimes(2);
  });
});

describe("app.ts mounts it on both interactive routes, right before the LLM router", () => {
  it("is the line immediately before createLlmRouter (a source pin: app.ts is too heavy to boot here)", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const app = readFileSync(resolve(__dirname, "../app.ts"), "utf8").replace(/\r\n/g, "\n");
    expect(app).toMatch(/import \{ trackInteractiveInference \} from "\.\/services\/interactive-inference\.service\.js";/);
    const mount = 'app.use(["/api/llm/chat", "/api/llm/complete"], trackInteractiveInference);';
    const router = 'app.use("/api", createLlmRouter(prisma));';
    expect(app.split(mount)).toHaveLength(2);
    const lines = app.split("\n").map((l) => l.trim());
    const at = lines.indexOf(router);
    expect(at).toBeGreaterThan(0);
    // Only comments may sit between the two.
    const before = lines.slice(0, at).filter((l) => l && !l.startsWith("//"));
    expect(before[before.length - 1]).toBe(mount);
  });
});

describe("interactiveInferenceIdle", () => {
  it("idle only when nothing is in flight AND the last turn ended at least 30 s ago", () => {
    vi.useFakeTimers({ now: new Date("2026-09-25T02:00:00Z") });
    const t0 = Date.now();
    expect(INTERACTIVE_QUIET_MS).toBe(30_000);
    // Never used since boot: idle.
    expect(interactiveInferenceIdle(t0)).toBe(true);

    const handlers = new Map<string, () => void>();
    const res = { on: (ev: string, fn: () => void) => void handlers.set(ev, fn) } as unknown as Response;
    trackInteractiveInference({ method: "POST" } as Request, res, () => undefined);
    expect(interactiveInferenceIdle(t0 + 120_000)).toBe(false);
    handlers.get("finish")!();
    const ended = Date.now();
    expect(interactiveInferenceIdle(ended + 29_999)).toBe(false);
    expect(interactiveInferenceIdle(ended + 30_000)).toBe(true);
    // A caller may ask for a different quiet.
    expect(interactiveInferenceIdle(ended + 5_000, 5_000)).toBe(true);
  });

  it("an unsubscribed listener is not called; a throwing listener never breaks the request", () => {
    const a = vi.fn();
    const b = vi.fn(() => {
      throw new Error("listener bug");
    });
    const offA = onInteractiveInferenceStart(a);
    onInteractiveInferenceStart(b);
    offA();
    const next = vi.fn();
    trackInteractiveInference({ method: "POST" } as Request, { on: () => undefined } as unknown as Response, next);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
