/**
 * WARP-3515 — the dashboard's client for the WARP-3512 recording-storage
 * contract: GET/PUT /api/storage/recordings, the old-footage delete, and the
 * one-time recovery-key read.
 *
 * Two properties carry the whole design and are pinned here:
 *
 *   1. ABSENCE IS NOT AN ERROR. The three backend branches land separately, so a
 *      404 (endpoint not there yet) and a 403 (role may not read it) resolve to
 *      a typed "unavailable" result the UI turns into a neutral state; only a
 *      transport failure or a 5xx throws.
 *   2. THE KEY IS READ ONCE. `fetchRecoveryKey` never retries, never caches, and
 *      keeps "this key was already shown" (410) distinct from "couldn't ask".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  RecoveryKeyUnavailableError,
  deleteOldRecordings,
  fetchRecordingStorage,
  fetchRecoveryKey,
  updateRecordingStorage,
} from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { ok?: boolean; status: number; json?: unknown; jsonRejects?: boolean }): Response {
  const ok = init.ok ?? (init.status >= 200 && init.status < 300);
  return {
    ok,
    status: init.status,
    json: init.jsonRejects
      ? vi.fn().mockRejectedValue(new SyntaxError("Unexpected token <"))
      : vi.fn().mockResolvedValue(init.json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

const TOKEN = {
  status: "confirmation_required",
  confirmationToken: "tok-1",
  service: "recordings_set",
  resourceId: "fs-uuid-2",
  tier: 2,
  expiresIn: 60,
};

describe("fetchRecordingStorage", () => {
  it("GETs /api/storage/recordings and returns the normalised payload", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({
        status: 200,
        json: {
          status: "active",
          mode: "full",
          drive: { fsUuid: "u1", label: "Bay 2", model: "", sizeBytes: 100, encrypted: true, mountPath: "/m" },
          reservedBytes: 100,
          usedBytes: 10,
          freeBytes: 90,
          needBytes: 20,
          retentionDays: 7,
          daysStored: 2,
          cameras: [],
          migration: { state: "idle", progressPct: 0, bytesCopied: 0, bytesTotal: 0, startedAt: null, error: null },
          oldFootage: { present: false, bytes: 0, location: "system_disk" },
          warnings: [],
          eligibleDrives: [],
        },
      }),
    );

    const result = await fetchRecordingStorage();

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(String(authFetchMock.mock.calls[0]![0])).toContain("/api/storage/recordings");
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.data.status).toBe("active");
      expect(result.data.mode).toBe("full");
      expect(result.data.drive?.label).toBe("Bay 2");
    }
  });

  it("treats a 404 as 'not on this Droplet yet' — not an error", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 404, json: { error: "Not found" } }));
    await expect(fetchRecordingStorage()).resolves.toEqual({
      available: false,
      reason: "not_supported",
    });
  });

  it("treats a 403 as 'this role may not read it' — not an error", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 403, json: { error: "Forbidden" } }));
    await expect(fetchRecordingStorage()).resolves.toEqual({
      available: false,
      reason: "forbidden",
    });
  });

  it("treats a 200 whose body is not JSON as not supported (a proxy fallback page)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, jsonRejects: true }));
    await expect(fetchRecordingStorage()).resolves.toEqual({
      available: false,
      reason: "not_supported",
    });
  });

  it("treats a 200 whose JSON is not an object as not supported", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: "ok" }));
    await expect(fetchRecordingStorage()).resolves.toEqual({
      available: false,
      reason: "not_supported",
    });
  });

  it("survives a payload with missing fields (renders, never throws)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: {} }));
    const result = await fetchRecordingStorage();
    expect(result.available).toBe(true);
    if (result.available) {
      expect(result.data.status).toBe("unknown");
      expect(result.data.cameras).toEqual([]);
    }
  });

  it("THROWS on a 5xx so the caller can say 'couldn't load', not 'not available'", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 502, json: { error: "bridge" } }));
    await expect(fetchRecordingStorage()).rejects.toThrow();
  });

  it("propagates a transport failure", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchRecordingStorage()).rejects.toThrow(/failed to fetch/i);
  });
});

describe("updateRecordingStorage — PUT /api/storage/recordings (tier-2)", () => {
  it("PUTs the change and, on a 202 + token, echoes it through the storage confirm", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: TOKEN }))
      .mockResolvedValueOnce(res({ status: 200, json: { ok: true } }));

    await expect(updateRecordingStorage({ mode: "full" })).resolves.toBeUndefined();

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    const [putUrl, putInit] = authFetchMock.mock.calls[0]!;
    expect(String(putUrl)).toContain("/api/storage/recordings");
    expect((putInit as RequestInit).method).toBe("PUT");
    expect(JSON.parse((putInit as RequestInit).body as string)).toEqual({ mode: "full" });

    const [confirmUrl, confirmInit] = authFetchMock.mock.calls[1]!;
    expect(String(confirmUrl)).toContain("/api/storage/command/confirm");
    expect((confirmInit as RequestInit).method).toBe("POST");
    expect(JSON.parse((confirmInit as RequestInit).body as string)).toEqual({
      confirmationToken: "tok-1",
      service: "recordings_set",
      resourceId: "fs-uuid-2",
    });
  });

  it("sends the chosen drive as fsUuid", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 202, json: { status: "accepted" } }));
    await updateRecordingStorage({ fsUuid: "fs-uuid-2" });
    const [, init] = authFetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ fsUuid: "fs-uuid-2" });
  });

  it("accepts a 202/200 with NO token as already applied (no confirm call)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 202, json: { status: "accepted" } }));
    await expect(updateRecordingStorage({ mode: "auto_reserved" })).resolves.toBeUndefined();
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty change without making a request", async () => {
    await expect(updateRecordingStorage({})).rejects.toThrow(/nothing to change/i);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("carries the HTTP status on a refusal so the UI can pick its copy (409)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 409, json: { error: "migration running" } }));
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toMatchObject({ status: 409 });
  });

  it("carries the HTTP status on a 403", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 403, json: { error: "no" } }));
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toMatchObject({ status: 403 });
  });

  it("carries the HTTP status on a 404 (endpoint absent)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 404, json: {} }));
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a token that arrives without the service/resourceId the confirm must echo", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ status: 202, json: { confirmationToken: "tok-1" } }),
    );
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toThrow(/unexpected 202/i);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects when the confirm step itself fails", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: TOKEN }))
      .mockResolvedValueOnce(res({ status: 400, json: { error: "Token expired" } }));
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toThrow(/token expired/i);
  });
});

describe("deleteOldRecordings — POST /api/storage/recordings/old-footage/delete (tier-3)", () => {
  it("POSTs, then echoes the 202 token through the storage confirm", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        res({ status: 202, json: { ...TOKEN, service: "recordings_old_delete", tier: 3 } }),
      )
      .mockResolvedValueOnce(res({ status: 200, json: { ok: true } }));

    await expect(deleteOldRecordings()).resolves.toBeUndefined();

    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/storage/recordings/old-footage/delete");
    expect((init as RequestInit).method).toBe("POST");
    const [confirmUrl, confirmInit] = authFetchMock.mock.calls[1]!;
    expect(String(confirmUrl)).toContain("/api/storage/command/confirm");
    expect(JSON.parse((confirmInit as RequestInit).body as string)).toMatchObject({
      confirmationToken: "tok-1",
      service: "recordings_old_delete",
    });
  });

  it("carries the HTTP status on a 409 (move not finished)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 409, json: { error: "migrating" } }));
    await expect(deleteOldRecordings()).rejects.toMatchObject({ status: 409 });
  });

  it("carries the HTTP status on a 403 (owner only)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 403, json: {} }));
    await expect(deleteOldRecordings()).rejects.toMatchObject({ status: 403 });
  });
});

describe("fetchRecoveryKey — GET /api/storage/drives/:id/recovery-key (read ONCE)", () => {
  it("returns the key on a 200", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ status: 200, json: { recoveryKey: "ABCD-EFGH-IJKL-MNOP" } }),
    );
    await expect(fetchRecoveryKey("U-1")).resolves.toBe("ABCD-EFGH-IJKL-MNOP");

    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/storage/drives/U-1/recovery-key");
    // A one-time secret must never land in an HTTP cache.
    expect((init as RequestInit).cache).toBe("no-store");
    expect(((init as RequestInit).method ?? "GET").toUpperCase()).toBe("GET");
  });

  it("URL-encodes the drive id", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "k" } }));
    await fetchRecoveryKey("a b/c");
    expect(String(authFetchMock.mock.calls[0]![0])).toContain("/drives/a%20b%2Fc/recovery-key");
  });

  it("maps a 410 to RecoveryKeyUnavailableError('gone') — already shown", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 410, json: { error: "gone" } }));
    const err = await fetchRecoveryKey("U-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe("gone");
  });

  it("maps a 404 to RecoveryKeyUnavailableError('not_found')", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 404, json: {} }));
    const err = await fetchRecoveryKey("U-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe("not_found");
  });

  it("maps a 403 to RecoveryKeyUnavailableError('forbidden')", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 403, json: {} }));
    const err = await fetchRecoveryKey("U-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe("forbidden");
  });

  it("a 5xx is a plain failure carrying its status — NOT 'already shown'", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 502, json: { error: "bridge" } }));
    const err = await fetchRecoveryKey("U-1").catch((e) => e);
    expect(err).not.toBeInstanceOf(RecoveryKeyUnavailableError);
    expect(err).toMatchObject({ status: 502 });
  });

  it("rejects an empty body rather than showing a blank key", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: {} }));
    await expect(fetchRecoveryKey("U-1")).rejects.toThrow();
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "   " } }));
    await expect(fetchRecoveryKey("U-1")).rejects.toThrow();
  });

  it("refuses an empty drive id without making a request", async () => {
    const err = await fetchRecoveryKey("").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe("not_found");
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("never retries — a retry after a read that succeeded server-side would 410", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(fetchRecoveryKey("U-1")).rejects.toThrow(/failed to fetch/i);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });
});
