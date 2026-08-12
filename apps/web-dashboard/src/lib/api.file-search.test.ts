/**
 * WARP-1914 — Files-page search helpers must throw STRUCTURED errors.
 *
 * `searchFileContent` / `searchFiles` used to throw a plain `Error` whose
 * message carried the orchestrator's reason — but `translateError` never
 * surfaces `err.message`, so every search failure flattened into the generic
 * files-domain fallback ("We couldn't load those files right now…"), the
 * QA-reported banner. These specs pin the `FileSearchError` shape: the HTTP
 * status plus the orchestrator's stable wire `code` (e.g.
 * `semantic_unavailable`) ride on the error so the translator can dispatch.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { searchFileContent, searchFiles, FileSearchError } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("WARP-1914 — searchFileContent error shape", () => {
  it("throws FileSearchError carrying status + the semantic_unavailable wire code on a 503", async () => {
    authFetchMock.mockResolvedValue(
      res(
        {
          error: "AI gateway not available for semantic search",
          code: "semantic_unavailable",
        },
        false,
        503,
      ),
    );

    const err = await searchFileContent("dental", 20, "semantic").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FileSearchError);
    expect((err as FileSearchError).status).toBe(503);
    expect((err as FileSearchError).code).toBe("semantic_unavailable");
  });

  it("throws FileSearchError with the status and no code when the body carries none", async () => {
    authFetchMock.mockResolvedValue(res({ error: "boom" }, false, 500));

    const err = await searchFileContent("dental", 20, "keyword").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FileSearchError);
    expect((err as FileSearchError).status).toBe(500);
    expect((err as FileSearchError).code).toBeUndefined();
  });

  it("still throws a structured error when the error body is not JSON", async () => {
    authFetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      json: vi.fn().mockRejectedValue(new Error("not json")),
    } as unknown as Response);

    const err = await searchFileContent("dental", 20, "semantic").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(FileSearchError);
    expect((err as FileSearchError).status).toBe(502);
  });

  it("returns the results array and forwards the mode as a query param on success", async () => {
    authFetchMock.mockResolvedValue(
      res({ results: [{ path: "/Docs/a.txt", score: 0.9, text: "snippet" }] }),
    );

    const out = await searchFileContent("dental", 20, "semantic");

    expect(out).toEqual([{ path: "/Docs/a.txt", score: 0.9, text: "snippet" }]);
    const url = authFetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/files/search/content?");
    expect(url).toContain("mode=semantic");
  });
});

describe("WARP-1914 — searchFiles (Name mode) error shape", () => {
  it("throws FileSearchError carrying the status on a non-2xx", async () => {
    authFetchMock.mockResolvedValue(res({ error: "nope" }, false, 500));

    const err = await searchFiles("dental").catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FileSearchError);
    expect((err as FileSearchError).status).toBe(500);
  });

  it("returns items on success", async () => {
    authFetchMock.mockResolvedValue(
      res({
        items: [
          {
            name: "Dental Hygenists",
            path: "/Dental Hygenists",
            isDirectory: true,
            size: 0,
            mimeType: null,
            modifiedAt: "2026-08-01T00:00:00.000Z",
          },
        ],
      }),
    );

    const out = await searchFiles("dental");

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Dental Hygenists");
  });
});
