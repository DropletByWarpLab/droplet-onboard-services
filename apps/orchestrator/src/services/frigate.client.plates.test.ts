import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FrigatePlatesUnsupportedError,
  deleteKnownPlate,
  fetchKnownPlates,
  nameKnownPlate,
} from "./frigate.client.js";

afterEach(() => vi.unstubAllGlobals());

function route(handlers: Record<string, () => Response>) {
  return vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = new URL(String(input));
    const h = handlers[url.pathname];
    return h ? h() : new Response("nope", { status: 404 });
  });
}

describe("license plates on Frigate 0.17", () => {
  it("reads /api/recognized_license_plates (a list of strings), not the removed /api/license_plates", async () => {
    const fetchMock = route({
      "/api/recognized_license_plates": () => Response.json(["ABC1234", "XYZ987"]),
      "/api/events": () =>
        Response.json([
          { data: { recognized_license_plate: "ABC1234" } },
          { data: { recognized_license_plate: "ABC1234" } },
          { data: { recognized_license_plate: "XYZ987" } },
        ]),
    });
    vi.stubGlobal("fetch", fetchMock);
    const plates = await fetchKnownPlates();
    expect(plates).toEqual([
      { plate: "ABC1234", name: null, eventCount: 2 },
      { plate: "XYZ987", name: null, eventCount: 1 },
    ]);
    const paths = fetchMock.mock.calls.map((c) => new URL(String(c[0])).pathname);
    expect(paths).not.toContain("/api/license_plates");
  });

  it("answers an empty roster as [] without querying events", async () => {
    const fetchMock = route({ "/api/recognized_license_plates": () => Response.json([]) });
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchKnownPlates()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the roster when the event tally fails", async () => {
    vi.stubGlobal(
      "fetch",
      route({
        "/api/recognized_license_plates": () => Response.json(["ABC1234"]),
        "/api/events": () => new Response("boom", { status: 500 }),
      }),
    );
    expect(await fetchKnownPlates()).toEqual([{ plate: "ABC1234", name: null, eventCount: 0 }]);
  });

  it("splits comma-joined plates in event data and de-duplicates the roster", async () => {
    vi.stubGlobal(
      "fetch",
      route({
        "/api/recognized_license_plates": () => Response.json(["A1", "A1", "B2", ""]),
        "/api/events": () => Response.json([{ data: { recognized_license_plate: "A1, B2" } }]),
      }),
    );
    expect(await fetchKnownPlates()).toEqual([
      { plate: "A1", name: null, eventCount: 1 },
      { plate: "B2", name: null, eventCount: 1 },
    ]);
  });

  it("surfaces a real Frigate failure but treats 404 as no plates", async () => {
    vi.stubGlobal(
      "fetch",
      route({ "/api/recognized_license_plates": () => new Response("x", { status: 500 }) }),
    );
    await expect(fetchKnownPlates()).rejects.toThrow(/500/);
    vi.stubGlobal("fetch", route({}));
    expect(await fetchKnownPlates()).toEqual([]);
  });

  it("naming and deleting a plate answer 501 without calling Frigate", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const named = await nameKnownPlate("ABC1234", "Alice").catch((e) => e);
    const deleted = await deleteKnownPlate("ABC1234").catch((e) => e);
    for (const err of [named, deleted]) {
      expect(err).toBeInstanceOf(FrigatePlatesUnsupportedError);
      expect((err as FrigatePlatesUnsupportedError).statusCode).toBe(501);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
