/**
 * WARP-1119 — the persona API client (Settings → AI personality card).
 *
 * Contract (backend: apps/orchestrator/src/routes/persona.ts, WARP-1118):
 *   - `fetchPersona()` GETs /api/persona. owner/admin get all fields;
 *     lesser roles get `preset` + `verbosity` only — the client passes the
 *     body through untouched (the CARD decides what to render).
 *   - `patchPersona(update)` PATCHes /api/persona with ONLY the fields the
 *     caller provides (the route zod-requires at least one). A 400 (e.g.
 *     over-length customInstructions) throws with the server detail so the
 *     card can keep edits and show the failed state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchPersona, patchPersona } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({
  authFetch: vi.fn(),
}));

const authFetchMock = vi.mocked(authFetch);

function res(init: { status: number; json?: unknown; text?: string }): Response {
  return {
    ok: init.status >= 200 && init.status < 300,
    status: init.status,
    json: vi.fn().mockResolvedValue(init.json ?? {}),
    text: vi.fn().mockResolvedValue(init.text ?? JSON.stringify(init.json ?? {})),
  } as unknown as Response;
}

const FULL = {
  preset: "warm_friendly",
  verbosity: "balanced",
  useFirstNames: true,
  customInstructions: "",
  updatedBy: null,
  updatedAt: "2026-07-09T00:00:00.000Z",
};

beforeEach(() => {
  authFetchMock.mockReset();
});

describe("fetchPersona", () => {
  it("returns the full persona for an admin reader", async () => {
    authFetchMock.mockResolvedValue(res({ status: 200, json: FULL }));
    await expect(fetchPersona()).resolves.toEqual(FULL);
    expect(authFetchMock).toHaveBeenCalledWith("/api/persona");
  });

  it("passes a role-limited body through untouched (preset + verbosity only)", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 200, json: { preset: "founder", verbosity: "concise" } }),
    );
    await expect(fetchPersona()).resolves.toEqual({
      preset: "founder",
      verbosity: "concise",
    });
  });

  it("throws on a non-2xx", async () => {
    authFetchMock.mockResolvedValue(res({ status: 500 }));
    await expect(fetchPersona()).rejects.toThrow();
  });
});

describe("patchPersona", () => {
  it("PATCHes only the provided fields and returns the updated persona", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 200, json: { ...FULL, preset: "direct_technical" } }),
    );
    await expect(
      patchPersona({ preset: "direct_technical" }),
    ).resolves.toMatchObject({ preset: "direct_technical" });

    expect(authFetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(url).toBe("/api/persona");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ preset: "direct_technical" });
  });

  it("throws with the server detail on a 400 (reject, never silently truncate)", async () => {
    authFetchMock.mockResolvedValue(
      res({ status: 400, json: { error: "Invalid persona patch" } }),
    );
    await expect(
      patchPersona({ customInstructions: "x".repeat(1201) }),
    ).rejects.toThrow(/persona/i);
  });
});
