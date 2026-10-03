/**
 * ADR-055 P4b — the doors API helpers' wire contract (P4a routes 1–5).
 *
 * The page and hook tests replace these helpers or the hooks over them, so
 * nothing else can see what goes on the wire: the method, the path, the query
 * string, the body field names. The orchestrator's schemas are `.strict()`, so
 * a renamed body field is a 400 and a wrong path a 404 on every save, while the
 * rest of the suite stays green. Pinned here at the transport, `authFetch`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { createDoor, doorEventsPath, getDoorEvents, getDoors, patchDoor, retireDoor } from "./api";
import { authFetch } from "./auth";

vi.mock("./auth", () => ({ authFetch: vi.fn() }));

const authFetchMock = vi.mocked(authFetch);

function res(json: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: vi.fn().mockResolvedValue(json),
  } as unknown as Response;
}

beforeEach(() => {
  authFetchMock.mockReset();
  authFetchMock.mockResolvedValue(res({ ok: true }));
});

/** The one request the helper made: [url, method, parsed body]. */
function sent(): [string, string, unknown] {
  expect(authFetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = authFetchMock.mock.calls[0]!;
  const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
  return [url as string, (init?.method ?? "GET") as string, body];
}

const ID = "3f6c2a4e-8b1d-4c5e-9a7f-1b2c3d4e5f60";

describe("routes 1–5 — method, path, query and body, exactly", () => {
  it.each([
    ["1 GET doors", () => getDoors(), "/api/doors", "GET", undefined],
    ["1 GET doors with retired ones", () => getDoors({ includeRetired: true }), "/api/doors?include=retired", "GET", undefined],
    ["2 GET events", () => getDoorEvents(), "/api/doors/events", "GET", undefined],
    ["2 GET events, a page", () => getDoorEvents({ cursor: "1790000000000_42", limit: 25 }), "/api/doors/events?limit=25&cursor=1790000000000_42", "GET", undefined],
    ["3 POST door", () => createDoor({ name: "Front door", doorPositionSource: "lock" }), "/api/doors", "POST", { name: "Front door", doorPositionSource: "lock" }],
    ["4 PATCH door", () => patchDoor(ID, { doorPositionSource: "none" }), `/api/doors/${ID}`, "PATCH", { doorPositionSource: "none" }],
    ["4 PATCH door, a name", () => patchDoor(ID, { name: "Back door" }), `/api/doors/${ID}`, "PATCH", { name: "Back door" }],
    ["5 POST retire", () => retireDoor(ID), `/api/doors/${ID}/retire`, "POST", {}],
  ])("%s", async (_name, call, url, method, body) => {
    await call();
    expect(sent()).toEqual([url, method, body]);
  });

  it("never sends heldOpenSeconds: the form has no such field (nothing reads it yet)", async () => {
    await createDoor({ name: "Front door", doorPositionSource: "dp1" });
    const [, , body] = sent();
    expect(Object.keys(body as object).sort()).toEqual(["doorPositionSource", "name"]);
  });

  it("encodes an id it puts in the path", async () => {
    await retireDoor("a/b c");
    expect(sent()[0]).toBe("/api/doors/a%2Fb%20c/retire");
  });

  it("the events query string omits what is not asked for", () => {
    expect(doorEventsPath()).toBe("/api/doors/events");
    expect(doorEventsPath({ cursor: null })).toBe("/api/doors/events");
    expect(doorEventsPath({ limit: 10 })).toBe("/api/doors/events?limit=10");
  });

  it("the writes carry a JSON content type", async () => {
    await createDoor({ name: "Front door", doorPositionSource: "lock" });
    const init = authFetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
  });
});

describe("a failure is typed, so the page can tell a refusal from an outage", () => {
  it("carries the server's error.code and the status (a typed body)", async () => {
    authFetchMock.mockResolvedValue(res({ error: { code: "DOOR_RETIRED", message: "raw" } }, 409));
    await expect(patchDoor(ID, { name: "x" })).rejects.toMatchObject({ code: "DOOR_RETIRED", status: 409 });
  });

  it("a role refusal (a flat 403 body) has the status and no code", async () => {
    authFetchMock.mockResolvedValue(res({ error: "Forbidden: role not permitted" }, 403));
    const err = await createDoor({ name: "x", doorPositionSource: "none" }).catch((e) => e);
    expect(err.status).toBe(403);
    expect(err.code).toBeUndefined();
  });

  it("a module refusal (404 module_disabled, flat) has the status and no code", async () => {
    authFetchMock.mockResolvedValue(res({ error: "module_disabled", module: "doors" }, 404));
    const err = await getDoors().catch((e) => e);
    expect(err.status).toBe(404);
    expect(err.code).toBeUndefined();
  });

  it("a request that never answered is NETWORK_ERROR with status 0", async () => {
    authFetchMock.mockRejectedValue(new Error("Failed to fetch"));
    await expect(getDoors()).rejects.toMatchObject({ code: "NETWORK_ERROR", status: 0 });
  });
});
