/**
 * WARP-1906 — premade business locations (buildings + named conference rooms).
 *
 * Pure helpers shared by the CRUD routes (routes/workspace-locations.ts) and
 * the calendar location autocomplete (routes/calendar.ts GET /calendar/places),
 * which ranks every matching room AHEAD of the Nominatim results. No I/O here
 * so everything is unit-tested directly (places.service.ts precedent).
 */

import type { PlaceSuggestion } from "./places.service.js";

/**
 * The canonical location string a picked room fills into the event form,
 * e.g. "HQ - Room Aurora". Built server-side so the dashboard (and any other
 * client) stores the identical value instead of re-deriving it.
 */
export function workspaceLocationLabel(building: string, room: string): string {
  return `${building} - ${room}`;
}

/** The two columns the matcher/mapper need — routes pass full Prisma rows. */
export interface WorkspaceLocationFields {
  building: string;
  room: string;
}

/**
 * Case-insensitive substring match against the combined label so a query can
 * hit the building ("hq"), the room ("aurora"), or span both ("hq - room").
 * Room counts are settings-sized (tens, not thousands), so an in-memory
 * filter over the full list is simpler than pushing two `contains` predicates
 * to Postgres — and unlike them it matches across the separator.
 */
export function matchRooms<T extends WorkspaceLocationFields>(
  rows: T[],
  q: string,
): T[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [];
  return rows.filter((r) =>
    workspaceLocationLabel(r.building, r.room).toLowerCase().includes(needle),
  );
}

/**
 * Map a WorkspaceLocation row onto the {@link PlaceSuggestion} wire shape the
 * combobox already consumes. `kind: "room"` tells the combobox to store
 * `displayName` verbatim (the canonical label) instead of composing
 * `name, context` — which would flip it to "Room, Building". Rooms have no
 * coordinates, so `lat`/`lon` stay empty strings.
 */
export function toRoomSuggestion(row: WorkspaceLocationFields): PlaceSuggestion {
  return {
    kind: "room",
    name: row.room,
    context: row.building,
    displayName: workspaceLocationLabel(row.building, row.room),
    lat: "",
    lon: "",
    type: "conference_room",
  };
}
