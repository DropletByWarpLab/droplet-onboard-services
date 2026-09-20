/**
 * WARP-2797 — fetchRoutines() reads the shape GET /api/tools actually sends.
 *
 * The route answers `{ specs: [...] }` (routes/tools.ts) and always has; the
 * client read `body.tools` and fell back to `[]`, so the Routines page
 * rendered empty on every box while every fetch was a 200. The fallback is
 * what hid it — so an unrecognised shape now throws instead of emptying.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchRoutines } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok: boolean; status: number; json: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json),
  } as unknown as Response;
}

const spec = { id: "s1", slug: "daily-report", name: "Daily report", status: "live" };

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchRoutines (WARP-2797)", () => {
  it("reads `specs` — the shape the route sends", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: true, status: 200, json: { specs: [spec] } }));
    const out = await fetchRoutines();
    expect(out).toEqual([spec]);
    expect(authFetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/tools$/));
  });

  it("passes ?status= through, encoded", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: true, status: 200, json: { specs: [] } }));
    await fetchRoutines("draft");
    expect(authFetchMock).toHaveBeenCalledWith(expect.stringMatching(/\/api\/tools\?status=draft$/));
  });

  it("still accepts a bare array", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: true, status: 200, json: [spec] }));
    expect(await fetchRoutines()).toEqual([spec]);
  });

  it("throws on a shape it does not recognise instead of returning an empty list", async () => {
    // The exact wrong shape the client used to read — `tools` — is now an
    // error, so a future rename goes red on the page, not quiet.
    authFetchMock.mockResolvedValueOnce(res({ ok: true, status: 200, json: { tools: [spec] } }));
    await expect(fetchRoutines()).rejects.toThrow(/unexpected response shape/);
  });

  it("surfaces the server's error on a non-OK response", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: false, status: 403, json: { error: "Forbidden" } }));
    await expect(fetchRoutines()).rejects.toThrow("Forbidden");
  });
});
