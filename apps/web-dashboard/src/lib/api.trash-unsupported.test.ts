/**
 * WARP-1555 — `fetchTrash` must not launder a 501 into an empty trash.
 *
 * The backend answers 501 when the box's storage has no trashbin at all. The
 * client turned that into `[]`, which every caller then rendered as "Trash is
 * empty" — telling a user their deleted files are recoverable when no trash
 * bin exists, or that nothing was deleted when in fact nothing is kept. The
 * 501 now surfaces as a typed error the UI can render as its own state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchTrash, isTrashUnsupportedError, TrashUnsupportedError } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok: boolean; status: number; json?: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json ?? {}),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchTrash — 501 is 'unsupported', not 'empty' (WARP-1555)", () => {
  it("throws TrashUnsupportedError on 501 instead of resolving to []", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: false, status: 501 }));

    await expect(fetchTrash()).rejects.toBeInstanceOf(TrashUnsupportedError);
  });

  it("tags the 501 error so the UI can tell it from a plain load failure", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: false, status: 501 }));

    const err = await fetchTrash().catch((e: unknown) => e);
    expect(isTrashUnsupportedError(err)).toBe(true);
    expect(isTrashUnsupportedError(new Error("Failed to fetch trash: 500"))).toBe(false);
  });

  it("still throws a plain error for other failures", async () => {
    authFetchMock.mockResolvedValueOnce(res({ ok: false, status: 500 }));

    const err = await fetchTrash().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(isTrashUnsupportedError(err)).toBe(false);
  });

  it("returns the items on a successful fetch", async () => {
    const items = [
      {
        name: "photo.jpg.d1712860391",
        originalName: "photo.jpg",
        originalLocation: "/Photos",
        size: 1024,
        deletedAt: "2026-07-20T10:00:00.000Z",
        isDirectory: false,
      },
    ];
    authFetchMock.mockResolvedValueOnce(res({ ok: true, status: 200, json: { items } }));

    await expect(fetchTrash()).resolves.toEqual(items);
  });
});
