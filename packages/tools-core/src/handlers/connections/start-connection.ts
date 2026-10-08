/**
 * WARP-3904 — `start_connection` LLM tool.
 *
 * Asks the orchestrator how to add ONE service and returns a `connect_card`
 * descriptor: which fields the form shows, which safety chip it wears, where
 * the browser posts and what blocks it. `GET /api/connections/card?q=<text>`
 * resolves what the person said ("gmail", "stripe", "our mail server") to a
 * provider server-side.
 *
 * NOT a write, so no confirmation. The tool changes nothing: the person fills
 * the card in themselves and the BROWSER posts it to the same route the
 * Integrations hub uses, which enforces its own role guard and egress
 * allowlist. A key, password or token never passes through this tool, the
 * transcript or the model, in either direction. That is why:
 *   - the argument is only the NAME of a service, and a value shaped like a
 *     credential is refused before it can reach a URL or a log line;
 *   - the card is re-validated with `parseConnectCard`, which drops any card
 *     whose POST target is not on the allowlist or whose secret field arrives
 *     pre-filled. A card that fails is an error, never a half card.
 */
import { CONNECTION_PROVIDER_RE, parseConnectCard } from "@droplet/shared-types";
import type { Tool, ToolContext, ToolResult } from "../../types.js";
import { actingHeaders, fail, gate, httpFailure, isRecord, readJson } from "./_common.js";

const MAX_SERVICE_CHARS = 120;
const MAX_SUGGESTIONS = 8;

const inputSchema = {
  type: "object",
  properties: {
    service: {
      type: "string",
      description:
        'Service name only, such as "gmail" or "stripe"; at most 120 characters.',
    },
  },
  required: ["service"],
  additionalProperties: false,
} as const;

/** Key shapes that must never be sent as a "service name". */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /\b[srp]k_(?:live|test)_[A-Za-z0-9]{8,}/, // Stripe
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/, // Slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}/, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./, // JWT
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/**
 * Defence in depth, not the control: the tool description tells the model
 * never to ask for secrets. This catches a pasted key anyway, so it cannot end
 * up in an orchestrator access log as part of a query string.
 */
function looksLikeCredential(text: string): boolean {
  if (CREDENTIAL_SHAPES.some((re) => re.test(text))) return true;
  // One long unbroken token with letters and digits and no dot: key-shaped.
  // A hostname has dots, a service name has spaces or is short.
  return text
    .split(/\s+/)
    .some(
      (tok) =>
        tok.length >= 32 &&
        !tok.includes(".") &&
        /^[A-Za-z0-9_+/=-]+$/.test(tok) &&
        /\d/.test(tok) &&
        /[A-Za-z]/.test(tok),
    );
}

function suggestionsFrom(raw: unknown): Array<{ provider: string; displayName: string }> {
  if (!Array.isArray(raw)) return [];
  const out: Array<{ provider: string; displayName: string }> = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const { provider, displayName } = item;
    if (typeof provider !== "string" || !CONNECTION_PROVIDER_RE.test(provider)) continue;
    if (typeof displayName !== "string" || displayName.length === 0 || displayName.length > 120) continue;
    out.push({ provider, displayName });
    if (out.length >= MAX_SUGGESTIONS) break;
  }
  return out;
}

async function handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const refused = gate(ctx);
  if (refused) return refused;

  // Collapse whitespace and strip control characters: the value rides in a URL.
  const service =
    typeof args.service === "string"
      ? // eslint-disable-next-line no-control-regex
        args.service.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim()
      : "";
  if (service.length === 0) {
    return fail("INVALID_ARGS", 'service is required: the service as the person said it, such as "gmail" or "stripe"');
  }
  if (service.length > MAX_SERVICE_CHARS) {
    return fail("INVALID_ARGS", `service must be ${MAX_SERVICE_CHARS} characters or fewer`);
  }
  if (looksLikeCredential(service)) {
    return fail(
      "INVALID_ARGS",
      "service must be the name of a service, not a key, token or password. Never put credentials in chat; the connection card collects them.",
    );
  }

  const res = await ctx.http.orchestrator.get(
    `/api/connections/card?q=${encodeURIComponent(service)}`,
    { headers: actingHeaders(ctx) },
  );

  if (res.status === 404) {
    const body = await readJson(res);
    if (isRecord(body) && body.error === "unknown_provider") {
      return fail(
        "UNKNOWN_SERVICE",
        "No service matches that name. Ask the person which one they mean; the suggestions are the closest matches.",
        { suggestions: suggestionsFrom(body.suggestions) },
      );
    }
    // A 404 with no unknown_provider body is the route missing, not a bad name.
    return httpFailure(404, "CONNECT_CARD_FAILED", "Droplet could not prepare that connection right now");
  }
  if (res.status === 400) {
    return fail("INVALID_ARGS", "That service name was not understood. Ask the person which service they mean.");
  }
  if (!res.ok) {
    return httpFailure(res.status, "CONNECT_CARD_FAILED", "Droplet could not prepare that connection right now");
  }

  const body = await readJson(res);
  const card = parseConnectCard(isRecord(body) ? body.card : null);
  if (!card) {
    return fail("INTERNAL", "Droplet could not prepare that setup. Retry start_connection or show connections here in this chat.");
  }
  return { ok: true, data: card };
}

const tool: Tool = {
  name: "start_connection",
  description:
    "Prepare setup when asked to connect or add any service. NEVER request keys, passwords or tokens in chat; the setup form collects them.",
  inputSchema,
  requiresWrite: false,
  requiresConfirmation: false,
  handler,
};

export default tool;
