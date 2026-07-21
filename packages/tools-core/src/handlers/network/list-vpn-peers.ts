/**
 * WARP-1443 — `list_vpn_peers` LLM tool.
 *
 * Read-only WireGuard peer listing via the orchestrator's
 * `GET /api/vpn/peers` (routes/vpn.ts). The route's Prisma select
 * already excludes private keys (a peer's private key exists in the
 * POST response exactly once and is never stored), but this handler
 * additionally strips ANY key-looking field from every peer before it
 * can reach the model — belt and braces against a future route change.
 * That filter intentionally also drops `publicKey`: it isn't secret,
 * but chat identifies peers by id/deviceLabel and a base64 key blob is
 * pure noise-with-risk in an LLM transcript.
 *
 * Creating or revoking peers from chat is WARP-1444 (not yet
 * available) — the description points the model at the dashboard.
 * Tier-1 read — no writes, no confirmation.
 */
import type { Tool, ToolContext, ToolResult } from "../../types.js";

/**
 * Field names that must never surface: WireGuard keys (private, public,
 * preshared/psk), secrets/tokens/passwords, and the rendered `conf`
 * (which embeds the private key).
 */
const KEY_LIKE_RE = /key|secret|token|psk|password|conf/i;

const inputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

function vpnUnavailable(detail: string): ToolResult {
  return {
    ok: false,
    status: "error",
    error: {
      code: "VPN_UNAVAILABLE",
      message: `VPN peer list is not available — ${detail}`,
    },
  };
}

async function handler(
  _args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  let rawPeers: Array<Record<string, unknown>>;
  try {
    const res = await ctx.http.orchestrator.get("/api/vpn/peers", {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      return vpnUnavailable(`orchestrator returned ${res.status}`);
    }
    const payload = (await res.json()) as { peers?: unknown };
    if (!Array.isArray(payload.peers)) {
      return vpnUnavailable("orchestrator returned an unexpected shape");
    }
    rawPeers = payload.peers as Array<Record<string, unknown>>;
  } catch {
    return vpnUnavailable("orchestrator not reachable");
  }

  const peers = rawPeers.map((p) =>
    Object.fromEntries(
      Object.entries(p).filter(([field]) => !KEY_LIKE_RE.test(field)),
    ),
  );

  return {
    ok: true,
    data: {
      type: "list_vpn_peers",
      peers,
      count: peers.length,
    },
  };
}

const tool: Tool = {
  name: "list_vpn_peers",
  description:
    "List the WireGuard remote-access (VPN) peers: device label, owner, assigned IP, active/revoked status, home/away mode, and creation time. Never returns key material. Creating or revoking peers from chat is not available yet (WARP-1444) — direct the user to the dashboard's Remote Access page for that. Tier-1 read; safe to call without operator confirmation.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
