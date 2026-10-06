import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchReviews } from "./frigate.client.js";

afterEach(() => vi.unstubAllGlobals());
describe("Frigate scalar review severity", () => {
  it("forwards a single severity as the Frigate enum", async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await fetchReviews({ severity: ["detection"], cameras: ["office"], limit: 7 });
    const params = new URL(String(fetch.mock.calls[0][0])).searchParams;
    expect(params.get("severity")).toBe("detection");
    expect(params.get("cameras")).toBe("office");
    expect(params.get("limit")).toBe("7");
  });
  it("never sends an invalid comma-separated severity to Frigate", async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await fetchReviews({ severity: ["alert", "detection"] });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.has("severity")).toBe(false);
  });
  it("requests all retained history when the caller selects Any time", async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await fetchReviews({});
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("after")).toBe("1");
  });
  it("preserves an explicit lower time bound", async () => {
    const fetch = vi.fn(async (_input: unknown, _init?: RequestInit) => Response.json([]));
    vi.stubGlobal("fetch", fetch);
    await fetchReviews({ after: 1791210000 });
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("after")).toBe("1791210000");
  });
});
