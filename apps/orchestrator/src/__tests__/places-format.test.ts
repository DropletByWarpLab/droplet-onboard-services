/**
 * WARP-1502 — structured place-suggestion formatting.
 *
 * The calendar location combobox used to render + store Nominatim's raw
 * `display_name` verbatim ("Newport Beach, Orange County, California, United
 * States"). We now request `addressdetails=1` and build a short primary
 * `name` + a concise "City, ST" `context`, keeping the full `displayName`,
 * `lat`, `lon` for compatibility. Provider (OSM Nominatim) is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  formatPlaceSuggestion,
  fetchNominatim,
  type NominatimRecord,
} from "../services/places.service.js";

const FETCH = global.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("formatPlaceSuggestion (WARP-1502)", () => {
  it("collapses a US city to `name` + abbreviated-state `context`", () => {
    const raw: NominatimRecord = {
      name: "Newport Beach",
      display_name:
        "Newport Beach, Orange County, California, United States",
      lat: "33.6189",
      lon: "-117.9298",
      type: "city",
      address: {
        city: "Newport Beach",
        county: "Orange County",
        state: "California",
        "ISO3166-2-lvl4": "US-CA",
        country: "United States",
        country_code: "us",
      },
    };
    const out = formatPlaceSuggestion(raw);
    expect(out).not.toBeNull();
    expect(out!.name).toBe("Newport Beach");
    // The place IS the city, so the locality is dropped to avoid
    // "Newport Beach, Newport Beach" — context is just the state.
    expect(out!.context).toBe("CA");
    // Full display_name retained for compatibility.
    expect(out!.displayName).toBe(raw.display_name);
    expect(out!.lat).toBe("33.6189");
    expect(out!.lon).toBe("-117.9298");
  });

  it("keeps the locality for a POI whose name differs from its city", () => {
    const raw: NominatimRecord = {
      name: "Disneyland Park",
      display_name:
        "Disneyland Park, 1313, Disneyland Drive, Anaheim, Orange County, California, 92802, United States",
      lat: "33.8121",
      lon: "-117.9190",
      type: "theme_park",
      address: {
        tourism: "Disneyland Park",
        city: "Anaheim",
        county: "Orange County",
        state: "California",
        country: "United States",
        country_code: "us",
      },
    };
    const out = formatPlaceSuggestion(raw);
    expect(out!.name).toBe("Disneyland Park");
    expect(out!.context).toBe("Anaheim, CA");
  });

  it("abbreviates a US state via the name map when no ISO code is present", () => {
    const raw: NominatimRecord = {
      name: "Paris",
      display_name: "Paris, Lamar County, Texas, United States",
      lat: "33.66",
      lon: "-95.55",
      type: "city",
      address: {
        city: "Paris",
        state: "Texas",
        country: "United States",
        country_code: "us",
      },
    };
    const out = formatPlaceSuggestion(raw);
    expect(out!.name).toBe("Paris");
    expect(out!.context).toBe("TX");
  });

  it("uses locality + full region for non-US results (no country chain)", () => {
    const raw: NominatimRecord = {
      name: "Eiffel Tower",
      display_name:
        "Eiffel Tower, Avenue Gustave Eiffel, Paris, Île-de-France, 75007, France",
      lat: "48.8583",
      lon: "2.2944",
      type: "attraction",
      address: {
        tourism: "Eiffel Tower",
        city: "Paris",
        state: "Île-de-France",
        country: "France",
        country_code: "fr",
      },
    };
    const out = formatPlaceSuggestion(raw);
    expect(out!.name).toBe("Eiffel Tower");
    expect(out!.context).toBe("Paris, Île-de-France");
    // Never the full country chain — the country ("France") is not appended
    // as its own trailing segment.
    expect(out!.context.split(", ")).not.toContain("France");
  });

  it("falls back to display_name segments when no address details are present", () => {
    const raw: NominatimRecord = {
      display_name: "Somewhere, Middle District, Nowhere County, Testland",
      lat: "1.0",
      lon: "2.0",
      type: null,
    };
    const out = formatPlaceSuggestion(raw);
    // First segment becomes the primary name.
    expect(out!.name).toBe("Somewhere");
    // Next segments become the context, capped to two for brevity.
    expect(out!.context).toBe("Middle District, Nowhere County");
  });

  it("returns null for a record missing coordinates", () => {
    const raw: NominatimRecord = {
      name: "No Coords",
      display_name: "No Coords, Somewhere",
      // lat/lon missing
      type: "city",
    };
    expect(formatPlaceSuggestion(raw)).toBeNull();
  });
});

describe("fetchNominatim (WARP-1502)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    global.fetch = FETCH;
  });

  it("requests addressdetails=1 & dedupe=1 and maps to structured suggestions", async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: unknown) =>
      jsonResponse([
        {
          name: "Newport Beach",
          display_name:
            "Newport Beach, Orange County, California, United States",
          lat: "33.6189",
          lon: "-117.9298",
          type: "city",
          address: {
            city: "Newport Beach",
            state: "California",
            "ISO3166-2-lvl4": "US-CA",
            country: "United States",
            country_code: "us",
          },
        },
      ]),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchNominatim("newport beach", 5);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("addressdetails=1");
    expect(url).toContain("dedupe=1");
    expect(url).toContain("format=jsonv2");
    expect(url).toContain("limit=5");
    expect(url).toContain("q=newport+beach");

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("Newport Beach");
    expect(out[0].context).toBe("CA");
    expect(out[0].displayName).toContain("Newport Beach");
  });

  it("returns [] on a non-2xx Nominatim response", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await fetchNominatim("paris", 5)).toEqual([]);
  });
});
