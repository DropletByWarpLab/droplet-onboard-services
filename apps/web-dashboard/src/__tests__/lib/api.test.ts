import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocking
import {
  fetchHealth,
  fetchDevices,
  fetchModels,
  saveProviderKey,
  listProviderKeys,
  deleteProviderKey,
  fetchNetworkOperation,
  uploadFiles,
  UploadBatchError,
} from "@/lib/api";
import {
  MAX_FILES_PER_UPLOAD,
  MAX_UPLOAD_BATCH_BYTES,
} from "@droplet/shared-types";

describe("API client", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  describe("fetchHealth", () => {
    it("calls /api/health and returns data", async () => {
      const mockData = { status: "ok", uptime: 100, version: "0.1.0", services: {} };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockData),
      });

      const result = await fetchHealth();
      // fetchHealth goes through authFetch, which always attaches
      // `credentials: "same-origin"` so the droplet_session cookie rides along.
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/health",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result.status).toBe("ok");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(fetchHealth()).rejects.toThrow("Health check failed: 500");
    });
  });

  describe("fetchDevices", () => {
    it("calls /api/devices", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([{ deviceId: "dev-001" }]),
      });

      const result = await fetchDevices();
      expect(result).toHaveLength(1);
      expect(result[0].deviceId).toBe("dev-001");
    });
  });

  describe("fetchModels", () => {
    it("calls /api/llm/models", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ models: [{ id: "llama3:8b" }] }),
      });

      const result = await fetchModels();
      expect(result.models).toHaveLength(1);
    });
  });

  describe("saveProviderKey", () => {
    it("posts key to correct endpoint", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      await saveProviderKey("anthropic", "sk-test");

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/llm/keys/anthropic",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ api_key: "sk-test" }),
        })
      );
    });

    it("throws on failure", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        text: () => Promise.resolve("Bad key"),
      });
      await expect(saveProviderKey("anthropic", "bad")).rejects.toThrow("Failed to save key");
    });
  });

  describe("listProviderKeys", () => {
    it("returns provider list", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ providers: ["anthropic"] }),
      });

      const result = await listProviderKeys();
      expect(result).toEqual(["anthropic"]);
    });
  });

  describe("deleteProviderKey", () => {
    it("sends DELETE request", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });
      await deleteProviderKey("openai");

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/llm/keys/openai",
        expect.objectContaining({ method: "DELETE" })
      );
    });
  });

  describe("fetchNetworkOperation", () => {
    it("passes a 200 operation record through unchanged", async () => {
      const op = {
        id: "op-1",
        state: "applied",
        startedAt: 1,
        finishedAt: 2,
        reason: null,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(op),
      });

      const result = await fetchNetworkOperation("op-1");
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/network/operations/op-1",
        expect.objectContaining({ credentials: "same-origin" }),
      );
      expect(result).toEqual(op);
    });

    it("DASH-07: maps a 404 to a distinct 'unknown' state, never 'applied'", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

      const result = await fetchNetworkOperation("op-gone");
      // The bug was reporting a 404 as success ("applied"). A 404 is
      // indeterminate — assert we never claim the change applied.
      expect(result.state).toBe("unknown");
      expect(result.state).not.toBe("applied");
      // Reason is a re-check prompt, not a success message.
      expect(result.reason).toMatch(/couldn't confirm/i);
    });

    it("throws on a non-404 error response", async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });
      await expect(fetchNetworkOperation("op-err")).rejects.toThrow(
        "Failed to fetch operation: 500",
      );
    });
  });

  // WARP-1666 — a 36-file selection used to go out as ONE request at a server
  // that accepts MAX_FILES_PER_UPLOAD, which rejected the whole thing (and
  // blamed the field name). Batching is what makes a folder-sized selection
  // work at all, so these tests pin the batch boundary and the partial-failure
  // contract the Files page relies on.
  //
  // WARP-1843 — count alone was not enough: nginx also caps every `/api/`
  // request at `client_max_body_size 100M`, so a batch of individually-fine
  // files whose bytes SUMMED past the cap was 413-rejected wholesale, and the
  // first failed batch aborted the whole run, stranding every batch behind it.
  // Packing is now size-aware (≤ MAX_FILES_PER_UPLOAD files AND
  // ≤ MAX_UPLOAD_BATCH_BYTES per batch, selection order preserved) and a
  // failed batch no longer stops the batches after it.
  describe("uploadFiles", () => {
    const makeFiles = (n: number) =>
      Array.from({ length: n }, (_, i) => new File([`x${i}`], `f${i}.txt`));

    /**
     * A File that REPORTS `bytes` without allocating them — batching reads
     * `file.size` and never the payload, so tests can talk in real upload
     * magnitudes (tens of MB) without tens-of-MB buffers.
     */
    const makeSizedFile = (name: string, bytes: number) => {
      const f = new File(["x"], name);
      Object.defineProperty(f, "size", { value: bytes });
      return f;
    };

    const okResponse = () => ({ ok: true, text: () => Promise.resolve("") });

    const failResponse = (status: number, body: string) => ({
      ok: false,
      status,
      text: () => Promise.resolve(body),
    });

    /** File names of every request actually sent, in send order. */
    const sentBatches = (): string[][] =>
      mockFetch.mock.calls.map(([, init]) =>
        (init.body as FormData).getAll("files").map((f) => (f as File).name),
      );

    it("splits a selection larger than the server cap into sequential batches", async () => {
      mockFetch.mockResolvedValue(okResponse());

      await uploadFiles("/Personal", makeFiles(36));

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const perRequest = mockFetch.mock.calls.map(
        ([, init]) => (init.body as FormData).getAll("files").length,
      );
      expect(perRequest).toEqual([
        MAX_FILES_PER_UPLOAD,
        36 - MAX_FILES_PER_UPLOAD,
      ]);
    });

    it("sends exactly one request when the selection fits in a single batch", async () => {
      mockFetch.mockResolvedValue(okResponse());

      await uploadFiles("/Personal", makeFiles(MAX_FILES_PER_UPLOAD));

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("WARP-1843: splits by bytes before the count limit, preserving order", async () => {
      mockFetch.mockResolvedValue(okResponse());

      // Three files of ~40% of the ceiling each: two fit together, the third
      // would push the request past what nginx accepts, so it must start a
      // new batch — long before the 20-file count limit is anywhere in sight.
      const big = Math.ceil(MAX_UPLOAD_BATCH_BYTES * 0.4);
      const files = [
        makeSizedFile("a.bin", big),
        makeSizedFile("b.bin", big),
        makeSizedFile("c.bin", big),
      ];

      await uploadFiles("/Personal", files);

      expect(sentBatches()).toEqual([["a.bin", "b.bin"], ["c.bin"]]);

      // Every request stays at or under the ceiling the nginx cap protects.
      const sizeByName = new Map(files.map((f) => [f.name, f.size]));
      for (const batch of sentBatches()) {
        const bytes = batch.reduce((sum, n) => sum + sizeByName.get(n)!, 0);
        expect(bytes).toBeLessThanOrEqual(MAX_UPLOAD_BATCH_BYTES);
      }
    });

    it("WARP-1843: still enforces the file-count cap when everything is tiny", async () => {
      mockFetch.mockResolvedValue(okResponse());

      await uploadFiles("/Personal", makeFiles(MAX_FILES_PER_UPLOAD + 1));

      expect(sentBatches().map((b) => b.length)).toEqual([
        MAX_FILES_PER_UPLOAD,
        1,
      ]);
    });

    it("WARP-1843: a file larger than the ceiling goes alone in its own batch and is still attempted", async () => {
      mockFetch.mockResolvedValue(okResponse());

      // The client never pre-rejects: the server stays the authority on
      // per-file/per-user caps, so the oversize file is still sent (alone)
      // and the server answers with its honest 413 / policy error.
      const files = [
        makeSizedFile("small-1.txt", 1024),
        makeSizedFile("huge.iso", MAX_UPLOAD_BATCH_BYTES * 2),
        makeSizedFile("small-2.txt", 1024),
      ];

      await uploadFiles("/Personal", files);

      expect(sentBatches()).toEqual([
        ["small-1.txt"],
        ["huge.iso"],
        ["small-2.txt"],
      ]);
    });

    it("reports how many files landed when a later batch fails", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(failResponse(500, "boom"));

      // The first batch is NOT rolled back — it stays on the box, and the
      // caller is told exactly how much made it so it can say so.
      const err = await uploadFiles("/Personal", makeFiles(36)).catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(UploadBatchError);
      expect(err).toMatchObject({
        name: "UploadBatchError",
        uploaded: MAX_FILES_PER_UPLOAD,
        total: 36,
      });
      // WARP-1843: the error also says WHICH files did not land.
      expect(err.failedFiles).toEqual(
        Array.from({ length: 16 }, (_, i) => `f${MAX_FILES_PER_UPLOAD + i}.txt`),
      );
    });

    it("WARP-1843: a failed batch no longer aborts the run — later batches still go out", async () => {
      mockFetch
        .mockResolvedValueOnce(okResponse())
        .mockResolvedValueOnce(failResponse(413, "too large"))
        .mockResolvedValueOnce(okResponse());

      // 41 tiny files → 3 batches of [20, 20, 1]. Batch 2 fails; batch 3 must
      // still be attempted instead of being silently abandoned.
      const files = makeFiles(MAX_FILES_PER_UPLOAD * 2 + 1);
      const err = await uploadFiles("/Personal", files).catch((e) => e);

      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(err).toBeInstanceOf(UploadBatchError);
      expect(err).toMatchObject({
        uploaded: MAX_FILES_PER_UPLOAD + 1, // batches 1 and 3 landed
        total: MAX_FILES_PER_UPLOAD * 2 + 1,
      });
      // The failed files are exactly batch 2, in selection order…
      expect(err.failedFiles).toEqual(
        Array.from(
          { length: MAX_FILES_PER_UPLOAD },
          (_, i) => `f${MAX_FILES_PER_UPLOAD + i}.txt`,
        ),
      );
      // …and the representative cause is the FIRST failure.
      expect(String(err.cause)).toContain("too large");
    });

    it("WARP-1843: reports zero uploaded when every batch fails — after attempting them all", async () => {
      mockFetch.mockResolvedValue(failResponse(500, "boom"));

      const err = await uploadFiles("/Personal", makeFiles(36)).catch(
        (e) => e,
      );

      // Both batches were tried; none landed.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(err).toMatchObject({ uploaded: 0, total: 36 });
      expect(err.failedFiles).toHaveLength(36);
    });

    it("WARP-1843: progress is monotonic to 100 across variable-size batches", async () => {
      // The XHR path is the one that reports progress. Drive a fake XHR so
      // the test controls per-batch progress fractions deterministically.
      class FakeXHR {
        static instances: FakeXHR[] = [];
        upload: {
          onprogress: ((e: ProgressEvent) => void) | null;
        } = { onprogress: null };
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;
        status = 0;
        responseText = "";
        withCredentials = false;
        open() {}
        send() {
          FakeXHR.instances.push(this);
        }
      }
      vi.stubGlobal("XMLHttpRequest", FakeXHR);

      /** Wait (in microtasks) until the n-th sequential XHR exists. */
      const nthXhr = async (n: number) => {
        for (let i = 0; i < 200 && FakeXHR.instances.length < n; i++) {
          await Promise.resolve();
        }
        expect(FakeXHR.instances.length).toBeGreaterThanOrEqual(n);
        return FakeXHR.instances[n - 1];
      };

      try {
        // Sizes chosen to force UNEQUAL batches: [a] alone (60% of the
        // ceiling; b would overflow), then [b, c] (70%).
        const files = [
          makeSizedFile("a.bin", Math.floor(MAX_UPLOAD_BATCH_BYTES * 0.6)),
          makeSizedFile("b.bin", Math.floor(MAX_UPLOAD_BATCH_BYTES * 0.6)),
          makeSizedFile("c.bin", Math.floor(MAX_UPLOAD_BATCH_BYTES * 0.1)),
        ];

        const percents: number[] = [];
        const run = uploadFiles("/Personal", files, (p) => percents.push(p));

        for (let batch = 1; batch <= 2; batch++) {
          const xhr = await nthXhr(batch);
          for (const fraction of [0.5, 1]) {
            xhr.upload.onprogress?.({
              lengthComputable: true,
              loaded: fraction * 1000,
              total: 1000,
            } as ProgressEvent);
          }
          xhr.status = 200;
          xhr.onload?.();
        }

        await run;

        expect(percents.length).toBeGreaterThan(0);
        for (let i = 1; i < percents.length; i++) {
          expect(percents[i]).toBeGreaterThanOrEqual(percents[i - 1]);
        }
        expect(percents.at(-1)).toBe(100);
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});
