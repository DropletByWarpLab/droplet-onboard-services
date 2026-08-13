/**
 * /api/calendar/* — events, sources, ICS publish.
 *
 * Identity: every endpoint reads the username from req.user (populated by
 * the auth middleware). Mutating endpoints rely on calendar.service.ts to
 * enforce ownership (`existing.userId !== userId → forbidden`).
 *
 * The publish endpoint is special: it serves an ICS feed at
 * `/api/calendar/publish/:user.ics?token=...` and is NOT behind auth so
 * phones can `webcal://` subscribe. Access is gated by a per-user secret
 * token derived from DEVICE_SECRET + username via HMAC. Rotating
 * DEVICE_SECRET invalidates every subscription; the user can rotate their
 * own token by hitting POST /api/calendar/publish/rotate.
 */

import { Router, type Request } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@prisma/client";
import {
  createEvent,
  listEvents,
  updateEvent,
  deleteEvent,
  createSource,
  listSources,
  deleteSource,
  syncSource,
} from "../services/calendar.service.js";
import { serializeIcs } from "../services/ics.js";
import { cacheGet, cacheSet } from "../services/cache.service.js";
import { fetchNominatim, type PlaceSuggestion } from "../services/places.service.js";
// WARP-1906 — premade workspace locations (building + conference room) rank
// ahead of the Nominatim results in the location autocomplete.
import {
  matchRooms,
  toRoomSuggestion,
} from "../services/workspace-locations.service.js";
// WARP-1874 — the single https-only gate for a value that becomes an href.
import { meetingUrlSchema } from "../lib/meeting-url.js";

// WARP-1502: the place-suggestion shape + Nominatim fetch/formatting moved to
// services/places.service.ts so the structured-formatting logic is unit-tested
// directly.

function getUser(req: Request): string {
  const username = req.user?.username;
  // authMiddleware guarantees req.user on these routes; an absent username is
  // an invariant break, not a legitimate "admin" default (ORCH-007 fail-open).
  if (!username) throw new Error("authenticated user required");
  return username;
}

function publishToken(username: string): string {
  const key = process.env.DEVICE_SECRET;
  if (!key) {
    // In production an unset DEVICE_SECRET silently weakens every token —
    // they'd all be derivable from a known literal. Fail loudly instead.
    if (process.env.NODE_ENV === "production") {
      throw new Error("DEVICE_SECRET must be set to issue calendar publish tokens");
    }
    // Tests / dev — log once and use a deterministic placeholder so the
    // dashboard URL stays stable across restarts of `npm run dev`.
    return crypto.createHmac("sha256", "dev-only-not-secure")
      .update(`calendar:${username}`).digest("hex").slice(0, 32);
  }
  return crypto.createHmac("sha256", key).update(`calendar:${username}`).digest("hex").slice(0, 32);
}

/** Constant-time string equality to avoid leaking the publish token via
 *  response timing on the public ICS endpoint. The two buffers must be the
 *  same length for `timingSafeEqual` not to throw — we enforce that with the
 *  length check before constructing the buffer. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
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
  description: z.string().max(10000).optional(),
  // Nullable on PATCH so "remove video call link" is expressible. An
  // empty string would store a falsy href instead of clearing the column.
  meetingUrl: meetingUrlSchema.nullable().optional(),
  location: z.string().max(500).optional(),
  startsAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().optional(),
  allDay: z.boolean().optional(),
});

const sourceCreateSchema = z.object({
  name: z.string().min(1).max(200),
  url: z.string().url().max(2048),
  authMode: z.enum(["none", "basic"]).default("none"),
  username: z.string().max(200).optional(),
  password: z.string().max(500).optional(),
  syncIntervalSec: z.number().int().min(60).max(86400).optional(),
});

/** PUBLIC router — only the ICS publish endpoint. Mount BEFORE the auth
 *  middleware in app.ts. Auth is by HMAC token in the query string, NOT by
 *  session cookie, so phones can subscribe via webcal:// without a Droplet
 *  account on the device. */
