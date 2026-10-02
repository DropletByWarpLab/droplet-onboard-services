/**
 * WARP-3101 — a ToolContext for the tools that reach their rows through the
 * orchestrator (calendar, reminders): `ctx.http.orchestrator` is four recording
 * mocks, and `ctx.prisma` throws on ANY touch, so a handler that reads or
 * writes its table itself fails loudly instead of passing on a stub.
 *
 * The mocks' parameters are declared: vitest 3 types an untyped `vi.fn` as a
 * zero-length tuple and `mock.calls[0]![0]` then fails `typecheck:tests`.
 */
import { vi } from "vitest";
import type { ToolContext } from "../../src/types.js";

export const NO_PRISMA = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(`the handler touched ctx.prisma.${String(prop)} — its rows belong to the orchestrator (WARP-3101)`);
    },
  },
) as ToolContext["prisma"];

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

type Opts = { headers?: Record<string, string> } | undefined;

export function orchestratorCtx(userId: string | null = "alice") {
  const get = vi.fn(async (_path: string, _opts?: Opts): Promise<Response> => json(500, {}));
  const post = vi.fn(async (_path: string, _body?: unknown, _opts?: Opts): Promise<Response> => json(500, {}));
  const patch = vi.fn(async (_path: string, _body?: unknown, _opts?: Opts): Promise<Response> => json(500, {}));
  const del = vi.fn(async (_path: string, _opts?: Opts): Promise<Response> => json(500, {}));
  const ctx: ToolContext = {
    prisma: NO_PRISMA,
    http: { orchestrator: { get, post, patch, delete: del } } as unknown as ToolContext["http"],
    matter: {} as ToolContext["matter"],
    userId: userId ?? undefined,
    signal: new AbortController().signal,
  };
  return { ctx, get, post, patch, delete: del };
}

/** The query of the one GET the handler made, as a plain object. */
export function queryOf(path: string): Record<string, string> {
  const q = path.indexOf("?");
  return Object.fromEntries(new URLSearchParams(q < 0 ? "" : path.slice(q + 1)));
}
