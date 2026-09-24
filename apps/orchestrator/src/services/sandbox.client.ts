/**
 * WARP-2895 (ADR-056 §6.3, ADR-047 §4) — the orchestrator's client for
 * services/sandbox, and the {@link Transformer} seam the ToolSpec walker
 * runs `transform` / `when` steps through.
 *
 * The sandbox is the ONE place on the box customer-written code runs: a
 * container on the internal-only network (reachable from here, routable
 * nowhere else), read-only, no capabilities, a child interpreter per call.
 * This client's job is to keep the orchestrator honest about that:
 *
 *   - bearer `SANDBOX_SERVICE_TOKEN`; EMPTY fails CLOSED here without
 *     dialling (and the sandbox 503s on its side) — a transform step on an
 *     unprovisioned box fails legibly, never runs unauthenticated;
 *   - the deadline is enforced on THIS side as well as by the service. A
 *     service-only timeout fails open if the service itself hangs
 *     (ROUTINES brief §4.2), so an AbortController holds the same number
 *     plus a small grace for the round trip;
 *   - the output cap is reported by the service as an error and relayed as
 *     one — never sliced on either side.
 *
 * Injected into the walker like `Summarizer`, so the run stays testable
 * without a container.
 */
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("sandbox-client");

/** Grace on top of the service-side deadline for the HTTP round trip. */
const CALLER_TIMEOUT_GRACE_MS = 2_000;

export interface Transformer {
  /**
   * Run `code` over `inputs` in the sandbox. Resolves to the JSON the code
   * assigned to `output`. Throws with the service's own message on refusal,
   * timeout, output cap, or a user error — the walker records it as a
   * failed step like any other.
   */
  transform(code: string, inputs: Record<string, unknown>): Promise<unknown>;
}

export interface SandboxClientOptions {
  baseUrl?: string;
  serviceToken?: string;
  timeoutMs?: number;
  outputCapBytes?: number;
  fetchImpl?: typeof fetch;
}

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: "NOT_CONFIGURED" | "TIMEOUT" | "SANDBOX_ERROR" | "UNREACHABLE",
  ) {
    super(message);
    this.name = "SandboxError";
  }
}

export function createSandboxTransformer(opts: SandboxClientOptions = {}): Transformer {
  // Config is read at CALL time, not at construction: the router constructs
  // this at boot (as a default parameter), and a test that mocks `config`
  // with a partial object must not blow up on a step kind it never uses.
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async transform(code, inputs) {
      const baseUrl = (opts.baseUrl ?? config.SANDBOX_URL ?? "http://sandbox:8030").replace(/\/+$/, "");
      const token = opts.serviceToken ?? config.SANDBOX_SERVICE_TOKEN ?? "";
      const timeoutMs = opts.timeoutMs ?? config.SANDBOX_TRANSFORM_TIMEOUT_MS ?? 10_000;
      const outputCapBytes = opts.outputCapBytes ?? config.SANDBOX_OUTPUT_CAP_BYTES ?? 262_144;
      if (!token) {
        throw new SandboxError(
          "the sandbox is not configured on this box (SANDBOX_SERVICE_TOKEN unset)",
          "NOT_CONFIGURED",
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + CALLER_TIMEOUT_GRACE_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/transform`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ code, inputs, timeoutMs, outputCapBytes }),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new SandboxError(`transform exceeded ${timeoutMs} ms (caller deadline)`, "TIMEOUT");
        }
        logger.warn({ err }, "sandbox_unreachable");
        throw new SandboxError("the sandbox could not be reached", "UNREACHABLE");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 503) {
        throw new SandboxError("the sandbox refused: its bearer is not configured", "NOT_CONFIGURED");
      }
      if (!res.ok) {
        throw new SandboxError(`the sandbox answered ${res.status}`, "SANDBOX_ERROR");
      }
      const body = (await res.json().catch(() => null)) as { output?: unknown; error?: string } | null;
      if (!body || typeof body !== "object") {
        throw new SandboxError("the sandbox answered with no result", "SANDBOX_ERROR");
      }
      if (typeof body.error === "string") {
        throw new SandboxError(body.error, "SANDBOX_ERROR");
      }
      return body.output;
    },
  };
}
