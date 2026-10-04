/**
 * /api/calendar/* — events, sources, ICS publish.
 *
 * Identity: every endpoint reads the username from req.user (populated by
 * the auth middleware). Mutating endpoints rely on calendar.service.ts to
 * enforce ownership (`existing.userId !== userId → forbidden`).
 *
 * WARP-3101 — the four event routes are also the assistant's calendar tools
 * (CALENDAR_TOOL_ROUTES). Called as `_service:mcp`, they act for the person
 * named in `X-Nextcloud-User` and key the rows on THAT person's username
 * (services/tool-acting-user.service.ts). The tools used to read and write
 * CalendarEvent themselves, by `ctx.userId` — a User.id on the mcp-server's
 * HTTP transport, which matches no row here.
 *
 * The publish endpoint is special: it serves an ICS feed at
 * `/api/calendar/publish/:user.ics?token=...` and is NOT behind auth so
 * phones can `webcal://` subscribe. Access is gated by a stored, per-user,
 * expiring token (WARP-2767, services/calendar-feed-token.service.ts) that
 * the owner can rotate (POST /calendar/publish/rotate) or turn off
 * (POST /calendar/publish/revoke).
 *
 * WARP-3533 — the same mechanism serves two work-item feeds, each behind its
 * own link (CalendarFeedToken.scope): `/calendar/publish/:user/my-work.ics`
 * (items assigned to the person, with a due date) and
 * `/calendar/publish/:user/projects/:projectId.ics` (one project's dated
 * items). They are minted and rotated from Settings -> Developer
 * (routes/developer.ts), not here: that router sits outside /api/pm, so an API
 * token can never mint a link. All three feed routes share one rate limit.
 */

import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  createEvent,
  listEvents,
  allDayDates,
  updateEvent,
  deleteEvent,
  createSource,
  listSources,
  deleteSource,
  syncSource,
} from "../services/calendar.service.js";
import { serializeIcs } from "../services/ics.js";
// WARP-2767 — stored, revocable, expiring feed credential.
import {
  getFeedTokenStatus,
  resolveFeedToken,
  revokeFeedTokens,
  rotateFeedToken,
  verifyFeedToken,
  type FeedTarget,
} from "../services/calendar-feed-token.service.js";
import { createRateLimit } from "../middleware/rate-limit.js";
import { resolveTrustedOriginUrl } from "../lib/trusted-origin.js";
import { pmFeedAccessRefusal } from "../services/pm/pm-feed-access.js";
import {
  findFeedProject,
  listMyWorkFeedItems,
  listProjectFeedItems,
  toIcsEvents,
} from "../services/pm/pm-ics.service.js";
import { recordActivity } from "../services/activity.singleton.js";
import { actorFromRequest } from "../services/activity.service.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { fetchNominatim, type PlaceSuggestion } from "../services/places.service.js";
// WARP-3264 — the Nominatim leg is behind the owner-only `place_lookup`
// off-LAN channel (default off).
import { placeLookupGate } from "../services/off-lan-gate.service.js";
// WARP-1906 — premade workspace locations (building + conference room) rank
// ahead of the Nominatim results in the location autocomplete.
import {
  matchRooms,
  toRoomSuggestion,
} from "../services/workspace-locations.service.js";
// WARP-1874 — the single https-only gate for a value that becomes an href.
import { meetingUrlSchema } from "../lib/meeting-url.js";
// WARP-2022 — tells a destination refusal apart from a transport failure
// without string-matching the message.
import { isOutboundUrlBlocked } from "../lib/outbound-url-guard.js";
import {
  sendToolActingUserDenial,
  toolActingUser,
  type RouteTools,
} from "../services/tool-acting-user.service.js";

/**
 * WARP-3101 — the calendar routes the assistant's tools call (tools-core
 * TOOL_ROUTES), and the tools each one serves. Only on these does
 * `_service:mcp` act for the person it names; elsewhere it is only itself.
 */
export const CALENDAR_TOOL_ROUTES = {
  "get /api/calendar/events": ["list_events", "search_calendar_events"],
  "post /api/calendar/events": ["create_event"],
  "patch /api/calendar/events/:id": ["update_event"],
  "delete /api/calendar/events/:id": ["delete_event"],
} as const satisfies Record<string, RouteTools>;

