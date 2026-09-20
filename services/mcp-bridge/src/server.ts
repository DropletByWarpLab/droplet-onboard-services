/**
 * WARP-2627 — the `node:http` adapter and the container's entry point.
 *
 * Everything interesting is in `http-api.ts`. This file is the socket: read the
 * body, parse it, hand it to {@link handleBridgeRequest}, write the answer. It
 * is deliberately thin so the routing, the auth and the session lifecycle are
 * all testable without listening on a port.
 *
 * BIND: `0.0.0.0` inside the container, `expose:`-only in compose — no host
 * port. The orchestrator is the only caller, over the compose bridge network,
 * with a bearer. That is the same posture `doc-render` and `erp-sql-bridge`
 * ship with.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BridgeSessionStore, handleBridgeRequest } from "./http-api.js";

/** Bodies are three short strings or a tool's arguments. A megabyte is already
 *  far more than any of that; the cap exists so a malformed caller cannot make
 *  this process buffer without bound. */
const MAX_BODY_BYTES = 1_000_000;

export interface BridgeServerOptions {
  serviceToken: string;
  store?: BridgeSessionStore;
  log?: (line: Record<string, unknown>) => void;
}

export function createBridgeServer(opts: BridgeServerOptions): Server {
  const store = opts.store ?? new BridgeSessionStore();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void serve(req, res, { serviceToken: opts.serviceToken, store, ...(opts.log ? { log: opts.log } : {}) });
  });
}

async function serve(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { serviceToken: string; store: BridgeSessionStore; log?: (l: Record<string, unknown>) => void },
): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    writeJson(res, 413, { error: { code: "INVALID_REQUEST", message: "Request body too large." } });
    return;
  }

  let body: unknown;
  if (raw.length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      writeJson(res, 400, { error: { code: "INVALID_REQUEST", message: "Body is not valid JSON." } });
      return;
    }
  }

  // Path only: no route reads the query string, and stripping it here means a
  // caller cannot smuggle one past the router's exact-match cases.
  const path = (req.url ?? "/").split("?")[0] ?? "/";
  const response = await handleBridgeRequest(
    {
      method: req.method ?? "GET",
      path,
      authorization: req.headers.authorization ?? null,
      body,
    },
    opts,
  );
  writeJson(res, response.status, response.body);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

/**
 * Container entry point.
 *
 * The token is read at boot and an EMPTY value is not an error here — the
 * process starts and every non-`/health` route answers 503, which is what makes
 * a failed secret injection visible on the healthcheck rather than a
 * crash-loop nobody can read. See `http-auth.ts`.
 */
export function main(): Server {
  const port = Number(process.env.MCP_BRIDGE_PORT ?? "9096");
  const serviceToken = (process.env.MCP_BRIDGE_SERVICE_TOKEN ?? "").trim();
  const server = createBridgeServer({
    serviceToken,
    log: (line) => process.stdout.write(`${JSON.stringify({ svc: "mcp-bridge", ...line })}\n`),
  });
  server.listen(port, "0.0.0.0", () => {
    process.stdout.write(
      `${JSON.stringify({
        svc: "mcp-bridge",
        msg: "listening",
        port,
        // Explicit, because "auth is off" must never be something an operator
        // has to infer from a 503 in someone else's log.
        authConfigured: serviceToken.length > 0,
      })}\n`,
    );
  });
  return server;
}

// `process.argv[1]` rather than `import.meta.url`: this workspace emits ES2022
// modules, but the same check has to keep working if the build target changes,
// and the Dockerfile's CMD is an absolute path to this file.
if (process.argv[1]?.endsWith("server.js")) {
  main();
}
