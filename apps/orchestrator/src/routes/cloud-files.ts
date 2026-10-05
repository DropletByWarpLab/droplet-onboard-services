/**
 * WARP-3538 (D13) — `GET /api/cloud-files`: ONE search over every cloud a person
 * has connected.
 *
 *   GET /api/cloud-files?q=&provider=&source=&modifiedSince=&limit=
 *     → 200 { items: [{ name, isFolder, provider, location, path, webUrl,
 *                       lastModifiedAt, lastModifiedBy, sizeBytes }], total }
 *
 * Their OneDrive, the SharePoint libraries Droplet reads for them and — as those
 * connectors land — Google Drive and Dropbox answer one question asked once, which
 * is why this is not an `/api/m365` route. A result carries `provider` (the wire
 * spelling, `m365`) and `location` (`"OneDrive"` or `"<site> › <library>"`). A file's
 * NAME, link and last modifier are sealed at rest and opened here, server-side
 * (`searchCloudFiles`); `sizeBytes` is a JSON number, exact below 2^53 bytes, which
 * no file approaches. Metadata only — there is no content to return.
 *
 * ## Whose files — and the assistant
 *
 * Every request is for exactly ONE person. There is no `:userId` and no identity in
 * the query; the query schema is strict, so a parameter that tries to name one is
 * refused, not ignored. A person in the browser is the session. The assistant's
 * `search_cloud_files` tool arrives as the `_service:mcp` principal
 * (`requireRoleOrMcpService`) and acts for the person named in
 * `X-Nextcloud-User` — resolved to ONE active person and checked against the same
 * tool-access rules chat applies (`toolActingUser`, WARP-3101). That helper answers
 * with a USERNAME, because calendars and reminders are keyed on it; the rows here
 * are keyed on `User.id`, so for the assistant the id is read off the person it
 * just resolved. A browser caller's header is ignored.
 *
 * ## Which clouds
 *
 * Only a cloud the person has CONNECTED is searched. Answering from a connection
 * that has died (NEEDS_RECONNECT, ERROR, a sign-in half done) would show names
 * the person may no longer be allowed to see, so that is a 409 like having
 * connected nothing: the tool tells them where to connect. A CONNECTED person
 * whose first read has not landed anything yet gets an empty list, not an error.
 * Each connector adds its own "is it connected" check here as it lands.
 *
 * ## Answers the tool reads (tools-core `search_cloud_files`)
 *
 *   400 invalid_request       `details.fieldErrors` names the fields (zod, as the
 *                             calendar and reminder routes answer)
 *   400 search_too_broad      more files than one search will open: narrow it. A 400
 *                             on purpose — the tool reports it as an argument the
 *                             model can fix, not as an outage to retry
 *   403 acting_user_required / forbidden_tool_for_role   the assistant's acting
 *                             person could not be resolved, or may not use the tool
 *   409 cloud_not_connected   nothing connected to search
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { CloudFileProvider, PrismaClient } from "@prisma/client";

import { requireRoleOrMcpService } from "../middleware/auth.js";
import { MCP_PRINCIPAL_ID } from "../middleware/mcp-acting-user-gate.js";
import { standardRateLimit } from "../middleware/rate-limit.js";
import { createLogger } from "../lib/logger.js";
import {
  CLOUD_FILE_WIRE_PROVIDERS,
  providerFromWire,
} from "../services/cloud-files/cloud-file-provider.js";
import {
  CloudFileSearchTooLargeError,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  searchCloudFiles,
} from "../services/cloud-files/cloud-file-search.service.js";
import {
  sendToolActingUserDenial,
  toolActingUser,
  type RouteTools,
} from "../services/tool-acting-user.service.js";

const logger = createLogger("cloud-files-route");

/**
 * The routes the assistant's tools call (tools-core TOOL_ROUTES), and the tools each
 * serves. Only on these does `_service:mcp` act for the person it names; the person
 * must be allowed EVERY tool the route serves.
 */
export const CLOUD_FILES_TOOL_ROUTES = {
  "get /api/cloud-files": ["search_cloud_files"],
} as const satisfies Record<string, RouteTools>;

/** Everyone who can connect a cloud may search what it landed. Guests cannot connect one. */
const CLOUD_FILES_ROLES = ["owner", "admin", "family"] as const;

/** The longest text filter. A file, site or library name is far shorter; past this it is not a name. */
const MAX_FILTER_CHARS = 200;

/** A client that has nothing to filter by may send the parameter empty: that is no filter. */
const blankIsAbsent = (value: unknown) => (value === "" ? undefined : value);

const text = z.preprocess(
  blankIsAbsent,
  z
    .string()
    .trim()
    .max(MAX_FILTER_CHARS)
    .transform((v) => (v === "" ? undefined : v))
    .optional(),
);

