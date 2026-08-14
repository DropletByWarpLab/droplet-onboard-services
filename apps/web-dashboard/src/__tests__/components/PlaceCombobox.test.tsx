/**
 * WARP-307 / WARP-1502 — PlaceCombobox: fuzzy location autocomplete backed by
 * the orchestrator's `/api/calendar/places` Nominatim proxy.
 *
 * WARP-1502 changes covered here:
 *   - suggestions render two lines (short `name` + muted `context`),
 *   - picking stores the CLEAN value `name, context` (e.g. "Newport Beach, CA"),
 *     NOT the long raw display_name,
 *   - free-text fallback + keyboard nav still work.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const { fetchPlacesMock } = vi.hoisted(() => ({
  fetchPlacesMock: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  fetchPlaces: fetchPlacesMock,
}));

import {
  PlaceCombobox,
  placeStoredValue,
} from "@/components/calendar/PlaceCombobox";
import type { PlaceSuggestion } from "@/lib/api";

function place(p: Partial<PlaceSuggestion>): PlaceSuggestion {
  return {
    kind: p.kind,
    name: p.name,
    context: p.context,
    displayName: p.displayName ?? "",
    lat: p.lat ?? "0",
    lon: p.lon ?? "0",
    type: p.type ?? null,
  };
}

function Harness({
  initialValue = "",
  onChangeSpy,
}: {
  initialValue?: string;
  onChangeSpy?: (v: string) => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <PlaceCombobox
      value={value}
      onChange={(v) => {
        setValue(v);
        onChangeSpy?.(v);
      }}
      className="dp-input"
    />
  );
}

// The debounce inside the component is 300 ms; tests wait with real
// timers because findByRole / waitFor poll on real time, and mixing
// fake timers with @testing-library async helpers deadlocks. 400 ms is
// plenty of margin for the debounce + microtask flush.
const POST_DEBOUNCE_MS = 400;
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe("placeStoredValue (WARP-1502)", () => {
  it("composes `name, context` when both present", () => {
    expect(
      placeStoredValue(
        place({ name: "Newport Beach", context: "CA", displayName: "long…" }),
      ),
    ).toBe("Newport Beach, CA");
  });

  it("uses the name alone when there is no context", () => {
    expect(
      placeStoredValue(place({ name: "Anywhere", context: "", displayName: "long…" })),
    ).toBe("Anywhere");
  });

  it("stores a premade room's canonical 'Building - Room' label verbatim (WARP-1906)", () => {
    // A kind:"room" suggestion carries the server-composed label in
    // displayName; composing `name, context` here would flip it to
    // "Room Aurora, HQ".
    expect(
      placeStoredValue(
        place({
          kind: "room",
          name: "Room Aurora",
          context: "HQ",
          displayName: "HQ - Room Aurora",
          lat: "",
          lon: "",
          type: "conference_room",
        }),
      ),
    ).toBe("HQ - Room Aurora");
  });

  it("falls back to the first display_name segment for a stale old-shape item", () => {
    // No `name`/`context` (e.g. a pre-WARP-1502 cache entry): don't store the
    // whole chain — take the first segment.
    expect(
      placeStoredValue(
        place({ displayName: "Newport Beach, Orange County, California, United States" }),
      ),
    ).toBe("Newport Beach");
  });
});

describe("PlaceCombobox (WARP-307 / WARP-1502)", () => {
  beforeEach(() => {
    fetchPlacesMock.mockReset();
  });

  it("does NOT fire a lookup for queries shorter than 2 chars", async () => {
    fetchPlacesMock.mockResolvedValue([]);
    render(<Harness />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "a" } });
    await sleep(POST_DEBOUNCE_MS);
    expect(fetchPlacesMock).not.toHaveBeenCalled();
  });

  it("debounces lookups — rapid keystrokes collapse to one fetch with the latest value", async () => {
    fetchPlacesMock.mockResolvedValue([]);
    render(<Harness />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Pa" } });
    fireEvent.change(input, { target: { value: "Par" } });
    fireEvent.change(input, { target: { value: "Pari" } });
    await sleep(POST_DEBOUNCE_MS);
    // Exactly one network call, for the most recent value the user typed.
    expect(fetchPlacesMock).toHaveBeenCalledTimes(1);
    expect(fetchPlacesMock.mock.calls[0][0]).toBe("Pari");
  });

  it("renders each suggestion as two lines — short name + muted context", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      place({
        name: "Paris",
        context: "Île-de-France",
        displayName: "Paris, Île-de-France, France",
      }),
      place({
        name: "Paris",
        context: "TX",
        displayName: "Paris, Lamar County, Texas, United States",
      }),
    ]);
    render(<Harness />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Paris" } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    // Primary name line.
    expect(options[0]).toHaveTextContent("Paris");
    // Muted context line disambiguates the two same-named cities.
    expect(options[0]).toHaveTextContent("Île-de-France");
    expect(options[1]).toHaveTextContent("TX");
    // The long raw display_name is NOT rendered.
    expect(options[0]).not.toHaveTextContent("France, France");
    expect(options[1]).not.toHaveTextContent(/Lamar County|United States/);
  });

  it("stores the CLEAN `name, context` value on pick, not the raw display_name", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      place({
        name: "Newport Beach",
        context: "CA",
        displayName: "Newport Beach, Orange County, California, United States",
      }),
    ]);
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Newport" } });
    const option = await screen.findByRole("option");
    // mousedown — the component listens on mousedown so the pick fires
    // before the input's onBlur tears the list down.
    fireEvent.mouseDown(option);
    expect(onChangeSpy).toHaveBeenCalledWith("Newport Beach, CA");
    expect(onChangeSpy).not.toHaveBeenCalledWith(
      "Newport Beach, Orange County, California, United States",
    );
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("falls back to plain free-text when the proxy returns []", async () => {
    fetchPlacesMock.mockResolvedValueOnce([]);
    render(<Harness />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Somewhere obscure" } });
    await sleep(POST_DEBOUNCE_MS);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect((input as HTMLInputElement).value).toBe("Somewhere obscure");
  });

  it("offers a premade conference room and picking fills the canonical label (WARP-1906)", async () => {
    // The orchestrator merge ranks rooms ahead of Nominatim places; the
    // combobox renders them through the SAME listbox and a pick fills the
    // location field with the server-composed "Building - Room" string.
    fetchPlacesMock.mockResolvedValueOnce([
      place({
        kind: "room",
        name: "Room Aurora",
        context: "HQ",
        displayName: "HQ - Room Aurora",
        lat: "",
        lon: "",
        type: "conference_room",
      }),
      place({
        name: "Aurora",
        context: "IL",
        displayName: "Aurora, Kane County, Illinois, United States",
      }),
    ]);
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Aur" } });
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(2);
    // The room ranks first, rendered as room name + muted building context.
    expect(options[0]).toHaveTextContent("Room Aurora");
    expect(options[0]).toHaveTextContent("HQ");
    fireEvent.mouseDown(options[0]);
    expect(onChangeSpy).toHaveBeenCalledWith("HQ - Room Aurora");
    expect(onChangeSpy).not.toHaveBeenCalledWith("Room Aurora, HQ");
  });

  it("ArrowDown / Enter picks the second suggestion's clean value", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      place({ name: "Paris", context: "Île-de-France", displayName: "Paris, France" }),
      place({
        name: "Paris",
        context: "TX",
        displayName: "Paris, Lamar County, Texas, United States",
      }),
    ]);
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Paris" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChangeSpy).toHaveBeenLastCalledWith("Paris, TX");
  });
});
