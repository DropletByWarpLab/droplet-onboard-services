import http from "node:http";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { verifyJwt, type Claims } from "../auth/jwt.js";

export interface HttpServerOptions {
  /** TCP port to bind. Use `0` to let the OS pick a free port (used in tests). */
  port: number;
  /** Optional bind address. Defaults to all interfaces. */
  host?: string;
  /** HS256 secret used to verify Bearer JWTs. */
  jwtSecret: string;
  /**
   * Factory that builds a fresh MCP `Server` for the given claims. Called
   * per-request so the server's RBAC sees the right role for each caller.
   * The mcp-server's `createServer` already accepts `claims` and feeds it
   * into the `ToolContext`.
   */
  buildServer: (claims: Claims | undefined) => Server;
}

const HEALTH_PATH = "/health";

/**
 * Streamable-HTTP transport. JWT-gated. Spec §5.2 + §7.2.
 *
 * Request flow:
 *   1. `GET /health` → 200 (no auth, for Compose healthcheck)
 *   2. Anything else without `Authorization: Bearer <jwt>` → 401
 *   3. JWT verify against `JWT_SECRET`. Failure → 401 with reason.
 *   4. Build a fresh per-request MCP `Server` carrying the verified
 *      claims; connect it to a stateless `StreamableHTTPServerTransport`;
 *      delegate the request.
 *
 * Stateless mode (sessionIdGenerator: undefined) keeps the v1 surface
 * simple: tools/list and tools/call are idempotent enough that we don't
 * need a long-lived session to cache anything between calls. If a future
 * MCP feature (resources, sampling) needs sessions, switch to stateful
 * mode and key the session map by `Mcp-Session-Id`.
 */
export function startHttp(opts: HttpServerOptions): http.Server {
  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://placeholder");
      if (url.pathname === HEALTH_PATH) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      // Spec §12 (WARP-103): "Reject missing/invalid/expired tokens with
      // MCP `Unauthorized` error (return HTTP 401 with a JSON body before
      // the MCP layer sees the request)." So we 401 here without ever
      // constructing the MCP transport.
      const auth = req.headers.authorization;
      if (!auth || !auth.startsWith("Bearer ")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "missing_bearer_token" }));
        return;
      }

      let claims: Claims;
      try {
        claims = verifyJwt(auth.slice("Bearer ".length).trim(), opts.jwtSecret);
      } catch (err) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "invalid_token",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
        return;
      }

      const server = opts.buildServer(claims);
      const transport = new StreamableHTTPServerTransport({
        // Stateless: no session ID, no in-memory connection bookkeeping.
        sessionIdGenerator: undefined,
      });
      // The transport closes when the request completes; we explicitly
      // close the per-request Server too so its onclose hooks fire and
      // there's no surprise leak.
      res.on("close", () => {
        void server.close().catch(() => {});
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (err) {
      // Last-resort guard. The SDK's transport.handleRequest is supposed to
      // own the response, but if it throws before writing headers we still
      // need to send something — otherwise the client hangs.
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error: "internal_error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      } else {
        try {
          res.end();
        } catch {
          // already destroyed; nothing to do
        }
      }
    }
  });
  httpServer.listen(opts.port, opts.host);
  return httpServer;
}
