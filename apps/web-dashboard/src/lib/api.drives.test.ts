/**
 * WARP-1141 — updateDriveLabel refuses an empty drive uuid up front.
 *
 * The bridge reports uuid:"" when the filesystem has no /dev/disk/by-uuid
 * link (degraded / auto-read-only pools — the live box's exact state when
 * the rename report was filed). An empty uuid would build
 * PATCH /api/storage/drives/ — a different route — so the label silently
 * vanished into a mis-routed request. The client must fail loudly before
 * any request is made. (The Drives-page rename affordance itself is hidden
 * for uuid-less drives by PR #929; this guard covers every other caller.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { updateDriveLabel } from "./api";
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

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("updateDriveLabel — empty-uuid guard (WARP-1141)", () => {
  it("rejects an empty uuid with the friendly message and never fires a request", async () => {
    await expect(
      updateDriveLabel("", { displayName: "Burrito" }),
    ).rejects.toThrow(/stable identifier/i);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("still PATCHes normally when the drive has a real uuid", async () => {
    const label = {
      uuid: "1a2b-3c4d",
      displayName: "Burrito",
      icon: null,
      notes: null,
    };
    authFetchMock.mockResolvedValueOnce(
      res({ ok: true, status: 200, json: label }),
    );

    await expect(
      updateDriveLabel("1a2b-3c4d", { displayName: "Burrito" }),
    ).resolves.toEqual(label);

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/storage/drives/1a2b-3c4d");
    expect(init?.method).toBe("PATCH");
  });
});