/**
 * An ISO 8601 date (`2026-10-01`) or timestamp (`2026-10-01T14:03:00Z`, with a
 * fraction or an offset). Both mean a moment; a date alone is its midnight in UTC.
 * A date that does not exist (`2026-02-30`, a month 13) is refused: `Date.parse`
 * alone would roll some of those over into the next month and search from a day
 * nobody asked for.
 */
function momentOf(raw: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dateOnly) {
    const [, y, m, d] = dateOnly.map(Number) as [number, number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? date : null;
  }
  if (!z.string().datetime({ offset: true }).safeParse(raw).success) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * The query, STRICT: a key this route does not know is refused rather than ignored.
 * A stale client that still sends the old Microsoft-only `site` or `library` filters
 * must hear that they do nothing — silently dropping them would answer with files
 * the person asked NOT to see.
 *
 * Every value is a single string (`?q=a&q=b` arrives as an array and is refused).
 */
const querySchema = z
  .object({
    q: text,
    // Exact wire spelling, no case folding: the set is closed and tiny, and a lenient
    // parser is a second spelling every consumer has to keep accepting.
    provider: z.preprocess(blankIsAbsent, z.enum(CLOUD_FILE_WIRE_PROVIDERS as [string, ...string[]]).optional()),
    source: text,
    modifiedSince: z.preprocess(
      blankIsAbsent,
      z
        .string()
        .refine((v) => momentOf(v) !== null, "must be an ISO 8601 date or timestamp")
        .transform((v) => momentOf(v)!)
        .optional(),
    ),
    limit: z.preprocess(
      blankIsAbsent,
      z
        .string()
        .regex(/^\d{1,4}$/, "must be a whole number")
        .transform(Number)
        .pipe(z.number().min(1).max(MAX_SEARCH_LIMIT))
        .optional(),
    ),
  })
  .strict();

/**
 * The person whose files these are, as a `User.id` — or null when it cannot be told.
 *
 * `toolActingUser` has already decided WHO (and whether they may use the tool) and
 * names them by username. A browser caller's id is on the request. For the assistant
 * it is read off the person it resolved a moment ago: usernames are unique, so this
 * names that one person.
 */
async function actingUserId(prisma: PrismaClient, req: Request, username: string): Promise<string | null> {
  const isAssistant = req.user?.id === MCP_PRINCIPAL_ID && req.user.role === "service";
  if (!isAssistant) return req.user?.id ?? null;
  const row = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return row?.id ?? null;
}

/**
 * The clouds this person has CONNECTED — the only ones whose files are searched.
 * Microsoft 365 today; each later connector adds its own check.
 */
async function connectedProviders(prisma: PrismaClient, userId: string): Promise<CloudFileProvider[]> {
  const connected: CloudFileProvider[] = [];
  const m365 = await prisma.m365Connection.findUnique({ where: { userId }, select: { state: true } });
  if (m365?.state === "CONNECTED") connected.push("M365");
  return connected;
}

export function createCloudFilesRouter(prisma: PrismaClient): Router {
  const router = Router();

  router.get(
    "/cloud-files",
    // CodeQL js/missing-rate-limiting — a search can open tens of thousands of
    // sealed names; routine authorised read, standard preset.
    standardRateLimit,
    requireRoleOrMcpService(...CLOUD_FILES_ROLES),
    async (req, res) => {
      const query = querySchema.safeParse(req.query);
      if (!query.success) {
        return res.status(400).json({ error: "invalid_request", details: query.error.flatten() });
      }

      try {
        const person = await toolActingUser(prisma, req, CLOUD_FILES_TOOL_ROUTES["get /api/cloud-files"]);
        if (!person.ok) return void sendToolActingUserDenial(res, person);
        const userId = await actingUserId(prisma, req, person.username);
        if (!userId) return res.status(403).json({ error: "acting_user_required" });

        const connected = await connectedProviders(prisma, userId);
        if (connected.length === 0) {
          return res.status(409).json({
            error: "cloud_not_connected",
            message: "No cloud drive is connected. Connect Microsoft 365 in Settings to search your OneDrive and SharePoint files.",
          });
        }

        // A provider asked for is narrowed to the ones connected; asking for one
        // that is not connected searches nothing (never "every cloud").
        const wanted = query.data.provider === undefined ? undefined : providerFromWire(query.data.provider);
        const providers = wanted === undefined ? connected : connected.filter((p) => p === wanted);

        const result = await searchCloudFiles(prisma, {
          userId,
          providers,
          query: query.data.q,
          source: query.data.source,
          modifiedSince: query.data.modifiedSince,
          limit: query.data.limit ?? DEFAULT_SEARCH_LIMIT,
        });
        return res.json({ items: result.items, total: result.total });
      } catch (err) {
        if (err instanceof CloudFileSearchTooLargeError) {
          return res.status(400).json({ error: "search_too_broad", message: err.message });
        }
        // Answered rather than left to hang, and logged here, never echoed: a
        // database error names hosts and queries.
        logger.error({ err }, "cloud files search failed");
        return res.status(500).json({ error: "cloud_files_unavailable" });
      }
    },
  );

  return router;
}
