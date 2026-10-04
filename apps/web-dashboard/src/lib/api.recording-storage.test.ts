/**
 * WARP-3515 — the dashboard's client for the WARP-3512 recording-storage
 * contract: GET/PUT /api/storage/recordings, the old-footage delete, and the
 * one-time recovery-key read.
 *
 * Properties that carry the whole design and are pinned here:
 *
 *   1. ABSENCE IS NOT AN ERROR. The three backend branches land separately, so a
 *      404 (endpoint not there yet) and a 403 (role may not read it) resolve to
 *      a typed "unavailable" result the UI turns into a neutral state; only a
 *      transport failure or a 5xx throws.
 *   2. THE KEY IS REVEALED ONCE. `revealRecoveryKey` is a POST with the tier-2
 *      handshake (the key arrives on the confirm), never retries, never caches,
 *      and keeps "already shown or expired" (410) distinct from "couldn't ask".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  RecoveryKeyUnavailableError,
  confirmPoolCommand,
  deleteOldRecordings,
  fetchRecordingStorage,
  reclaimDrive,
  regenerateRecoveryKey,
  requestAdoptDrive,
  requestFormatPool,
  revealRecoveryKey,
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
  resourceId: "recordings",
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
      resourceId: "recordings",
    });
  });

  it("sends the chosen drive as fsUuid", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: TOKEN }))
      .mockResolvedValueOnce(res({ status: 200, json: { ok: true } }));
    await updateRecordingStorage({ fsUuid: "fs-uuid-2" });
    const [, init] = authFetchMock.mock.calls[0]!;
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ fsUuid: "fs-uuid-2" });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([200, 202])("rejects a %d success response without the required confirmation token", async (status) => {
    authFetchMock.mockResolvedValueOnce(res({ status, json: { status: "accepted" } }));
    await expect(updateRecordingStorage({ mode: "auto_reserved" })).rejects.toThrow(/confirmation token/i);
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
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toThrow(/operation or resource/i);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { service: "pool_destroy", resourceId: "md0" },
    { service: "recordings_set", resourceId: "fs-uuid-2" },
  ])("rejects a token for a different operation or resource ($service / $resourceId)", async (target) => {
    authFetchMock.mockResolvedValueOnce(
      res({ status: 202, json: { ...TOKEN, ...target } }),
    );
    await expect(updateRecordingStorage({ mode: "full" })).rejects.toThrow(/operation or resource/i);
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
        res({
          status: 202,
          json: {
            ...TOKEN,
            service: "recordings_old_footage_delete",
            resourceId: "recordings",
            tier: 3,
          },
        }),
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
      service: "recordings_old_footage_delete",
      resourceId: "recordings",
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

describe("revealRecoveryKey — POST /api/storage/drives/:id/recovery-key/reveal (tier 2, ONCE)", () => {
  const REVEAL_TOKEN = {
    status: "confirmation_required",
    confirmationToken: "tok-key",
    service: "recovery_key_reveal",
    resourceId: "U-1",
    tier: 2,
    expiresIn: 60,
  };

  it("POSTs the reveal, echoes the 202 token through the storage confirm, and returns the key from it", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockResolvedValueOnce(
        res({ status: 200, json: { ok: true, status: "ok", recoveryKey: "ABCD-EFGH-IJKL-MNOP" } }),
      );

    await expect(revealRecoveryKey("U-1")).resolves.toBe("ABCD-EFGH-IJKL-MNOP");

    expect(authFetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/storage/drives/U-1/recovery-key/reveal");
    expect((init as RequestInit).method).toBe("POST");
    const [confirmUrl, confirmInit] = authFetchMock.mock.calls[1]!;
    expect(String(confirmUrl)).toContain("/api/storage/command/confirm");
    expect((confirmInit as RequestInit).method).toBe("POST");
    expect(JSON.parse((confirmInit as RequestInit).body as string)).toEqual({
      confirmationToken: "tok-key",
      service: "recovery_key_reveal",
      resourceId: "U-1",
    });
  });

  it("never lets a one-time secret into an HTTP cache, on either request", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "k" } }));
    await revealRecoveryKey("U-1");
    for (const call of authFetchMock.mock.calls) {
      expect((call[1] as RequestInit).cache).toBe("no-store");
    }
  });

  it("accepts a key on the first reply too (a server that skips the handshake)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "DIRECT-KEY" } }));
    await expect(revealRecoveryKey("U-1")).resolves.toBe("DIRECT-KEY");
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("URL-encodes the drive id", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "k" } }));
    await revealRecoveryKey("a b/c");
    expect(String(authFetchMock.mock.calls[0]![0])).toContain("/drives/a%20b%2Fc/recovery-key/reveal");
  });

  it.each([
    [410, "gone"],
    [404, "not_found"],
    [403, "forbidden"],
  ] as const)("maps a %d on the REQUEST to RecoveryKeyUnavailableError(%s)", async (status, reason) => {
    authFetchMock.mockResolvedValueOnce(res({ status, json: {} }));
    const err = await revealRecoveryKey("U-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe(reason);
  });

  it.each([
    [410, "gone"],
    [404, "not_found"],
    [403, "forbidden"],
  ] as const)("maps a %d on the CONFIRM to RecoveryKeyUnavailableError(%s)", async (status, reason) => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockResolvedValueOnce(res({ status, json: {} }));
    const err = await revealRecoveryKey("U-1").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe(reason);
  });

  it("a 5xx on either step is a plain failure carrying its status, NOT 'already shown'", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 502, json: { error: "bridge" } }));
    const first = await revealRecoveryKey("U-1").catch((e) => e);
    expect(first).not.toBeInstanceOf(RecoveryKeyUnavailableError);
    expect(first).toMatchObject({ status: 502 });

    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockResolvedValueOnce(res({ status: 503, json: { error: "x" } }));
    const second = await revealRecoveryKey("U-1").catch((e) => e);
    expect(second).not.toBeInstanceOf(RecoveryKeyUnavailableError);
    expect(second).toMatchObject({ status: 503 });
  });

  it("rejects a confirm that carries no key rather than showing a blank one", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockResolvedValueOnce(res({ status: 200, json: { ok: true } }));
    await expect(revealRecoveryKey("U-1")).rejects.toThrow(/empty/i);
    authFetchMock.mockResolvedValueOnce(res({ status: 200, json: { recoveryKey: "   " } }));
    await expect(revealRecoveryKey("U-1")).rejects.toThrow(/empty/i);
  });

  it("rejects a token that arrives without the service/resourceId the confirm must echo", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 202, json: { confirmationToken: "t" } }));
    await expect(revealRecoveryKey("U-1")).rejects.toThrow(/unexpected 202/i);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses an empty drive id without making a request", async () => {
    const err = await revealRecoveryKey("").catch((e) => e);
    expect(err).toBeInstanceOf(RecoveryKeyUnavailableError);
    expect((err as RecoveryKeyUnavailableError).reason).toBe("not_found");
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("never retries: a retry after a reveal that succeeded server-side would 410", async () => {
    authFetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(revealRecoveryKey("U-1")).rejects.toThrow(/failed to fetch/i);
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    authFetchMock.mockReset();
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REVEAL_TOKEN }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(revealRecoveryKey("U-1")).rejects.toThrow(/failed to fetch/i);
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("regenerateRecoveryKey — POST /api/storage/drives/:id/recovery-key/regenerate (tier 3)", () => {
  const REGEN_TOKEN = {
    status: "confirmation_required",
    confirmationToken: "tok-regen",
    service: "recovery_key_regenerate",
    resourceId: "U-1",
    tier: 3,
    expiresIn: 60,
  };

  it("POSTs, then echoes the 202 token through the storage confirm", async () => {
    authFetchMock
      .mockResolvedValueOnce(res({ status: 202, json: REGEN_TOKEN }))
      .mockResolvedValueOnce(res({ status: 200, json: { ok: true } }));

    await expect(regenerateRecoveryKey("U-1")).resolves.toBeUndefined();

    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/storage/drives/U-1/recovery-key/regenerate");
    expect((init as RequestInit).method).toBe("POST");
    const [confirmUrl, confirmInit] = authFetchMock.mock.calls[1]!;
    expect(String(confirmUrl)).toContain("/api/storage/command/confirm");
    expect(JSON.parse((confirmInit as RequestInit).body as string)).toEqual({
      confirmationToken: "tok-regen",
      service: "recovery_key_regenerate",
      resourceId: "U-1",
    });
  });

  it.each([403, 404, 409])("carries the HTTP status on a %d so the UI can pick its copy", async (status) => {
    authFetchMock.mockResolvedValueOnce(res({ status, json: { error: "no" } }));
    await expect(regenerateRecoveryKey("U-1")).rejects.toMatchObject({ status });
  });

  it("refuses an empty drive id without making a request", async () => {
    await expect(regenerateRecoveryKey("")).rejects.toThrow();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});

describe("prepare-type requests carry their HTTP status and code (so a TPM refusal can be recognised)", () => {
  it("requestAdoptDrive: a 409 tpm_required keeps status 409 and code tpm_required", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ status: 409, json: { error: "tpm_required", code: "tpm_required" } }),
    );
    const err = await requestAdoptDrive({
      device: "sdb",
      wipeMethod: "quick",
      confirmPhrase: "ERASE sdb",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ status: 409, code: "tpm_required" });
  });

  it("confirmPoolCommand: a 409 keeps its status and code too (the refusal can come on the confirm)", async () => {
    authFetchMock.mockResolvedValueOnce(
      res({ status: 409, json: { error: "tpm_required", code: "tpm_required" } }),
    );
    const err = await confirmPoolCommand({
      confirmationToken: "t",
      service: "drive_adopt",
      resourceId: "sdb",
    }).catch((e) => e);
    expect(err).toMatchObject({ status: 409, code: "tpm_required" });
  });

  it("the message is unchanged for existing callers (the server's own error text)", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 422, json: { error: "drive has data" } }));
    await expect(
      requestAdoptDrive({ device: "sdb", wipeMethod: "quick", confirmPhrase: "ERASE sdb" }),
    ).rejects.toThrow("drive has data");
  });

  it("falls back to the legacy wording when the server sent no error text", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 500, json: {} }));
    await expect(
      requestAdoptDrive({ device: "sdb", wipeMethod: "quick", confirmPhrase: "ERASE sdb" }),
    ).rejects.toThrow("Could not start drive adopt: 500");
  });

  it("requestFormatPool and reclaimDrive carry the status as well", async () => {
    authFetchMock.mockResolvedValueOnce(res({ status: 409, json: { code: "tpm_required" } }));
    await expect(
      requestFormatPool("md127", { confirmPhrase: "ERASE md127" }),
    ).rejects.toMatchObject({ status: 409, code: "tpm_required" });
    authFetchMock.mockResolvedValueOnce(res({ status: 409, json: { code: "tpm_required" } }));
    await expect(
      reclaimDrive({ device: "sda", md: "md127", confirmPhrase: "ERASE sda" }),
    ).rejects.toMatchObject({ status: 409, code: "tpm_required" });
  });
});