/** WARP-3101 — `search_calendar_events`' text, as the tool bounds it. */
const eventQuerySchema = z.string().trim().min(1).max(200);

// WARP-1502: the place-suggestion shape + Nominatim fetch/formatting moved to
// services/places.service.ts so the structured-formatting logic is unit-tested
// directly.

/** WARP-2767 — the local User.id, which feed tokens are bound to (a username
 *  can be reused after de-provisioning; a User.id cannot). */
function getUserId(req: Request): string {
  const id = req.user?.id;
  if (!id) throw new Error("authenticated user required");
  return id;
}

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

const eventCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  location: z.string().max(500).optional(),
  meetingUrl: meetingUrlSchema.optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  allDay: z.boolean().optional(),
});

const eventPatchSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  // WARP-3262 — `null` clears notes / place, as it does the video link: the
  // web's EventForm sends null for an empty field. "" (the Mac, R-CAL4)
  // still validates and stores "".
  description: z.string().max(10000).nullable().optional(),
  // Nullable on PATCH so "remove video call link" is expressible. An
  // empty string would store a falsy href instead of clearing the column.
  meetingUrl: meetingUrlSchema.nullable().optional(),
  location: z.string().max(500).nullable().optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  allDay: z.boolean().optional(),
});

const sourceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  // WARP-2022 — `z.string().url()` accepts http://127.0.0.1/,
  // http://169.254.169.254/ and file:///etc/passwd. The real destination rule
  // is assertOutboundUrlAllowed in calendar.service.ts's createSource; this
  // only bounds the shape and the length.
  url: z.string().url().max(2048),
  authMode: z.enum(["none", "basic"]).default("none"),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  syncIntervalSec: z.number().int().min(60).max(86400).optional(),
  /** WARP-2022 — owner/admin only; enforced in the handler, not here, so the
   *  refusal is a 403 about authority rather than a 400 about shape. */
  allowPrivateHost: z.boolean().optional(),
});

/** WARP-2022 — roles permitted to point a calendar source inside the box's
 *  trust boundary. Mirrors the ADR-004 §3 matrix: an exemption from a
 *  network-security control is an administrative act, not a household one. */
const PRIVATE_HOST_ROLES = new Set(["owner", "admin"]);

/**
 * WARP-3533 — the feed routes are mounted before every gate (and so before the
 * app-wide per-IP limiter), so they carry their own. 60 a minute per client:
 * a calendar app polls every few hours, an office behind one NAT with twenty
 * subscribers is still an order of magnitude under it, and a scripted probe of
 * the token is not. One limiter for all three feeds, and one for the process
 * (module scope), as the app-wide one is.
 */
const calendarFeedRateLimit = createRateLimit("calendar-feed", { windowMs: 60_000, limit: 60 });

/** A feed's file name: the username comes from the URL, so keep it to what a header may carry. */
const fileSafe = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);

/** PUBLIC router — only the ICS publish endpoints. Mount BEFORE the auth
 *  middleware in app.ts. Auth is by a stored feed token in the query string,
 *  NOT by session cookie, so phones can subscribe via webcal:// without a
 *  Droplet account on the device. */
