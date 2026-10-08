/**
 * WARP-3904 — connect from chat: the three routes behind the Ask AI tools
 * `list_connections`, `start_connection` and `disconnect_connection`.
 *
 *   GET  /api/connections
 *        -> ConnectionsOverview: what is connected across the five families
 *           (Google, Microsoft 365, mailbox, calendar feed, catalog provider)
 *           in ONE status vocabulary, plus what could be added. Box-wide rows
 *           are owner/admin only; everyone else sees their own.
 *
 *   GET  /api/connections/card?q=<text>
 *        -> { card: ConnectCard } describing how to add what `q` names, or
 *           404 { error: "unknown_provider", suggestions }. A card is a
 *           descriptor: the browser posts the form straight to the EXISTING
 *           route (the hub's, Settings'), which keeps its own role guard and
 *           egress allowlist. This route takes no credential and writes nothing.
 *
 *   POST /api/connections/disconnect   { id } | { provider }
 *        -> { disconnected: ConnectionDisconnected }. Dispatches to the same
 *           code each family's own DELETE uses, with the same audit record.
 *           Catalog providers keep their synced records (ADR-041: tokens are
 *           purged, landed data persists). The chat asks the person to approve
 *           before it calls this.
 *
 * ## Whose connection is it
 *
 * Browser sessions act as themselves. The tools-core handlers reach these
 * routes as the trusted `_service:mcp` principal and name the person in
 * `X-Droplet-User` (a username over stdio, a `User.id` over HTTP). That header
 * is honoured for that one principal ONLY, resolved by `resolveAssertedUser`
 * (nobody, two people, or a deactivated one fail closed), and the person's own
 * canonical role then drives every decision — the same posture as
 * `GET /api/email/accounts`. For anyone else the header is ignored.
 *
 * No response here carries a token, key, host password, ciphertext or a
 * vendor's raw error: statuses are mapped to short fixed lines in the services.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  CONNECTION_FAMILIES,
  CONNECTION_PROVIDER_RE,
  parseConnectCard,
  type ConnectionDisconnected,
  type ConnectionFamily,
} from "@droplet/shared-types";
import { requireRoleOrMcpService } from "../middleware/auth.js";
import { sensitiveRateLimit, standardRateLimit } from "../middleware/rate-limit.js";
import { createLogger } from "../lib/logger.js";
import { trustedOriginUrl } from "../lib/trusted-origin.js";
import { resolveAssertedUser } from "../services/asserted-user.service.js";
import type { ActivityActor } from "../services/activity.service.js";
import { credentialsPurgedFor } from "../services/integration-status.js";
import { ErpError } from "../services/erp-error.js";
import { isConcurrencyConflict } from "../services/role-mutation-guard.service.js";
import { createIntegrationsService, type IntegrationsServiceDeps } from "../services/integrations.service.js";
import { deleteSource } from "../services/calendar.service.js";
import { disconnectMailbox } from "../services/email/provision.service.js";
import { auditMailboxDisconnected } from "../services/email/mailbox-audit.js";
import { disconnectGoogle, googleDependencies, getGoogleConnectionView, type GoogleDependencies } from "../services/google/google-auth.service.js";
import { disconnect as disconnectM365, getConnectionView as getM365ConnectionView } from "../services/m365/m365-auth.service.js";
import {
  BOX_CONNECT_ROLES,
  CALENDAR_FEED_AUTH_MODES,
  PERSONAL_CONNECT_ROLES,
  buildConnectionsOverview,
} from "../services/connections-overview.service.js";
import {
  buildConnectCard,
  connectionDisplayName,
  defaultConnectionSuggestions,
  resolveConnectionProvider,
  suggestConnectionProviders,
  type ConnectCardDeps,
  type ConnectionTarget,
} from "../services/connect-card.service.js";
import { GOOGLE_CALLBACK_PATH } from "./google.js";

const logger = createLogger("connections-route");

/** The longest `q` the card route reads; a provider name is never near this. */
const MAX_QUERY_LENGTH = 120;
const MCP_PRINCIPAL_ID = "_service:mcp";

/** Roles that may ask what is connected. A guest gets an empty overview, not an error. */
const OVERVIEW_ROLES = ["owner", "admin", "family", "guest"] as const;
const WRITE_ROLES = ["owner", "admin", "family"] as const;

