/**
 * WARP-1827 — useModelPull: the NDJSON download-progress reader.
 *
 * Pins the streaming contract: progress % derives from completed/total when
 * both are present (indeterminate otherwise), the live status text follows
 * the stream, a terminal success refreshes via onSuccess, an error line (or
 * a non-2xx — notably the 409 disk preflight, whose `detail` must surface
 * VERBATIM) becomes an honest inline error, and only ONE pull runs at a time.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

const startModelPullMock = vi.fn();
vi.mock("@/lib/api", () => ({
  startModelPull: (name: string) => startModelPullMock(name),
}));

import { useModelPull } from "./useModelPull";

/** A Response-like whose NDJSON body the TEST feeds line by line, so the
 *  hook's intermediate states are observable deterministically. */
function controlledStream(status = 200) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });
  const encoder = new TextEncoder();
  return {
    response: {
      ok: status >= 200 && status < 300,
      status,
      body,
    } as unknown as Response,
    push: (line: string) => controller.enqueue(encoder.encode(`${line}\n`)),
    close: () => controller.close(),
  };
}

function errorResponse(status: number, body: unknown): Response {
  return {
    ok: false,
    status,
    body: null,
    json: async () => body,
  } as unknown as Response;
}

beforeEach(() => {
  startModelPullMock.mockReset();
});

describe("useModelPull (WARP-1827)", () => {
  it("streams progress (completed/total → %), then success refreshes", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useModelPull(onSuccess));

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() => expect(result.current.pulling).toBe("qwen3:14b"));

    stream.push('{"status":"pulling 9f13bb","completed":4500000000,"total":9000000000}');
    await waitFor(() => {
      expect(result.current.progressPct).toBe(50);
      expect(result.current.progressStatus).toBe("pulling 9f13bb");
    });

    stream.push('{"status":"success"}');
    stream.close();
    await waitFor(() => expect(result.current.pulling).toBeNull());
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });

  it("goes indeterminate (null %) on a status line without totals", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useModelPull());

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    stream.push('{"status":"pulling 9f13bb","completed":50,"total":100}');
    await waitFor(() => expect(result.current.progressPct).toBe(50));
    stream.push('{"status":"verifying sha256 digest"}');
    await waitFor(() => {
      expect(result.current.progressStatus).toBe("verifying sha256 digest");
      expect(result.current.progressPct).toBeNull();
    });
    stream.close();
    await waitFor(() => expect(result.current.pulling).toBeNull());
  });

  it("surfaces the 409 disk-preflight detail VERBATIM", async () => {
    const detail = "Needs 9.0 GB free; 2.1 GB available.";
    startModelPullMock.mockResolvedValue(
      errorResponse(409, { error: "insufficient_disk", detail }),
    );
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useModelPull(onSuccess));

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() =>
      expect(result.current.error).toEqual({
        model: "qwen3:14b",
        message: detail,
      }),
    );
    expect(result.current.pulling).toBeNull();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("turns a terminal error line into an honest inline error", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useModelPull(onSuccess));

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() => expect(result.current.pulling).toBe("qwen3:14b"));
    stream.push('{"error":"pull model manifest: file does not exist"}');
    stream.close();
    await waitFor(() =>
      expect(result.current.error?.message).toBe(
        "pull model manifest: file does not exist",
      ),
    );
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it("reports honestly when the stream ends without a terminal line", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useModelPull());

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() => expect(result.current.pulling).toBe("qwen3:14b"));
    stream.push('{"status":"pulling 9f13bb","completed":1,"total":2}');
    stream.close(); // connection dropped mid-download
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.error?.message).toMatch(/ended before/i);
  });

  it("runs ONE pull at a time — a second start is ignored while busy", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const { result } = renderHook(() => useModelPull());

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() => expect(result.current.pulling).toBe("qwen3:14b"));
    act(() => {
      void result.current.startPull("gemma3:12b");
    });
    expect(startModelPullMock).toHaveBeenCalledTimes(1);
    expect(startModelPullMock).toHaveBeenCalledWith("qwen3:14b");
    stream.push('{"status":"success"}');
    stream.close();
    await waitFor(() => expect(result.current.pulling).toBeNull());
  });

  it("ignores unparseable NDJSON lines instead of failing the download", async () => {
    const stream = controlledStream();
    startModelPullMock.mockResolvedValue(stream.response);
    const onSuccess = vi.fn();
    const { result } = renderHook(() => useModelPull(onSuccess));

    act(() => {
      void result.current.startPull("qwen3:14b");
    });
    await waitFor(() => expect(result.current.pulling).toBe("qwen3:14b"));
    stream.push("not-json-at-all");
    stream.push('{"status":"success"}');
    stream.close();
    await waitFor(() => expect(result.current.pulling).toBeNull());
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBeNull();
  });
});
