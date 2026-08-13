/**
 * WARP-1502 — structured place suggestions for the calendar location combobox.
 *
 * Nominatim's raw `display_name` is a long comma-separated chain
 * ("Newport Beach, Orange County, California, United States"). Rendering /
 * storing that verbatim is the bug Samantha filed. We request
 * `addressdetails=1` (and `dedupe=1`) so we can build:
 *   - a short primary `name` (the place's own name / first display_name segment),
 *   - a concise `context` ("Newport Beach, CA" → "CA"; "Disneyland Park" →
 *     "Anaheim, CA") — human-scale "City, State", never the full country chain,
 *   - the existing `displayName`, `lat`, `lon`, `type` for compatibility.
 *
 * Provider is unchanged (OSM Nominatim). The egress host
 * `nominatim.openstreetmap.org` is already allow-listed
 * (docs/security/allowed-egress.yaml). OSM ToS constraints — an identifying
 * User-Agent and ~1 req/s (enforced by the combobox's 300 ms debounce) — are
 * unchanged; parameter tuning + clean formatting is the scoped fix.
 */

/** Structured suggestion returned to the dashboard. */
export interface PlaceSuggestion {
  /** WARP-1906 — set to "room" when the suggestion is a premade workspace
   *  conference room (WorkspaceLocation row) rather than a Nominatim place.
   *  A room's `displayName` is the canonical "Building - Room" label the
   *  combobox stores verbatim on pick. Absent on Nominatim results. */
  kind?: "room";
  /** Short primary label — the place's own name / first display_name segment. */
  name: string;
  /** Concise human-scale locality, e.g. "CA", "Anaheim, CA", "Paris,
   *  Île-de-France". Empty string when nothing sensible can be derived. */
  context: string;
  /** Full Nominatim display_name, retained for backward compatibility. */
  displayName: string;
  lat: string;
  lon: string;
  type: string | null;
}

/** Raw Nominatim address block (present with `addressdetails=1`). Every field
 *  is optional — the shape varies by result class — and an index signature
 *  covers the ISO subdivision keys ("ISO3166-2-lvl4" etc.). */
export interface NominatimAddress {
  city?: string;
  town?: string;
  village?: string;
  hamlet?: string;
  municipality?: string;
  county?: string;
  state?: string;
  region?: string;
  state_district?: string;
  country?: string;
  country_code?: string;
  [key: string]: unknown;
}

/** Raw Nominatim `search` record (format=jsonv2). Fields are `unknown` because
 *  we validate them before use. */
export interface NominatimRecord {
  name?: unknown;
  display_name?: unknown;
  lat?: unknown;
  lon?: unknown;
  type?: unknown;
  address?: NominatimAddress;
}

const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
// OSM ToS requires a real User-Agent that identifies the app. Pin a stable
// string so OSM ops can correlate any rate-limit complaints back to us.
const NOMINATIM_UA = "DropletByWarpLab/1.0 (https://warp-lab.com)";

/** US state / territory name → USPS abbreviation. Used when Nominatim doesn't
 *  hand us an ISO-3166-2 subdivision code. Keyed lowercase. */
const US_STATE_ABBR: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
  "puerto rico": "PR",
  guam: "GU",
  "u.s. virgin islands": "VI",
  "american samoa": "AS",
  "northern mariana islands": "MP",
};

function strOrUndef(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    const s = strOrUndef(v);
    if (s) return s;
  }
  return undefined;
}

/** Derive a two-letter US subdivision code from an ISO-3166-2 value like
 *  "US-CA" → "CA". Returns undefined when the value isn't a US subdivision. */
function isoUsStateCode(addr: NominatimAddress): string | undefined {
  const iso =
    strOrUndef(addr["ISO3166-2-lvl4"]) ??
    strOrUndef(addr["ISO3166-2-lvl6"]) ??
    strOrUndef(addr["ISO3166-2-lvl3"]);
  if (iso && /^US-[A-Z]{2}$/.test(iso)) {
    return iso.slice(3);
  }
  return undefined;
}

