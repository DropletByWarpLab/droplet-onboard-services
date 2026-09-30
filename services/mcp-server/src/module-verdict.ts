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
 *
 * A failure is SAID, once a minute: an operator whose tool list has quietly
 * shrunk needs one line naming why. The reason is a closed vocabulary
 * (`timeout`, `network`, `malformed`, `http_<status>`) — never the person, a
 * URL, a header or an error message, any of which can carry a credential.
 */

/** The person the call is for: a `User.id` (HTTP JWT `sub`), a username (stdio `_meta.userId`), or nobody. */
export type ModuleVerdictSource = (asserted: string | undefined) => Promise<ModuleVerdict>;

/** Why a verdict could not be had. A closed vocabulary: nothing free-form is ever logged. */
export type FailClosedReason = "timeout" | "network" | "malformed" | `http_${number}`;

/**
 * The source a server gets when it is built WITHOUT one: every call answers the
 * fail-closed verdict. Omitting `ServerOptions.moduleVerdict` is therefore
 * safe by construction, not a silent fail-open.
 */
export const FAIL_CLOSED_MODULE_SOURCE: ModuleVerdictSource = async () => FAIL_CLOSED_MODULE_VERDICT;

/**
 * Withholds nothing. For unit tests and embedders that have no orchestrator to
 * ask, and only for them: opting out of the gate is an explicit, greppable act,
 * pinned by server-module-gate.test.ts to appear nowhere in `src/` except here
 * and the library barrel. Production wires `createModuleVerdictSource`.
 */
export const NO_MODULE_GATING: ModuleVerdictSource = async () => ({
  withheldDomains: new Set<string>(),
});

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
  /** Called on the fail-closed branch, at most once a minute. Default: one `console.warn` line. */
  warn?: (reason: FailClosedReason) => void;
}

const WARN_EVERY_MS = 60_000;

function defaultWarn(reason: FailClosedReason): void {
  console.warn(
    `[mcp-server] module verdict unavailable (${reason}): module-owned tools are withheld until the orchestrator answers`,
  );
}

export const VERDICT_PATH = "/api/modules/tool-verdict";
const DEFAULT_TTL_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 3_000;
const MAX_CACHED = 512;

export function createModuleVerdictSource(opts: ModuleVerdictSourceOptions): ModuleVerdictSource {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const warn = opts.warn ?? defaultWarn;
  const cache = new Map<string, { at: number; verdict: ModuleVerdict }>();
  const inflight = new Map<string, Promise<ModuleVerdict>>();
  let lastWarnAt = Number.NEGATIVE_INFINITY;

  function failClosed(reason: FailClosedReason): ModuleVerdict {
    const at = now();
    if (at - lastWarnAt >= WARN_EVERY_MS) {
      lastWarnAt = at;
      try {
        warn(reason);
      } catch {
        // a broken logger must never turn a withheld list into an error
      }
    }
    return FAIL_CLOSED_MODULE_VERDICT;
  }

  async function fetchVerdict(asserted: string | undefined): Promise<ModuleVerdict> {
    let res: Response;
    try {
      res = await opts.http.get(VERDICT_PATH, {
        headers: asserted ? { "X-Nextcloud-User": asserted } : {},
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      return failClosed(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network");
    }
    if (!res.ok) return failClosed(`http_${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return failClosed("malformed");
    }
    return parseModuleVerdict(body) ?? failClosed("malformed");
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
