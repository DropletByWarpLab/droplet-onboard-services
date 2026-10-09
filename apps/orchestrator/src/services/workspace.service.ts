/**
 * WARP-2896 (ADR-056 §6.2, slice G) — the orchestrator's side of the
 * workshop: the client for the sandbox's git store, the `run` allow-list,
 * and the pieces routes/workspace.ts and the run worker share.
 *
 * WHAT LIVES WHERE. The sandbox (services/sandbox: gitstore.py,
 * workspace.py) holds the repositories and does every git operation; it is
 * on the internal-only network and trusts whatever reaches it. THIS side is
 * where the questions of identity are answered — who is asking, which run
 * is asking, does that run own that workspace — before anything is
 * forwarded, and where the `run` command is refused BEFORE the request is
 * made. The sandbox refuses it a second time; a guard that lives in one
 * place is one bug from gone.
 *
 * The client is injected into the router (like `Transformer` into the
 * ToolSpec walker) so the routes are testable without a container.
 */
import { pipeline, Readable, Transform } from "node:stream";
import { createReadStream } from "node:fs";
import { config } from "../config.js";
import { createLogger } from "../lib/logger.js";
import { parseConnectorDraftFacts, type ConnectorDraftFacts } from "./connector-draft.js";

const logger = createLogger("workspace");

/** Sandbox id grammar — doubles as the repository name (`<id>.git`). */
export const WORKSPACE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * The `run` allow-list. argv must START with one of these, verbatim; what
 * follows is checked against {@link RUN_ARG}. Mirrors services/sandbox
 * workspace.py RUN_COMMANDS — the sandbox test pins its own copy, and
 * `workspace.routes.test.ts` pins this one against the same cases.
 * `app-check` is an exact, argument-free command handled separately below.
 */
export const RUN_COMMANDS: ReadonlyArray<ReadonlyArray<string>> = [
  ["npm", "test"],
  ["npm", "run", "build"],
  ["pytest"],
  ["ruff"],
  ["tsc"],
];
const RUN_ARG = /^[A-Za-z0-9_./=:@,+-]{1,128}$/;

/** `null` when allowed; otherwise the reason, for the 400 body. */
export function refuseRunArgv(argv: unknown): string | null {
  if (!Array.isArray(argv) || argv.length === 0 || argv.length > 16) {
    return "argv must have 1–16 entries";
  }
  if (argv[0] === "app-check") {
    return argv.length === 1 ? null : "app-check takes no arguments";
  }
  if (!argv.every((a) => typeof a === "string")) return "argv must be strings";
  const words = argv as string[];
  for (const prefix of RUN_COMMANDS) {
    if (prefix.every((p, i) => words[i] === p)) {
      for (const a of words.slice(prefix.length)) {
        if (!RUN_ARG.test(a) || a.startsWith("/") || a.includes("..")) {
          return `argument not allowed: ${JSON.stringify(a.slice(0, 40))}`;
        }
      }
      return null;
    }
  }
  return `command not allowed; the workspace can run: ${RUN_COMMANDS.map((c) => c.join(" ")).join(", ")}`;
}

export interface WorkspaceAuthor {
  name: string;
  email: string;
}

export interface SandboxWorkspaceStatus {
  id: string;
  branch: string;
  head: string;
  dirty: boolean;
  tags: string[];
}

export class WorkspaceSandboxError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: "NOT_CONFIGURED" | "UNREACHABLE" | "SANDBOX_ERROR" | "TIMEOUT",
  ) {
    super(message);
    this.name = "WorkspaceSandboxError";
  }
}