export function createCalendarPublicRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get("/calendar/publish/:user.ics", calendarFeedRateLimit, async (req, res, next) => {
    try {
      const user = req.params.user;
      // Defense in depth: usernames in this codebase are Nextcloud handles
      // (short, ASCII). A 200-char cap rejects pathological input before it
      // reaches the token lookup + Prisma where-clause.
      if (!user || user.length > 200) {
        res.status(400).json({ error: "invalid_user" });
        return;
      }
      const token = req.query.token;
      // CodeQL js/type-confusion-through-parameter-tampering: `?token=a&token=b`
      // arrives as an array; only a single string can be the feed token.
      // WARP-2767: the token must be active, unexpired, and belong to the
      // account whose CURRENT username is `user` — anything else is a 403.
      if (typeof token !== "string" || !(await verifyFeedToken(prisma, token, user))) {
        res.status(403).json({ error: "invalid_token" });
        return;
      }
      const events = await listEvents(prisma, user, {
        from: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        to: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        limit: 500,
      });
      const ics = serializeIcs(
        events.map((e) => ({
          uid: e.externalUid ?? `${e.id}@droplet`,
          summary: e.title,
          description: e.description,
          location: e.location,
          meetingUrl: e.meetingUrl,
          startsAt: e.startsAt,
          endsAt: e.endsAt,
          allDay: e.allDay,
          updatedAt: e.updatedAt,
        })),
        `Droplet — ${user}`,
      );
      res.setHeader("Content-Type", "text/calendar; charset=utf-8");
      res.setHeader("Content-Disposition", `inline; filename="droplet-${user}.ics"`);
      res.send(ics);
    } catch (err) {
      next(err);
    }
  });

  /**
   * WARP-3533 — a work-item feed. The same checks as the calendar feed, then the
   * two the route cannot inherit because it sits ahead of every gate: the
   * `projects` module must be on for the workspace, and the person's role (read
   * now, not carried in the link) must clear the module's tier floor. Anything
   * wrong with the link is the one 403 `invalid_token`, whichever way it is wrong.
   *
   * Identity: the link resolves to a `User` row, and the items are looked up by
   * that row's `id` (PM assignees are User.id). The `:user` in the path is only
   * ever compared to the row's username, never used to find anyone.
   */
  async function servePmFeed(req: Request, res: Response, target: FeedTarget): Promise<void> {
    const user = req.params.user;
    if (!user || user.length > 200) {
      res.status(400).json({ error: "invalid_user" });
      return;
    }
    const token = req.query.token;
    // `?token=a&token=b` arrives as an array; only a single string can be the link's token.
    const principal = typeof token === "string" ? await resolveFeedToken(prisma, token, user, target) : null;
    if (!principal) {
      res.status(403).json({ error: "invalid_token" });
      return;
    }
    const refusal = await pmFeedAccessRefusal(prisma, principal.role);
    if (refusal) {
      res.status(refusal.status).json(refusal.body);
      return;
    }
    const now = new Date();
    let items;
    let calName: string;
    let fileName: string;
    if (target.scope === "pm_project") {
      const project = await findFeedProject(prisma, target.projectId);
      if (!project) {
        res.status(404).json({ error: "project_not_found" });
        return;
      }
      items = await listProjectFeedItems(prisma, project.id, now);
      calName = `Droplet — ${project.name}`;
      fileName = `droplet-${fileSafe(project.identifier)}.ics`;
    } else {
      items = await listMyWorkFeedItems(prisma, principal.userId, now);
      calName = "Droplet — My work";
      fileName = `droplet-${fileSafe(principal.username)}-my-work.ics`;
    }
    const origin = await resolveTrustedOriginUrl(req);
    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `inline; filename="${fileName}"`);
    res.send(serializeIcs(toIcsEvents(items, origin), calName));
  }

  router.get("/calendar/publish/:user/my-work.ics", calendarFeedRateLimit, async (req, res, next) => {
    try {
      await servePmFeed(req, res, { scope: "pm_my_work" });
    } catch (err) {
      next(err);
    }
  });

  router.get("/calendar/publish/:user/projects/:projectId.ics", calendarFeedRateLimit, async (req, res, next) => {
    try {
      await servePmFeed(req, res, { scope: "pm_project", projectId: req.params.projectId });
    } catch (err) {
      next(err);
    }
  });

  return router;
}

