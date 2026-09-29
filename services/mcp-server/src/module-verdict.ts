import {
  FAIL_CLOSED_MODULE_VERDICT,
  parseModuleVerdict,
  type HttpClient,
  type ModuleVerdict,
} from "@droplet/tools-core";

/**
 * WARP-2972 — where the mcp-server learns which tool domains a module toggle,
 * or a person's own grants, withhold.
 *
 * The module registry and the box's availability signals (FRIGATE_URL,
 * SERVICE_TOKEN_EMAIL, …) exist only in the orchestrator — this container's
 * environment carries none of them — so the verdict is ASKED for, from
 * `GET /api/modules/tool-verdict`, with the service bearer every orchestrator
 * call from here already carries. The predicate that uses the answer is
 * `isToolWithheldByModule` in `@droplet/tools-core`, the same one the
 * orchestrator applies to its own chat pool.
 *
 * FAIL CLOSED. Anything short of a well-formed 200 — a refusal, a timeout, an
 * unreachable orchestrator, a body of the wrong shape — is
 * `FAIL_CLOSED_MODULE_VERDICT`: every module-owned domain withheld, every
 * unclaimed domain (system, data, routines, …) still available. The caller
 * gets a shorter tool list, never an error, and a failure is not remembered:
 * the next call asks again, so recovery is immediate.
 */

/** The person the call is for: a `User.id` (HTTP JWT `sub`), a username (stdio `_meta.userId`), or nobody. */
export type ModuleVerdictSource = (asserted: string | undefined) => Promise<ModuleVerdict>;

export interface ModuleVerdictSourceOptions {
  /** The orchestrator client (`deps.httpFactory("orchestrator")`) — it carries the service bearer. */
  http: HttpClient;
  /**
   * How long a good answer is reused. Short on purpose: a toggle or a grant
   * change reaches an external MCP client within this window, on top of the
   * orchestrator's own (equally short) caches.
   */
  ttlMs?: number;
  /** Deadline for one request; a list or a call waits at most this long for a verdict. */
  timeoutMs?: number;
  now?: () => number;
}

export const VERDICT_PATH = "/api/modules/tool-verdict";
const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CACHED = 512;

export function createModuleVerdictSource(opts: ModuleVerdictSourceOptions): ModuleVerdictSource {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; verdict: ModuleVerdict }>();
  const inflight = new Map<string, Promise<ModuleVerdict>>();

  async function fetchVerdict(asserted: string | undefined): Promise<ModuleVerdict> {
    try {
      const res = await opts.http.get(VERDICT_PATH, {
        headers: asserted ? { "X-Nextcloud-User": asserted } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return FAIL_CLOSED_MODULE_VERDICT;
      return parseModuleVerdict(await res.json()) ?? FAIL_CLOSED_MODULE_VERDICT;
    } catch {
      return FAIL_CLOSED_MODULE_VERDICT;
    }
  }

  return async function moduleVerdict(asserted) {
    const key = asserted ?? "";
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.verdict;
    let pending = inflight.get(key);
    if (!pending) {
      pending = fetchVerdict(asserted).then((verdict) => {
        // Only a real answer is remembered; the fail-closed sentinel is not.
        if (verdict !== FAIL_CLOSED_MODULE_VERDICT) {
          if (cache.size >= MAX_CACHED) cache.clear();
          cache.set(key, { at: now(), verdict });
        }
        return verdict;
      });
      inflight.set(key, pending);
      void pending.finally(() => inflight.delete(key)).catch(() => {});
    }
    return pending;
  };
}
