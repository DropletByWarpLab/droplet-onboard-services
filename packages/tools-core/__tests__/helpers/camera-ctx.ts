/**
 * WARP-3927 — a ToolContext for the camera activity tools: the orchestrator
 * client answers by PATH (query ignored) from a table of handlers, every call is
 * recorded with its `params`, and `ctx.prisma` serves the one row the tools read
 * (the camera business-hours row, which carries the workspace time zone).
 */
import { vi } from "vitest";
import type { ToolContext } from "../../src/types.js";

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export type Params = Record<string, unknown>;
export type RouteFn = (params: Params, path: string) => Response | Promise<Response>;

export interface GetCall {
  path: string;
  params: Params;
}

/** `timezone: null` = the business-hours row is unset (the box zone applies). */
export function cameraCtx(routes: Record<string, RouteFn>, timezone: string | null = "America/Los_Angeles") {
  const calls: GetCall[] = [];
  const get = vi.fn(async (path: string, opts?: { params?: Params }): Promise<Response> => {
    const params = opts?.params ?? {};
    calls.push({ path, params });
    const key = path.split("?")[0];
    const fn = routes[key];
    return fn ? fn(params, path) : json(404, { error: `no mock for ${key}` });
  });
  const findUnique = vi.fn(async () =>
    timezone === null ? null : { key: "cameras.business_hours", valueJson: { configured: true, timezone } },
  );
  const ctx = {
    prisma: { systemFlag: { findUnique } },
    http: { orchestrator: { get, post: vi.fn(), patch: vi.fn(), delete: vi.fn() } },
    matter: {},
    signal: new AbortController().signal,
  } as unknown as ToolContext;
  return { ctx, get, calls, findUnique };
}

/** 2026-10-08T12:00:00Z — 05:00 PDT, 08:00 EDT. */
export const NOW_ISO = "2026-10-08T12:00:00Z";
export const NOW_EPOCH = Date.parse(NOW_ISO) / 1000;