export function createCalendarRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Events ──

  router.get("/calendar/events", async (req, res, next) => {
    try {
      // WARP-3101 — `?q=` narrows the list to events whose title, notes or
      // place mention it (the search_calendar_events tool).
      const q = req.query.q === undefined ? undefined : eventQuerySchema.safeParse(req.query.q);
      if (q && !q.success) {
        res.status(400).json({ error: "invalid_request", details: q.error.flatten() });
        return;
      }
      const person = await toolActingUser(prisma, req, CALENDAR_TOOL_ROUTES["get /api/calendar/events"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      const fromStr = req.query.from as string | undefined;
      const toStr = req.query.to as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const events = await listEvents(prisma, person.username, {
        from: fromStr ? new Date(fromStr) : undefined,
        to: toStr ? new Date(toStr) : undefined,
        limit,
        query: q?.data,
      });
      res.json({ events: events.map((e) => ({ ...e, ...allDayDates(e) })) });
    } catch (err) {
      next(err);
    }
  });

  router.post("/calendar/events", async (req, res, next) => {
    try {
      const parsed = eventCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const person = await toolActingUser(prisma, req, CALENDAR_TOOL_ROUTES["post /api/calendar/events"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      const ev = await createEvent(prisma, person.username, {
        title: parsed.data.title,
        description: parsed.data.description,
        location: parsed.data.location,
        meetingUrl: parsed.data.meetingUrl,
        startsAt: new Date(parsed.data.startsAt),
        endsAt: new Date(parsed.data.endsAt),
        allDay: parsed.data.allDay,
      });
      res.status(201).json({ event: ev });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("must be after")) {
        res.status(400).json({ error: msg });
        return;
      }
      next(err);
    }
  });

  router.patch("/calendar/events/:id", async (req, res, next) => {
    try {
      const parsed = eventPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      const person = await toolActingUser(prisma, req, CALENDAR_TOOL_ROUTES["patch /api/calendar/events/:id"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      const ev = await updateEvent(prisma, person.username, req.params.id, {
        title: parsed.data.title,
        description: parsed.data.description,
        location: parsed.data.location,
        meetingUrl: parsed.data.meetingUrl,
        startsAt: parsed.data.startsAt ? new Date(parsed.data.startsAt) : undefined,
        endsAt: parsed.data.endsAt ? new Date(parsed.data.endsAt) : undefined,
        allDay: parsed.data.allDay,
      });
      res.json({ event: ev });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "event_not_found") return void res.status(404).json({ error: msg });
      if (msg === "forbidden") return void res.status(403).json({ error: msg });
      if (msg.includes("cannot modify")) return void res.status(409).json({ error: msg });
      if (msg.includes("must be after")) return void res.status(400).json({ error: msg });
      next(err);
    }
  });

  router.delete("/calendar/events/:id", async (req, res, next) => {
    try {
      const person = await toolActingUser(prisma, req, CALENDAR_TOOL_ROUTES["delete /api/calendar/events/:id"]);
      if (!person.ok) return void sendToolActingUserDenial(res, person);
      await deleteEvent(prisma, person.username, req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "event_not_found") return void res.status(404).json({ error: msg });
      if (msg === "forbidden") return void res.status(403).json({ error: msg });
      if (msg.includes("cannot delete")) return void res.status(409).json({ error: msg });
      next(err);
    }
  });

  // ── External sources (CalDAV / ICS feeds) ──

  router.get("/calendar/sources", async (req, res, next) => {
    try {
      const sources = await listSources(prisma, getUser(req));
      res.json({ sources });
    } catch (err) {
      next(err);
    }
  });

  router.post("/calendar/sources", async (req, res, next) => {
    try {
      const parsed = sourceCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
        return;
      }
      // WARP-2022 — the escape hatch is an administrative grant. Checked
      // BEFORE createSource so a lower role gets "you may not do that"
      // rather than a destination refusal that hides the real reason.
      const allowPrivateHost = parsed.data.allowPrivateHost === true;
      if (allowPrivateHost && !PRIVATE_HOST_ROLES.has(req.user?.role ?? "")) {
        res.status(403).json({ error: "forbidden" });
        return;
      }
      const src = await createSource(prisma, getUser(req), {
        name: parsed.data.name,
        url: parsed.data.url,
        authMode: parsed.data.authMode,
        username: parsed.data.username,
        password: parsed.data.password,
        syncIntervalSec: parsed.data.syncIntervalSec,
        allowPrivateHost,
      });
      res.status(201).json({
        source: {
          id: src.id,
          name: src.name,
          url: src.url,
          authMode: src.authMode,
          username: src.username,
          syncIntervalSec: src.syncIntervalSec,
          allowPrivateHost: src.allowPrivateHost,
        },
      });
    } catch (err) {
      // WARP-2022 — a refused destination is a 400 with the guard's FIXED
      // string. `err.message` is safe to echo precisely because the guard
      // bakes `blocked_destination` into it and keeps the specifics on a
      // separate field; echoing the detail here would rebuild the probe
      // oracle at the registration endpoint instead of the sync one.
      if (isOutboundUrlBlocked(err)) {
        return void res.status(400).json({ error: err.message });
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("basic auth requires")) return void res.status(400).json({ error: msg });
      next(err);
    }
  });

  router.delete("/calendar/sources/:id", async (req, res, next) => {
    try {
      await deleteSource(prisma, getUser(req), req.params.id);
      res.json({ deleted: req.params.id });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === "source_not_found") return void res.status(404).json({ error: msg });
      if (msg === "forbidden") return void res.status(403).json({ error: msg });
      next(err);
    }
  });

  router.post("/calendar/sources/:id/sync", async (req, res, next) => {
    try {
      // Authorise FIRST — verify the source belongs to the caller before
      // kicking the sync. syncSource itself doesn't enforce ownership
      // (it's reused by the background poller which has no req.user).
      const src = await prisma.calendarSource.findUnique({ where: { id: req.params.id } });
      if (!src) return void res.status(404).json({ error: "source_not_found" });
      if (src.userId !== getUser(req)) return void res.status(403).json({ error: "forbidden" });
      const result = await syncSource(prisma, req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // ── Publish: ICS feed phones can subscribe to via webcal:// ──

  // WARP-2767 — the feed link is a stored credential. Only its hash exists
  // server-side, so this reports status and never a URL; a URL is returned
  // exactly once, by /publish/rotate.
  router.get("/calendar/publish-token", async (req, res, next) => {
    try {
      res.json(await getFeedTokenStatus(prisma, getUserId(req)));
    } catch (err) {
      next(err);
    }
  });

  // The actual publish handler lives in createCalendarPublicRouter so it
  // can be mounted BEFORE the auth middleware. Don't duplicate it here.

  // Mint a new link; every earlier link of the CALLER stops working in the
  // same transaction. Other users' links are untouched.
  router.post("/calendar/publish/rotate", async (req, res, next) => {
    try {
      const user = getUser(req);
      const minted = await rotateFeedToken(prisma, getUserId(req));
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "calendar",
        what: minted.rotated > 0 ? "Calendar feed link replaced" : "Calendar feed link created",
        sub: user,
        // Never the token itself — the row id is the non-secret selector.
        refs: { tokenId: minted.id, endedPrevious: minted.rotated, expiresAt: minted.expiresAt.toISOString() },
        actor: actorFromRequest(req),
      });
      res.json({
        url: `/api/calendar/publish/${encodeURIComponent(user)}.ics?token=${minted.token}`,
        expiresAt: minted.expiresAt,
      });
    } catch (err) {
      next(err);
    }
  });

  router.post("/calendar/publish/revoke", async (req, res, next) => {
    try {
      const revoked = await revokeFeedTokens(prisma, getUserId(req));
      await recordActivity({
        kind: "auth",
        severity: "ok",
        sourceIcon: "calendar",
        what: "Calendar feed link turned off",
        sub: getUser(req),
        refs: { revoked },
        actor: actorFromRequest(req),
      });
      res.json({ revoked });
    } catch (err) {
      next(err);
    }
  });

  // ── WARP-307: location autocomplete via OSM Nominatim ──
  //
  // Backs the event-form location combobox. Proxies to nominatim.openstreetmap.org
  // so the dashboard never makes cross-origin requests itself and so we can
  // be a good citizen with OSM's policy:
  //
  //   - 1 req/sec/IP from the orchestrator (the de-facto IP for all users
  //     on this device).
  //   - Identifying User-Agent string (mandatory per OSM ToS).
  //   - Cache identical queries for 10 minutes in Redis to soak up repeat
  //     keystrokes from the same user.
  //
  // Result shape is intentionally narrow: just enough for the combobox to
  // render a list and persist a string. Lat/lon are included so a follow-up
  // can store coordinates without changing the wire.
  // WARP-3264 — the caller's own previously used event places matching `q`,
  // most recently used first, minus anything already offered as a room.
  // Scoped to the caller's calendar so one person's meeting places never
  // surface in a colleague's field. Dedup + LIMIT run in Postgres (Prisma's
  // `distinct` dedupes in memory, loading every matching row per keystroke).
  // Values that are meeting links (pre-WARP-1874 rows) are not places.
  // Never throws: a failed read is just no suggestions.
  async function usedPlaces(
    userId: string,
    q: string,
    limit: number,
    rooms: PlaceSuggestion[],
  ): Promise<PlaceSuggestion[]> {
    try {
      const pattern = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      const rows = await prisma.$queryRaw<Array<{ location: string }>>`
        SELECT btrim("location") AS location
          FROM "CalendarEvent"
         WHERE "userId" = ${userId}
           AND "location" ILIKE ${pattern}
           AND btrim("location") <> ''
           AND btrim("location") !~* '^https?://'
         GROUP BY btrim("location")
         ORDER BY MAX("startsAt") DESC
         LIMIT ${limit + rooms.length}`;
      const roomNames = new Set(rooms.map((r) => r.displayName.toLowerCase()));
      return rows
        .map((r) => r.location)
        .filter((l) => !roomNames.has(l.toLowerCase()))
        .slice(0, limit)
        .map((l) => ({ name: l, context: "", displayName: l, lat: "", lon: "", type: null }));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[calendar/places] used-places lookup failed:", err);
      return [];
    }
  }

  router.get("/calendar/places", async (req, res) => {
    // Declared OUTSIDE the try so the catch can still serve them: on an
    // offline/air-gapped box (the flagship posture) the premade rooms are
    // exactly the part that must keep working when Nominatim can't.
    let rooms: PlaceSuggestion[] = [];
    try {
      const q = String(req.query.q ?? "").trim();
      if (q.length < 2) {
        res.json({ places: [] });
        return;
      }
      const limit = Math.max(1, Math.min(10, Number(req.query.limit) || 5));
      // WARP-1502: `v2` — the suggestion shape gained `name`/`context`. Bumping
      // the key prefix guarantees we never serve a stale old-shape entry from
      // the 10-minute cache after this ships.
      // WARP-1906 — premade workspace locations rank AHEAD of the Nominatim
      // results: on a business box "Aur" should surface "HQ - Room Aurora"
      // before any city. Read fresh on every request (NEVER cached with the
      // Nominatim list below) so an admin edit in Settings shows up
      // immediately; a failed read degrades to Nominatim-only rather than
      // failing the lookup.
      try {
        const rows = await prisma.workspaceLocation.findMany({
          orderBy: [{ building: "asc" }, { room: "asc" }],
        });
        rooms = matchRooms(rows, q).slice(0, limit).map(toRoomSuggestion);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[calendar/places] workspace-location lookup failed:", err);
      }

      // The external lookup is scoped to its own try/catch: a network-level
      // Nominatim failure (DNS, ECONNREFUSED, the 5s abort — the fetch
      // REJECTS, unlike a non-OK response which resolves to []) degrades to
      // rooms-only instead of discarding the rows already read above.
      // WARP-3264 — with the `place_lookup` channel off (the default), the
      // typed text never leaves the box: suggest only the caller's own
      // previously used event places. Scoped to the caller's calendar so
      // one person's meeting places never surface in a colleague's field.
      if (!(await placeLookupGate(prisma))) {
        // Rooms and used places are capped separately (each ≤ limit), the
        // same shape as rooms + externals below, so a workspace with many
        // matching rooms never starves the caller's own places.
        const used = await usedPlaces(getUser(req), q, limit, rooms);
        res.json({ places: [...rooms, ...used] });
        return;
      }

      let external: PlaceSuggestion[] = [];
      try {
        const cacheKey = `places:v2:${limit}:${q.toLowerCase()}`;
        const cached = await cacheGet<PlaceSuggestion[]>(cacheKey);
        if (cached) {
          external = cached;
        } else {
          external = await fetchNominatim(q, limit);
          // 10 minutes — the same prefix lookup is going to repeat as a user
          // types; longer TTLs risk staleness for fast-moving entities
          // (renamed venues, etc.) but 10 min is a sane compromise. Only the
          // Nominatim list is cached — the room merge above stays live.
          await cacheSet(cacheKey, external, 600);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[calendar/places] external lookup failed:", err);
        // Degraded ON is a superset of OFF: still offer the caller's places.
        external = await usedPlaces(getUser(req), q, limit, rooms);
      }

      res.json({ places: [...rooms, ...external] });
    } catch (err) {
      // Never 5xx the combobox — it falls back to free-text entry. Serve
      // whatever local rooms we already read rather than an empty list.
      // eslint-disable-next-line no-console
      console.warn("[calendar/places] lookup failed:", err);
      res.json({ places: rooms });
    }
  });

  return router;
}
