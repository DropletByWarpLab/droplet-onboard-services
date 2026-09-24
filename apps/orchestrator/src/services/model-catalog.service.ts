/**
 * WARP-1827 — the model-catalog proxy to the appliance's inference-manager.
 *
 * The orchestrator never decides which models this box can run. That knowledge
 * lives appliance-side, in droplet-local-LLM's inference-manager sidecar
 * (`:8002` on the box): it detects VRAM, filters its catalog down to the
 * ELIGIBLE set, preflights disk before a pull, and executes the pull against
 * the inference runtime. This module is the orchestrator's thin client for
 * that surface — two calls, both honest:
 *
 *   - `fetchEligibleCatalog()` — GET /models/eligible. Parsed TOLERANTLY:
 *     a field the sidecar didn't send becomes null/[]/false, never a
 *     fabricated value (same honesty contract as model-metrics.service).
 *     Entries with no usable `name` are dropped — they can't be addressed.
 *
 *   - `openPullStream()` — POST /models/pull?stream=true. Returns the RAW
 *     fetch Response WITHOUT consuming the body: the route pipes the NDJSON
 *     progress stream through to the dashboard chunk-by-chunk. No retry, no
 *     overall timeout — a pull legitimately runs for minutes, so only the
 *     connect-level defaults (undici) and the caller's AbortSignal bound it.
 *
 *   - `readPullRefusal()` — WARP-3046: when that pull is refused before any
 *     progress, translate the sidecar's FastAPI error body into the
 *     orchestrator's own typed refusal, so a disk 409 or the runtime's own
 *     reason reaches the dashboard as a string it can show.
 *
 * ADR-003 note: nothing here touches model CHOICE. Pulls only install; the
 * active-model setting is a separate control-plane preference (WARP-1112).
 */

/** Base URL of the inference-manager sidecar. Read per call (not cached at
 *  module load) so tests can `vi.stubEnv` it — same rationale as
 *  inference-runtime.ts. */
function baseUrl(): string {
  const raw =
    process.env.INFERENCE_MANAGER_URL?.trim() ||
    "http://host.docker.internal:8002";
  return raw.replace(/\/+$/, "");
}

/** Optional bearer auth for the sidecar. Applied to EVERY request when set. */
function authHeaders(): Record<string, string> {
  const token = process.env.INFERENCE_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** The eligible-catalog read is a control-plane GET — bound it like the other
 *  sidecar probes so a wedged sidecar can't hang the Models page. */
const CATALOG_BUDGET_MS = 5000;

export interface CatalogModelEntry {
  /** Catalog identity: how the user, the dashboard and the audit trail
   *  address this model. NOT what goes on the wire to /models/pull. */
  name: string;
  /** The runtime tag the sidecar actually pulls, and therefore the value
   *  POSTed to /models/pull (may differ from `name`; null when the catalog
   *  didn't state one, in which case `name` is the only addressable id).
   *  The sidecar passes whatever it's handed straight to the runtime — it
   *  does NOT resolve `name` → `pull_tag` on our behalf. */
  pull_tag: string | null;
  min_vram_gb: number | null;
  /** Sidecar's size class, e.g. "flagship" / "compact". */
  class: string | null;
  /** True for the catalog's default recommendation at this VRAM tier. */
  default: boolean;
  display_name: string | null;
  maker: string | null;
  description: string | null;
  capabilities: string[];
  roles: string[];
  /** Approximate download size in GB, when the catalog knows it. */
  disk_gb: number | null;
  /** True when the model is already installed on this box. */
  pulled: boolean;
}

export interface EligibleCatalog {
  /** GB the sidecar will size downloads against. `null` = UNKNOWN (WARP-3046:
   *  nothing could size the box — e.g. an NVIDIA card with the device-bridge
   *  down), which is not the same as 0. */
  detected_vram_gb: number | null;
  /** Where `detected_vram_gb` came from: override | device_bridge |
   *  dgpu_sysfs | unified_memory — `null` when unknown or not reported. */
  vram_source: string | null;
  /** The sidecar could not read the runtime's installed list, so every
   *  `pulled` flag below is unconfirmed (all read false). */
  tags_unreachable: boolean;
  /** The sidecar served a last-known-good or empty manifest because the
   *  shipped one failed to load. */
  degraded_manifest: boolean;
  models: CatalogModelEntry[];
}

function readString(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

function readNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function readStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((s): s is string => typeof s === "string" && s.trim() !== "");
}

/** One raw entry → typed entry, or null when it can't even be named. Every
 *  field is probed, not assumed — a gap stays a gap. */
function parseEntry(raw: unknown): CatalogModelEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const name = readString(e.name);
  if (!name) return null;
  return {
    name,
    pull_tag: readString(e.pull_tag),
    min_vram_gb: readNumber(e.min_vram_gb),
    class: readString(e.class),
    default: e.default === true,
    display_name: readString(e.display_name),
    maker: readString(e.maker),
    description: readString(e.description),
    capabilities: readStringArray(e.capabilities),
    roles: readStringArray(e.roles),
    disk_gb: readNumber(e.disk_gb),
    pulled: e.pulled === true,
  };
}

/**
 * The models this box is ELIGIBLE to run (VRAM-gated, sidecar-decided), with
 * per-model `pulled` flags. Throws on any transport/HTTP failure — the route
 * maps that to its 503, never to an empty catalog (an unreachable sidecar
 * must not read as "nothing available to install").
 */
