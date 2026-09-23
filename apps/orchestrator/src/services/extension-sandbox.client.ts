/**
 * WARP-2900 (ADR-056 slice H2): the orchestrator's client for the sandbox's
 * extension routes (services/sandbox/main.py, extensions.py).
 *
 * One method per route, a bearer on every call, and a CALLER-side timeout on
 * every call (a service-only timeout fails open if the service itself hangs;
 * sandbox.client.ts precedent). It dials `config.SANDBOX_URL` and nothing
 * else: the extension processes themselves listen on the sandbox container's
 * loopback and are reachable only through `rpc` (the sandbox relays).
 *
 * The sandbox answers every extension route with a bare 404 `Not found`
 * while SANDBOX_PROCESS_SUPERVISION is off. That is reported here as
 * `SUPERVISION_OFF` (503 to a caller), never confused with "no such
 * extension" (a 404 with its own detail).
 */
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";

const logger = createLogger("extension-sandbox");

export type ExtensionRuntime = "node20" | "python312";

export interface ProposalManifest {
  workspaceId: string;
  tag: string;
  commit: string;
  tree: string;
  /** The exact committed bytes, or null when the commit has no manifest. */
  manifest: Buffer | null;
}

export interface SandboxBudget {
  ceilingMb: number;
  source: "cgroup" | "env";
  transformHeadroomMb: number;
  installedMb: number;
  availableMb: number;
}

export interface SandboxExtensionStatus {
  slug: string;
  workspaceId: string;
  version: string;
  runtime: ExtensionRuntime;
  memoryMb: number;
  port: number;
  running: boolean;
  process: { state: string; restarts: number; exitCode: number | null } | null;
}

export interface ExtensionInstallRequest {
  workspaceId: string;
  version: string;
  commit: string;
  tree: string;
  runtime: ExtensionRuntime;
  entrypoint: string;
  memoryMb: number;
  /** The extension's call-back bearer (dxt_…); it reaches the child's env only. */
  token: string;
  orchestratorUrl?: string;
}

export type ExtensionSandboxErrorCode =
  | "NOT_CONFIGURED"
  | "UNREACHABLE"
  | "SANDBOX_ERROR"
  | "TIMEOUT"
  | "SUPERVISION_OFF";

export class ExtensionSandboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: ExtensionSandboxErrorCode,
  ) {
    super(message);
    this.name = "ExtensionSandboxError";
  }
}

export interface ExtensionSandboxClient {
  proposalManifest(workspaceId: string, version: string): Promise<ProposalManifest>;
  budget(): Promise<SandboxBudget>;
  /** null when the sandbox has no such extension installed (e.g. after a restart). */
  status(slug: string): Promise<SandboxExtensionStatus | null>;
  install(slug: string, req: ExtensionInstallRequest): Promise<SandboxExtensionStatus>;
  /** Stop the process; a missing one is not an error. */
  stop(slug: string): Promise<void>;
  uninstall(slug: string): Promise<void>;
  /** Relay one JSON-RPC message to the extension (used by the attach port, H3). */
  rpc(slug: string, message: unknown, timeoutMs?: number): Promise<{ status: number; json: unknown }>;
}

export interface ExtensionSandboxClientOptions {
  baseUrl?: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
}

const CALLER_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Export + tsc + start + ready, with the sandbox's own 180 s build ceiling. */
export const INSTALL_TIMEOUT_MS = 240_000;
/** The sandbox gate's exact 404 body. */
const GATE_DETAIL = "Not found";

