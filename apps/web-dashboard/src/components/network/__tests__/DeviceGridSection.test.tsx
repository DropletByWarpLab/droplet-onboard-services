import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DeviceGridSection } from "../DeviceGridSection";
import type { EnrichedNetworkDevice } from "@/lib/types";

const LS_KEY = "droplet.network.sections";

// jsdom in this project's vitest setup doesn't provision a real localStorage,
// so we install an in-memory shim for these tests.
beforeAll(() => {
  const store: Record<string, string> = {};
  const shim: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear() {
      for (const k of Object.keys(store)) delete store[k];
    },
    getItem(key: string) {
      return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null;
    },
    key(i: number) {
      return Object.keys(store)[i] ?? null;
    },
    removeItem(key: string) {
      delete store[key];
    },
    setItem(key: string, value: string) {
      store[key] = String(value);
    },
  };
  Object.defineProperty(window, "localStorage", {
    value: shim,
    configurable: true,
    writable: true,
  });
});

function makeDevice(overrides: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: "aa:bb:cc:dd:ee:01",
    displayName: "Device A",
    icon: null,
    notes: null,
    vendor: "Apple",
    hostname: "dev-a",
    lastIp: "192.168.1.42",
    firstSeen: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
    isBlocked: false,
    online: true,
    groups: [],
    presenceDays: [],
    ...overrides,
  };
}

describe("DeviceGridSection", () => {
  beforeEach(() => {
    window.localStorage.removeItem(LS_KEY);
  });

  it("renders section heading with device count", () => {
    const devices = [
      makeDevice({ mac: "00:00:00:00:00:01", displayName: "Alpha" }),
      makeDevice({ mac: "00:00:00:00:00:02", displayName: "Beta" }),
    ];
    render(
      <DeviceGridSection
        group={{ id: "g1", name: "Work" }}
        devices={devices}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("heading", { name: "Work" })).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("toggles aria-expanded and hides cards when collapsed", () => {
    const devices = [makeDevice({ mac: "00:00:00:00:00:01", displayName: "Alpha" })];
    render(
      <DeviceGridSection
        group={{ id: "g1", name: "Work" }}
        devices={devices}
        onOpen={() => {}}
      />,
    );
    const toggle = screen.getByRole("button", { expanded: true });
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });

  it("persists collapse state in localStorage", () => {
    const devices = [makeDevice({ mac: "00:00:00:00:00:01" })];
    const { unmount } = render(
      <DeviceGridSection
        group={{ id: "g-persist", name: "Work" }}
        devices={devices}
        onOpen={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    const raw = window.localStorage.getItem("droplet.network.sections");
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw!)["g-persist"]).toBe(false);

    // Remount and confirm collapsed state is restored.
    unmount();
    render(
      <DeviceGridSection
        group={{ id: "g-persist", name: "Work" }}
        devices={devices}
        onOpen={() => {}}
      />,
    );
    expect(screen.getByRole("button", { expanded: false })).toBeInTheDocument();
  });

  it("renders cards in the order provided", () => {
    const devices = [
      makeDevice({ mac: "00:00:00:00:00:01", displayName: "Zulu" }),
      makeDevice({ mac: "00:00:00:00:00:02", displayName: "Alpha" }),
      makeDevice({ mac: "00:00:00:00:00:03", displayName: "Mike" }),
    ];
    render(
      <DeviceGridSection
        group={{ id: "g1", name: "Work" }}
        devices={devices}
        onOpen={() => {}}
      />,
    );
    const headings = screen
      .getAllByRole("button")
      .map((el) => el.getAttribute("aria-label"))
      .filter((l): l is string => !!l && l.startsWith("Open "));
    expect(headings).toEqual([
      "Open Zulu details",
      "Open Alpha details",
      "Open Mike details",
    ]);
  });
});
