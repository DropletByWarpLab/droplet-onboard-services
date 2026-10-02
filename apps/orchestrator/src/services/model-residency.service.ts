/**
 * WARP-3047 — make the active model the ONLY resident chat model.
 *
 * `PATCH /api/models/active` used to write a settings row and nothing else.
 * The old model stayed loaded, and on Docker Model Runner — which has no
 * memory-aware eviction (v1.2.6: up to min(NumCPU, 8) runner slots, evicted
 * only when every slot is taken or after 5 idle minutes) — the new model then
 * loaded NEXT TO it. Anything larger than what the old one left free failed
 * with "not enough GPU memory to load the model", which the person saw as a
 * generic upstream error.
 *
 * Residency is lifecycle, and lifecycle belongs to the inference-manager
 * sidecar: this is the orchestrator's thin client for its
 * `POST /models/unload {keep}`, which unloads every other resident chat model
 * and reads back what is STILL resident (DMR skips a runner that is serving a
 * request). No chat traffic goes through the sidecar — this only makes room.
 *
 * Same base URL + bearer resolution as `model-catalog.service.ts` (the
 * sidecar's other client), read per call so tests can `vi.stubEnv` them.
 */

/** Base URL of the inference-manager sidecar (see model-catalog.service.ts). */
function baseUrl(): string {
  const raw =
    process.env.INFERENCE_MANAGER_URL?.trim() ||
    "http://host.docker.internal:8002";
  return raw.replace(/\/+$/, "");
}

/** Bearer for the sidecar, applied when set (its auth.py reads this name). */
function authHeaders(): Record<string, string> {
  const token = process.env.INFERENCE_AUTH_TOKEN?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Unloading waits for each evicted runner process to exit — seconds, not a
 *  turn. Bounded so a wedged sidecar can't hold a PATCH open. */
const UNLOAD_BUDGET_MS = 30_000;

export interface ResidencyReport {
  /** Resident chat models this call actually freed. */
  unloaded: string[];
  /** Other chat models STILL resident afterwards — e.g. one mid-request,
   *  which DMR will not evict. Reported, never pretended away. */
  stillResident: string[];
}

function readNames(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((m): m is string => typeof m === "string") : [];
}

/**
 * Unload every resident chat model except `keep`. Throws on any transport or
 * HTTP failure — the caller decides whether that is fatal (for a model switch
 * it is not: the choice stands, and the old model idles out on its own).
 */
export async function unloadAllExcept(keep: string): Promise<ResidencyReport> {
  const resp = await fetch(`${baseUrl()}/models/unload`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ keep }),
    signal: AbortSignal.timeout(UNLOAD_BUDGET_MS),
  });
  if (!resp.ok) {
    // Drain so the socket isn't pinned by an unread body.
    await resp.text().catch(() => undefined);
    throw new Error(`inference-manager /models/unload answered ${resp.status}`);
  }
  const body = (await resp.json()) as Record<string, unknown> | null;
  return {
    unloaded: readNames(body?.unloaded),
    stillResident: readNames(body?.still_resident),
  };
}
