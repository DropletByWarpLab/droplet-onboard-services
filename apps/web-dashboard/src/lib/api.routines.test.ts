/**
 * WARP-2797 — `fetchRoutines` reads the envelope `GET /api/tools` actually
 * sends.
 *
 * The list route (`apps/orchestrator/src/routes/tools.ts`) answers
 * `{ specs: Routine[] }`. The reader used to look for `body.tools`, so every
 * box showed the `/routines` empty state regardless of data. iOS decodes
 * `specs`; the route is the contract both clients share, so the reader is
 * the side that moves.
 *
 * The second case is the one that hid the bug: the old `{ tools }` shape
 * must yield ZERO routines, not be quietly accepted. A tolerant reader is a
 * green test against the wrong envelope.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchRoutines } from "./api";
import { authFetch } from "./auth";
import type { Routine } from "./types";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: "spec-1",
    slug: "daily-report",
    name: "Daily report",
    category: null,
    description: null,
    version: 1,
    status: "live",
    ownerId: "u-owner",
    share: null,
    safety: 1,
    writes: false,
    reversible: true,
    createdAt: "2026-09-19T00:00:00.000Z",
    updatedAt: "2026-09-19T00:00:00.000Z",
    ...over,
  };
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchRoutines (WARP-2797) — the { specs } envelope", () => {
  it("decodes { specs: [...] } into routines with their status intact", async () => {
    authFetchMock.mockResolvedValue(
      res({
        specs: [
          routine({ id: "spec-live", slug: "daily-report", status: "live" }),
          routine({ id: "spec-draft", slug: "weekly-digest", status: "draft" }),
        ],
      }),
    );

    const rows = await fetchRoutines();

    expect(rows).toHaveLength(2);
    expect(rows.map((r) => [r.slug, r.status])).toEqual([
      ["daily-report", "live"],
      ["weekly-digest", "draft"],
    ]);
    expect(authFetchMock).toHaveBeenCalledWith("/api/tools");
  });

  it("does NOT accept the old { tools: [...] } shape — that tolerance hid the bug", async () => {
    authFetchMock.mockResolvedValue(
      res({
        tools: [
          routine({ id: "spec-live", slug: "daily-report", status: "live" }),
          routine({ id: "spec-draft", slug: "weekly-digest", status: "draft" }),
        ],
      }),
    );

    const rows = await fetchRoutines();

    expect(rows).toEqual([]);
  });

  it("forwards the status filter as ?status=", async () => {
    authFetchMock.mockResolvedValue(res({ specs: [] }));
    await fetchRoutines("draft");
    expect(authFetchMock).toHaveBeenCalledWith("/api/tools?status=draft");
  });

  it("surfaces the route's error body when the list fails", async () => {
    authFetchMock.mockResolvedValue(
      res({ error: "Invalid status filter" }, false, 400),
    );
    await expect(fetchRoutines()).rejects.toThrow("Invalid status filter");
  });
});