/** Every call the routes make to the sandbox, one method per endpoint. */
export interface WorkspaceSandboxClient {
  templates(): Promise<string[]>;
  create(id: string, template: string | null, author: WorkspaceAuthor): Promise<SandboxWorkspaceStatus>;
  /** Human archive upload; streamed from a temporary file and never executed. */
  importArchive?(id: string, format: "zip" | "tar.gz", author: WorkspaceAuthor, file: string, bytes: number): Promise<SandboxWorkspaceStatus>;
  status(id: string): Promise<SandboxWorkspaceStatus>;
  remove(id: string): Promise<void>;
  op(id: string, op: WorkspaceOp, body: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  output(id: string): Promise<unknown>;
  /** The smart-HTTP transport, raw. */
  git(input: {
    method: string;
    path: string;
    query: string;
    contentType: string | null;
    contentEncoding: string | null;
    body: Buffer;
    user: string;
    allowPush: boolean;
  }): Promise<{ status: number; headers: Record<string, string>; body: Buffer }>;
  /**
   * WARP-2899 — the workspace as a `git bundle` (the `work` branch and every
   * proposal tag), built by the sandbox from its local bare repo, plus the
   * head of `work`. The export's only dial. The bytes are NOT buffered: the
   * caller drains `stream` and checks it against `size` and `sha256` (the
   * sandbox hashed the file as it wrote it) before trusting the download.
   */
  bundle(id: string): Promise<WorkspaceBundle>;
  /** WARP-2899 — a connector draft's facts at `ref` (work, or a proposal tag); null when there is no draft. */
  connectorDraft(id: string, ref: string): Promise<ConnectorDraftFacts | null>;
}

export interface WorkspaceBundle {
  stream: Readable;
  head: string;
  /** Bytes the sandbox will send (its content-length). */
  size: number;
  /** Lowercase hex sha256 of those bytes (its x-bundle-sha256). */
  sha256: string;
}

export type WorkspaceOp = "read" | "search" | "diff" | "log" | "write" | "commit" | "run" | "propose";

export interface WorkspaceSandboxClientOptions {
  baseUrl?: string;
  serviceToken?: string;
  fetchImpl?: typeof fetch;
}

const CALLER_TIMEOUT_GRACE_MS = 5_000;
const DEFAULT_OP_TIMEOUT_MS = 30_000;
const BUNDLE_TIMEOUT_MS = 120_000;
/**
 * Once an export's headers and integrity checks have passed, the body moves at
 * the owner's pace (the route pipes it to them with backpressure). It is
 * abandoned only when no bytes move for this long, not when the transfer as a
 * whole runs long.
 */
export const BUNDLE_STALL_TIMEOUT_MS = 60_000;
/** A commit id — the export's filename is built from it, so nothing else passes. */
const SHA256_HEX = /^[0-9a-f]{64}$/;
const COMMIT_ID = /^[0-9a-f]{40,64}$/;
export const RUN_DEFAULT_TIMEOUT_MS = 120_000;
export const RUN_MAX_TIMEOUT_MS = 600_000;

export function createWorkspaceSandboxClient(opts: WorkspaceSandboxClientOptions = {}): WorkspaceSandboxClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  function settings(): { baseUrl: string; token: string } {
    // Read at call time (sandbox.client.ts precedent): the router builds
    // this at boot as a default parameter.
    const baseUrl = (opts.baseUrl ?? config.SANDBOX_URL ?? "http://sandbox:8030").replace(/\/+$/, "");
    const token = opts.serviceToken ?? config.SANDBOX_SERVICE_TOKEN ?? "";
    if (!token) {
      throw new WorkspaceSandboxError(
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
        throw new WorkspaceSandboxError(`the sandbox did not answer within ${timeoutMs} ms`, 504, "TIMEOUT");
      }
      logger.warn({ err, path }, "workspace_sandbox_unreachable");
      throw new WorkspaceSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 503) {
      throw new WorkspaceSandboxError("the sandbox refused: its bearer is not configured", 503, "NOT_CONFIGURED");
    }
    const json = await res.json().catch(() => null);
    return { status: res.status, json };
  }

  /** Relay the sandbox's 4xx as-is (its `detail` is the honest reason); 5xx becomes a 502. */
  function unwrap<T>(r: { status: number; json: unknown }, what: string): T {
    if (r.status >= 200 && r.status < 300) return r.json as T;
    const detail =
      r.json && typeof r.json === "object" && typeof (r.json as { detail?: unknown }).detail === "string"
        ? (r.json as { detail: string }).detail
        : `the sandbox answered ${r.status}`;
    if (r.status >= 400 && r.status < 500) {
      throw new WorkspaceSandboxError(detail, r.status, "SANDBOX_ERROR");
    }
    logger.warn({ status: r.status, what, detail }, "workspace_sandbox_error");
    throw new WorkspaceSandboxError(`${what}: ${detail}`, 502, "SANDBOX_ERROR");
  }