export async function fetchEligibleCatalog(): Promise<EligibleCatalog> {
  const resp = await fetch(`${baseUrl()}/models/eligible`, {
    headers: { ...authHeaders() },
    signal: AbortSignal.timeout(CATALOG_BUDGET_MS),
  });
  if (!resp.ok) {
    // Drain so the socket isn't pinned by an unread body.
    await resp.text().catch(() => undefined);
    throw new Error(`inference-manager /models/eligible answered ${resp.status}`);
  }
  const body = (await resp.json()) as Record<string, unknown> | null;
  const rawModels = Array.isArray(body?.models) ? body.models : [];
  return {
    detected_vram_gb: readNumber(body?.detected_vram_gb),
    // WARP-3046: the three flags below were dropped here, so an empty
    // catalog could never say WHY it was empty (unknown VRAM, an unreadable
    // inventory, a broken manifest). Strict `=== true`: an older sidecar that
    // doesn't send one reads as "not flagged", never as a guess.
    vram_source: readString(body?.vram_source),
    tags_unreachable: body?.tags_unreachable === true,
    degraded_manifest: body?.degraded_manifest === true,
    models: rawModels
      .map(parseEntry)
      .filter((m): m is CatalogModelEntry => m !== null),
  };
}

/**
 * Start a streaming pull and hand back the RAW response — body untouched, so
 * the caller can pipe the NDJSON progress through to its own client and abort
 * via `signal` when that client goes away. Deliberately NO retry and NO
 * overall timeout: a multi-GB pull runs for minutes and progress lines keep
 * the connection demonstrably alive.
 *
 * @param model The catalog entry's `pull_tag` (falling back to `name` when the
 *   catalog states none) — NOT the user-facing catalog name. The sidecar sends
 *   this identifier straight to the runtime without consulting its manifest.
 */
export async function openPullStream(
  model: string,
  signal: AbortSignal,
): Promise<Response> {
  return fetch(`${baseUrl()}/models/pull?stream=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      ...authHeaders(),
    },
    body: JSON.stringify({ model }),
    signal,
  });
}

/** Generic copy for a refusal that carried no reason of its own. */
const PULL_FAILED_FALLBACK =
  "The download couldn't be started. Try again in a moment.";

/** A runtime reason is shown to an admin verbatim — bound it so a runaway
 *  upstream body can't flood the page or the audit row. */
const MAX_REASON_CHARS = 500;

export type PullRefusal =
  | {
      status: 409;
      body: {
        error: "insufficient_disk";
        detail: string;
        needed_gb: number;
        free_gb: number;
      };
    }
  | { status: 502; body: { error: "pull_failed"; detail: string } };

/** The human-readable reason inside one FastAPI `detail`, or null. A string
 *  may itself be the runtime's JSON body relayed verbatim — DMR answers a
 *  pre-stream failure with 500 `{"error":"Failed to pull model: …"}`, which
 *  the sidecar re-raises as `detail: "<that body>"` — so unwrap its `error`. */
function refusalReason(detail: unknown): string | null {
  if (typeof detail === "string") {
    const text = detail.trim();
    if (!text) return null;
    try {
      const inner = JSON.parse(text) as unknown;
      if (inner && typeof inner === "object") {
        const reason = readString((inner as Record<string, unknown>).error);
        if (reason) return reason;
      }
    } catch {
      /* not JSON — the text is the reason */
    }
    return text;
  }
  if (detail && typeof detail === "object") {
    return readString((detail as Record<string, unknown>).error);
  }
  return null;
}

/**
 * WARP-3046 — turn the sidecar's non-2xx answer to POST /models/pull into the
 * orchestrator's own typed refusal (cross-lane contract C2). Consumes the body.
 *
 * The sidecar is FastAPI, so every refusal is `{"detail": X}`:
 *  - the disk preflight's 409 carries X as an OBJECT `{error, needed_gb,
 *    free_gb}` — it used to be relayed verbatim, and the dashboard rendered
 *    that object as a React child and crashed the page. It becomes
 *    409 `insufficient_disk` with a STRING `detail` plus the two numbers;
 *  - anything else carries the runtime's own reason (a bad tag, no egress,
 *    a registry rate limit), previously flattened into "try again". It
 *    becomes 502 `pull_failed` with that reason as `detail`.
 * `detail` is always a non-empty string, whatever the upstream sent.
 */
export async function readPullRefusal(upstream: Response): Promise<PullRefusal> {
  const text = await upstream.text().catch(() => "");
  let detail: unknown = text;
  try {
    const parsed = JSON.parse(text) as unknown;
    detail =
      parsed && typeof parsed === "object" && "detail" in parsed
        ? (parsed as Record<string, unknown>).detail
        : parsed;
  } catch {
    /* not JSON — the raw text is the detail */
  }

  if (upstream.status === 409 && detail && typeof detail === "object") {
    const d = detail as Record<string, unknown>;
    const neededGb = readNumber(d.needed_gb);
    const freeGb = readNumber(d.free_gb);
    if (d.error === "insufficient_disk" && neededGb !== null && freeGb !== null) {
      return {
        status: 409,
        body: {
          error: "insufficient_disk",
          detail: `Not enough free space for this download: it needs ${neededGb} GB free and ${freeGb} GB is available.`,
          needed_gb: neededGb,
          free_gb: freeGb,
        },
      };
    }
  }

  const reason = refusalReason(detail);
  return {
    status: 502,
    body: {
      error: "pull_failed",
      detail: reason ? reason.slice(0, MAX_REASON_CHARS) : PULL_FAILED_FALLBACK,
    },
  };
}