export function createCalendarPublicRouter(prisma: PrismaClient): Router {
  const router = Router();
  router.get("/calendar/publish/:user.ics", async (req, res, next) => {
    try {
      const user = req.params.user;
      // Defense in depth: usernames in this codebase are Nextcloud handles
      // (short, ASCII). A 200-char cap rejects pathological input before it
      // reaches the HMAC + Prisma where-clause.
      if (!user || user.length > 200) {
        res.status(400).json({ error: "invalid_user" });
        return;
      }
      const token = req.query.token as string | undefined;
      if (!token || !safeEqual(token, publishToken(user))) {
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
  return router;
}

export function createCalendarRouter(prisma: PrismaClient): Router {
  const router = Router();

  // ── Events ──

  router.get("/calendar/events", async (req, res, next) => {
    try {
      const user = getUser(req);
      const fromStr = req.query.from as string | undefined;
      const toStr = req.query.to as string | undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      const events = await listEvents(prisma, user, {
        from: fromStr ? new Date(fromStr) : undefined,
        to: toStr ? new Date(toStr) : undefined,
        limit,
      });
      res.json({ events });
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
      const ev = await createEvent(prisma, getUser(req), {
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
      const ev = await updateEvent(prisma, getUser(req), req.params.id, {
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
      await deleteEvent(prisma, getUser(req), req.params.id);
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
      const src = await createSource(prisma, getUser(req), {
        name: parsed.data.name,
        url: parsed.data.url,
        authMode: parsed.data.authMode,
        username: parsed.data.username,
        password: parsed.data.password,
        syncIntervalSec: parsed.data.syncIntervalSec,
      });
      res.status(201).json({
        source: {
          id: src.id,
          name: src.name,
          url: src.url,
          authMode: src.authMode,
          username: src.username,
          syncIntervalSec: src.syncIntervalSec,
        },
      });
    } catch (err) {
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

  router.get("/calendar/publish-token", (req, res) => {
    const user = getUser(req);
    res.json({
      url: `/api/calendar/publish/${encodeURIComponent(user)}.ics?token=${publishToken(user)}`,
    });
  });

  // The actual publish handler lives in createCalendarPublicRouter so it
  // can be mounted BEFORE the auth middleware. Don't duplicate it here.

  router.post("/calendar/publish/rotate", (req, res) => {
    // The token is derived deterministically from DEVICE_SECRET. To rotate
    // a single user's token we'd need a per-user salt column; for v1 the
    // user can rotate by changing DEVICE_SECRET (which invalidates ALL
    // tokens — fine for a single-user appliance). Document and stub.
    res.status(501).json({
      error: "not_implemented",
      hint: "rotate DEVICE_SECRET to invalidate all subscription tokens; per-user rotation is a follow-up",
    });
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
  router.get("/calendar/places", async (req, res, next) => {
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
      let rooms: PlaceSuggestion[] = [];
      try {
        const rows = await prisma.workspaceLocation.findMany({
          orderBy: [{ building: "asc" }, { room: "asc" }],
        });
        rooms = matchRooms(rows, q).slice(0, limit).map(toRoomSuggestion);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[calendar/places] workspace-location lookup failed:", err);
      }

      const cacheKey = `places:v2:${limit}:${q.toLowerCase()}`;
      const cached = await cacheGet<PlaceSuggestion[]>(cacheKey);
      if (cached) {
        res.json({ places: [...rooms, ...cached] });
        return;
      }

      const places = await fetchNominatim(q, limit);
      // 10 minutes — the same prefix lookup is going to repeat as a user
      // types; longer TTLs risk staleness for fast-moving entities (renamed
      // venues, etc.) but 10 min is a sane compromise. Only the Nominatim
      // list is cached — the room merge above stays live.
      await cacheSet(cacheKey, places, 600);
      res.json({ places: [...rooms, ...places] });
    } catch (err) {
      // Surface a clean empty list rather than a 5xx — the combobox falls
      // back to free-text entry. The error still hits the logger for
      // operators.
      // eslint-disable-next-line no-console
      console.warn("[calendar/places] lookup failed:", err);
      res.json({ places: [] });
    }
  });

  return router;
}