  return {
    async templates() {
      const r = unwrap<{ templates?: string[] }>(
        await call("GET", "/workspaces/templates", undefined, DEFAULT_OP_TIMEOUT_MS),
        "list templates",
      );
      return Array.isArray(r.templates) ? r.templates : [];
    },
    async create(id, template, author) {
      return unwrap<SandboxWorkspaceStatus>(
        await call("POST", "/workspaces", { id, template, author }, DEFAULT_OP_TIMEOUT_MS),
        "create workspace",
      );
    },
    async importArchive(id, format, author, file, bytes) {
      const { baseUrl, token } = settings();
      const source = createReadStream(file);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 300_000);
      try {
        const init = {
          method: "POST", body: source, duplex: "half", signal: controller.signal,
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes), "X-Droplet-Author-Name": encodeURIComponent(author.name),
            "X-Droplet-Author-Email": encodeURIComponent(author.email) },
        } as unknown as RequestInit;
        const response = await fetchImpl(`${baseUrl}/workspaces/${encodeURIComponent(id)}/import?format=${encodeURIComponent(format)}`, init);
        return unwrap<SandboxWorkspaceStatus>({status: response.status, json: await response.json().catch(() => null)}, "import archive");
      } catch (err) {
        if (err instanceof WorkspaceSandboxError) throw err;
        throw new WorkspaceSandboxError(controller.signal.aborted ? "archive import timed out" : "archive import could not reach the sandbox",
          controller.signal.aborted ? 504 : 502, controller.signal.aborted ? "TIMEOUT" : "UNREACHABLE");
      } finally {
        clearTimeout(timer);
        controller.abort();
        source.destroy();
      }
    },
    async status(id) {
      return unwrap<SandboxWorkspaceStatus>(
        await call("GET", `/workspaces/${encodeURIComponent(id)}`, undefined, DEFAULT_OP_TIMEOUT_MS),
        "workspace status",
      );
    },
    async remove(id) {
      const r = await call("DELETE", `/workspaces/${encodeURIComponent(id)}`, undefined, DEFAULT_OP_TIMEOUT_MS);
      if (r.status === 404) return;
      unwrap(r, "delete workspace");
    },
    async op(id, op, body, timeoutMs) {
      const budget = timeoutMs ?? (op === "run" ? RUN_DEFAULT_TIMEOUT_MS : DEFAULT_OP_TIMEOUT_MS);
      return unwrap(await call("POST", `/workspaces/${encodeURIComponent(id)}/${op}`, body, budget), op);
    },
    async bundle(id) {
      const { baseUrl, token } = settings();
      const controller = new AbortController();
      // Bounds the wait for the sandbox's headers and the checks on them. It
      // is cleared the moment the export is handed over (the body is then
      // bounded by the stall timer below, not by how long the owner's
      // connection takes) and on every failure before that.
      const timer = setTimeout(() => controller.abort(), BUNDLE_TIMEOUT_MS + CALLER_TIMEOUT_GRACE_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/workspaces/${encodeURIComponent(id)}/bundle`, {
          method: "GET",
          headers: { Accept: "application/octet-stream", Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        if (controller.signal.aborted) {
          throw new WorkspaceSandboxError(`the sandbox did not answer within ${BUNDLE_TIMEOUT_MS} ms`, 504, "TIMEOUT");
        }
        logger.warn({ err }, "workspace_bundle_unreachable");
        throw new WorkspaceSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
      }
      const fail = async (e: WorkspaceSandboxError): Promise<never> => {
        clearTimeout(timer);
        controller.abort();
        throw e;
      };
      if (res.status === 503) {
        return fail(new WorkspaceSandboxError("the sandbox refused: its bearer is not configured", 503, "NOT_CONFIGURED"));
      }
      if (res.status < 200 || res.status >= 300) {
        let json: unknown = null;
        try {
          json = JSON.parse(Buffer.from(await res.arrayBuffer()).toString("utf8"));
        } catch {
          json = null;
        }
        clearTimeout(timer);
        return unwrap({ status: res.status, json }, "bundle") as never;
      }
      const head = res.headers.get("x-bundle-head") ?? "";
      if (!COMMIT_ID.test(head)) {
        logger.warn({ id }, "workspace_bundle_bad_head");
        return fail(new WorkspaceSandboxError("bundle: the sandbox named no commit for work", 502, "SANDBOX_ERROR"));
      }
      const sha256 = res.headers.get("x-bundle-sha256") ?? "";
      const lengthHeader = res.headers.get("content-length") ?? "";
      const size = /^\d+$/.test(lengthHeader) ? Number(lengthHeader) : -1;
      if (!SHA256_HEX.test(sha256) || !Number.isSafeInteger(size) || size < 0 || !res.body) {
        logger.warn({ id }, "workspace_bundle_bad_integrity_headers");
        return fail(new WorkspaceSandboxError("bundle: the sandbox sent no length and sha256 for the export", 502, "SANDBOX_ERROR"));
      }
      clearTimeout(timer);
      const source = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream<Uint8Array>);
      // The route pipes this to the owner with backpressure, so the body runs at
      // their pace: a slow download is fine, a stalled one is not. Every chunk
      // that passes re-arms the stall timer, so it fires only when no bytes
      // have moved for BUNDLE_STALL_TIMEOUT_MS (a dead sandbox or a client that
      // stopped reading). It is cleared when the stream ends, errors or is
      // destroyed by the caller.
      let stall: NodeJS.Timeout | undefined;
      const arm = () => {
        clearTimeout(stall);
        stall = setTimeout(() => {
          stream.destroy(
            new WorkspaceSandboxError(`bundle: no bytes moved for ${BUNDLE_STALL_TIMEOUT_MS} ms`, 504, "TIMEOUT"),
          );
          controller.abort();
        }, BUNDLE_STALL_TIMEOUT_MS);
      };
      const stream = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          arm();
          cb(null, chunk);
        },
        flush(cb) {
          clearTimeout(stall);
          cb();
        },
        destroy(err, cb) {
          clearTimeout(stall);
          cb(err);
        },
      });
      // Errors from either end land on `stream`; destroying it closes `source`.
      pipeline(source, stream, () => undefined);
      arm();
      return { stream, head, size, sha256 };
    },
    async connectorDraft(id, ref) {
      const r = unwrap<{ draft?: unknown }>(
        await call(
          "GET",
          `/workspaces/${encodeURIComponent(id)}/connector-draft?ref=${encodeURIComponent(ref)}`,
          undefined,
          DEFAULT_OP_TIMEOUT_MS,
        ),
        "connector draft",
      );
      return parseConnectorDraftFacts(r?.draft ?? null);
    },
    async output(id) {
      return unwrap(
        await call("GET", `/workspaces/${encodeURIComponent(id)}/output`, undefined, DEFAULT_OP_TIMEOUT_MS),
        "output",
      );
    },
    async git(input) {
      const { baseUrl, token } = settings();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), RUN_DEFAULT_TIMEOUT_MS);
      let res: Response;
      try {
        res = await fetchImpl(`${baseUrl}/git${input.path}${input.query ? `?${input.query}` : ""}`, {
          method: input.method,
          headers: {
            Authorization: `Bearer ${token}`,
            "X-Droplet-Git-User": input.user,
            "X-Droplet-Git-Push": input.allowPush ? "1" : "0",
            ...(input.contentType ? { "Content-Type": input.contentType } : {}),
            ...(input.contentEncoding ? { "Content-Encoding": input.contentEncoding } : {}),
          },
          ...(input.method === "POST" ? { body: new Uint8Array(input.body) } : {}),
          signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          throw new WorkspaceSandboxError("git timed out", 504, "TIMEOUT");
        }
        logger.warn({ err }, "workspace_git_unreachable");
        throw new WorkspaceSandboxError("the sandbox could not be reached", 502, "UNREACHABLE");
      } finally {
        clearTimeout(timer);
      }
      const headers: Record<string, string> = {};
      for (const name of ["content-type", "cache-control", "pragma", "expires", "content-encoding"]) {
        const v = res.headers.get(name);
        if (v) headers[name] = v;
      }
      return { status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) };
    },
  };
}
