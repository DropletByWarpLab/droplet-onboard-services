/**
 * WARP-307 — PlaceCombobox: fuzzy location autocomplete backed by the
 * orchestrator's `/api/calendar/places` Nominatim proxy.
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

import { PlaceCombobox } from "@/components/calendar/PlaceCombobox";

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

describe("PlaceCombobox (WARP-307)", () => {
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

  it("renders suggestions as a listbox once the proxy answers", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      { displayName: "Paris, France", lat: "48.85", lon: "2.35", type: "city" },
      {
        displayName: "Paris, Texas, USA",
        lat: "33.66",
        lon: "-95.55",
        type: "city",
      },
    ]);
    render(<Harness />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Paris" } });
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveTextContent(/Paris, France/);
  });

  it("clicking a suggestion fills the input and closes the list", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      {
        displayName: "Eiffel Tower, Paris, France",
        lat: "48.858",
        lon: "2.294",
        type: "tourism",
      },
    ]);
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Eiffel" } });
    const option = await screen.findByRole("option");
    // mousedown — the component listens on mousedown so the pick fires
    // before the input's onBlur tears the list down.
    fireEvent.mouseDown(option);
    expect(onChangeSpy).toHaveBeenCalledWith("Eiffel Tower, Paris, France");
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

  it("ArrowDown / Enter picks the second suggestion", async () => {
    fetchPlacesMock.mockResolvedValueOnce([
      { displayName: "Paris, France", lat: "48.85", lon: "2.35", type: "city" },
      {
        displayName: "Paris, Texas, USA",
        lat: "33.66",
        lon: "-95.55",
        type: "city",
      },
    ]);
    const onChangeSpy = vi.fn();
    render(<Harness onChangeSpy={onChangeSpy} />);
    const input = screen.getByTestId("place-input");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Paris" } });
    await screen.findByRole("listbox");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChangeSpy).toHaveBeenLastCalledWith("Paris, Texas, USA");
  });
});
