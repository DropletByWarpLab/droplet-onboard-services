import { Server as HttpServer, IncomingMessage } from "node:http";
import { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import {
  SESSION_COOKIE_NAME,
  validateTokenForWs,
  type AuthUser,
} from "../middleware/auth.js";
import { subscribeToTopic } from "./mqtt.service.js";
import { createLogger } from "../lib/logger.js";

/** Minimal RFC 6265 cookie header parser — we only need name/value lookups. */
function parseCookieHeader(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of header.split(";")) {
    const eq = raw.indexOf("=");
    if (eq < 0) continue;
    const name = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

const logger = createLogger("ws-bridge");

const WS_PATH = "/api/ws/events";

/**
 * Attach a WebSocket bridge that forwards MQTT events to authenticated
 * browser sessions. Each connection subscribes only to its own user-scoped
 * topics, so user B can't see user A's file events even if they share
 * the same Droplet box.
 *
 * Protocol: the server sends JSON text frames in the shape
 *   `{ topic: "droplet/files/alice/uploaded", payload: { ... } }`
 * plus a keepalive ping every 25s. The client should drop the connection
 * and reconnect with exponential backoff on close.
 */
export function attachWsBridge(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket: Duplex, head) => {
    if (!req.url || !req.url.startsWith(WS_PATH)) {
      // This is currently the only upgrade endpoint on the orchestrator,
      // so reject any other path outright instead of leaving the socket
      // hanging for a non-existent listener to pick up.
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    try {
      const cookieHeader = req.headers.cookie ?? "";
      const cookies = parseCookieHeader(cookieHeader);
      const cookieToken = cookies[SESSION_COOKIE_NAME] ?? null;
      // Also accept a Bearer token via the standard Sec-WebSocket-Protocol
      // escape hatch: browsers can't set arbitrary headers on ws://, so we
      // let mobile/desktop clients pass the token as a subprotocol value.
      const protocolHeader = req.headers["sec-websocket-protocol"];
      const bearerFromProtocol =
        typeof protocolHeader === "string" && protocolHeader.startsWith("bearer.")
          ? protocolHeader.slice("bearer.".length)
          : null;

      const token = cookieToken ?? bearerFromProtocol;
      const user = await validateTokenForWs(token);
      if (!user) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, user);
      });
    } catch (err) {
      logger.warn({ err }, "WebSocket upgrade failed");
      try {
        socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      } catch {
        // socket may already be dead
      }
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, user: AuthUser) => {
    logger.info({ user: user.username }, "WebSocket client connected");

    // Subscribe this connection to everything under droplet/{area}/{user}/#
    const topics = [
      `droplet/files/${user.username}/#`,
      `droplet/devices/${user.username}/#`,
      `droplet/index/${user.username}/#`,
      // Calendar/reminder/system toast notifications (PR #2). The
      // notifications service publishes here from sendNotification().
      `droplet/notifications/${user.username}`,
      // WARP-329: chat turn-completed events. The orchestrator's
      // /api/llm/chat publishes `droplet/chat/<user>/turn-completed`
      // when an in-flight LLM response finishes, so a background tab
      // can fire a browser notification (or, in the future, a mobile
      // push when a push-dispatcher subscribes to the same topic).
      `droplet/chat/${user.username}/#`,
    ];

    const unsubscribes = topics.map((t) =>
      subscribeToTopic(t, (topic, payload) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        try {
          ws.send(JSON.stringify({ topic, payload }));
        } catch (err) {
          logger.warn({ err, topic }, "Failed to forward MQTT message");
        }
      })
    );

    // Keepalive: ping every 25s. The client doesn't need to respond — pings
    // are fire-and-forget at the ws protocol level and keep middleboxes
    // from silently closing idle connections.
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // ignore
        }
      }
    }, 25_000);

    const cleanup = () => {
      clearInterval(keepalive);
      for (const unsubscribe of unsubscribes) {
        try {
          unsubscribe();
        } catch (err) {
          logger.warn({ err }, "Unsubscribe failed on close");
        }
      }
      logger.debug({ user: user.username }, "WebSocket client disconnected");
    };

    ws.on("close", cleanup);
    ws.on("error", (err) => {
      logger.warn({ err, user: user.username }, "WebSocket error");
      cleanup();
    });
  });

  return wss;
}