export interface ConnectionsRouterDeps {
  /** Same seam as `createIntegrationsRouter`: the remote MCP teardown an `mcp` track's disconnect needs. */
  integrations?: IntegrationsServiceDeps;
  google?: Partial<GoogleDependencies>;
  card?: Partial<ConnectCardDeps>;
}

interface ActingPerson {
  id: string;
  username: string;
  role: string;
  /** True when a tool acted for them through the `_service:mcp` principal. */
  viaAssistant: boolean;
}

type Acting = { ok: true; person: ActingPerson } | { ok: false; status: number; error: string };

/** Same test `routes/email.ts` uses: the pinned MCP principal, by id AND role. */
function isMcpService(req: Request): boolean {
  return req.user?.id === MCP_PRINCIPAL_ID && req.user.role === "service";
}

/**
 * The person a request acts for. Only the MCP service principal may name one,
 * by `X-Droplet-User`; for every other caller the header is ignored and the
 * session's own identity rules. Fails closed: no header -> 401, unresolved,
 * ambiguous or deactivated person -> 403, a role the route does not serve -> 403.
 */
async function actingPerson(prisma: PrismaClient, req: Request, allowedRoles: readonly string[]): Promise<Acting> {
  if (isMcpService(req)) {
    const asserted = (req.header("x-droplet-user") ?? "").trim();
    if (!asserted) return { ok: false, status: 401, error: "x_droplet_user_required" };
    const resolved = await resolveAssertedUser(prisma, asserted);
    if (!resolved.ok) return { ok: false, status: 403, error: "acting_user_unavailable" };
    const { id, username, role } = resolved.user;
    // The route's HUMAN role set, so the tool path can never widen it.
    if (!allowedRoles.includes(role)) return { ok: false, status: 403, error: "forbidden" };
    return { ok: true, person: { id, username, role, viaAssistant: true } };
  }
  const user = req.user;
  if (!user?.id || !user.username || !user.role) return { ok: false, status: 401, error: "unauthenticated" };
  if (!allowedRoles.includes(user.role)) return { ok: false, status: 403, error: "forbidden" };
  return { ok: true, person: { id: user.id, username: user.username, role: user.role, viaAssistant: false } };
}

const disconnectBody = z
  .object({
    id: z.string().min(1).max(160).optional(),
    provider: z.string().min(1).max(MAX_QUERY_LENGTH).optional(),
  })
  .strict()
  .refine((body) => (body.id === undefined) !== (body.provider === undefined), { message: "exactly one of id or provider" });

/** A connection to remove: its family, its provider key, and the record id when the family has many. */
interface DisconnectRef extends ConnectionTarget {
  recordId?: string;
}

const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** `google:me` · `m365:me` · `mailbox:<accountId>` · `calendar:<sourceId>` · `integration:<provider>`. */
function refFromId(id: string): DisconnectRef | null {
  const at = id.indexOf(":");
  if (at < 1) return null;
  const family = id.slice(0, at);
  const rest = id.slice(at + 1);
  if (!(CONNECTION_FAMILIES as readonly string[]).includes(family)) return null;
  switch (family as ConnectionFamily) {
    case "google":
      return rest === "me" ? { family: "google", provider: "google" } : null;
    case "m365":
      return rest === "me" ? { family: "m365", provider: "m365" } : null;
    case "mailbox":
      return RECORD_ID_RE.test(rest) ? { family: "mailbox", provider: "mailbox", recordId: rest } : null;
    case "calendar":
      return RECORD_ID_RE.test(rest) ? { family: "calendar", provider: "calendar", recordId: rest } : null;
    case "integration":
      return CONNECTION_PROVIDER_RE.test(rest) ? { family: "integration", provider: rest } : null;
  }
}

function disconnected(family: ConnectionFamily, provider: string, displayName: string): ConnectionDisconnected {
  return { kind: "connection_disconnected", provider, family, displayName };
}

