/**
 * WARP-1906 — pure helpers behind premade business locations: the canonical
 * "Building - Room" label, the label-substring matcher the /calendar/places
 * merge uses, and the row → PlaceSuggestion wire mapping.
 */
import { describe, it, expect } from "vitest";
import {
  workspaceLocationLabel,
  matchRooms,
  toRoomSuggestion,
} from "./workspace-locations.service.js";

const ROWS = [
  { building: "HQ", room: "Room Aurora" },
  { building: "HQ", room: "Fishbowl" },
  { building: "2nd Floor", room: "Boardroom" },
];

describe("workspaceLocationLabel (WARP-1906)", () => {
  it("composes the canonical 'Building - Room' label the ticket specifies", () => {
    expect(workspaceLocationLabel("HQ", "Room Aurora")).toBe("HQ - Room Aurora");
  });
});

describe("matchRooms (WARP-1906)", () => {
  it("matches case-insensitively on the room name", () => {
    expect(matchRooms(ROWS, "aurora")).toEqual([ROWS[0]]);
  });

  it("matches on the building name", () => {
    expect(matchRooms(ROWS, "2nd")).toEqual([ROWS[2]]);
  });

  it("matches across the separator — the whole label is the haystack", () => {
    // "hq - room" spans building + separator + room; two independent
    // `contains` predicates on the columns could never match this.
    expect(matchRooms(ROWS, "hq - room")).toEqual([ROWS[0]]);
  });

  it("returns [] for a blank query instead of everything", () => {
    expect(matchRooms(ROWS, "   ")).toEqual([]);
  });

  it("returns [] when nothing matches", () => {
    expect(matchRooms(ROWS, "warehouse")).toEqual([]);
  });
});

describe("toRoomSuggestion (WARP-1906)", () => {
  it("maps a row onto the PlaceSuggestion wire shape with kind 'room'", () => {
    expect(toRoomSuggestion({ building: "HQ", room: "Room Aurora" })).toEqual({
      kind: "room",
      name: "Room Aurora",
      context: "HQ",
      displayName: "HQ - Room Aurora",
      lat: "",
      lon: "",
      type: "conference_room",
    });
  });
});