/** Resolve the "region" (state) piece of the context. Abbreviates US states;
 *  leaves other countries' regions as-is (per spec: no full country chain). */
function resolveRegion(addr: NominatimAddress): string | undefined {
  const isUS = (strOrUndef(addr.country_code) ?? "").toLowerCase() === "us";
  const state = firstString(addr.state, addr.region, addr.state_district);
  if (isUS) {
    const iso = isoUsStateCode(addr);
    if (iso) return iso;
    if (state) return US_STATE_ABBR[state.toLowerCase()] ?? state;
    return undefined;
  }
  return state;
}

function buildContext(
  addr: NominatimAddress | undefined,
  name: string,
  segments: string[],
): string {
  if (addr) {
    const locality = firstString(
      addr.city,
      addr.town,
      addr.village,
      addr.hamlet,
      addr.municipality,
    );
    const region = resolveRegion(addr);
    const country = strOrUndef(addr.country);

    // A state-level result abbreviates to its own region ("California" →
    // "CA"), which the plain equality check can't see — treat it as a
    // duplicate of the name, not context.
    const regionDuplicatesName =
      region !== undefined &&
      (region.toLowerCase() === name.toLowerCase() ||
        US_STATE_ABBR[name.toLowerCase()] === region);

    const parts: string[] = [];
    if (locality && locality !== name) parts.push(locality);
    if (region && !regionDuplicatesName && region !== locality) parts.push(region);
    // Only fall back to the country when we have nothing else — keeps the
    // context human-scale ("City, State") rather than the full chain.
    if (parts.length === 0 && country && country !== name) parts.push(country);

    const context = parts.slice(0, 2).join(", ");
    if (context) return context;
  }

  // No usable address block — take the next 1-2 display_name segments after
  // the primary name, capped for brevity so we never re-emit the long chain.
  return segments
    .filter((s) => s !== name)
    .slice(0, 2)
    .join(", ");
}

/**
 * Turn a raw Nominatim record into a structured {@link PlaceSuggestion}, or
 * `null` when the record lacks the fields the combobox needs (display name +
 * coordinates). Pure — no I/O — so it's unit-tested directly.
 */
export function formatPlaceSuggestion(
  raw: NominatimRecord,
): PlaceSuggestion | null {
  const displayName = strOrUndef(raw.display_name);
  const lat = strOrUndef(raw.lat);
  const lon = strOrUndef(raw.lon);
  if (!displayName || !lat || !lon) return null;

  const segments = displayName
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const name = strOrUndef(raw.name) ?? segments[0] ?? displayName;
  const context = buildContext(raw.address, name, segments);

  return {
    name,
    context,
    displayName,
    lat,
    lon,
    type: typeof raw.type === "string" ? raw.type : null,
  };
}

/**
 * Query OSM Nominatim for fuzzy location suggestions and return them as
 * structured {@link PlaceSuggestion}s. Requests `addressdetails=1` (so we can
 * build the short name + concise context) and `dedupe=1` (so near-duplicate
 * OSM objects collapse). Returns `[]` on any non-2xx or malformed body — the
 * combobox then falls back to free-text entry.
 */
export async function fetchNominatim(
  q: string,
  limit: number,
): Promise<PlaceSuggestion[]> {
  const params = new URLSearchParams({
    format: "jsonv2",
    addressdetails: "1",
    dedupe: "1",
    limit: String(limit),
    q,
  });
  const resp = await fetch(`${NOMINATIM_URL}?${params.toString()}`, {
    headers: {
      "User-Agent": NOMINATIM_UA,
      Accept: "application/json",
      // Ask for English when there's no preference; letting it default would
      // pick locale-of-server, which is unpredictable in a container.
      "Accept-Language": "en",
    },
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) return [];
  const raw = (await resp.json()) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((r) => formatPlaceSuggestion(r as NominatimRecord))
    .filter((r): r is PlaceSuggestion => r !== null);
}
