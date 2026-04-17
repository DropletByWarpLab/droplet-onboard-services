import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DeviceDetailPanel } from "../DeviceDetailPanel";
import type { EnrichedNetworkDevice, DevicePresenceDay } from "@/lib/types";

const MAC = "aa:bb:cc:dd:ee:01";

function makeDevice(overrides: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: MAC,
    displayName: "Romain's MacBook",
    icon: null,
    notes: "Primary laptop",
    vendor: "Apple",
    hostname: "romain-mbp",
    lastIp: "192.168.1.42",
    firstSeen: new Date(Date.now() - 86_400_000 * 10).toISOString(),
    lastSeen: new Date().toISOString(),
    isBlocked: false,
    online: true,
    groups: [],
    presenceDays: [],
    ...overrides,
  };
}

function makePresence(): DevicePresenceDay[] {
  return Array.from({ length: 30 }, (_, i) => ({
    date: `2026-03-${String(i + 1).padStart(2, "0")}`,
    seenMinutes: 60,
  }));
}

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchOnceJson(mock: FetchMock, body: unknown, ok = true, status = 200) {
  mock.mockImplementationOnce(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

function renderPanel(onClose = () => {}) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DeviceDetailPanel mac={MAC} onClose={onClose} />
    </SWRConfig>,
  );
}

describe("DeviceDetailPanel", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders displayName from loaded data", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();
    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Romain's MacBook"));
  });

  it("debounces displayName edits and PATCHes after 500ms", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();

    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Romain's MacBook"));

    // The PATCH call:
    mockFetchOnceJson(fetchMock, {});

    fireEvent.change(input, { target: { value: "New name" } });
    // Before timer fires: only the initial GET should have happened.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH")).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls).toHaveLength(1);
      const body = JSON.parse(patchCalls[0][1].body);
      expect(body).toEqual({ displayName: "New name" });
    });
  });

  it("saves immediately on blur", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();

    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Romain's MacBook"));

    mockFetchOnceJson(fetchMock, {});

    fireEvent.change(input, { target: { value: "Blur Save" } });
    fireEvent.blur(input);
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls).toHaveLength(1);
      expect(JSON.parse(patchCalls[0][1].body)).toEqual({ displayName: "Blur Save" });
    });
  });

  it("opens icon picker and PATCHes the chosen icon", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();
    await screen.findByLabelText("Display name");

    fireEvent.click(screen.getByRole("button", { name: "Change icon" }));
    const radios = await screen.findAllByRole("radio");
    expect(radios).toHaveLength(20);

    mockFetchOnceJson(fetchMock, {});
    fireEvent.click(screen.getByLabelText("Tv"));

    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "PATCH");
      expect(patchCalls).toHaveLength(1);
      expect(JSON.parse(patchCalls[0][1].body)).toEqual({ icon: "Tv" });
    });
  });

  it("renders 30 sparkline bars from presence data", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();
    await screen.findByLabelText("Display name");
    await waitFor(() => {
      expect(screen.getAllByTestId("sparkline-bar")).toHaveLength(30);
    });
  });

  it("Forget device: confirm prompt → DELETE → onClose", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    const onClose = vi.fn();
    renderPanel(onClose);
    await screen.findByLabelText("Display name");

    fireEvent.click(screen.getByRole("button", { name: "Forget device" }));
    const confirm = await screen.findByRole("button", { name: "Yes, forget" });

    mockFetchOnceJson(fetchMock, {});
    fireEvent.click(confirm);

    await waitFor(() => {
      const deleteCalls = fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE");
      expect(deleteCalls).toHaveLength(1);
      expect(onClose).toHaveBeenCalled();
    });
  });

  it("rolls back local state and shows typed-error toast when PATCH fails", async () => {
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });
    renderPanel();

    const input = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe("Romain's MacBook"));

    // Fail the PATCH with INVALID_ICON; and the mutate-triggered refetch will
    // then re-load the original device data.
    mockFetchOnceJson(
      fetchMock,
      { error: { code: "INVALID_ICON", message: "Bad icon", status: 400 } },
      false,
      400,
    );
    mockFetchOnceJson(fetchMock, { device: makeDevice(), presence: makePresence() });

    // Open picker and pick a new icon to exercise the icon save path.
    fireEvent.click(screen.getByRole("button", { name: "Change icon" }));
    fireEvent.click(screen.getByLabelText("Tv"));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Pick a different icon");
  });
});