export function createExtensionSandboxClient(
  opts: ExtensionSandboxClientOptions = {},
): ExtensionSandboxClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  function settings(): { baseUrl: string; token: string } {
    const baseUrl = (opts.baseUrl ?? config.SANDBOX_URL ?? "http://sandbox:8030").replace(/\/+$/, "");
    const token = opts.serviceToken ?? config.SANDBOX_SERVICE_TOKEN ?? "";
    if (!token) {
      throw new ExtensionSandboxError(
        "the sandbox is not configured on this box (SANDBOX_SERVICE_TOKEN unset)",
        503,
        "NOT_CONFIGURED",
      );
    }
    return { baseUrl, token };
  }

  async function call(
    method: "GET" | "POST" | "DELETE",
    path: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<{ status: number; json: unknown }> {
    const { baseUrl, token } = settings();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + CALLER_TIMEOUT_GRACE_MS);
    let res: Response;
    try {
      res = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ExtensionSandboxError(`the sandbox did not answer within ${timeoutMs} ms`, 504, "TIMEOUT");
      }
      logger.warn({ err, path }, "extension_sandbox_unreachable");
      throw new ExtensionSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 503) {
      throw new ExtensionSandboxError("the sandbox refused: its bearer is not configured", 503, "NOT_CONFIGURED");
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  function detailOf(json: unknown): string | null {
    return json && typeof json === "object" && typeof (json as { detail?: unknown }).detail === "string"
      ? (json as { detail: string }).detail
      : null;
  }

  function isGate(r: { status: number; json: unknown }): boolean {
    return r.status === 404 && detailOf(r.json) === GATE_DETAIL;
  }

  /** 2xx → body; the gate's 404 → SUPERVISION_OFF; other 4xx relayed; 5xx → 502. */
  function unwrap<T>(r: { status: number; json: unknown }, what: string): T {
    if (r.status >= 200 && r.status < 300) return r.json as T;
    if (isGate(r)) {
      throw new ExtensionSandboxError(
        "extensions are not enabled on this box (SANDBOX_PROCESS_SUPERVISION is off)",
        503,
        "SUPERVISION_OFF",
      );
    }
    const detail = detailOf(r.json) ?? `the sandbox answered ${r.status}`;
    if (r.status >= 400 && r.status < 500) {
      throw new ExtensionSandboxError(detail, r.status, "SANDBOX_ERROR");
    }
    logger.warn({ status: r.status, what, detail }, "extension_sandbox_error");
    throw new ExtensionSandboxError(`${what}: ${detail}`, 502, "SANDBOX_ERROR");
  }

  const slugPath = (slug: string) => `/extensions/${encodeURIComponent(slug)}`;

  return {
    async proposalManifest(workspaceId, version) {
      const r = unwrap<{ workspaceId: string; tag: string; commit: string; tree: string; manifest: string | null }>(
        await call(
          "GET",
          `/workspaces/${encodeURIComponent(workspaceId)}/proposals/${encodeURIComponent(version)}/manifest`,
          undefined,
          DEFAULT_TIMEOUT_MS,
        ),
        "proposal manifest",
      );
      return {
        workspaceId: r.workspaceId,
        tag: r.tag,
        commit: r.commit,
        tree: r.tree,
        manifest: typeof r.manifest === "string" ? Buffer.from(r.manifest, "base64") : null,
      };
    },
    async budget() {
      return unwrap<SandboxBudget>(await call("GET", "/extensions/budget", undefined, DEFAULT_TIMEOUT_MS), "budget");
    },
    async status(slug) {
      const r = await call("GET", slugPath(slug), undefined, DEFAULT_TIMEOUT_MS);
      if (r.status === 404 && !isGate(r)) return null;
      const st = unwrap<SandboxExtensionStatus | null>(r, "extension status");
      // Trust `running` only from a body about THIS extension: a route that
      // shadows /extensions/{slug} (the budget) must not read as "stopped".
      if (!st || typeof st !== "object" || st.slug !== slug) {
        throw new ExtensionSandboxError(`the sandbox answered a status that is not about ${slug}`, 502, "SANDBOX_ERROR");
      }
      return st;
    },
    async install(slug, req) {
      return unwrap<SandboxExtensionStatus>(
        await call("POST", `${slugPath(slug)}/install`, req, INSTALL_TIMEOUT_MS),
        "install extension",
      );
    },
    async stop(slug) {
      const r = await call("DELETE", `${slugPath(slug)}/process`, undefined, DEFAULT_TIMEOUT_MS);
      if (r.status === 404 && !isGate(r)) return;
      unwrap(r, "stop extension");
    },
    async uninstall(slug) {
      unwrap(await call("DELETE", slugPath(slug), undefined, DEFAULT_TIMEOUT_MS), "uninstall extension");
    },
    async rpc(slug, message, timeoutMs) {
      const budget = timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const query = timeoutMs ? `?timeoutMs=${Math.trunc(timeoutMs)}` : "";
      const r = await call("POST", `${slugPath(slug)}/rpc${query}`, message, budget);
      if (isGate(r)) unwrap(r, "extension rpc");
      if (r.status >= 500) unwrap(r, "extension rpc");
      return r;
    },
  };
}