function failureStatus(res: Response, err: unknown): Response {
  if (err instanceof ErpError) return res.status(err.status).json(err.toJSON());
  // Same mapping as the integrations router: a lost SERIALIZABLE race applied nothing.
  if (isConcurrencyConflict(err)) return res.status(409).json({ error: "concurrent_mutation" });
  logger.error({ errorType: err instanceof Error ? err.name : "unknown" }, "connection disconnect failed");
  return res.status(503).json({ error: "disconnect_failed" });
}

export function createConnectionsRouter(prisma: PrismaClient, deps: ConnectionsRouterDeps = {}): Router {
  const router = Router();
  const integrations = createIntegrationsService(prisma, deps.integrations ?? {});

  router.use("/connections", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  router.get("/connections", standardRateLimit, requireRoleOrMcpService(...OVERVIEW_ROLES), async (req, res) => {
    const acting = await actingPerson(prisma, req, OVERVIEW_ROLES).catch(() => null);
    if (!acting) return res.status(503).json({ error: "connections_unavailable" });
    if (!acting.ok) return res.status(acting.status).json({ error: acting.error });
    try {
      return res.json(await buildConnectionsOverview(prisma, acting.person));
    } catch (err) {
      logger.error({ errorType: err instanceof Error ? err.name : "unknown" }, "connections overview failed");
      return res.status(503).json({ error: "connections_unavailable" });
    }
  });

  router.get("/connections/card", standardRateLimit, requireRoleOrMcpService(...WRITE_ROLES), async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q.length === 0 || q.length > MAX_QUERY_LENGTH) return res.status(400).json({ error: "invalid_request" });
    const acting = await actingPerson(prisma, req, WRITE_ROLES).catch(() => null);
    if (!acting) return res.status(503).json({ error: "connections_unavailable" });
    if (!acting.ok) return res.status(acting.status).json({ error: acting.error });

    const target = resolveConnectionProvider(q);
    if (!target) {
      const close = suggestConnectionProviders(q);
      return res.status(404).json({ error: "unknown_provider", suggestions: close.length > 0 ? close : defaultConnectionSuggestions() });
    }
    try {
      const cardDeps: Partial<ConnectCardDeps> = { ...deps.card };
      if (target.family === "google" && cardDeps.googleRedirectUri === undefined) {
        cardDeps.googleRedirectUri = await trustedOriginUrl(req, GOOGLE_CALLBACK_PATH);
      }
      const card = await buildConnectCard(prisma, acting.person, target, cardDeps);
      // What reaches the browser has passed the same allowlist the dashboard
      // applies: a descriptor that would let a form post elsewhere never leaves.
      const checked = parseConnectCard(card);
      if (!checked) {
        logger.error({ provider: target.provider }, "connect card failed validation");
        return res.status(500).json({ error: "card_unavailable" });
      }
      return res.json({ card: checked });
    } catch (err) {
      logger.error({ errorType: err instanceof Error ? err.name : "unknown", provider: target.provider }, "connect card failed");
      return res.status(503).json({ error: "connections_unavailable" });
    }
  });

  router.post("/connections/disconnect", sensitiveRateLimit, requireRoleOrMcpService(...WRITE_ROLES), async (req, res) => {
    const body = disconnectBody.safeParse(req.body ?? {});
    if (!body.success) return res.status(400).json({ error: "invalid_request" });
    const acting = await actingPerson(prisma, req, WRITE_ROLES).catch(() => null);
    if (!acting) return res.status(503).json({ error: "connections_unavailable" });
    if (!acting.ok) return res.status(acting.status).json({ error: acting.error });
    const { person } = acting;

    let ref: DisconnectRef | null;
    if (body.data.id !== undefined) {
      ref = refFromId(body.data.id);
      if (!ref) return res.status(400).json({ error: "invalid_request" });
    } else {
      ref = resolveConnectionProvider(body.data.provider ?? "");
      if (!ref) {
        const close = suggestConnectionProviders(body.data.provider ?? "");
        return res.status(404).json({ error: "unknown_provider", suggestions: close.length > 0 ? close : defaultConnectionSuggestions() });
      }
    }

    // Personal connections are the requester's own; box-wide ones are an admin's call.
    const allowed = ref.family === "mailbox" || ref.family === "integration" ? BOX_CONNECT_ROLES : PERSONAL_CONNECT_ROLES;
    if (!allowed.includes(person.role)) return res.status(403).json({ error: "forbidden" });

    const auditActor: ActivityActor = { type: person.viaAssistant ? "ai" : "user", id: person.id };

    try {
      switch (ref.family) {
        case "google": {
          const view = await getGoogleConnectionView(prisma, person.id);
          if (view.state === "DISCONNECTED") return res.status(404).json({ error: "connection_not_found" });
          await disconnectGoogle(prisma, person.id, googleDependencies(deps.google));
          return res.json({ disconnected: disconnected("google", "google", connectionDisplayName(ref)) });
        }
        case "m365": {
          const view = await getM365ConnectionView(prisma, person.id);
          if (view.state === "DISCONNECTED") return res.status(404).json({ error: "connection_not_found" });
          await disconnectM365(prisma, person.id);
          return res.json({ disconnected: disconnected("m365", "m365", connectionDisplayName(ref)) });
        }
        case "mailbox": {
          let accountId = ref.recordId;
          if (!accountId) {
            const accounts = await prisma.emailAccount.findMany({ where: { authMode: "PASSWORD" }, select: { id: true }, take: 2 });
            if (accounts.length === 0) return res.status(404).json({ error: "connection_not_found" });
            if (accounts.length > 1) return res.status(409).json({ error: "ambiguous_connection" });
            accountId = accounts[0].id;
          }
          // Google / Microsoft mailboxes are removed with their account, not as a "mailbox".
          const account = await prisma.emailAccount.findUnique({ where: { id: accountId }, select: { authMode: true } });
          if (!account || account.authMode !== "PASSWORD") return res.status(404).json({ error: "connection_not_found" });
          const { removed, address } = await disconnectMailbox(prisma, accountId);
          if (!removed) return res.status(404).json({ error: "connection_not_found" });
          // The mailbox is already gone; a failed audit write must not report a false failure.
          await auditMailboxDisconnected({ actor: auditActor, accountId, address }).catch((err) =>
            logger.warn({ errorType: err instanceof Error ? err.name : "unknown", accountId }, "mailbox disconnect audit failed"),
          );
          return res.json({ disconnected: disconnected("mailbox", "mailbox", address ?? connectionDisplayName(ref)) });
        }
        case "calendar": {
          let sourceId = ref.recordId;
          const feedModes = [...CALENDAR_FEED_AUTH_MODES];
          if (!sourceId) {
            const sources = await prisma.calendarSource.findMany({
              where: { userId: person.username, authMode: { in: feedModes } },
              select: { id: true },
              take: 2,
            });
            if (sources.length === 0) return res.status(404).json({ error: "connection_not_found" });
            if (sources.length > 1) return res.status(409).json({ error: "ambiguous_connection" });
            sourceId = sources[0].id;
          }
          // Calendar sources are keyed on the username; a source that is not
          // this person's, or belongs to Google / Microsoft, is "not found".
          const source = await prisma.calendarSource.findUnique({ where: { id: sourceId }, select: { userId: true, authMode: true, name: true } });
          if (!source || source.userId !== person.username || !(feedModes as string[]).includes(source.authMode)) {
            return res.status(404).json({ error: "connection_not_found" });
          }
          try {
            await deleteSource(prisma, person.username, sourceId);
          } catch (err) {
            const message = err instanceof Error ? err.message : "";
            if (message === "source_not_found" || message === "forbidden") return res.status(404).json({ error: "connection_not_found" });
            throw err;
          }
          return res.json({ disconnected: disconnected("calendar", "calendar", source.name) });
        }
        case "integration": {
          const row = await prisma.integrationConnection.findFirst({
            where: { provider: ref.provider },
            select: { status: true, apiCredentialsEnc: true, providerTokensEnc: true },
          });
          // A row whose credentials are already purged is a connection that is already gone.
          if (!row || credentialsPurgedFor(row)) return res.status(404).json({ error: "connection_not_found" });
          // ADR-041: tokens are purged, what the connector already landed stays.
          await integrations.disconnect({ actor: person.id }, ref.provider, { records: "keep" });
          return res.json({ disconnected: disconnected("integration", ref.provider, connectionDisplayName(ref)) });
        }
      }
    } catch (err) {
      return failureStatus(res, err);
    }
  });

  return router;
}
