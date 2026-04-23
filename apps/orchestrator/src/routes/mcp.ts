/**
 * /api/mcp/* — Model Context Protocol HTTP endpoints.
 *
 *   POST /api/mcp/jsonrpc  — JSON-RPC 2.0 over HTTP. Accepts initialize,
 *                            tools/list, tools/call, ping. The MCP spec
 *                            also defines an SSE transport; we ship the
 *                            HTTP-only subset in v1 because every MCP
 *                            client we care about (Claude Desktop, Continue,
 *                            etc.) supports it.
 *   GET  /api/mcp/health   — readiness probe
 *
 * Auth: same session/Bearer token as the rest of the protected API
 * (mounted behind authMiddleware in app.ts). The role gate from
 * routes/llm.ts is mirrored here — non-owner/admin callers cannot see
 * or invoke write tools regardless of which transport they use.
 */

import { Router, type Request } from "express";
import type { PrismaClient } from "@prisma/client";
import { handleMcpMessage } from "../services/mcp-server.js";
import { TOOL_REGISTRY } from "../services/llm-tools.js";
import { resolveNcToken } from "../services/nextcloud-session.service.js";

// MUST stay in sync with routes/llm.ts WRITE_TOOLS. Duplicated rather than
// imported to avoid a circular dep between routes/mcp.ts and routes/llm.ts.
const WRITE_TOOLS = new Set([
  "block_device",
  "unblock_device",
  "accept_discovered_camera",
  "scan_for_cameras",
]);

function getUser(req: Request): { username?: string; role?: string } {
  const u = (req as { user?: { username: string; role?: string } }).user;
  return { username: u?.username, role: u?.role };
}

export function createMcpRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get("/mcp/health", (_req, res) => {
    res.json({
      status: "ok",
      protocol: "mcp/2025-03-26",
      tool_count: Object.keys(TOOL_REGISTRY).length,
    });
  });

  router.post("/mcp/jsonrpc", async (req, res, next) => {
    try {
      const { username, role } = getUser(req);
      const isPrivileged = role === "owner" || role === "admin";
      const allowedTools = new Set(
        Object.keys(TOOL_REGISTRY).filter(
          (n) => isPrivileged || !WRITE_TOOLS.has(n),
        ),
      );
      const ncToken = (await resolveNcToken(req).catch(() => null)) ?? undefined;

      const result = await handleMcpMessage(req.body, {
        prisma,
        userId: username,
        ncToken,
        allowedTools,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
