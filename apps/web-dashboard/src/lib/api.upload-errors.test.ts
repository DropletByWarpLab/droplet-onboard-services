/**
 * WARP-1912 — upload rejections must throw STRUCTURED errors.
 *
 * `uploadBatch` used to throw a plain `Error("Upload failed: <body>")` — but
 * `translateError` never surfaces `err.message`, so every upload rejection
 * flattened into the generic files-domain fallback ("We couldn't load those
 * files right now…"). That is exactly how a too-large .dmg (nginx's 100M
 * `client_max_body_size`, or the orchestrator's per-user multer cap — both
 * answer 413) rendered as a retry error for a file that can never fit.
 *
 * Same defect class and same fix as WARP-1914's `FileSearchError`: the HTTP
 * status plus the orchestrator's stable wire `code` / `limitMb` ride on the
 * error so `uploadOutcomeMessage` can say "too large (max X MB)" instead.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { uploadFiles, UploadBatchError } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(body: string, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("WARP-1912 — upload rejection error shape", () => {
  it("carries status + wire code + limitMb from the orchestrator's 413", async () => {
    authFetchMock.mockResolvedValue(
      res(
        JSON.stringify({
          error: "File too large (max 10MB for your account)",
          code: "UPLOAD_TOO_LARGE",
          limitMb: 10,
        }),
        false,
        413,
      ),
    );

    const err = await uploadFiles("/", [new File(["x"], "big.dmg")]).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UploadBatchError);
    const cause = (err as UploadBatchError).cause as {
      status?: number;
      code?: string;
      limitMb?: number;
    };
    expect(cause.status).toBe(413);
    expect(cause.code).toBe("UPLOAD_TOO_LARGE");
    expect(cause.limitMb).toBe(10);
  });

  it("carries the bare status from an nginx-style HTML 413 (no code, no limit)", async () => {
    authFetchMock.mockResolvedValue(
      res(
        "<html><head><title>413 Request Entity Too Large</title></head></html>",
        false,
        413,
      ),
    );

    const err = await uploadFiles("/", [new File(["x"], "huge.dmg")]).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UploadBatchError);
    const cause = (err as UploadBatchError).cause as {
      status?: number;
      code?: string;
      limitMb?: number;
    };
    expect(cause.status).toBe(413);
    expect(cause.code).toBeUndefined();
    expect(cause.limitMb).toBeUndefined();
  });

  it("keeps the NETWORK-inferable message when the fetch itself dies", async () => {
    authFetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const err = await uploadFiles("/", [new File(["x"], "a.txt")]).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(UploadBatchError);
    const cause = (err as UploadBatchError).cause as Error;
    expect(String(cause.message)).toMatch(/fetch/i);
  });
});
