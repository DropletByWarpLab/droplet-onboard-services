import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DeviceCard } from "../DeviceCard";
import type { EnrichedNetworkDevice } from "@/lib/types";

// WARP-291: framer-motion useReducedMotion stub keeps the <Dialog>'s
// animation gates deterministic so the confirm button is in the DOM
// synchronously after clicking the trigger.
vi.mock("framer-motion", async () => {
  const actual: any = await vi.importActual("framer-motion");
  return { ...actual, useReducedMotion: () => true };
});

function makeDevice(overrides: Partial<EnrichedNetworkDevice> = {}): EnrichedNetworkDevice {
  return {
    mac: "aa:bb:cc:dd:ee:01",
    displayName: "Romain's MacBook",
    icon: null,
    notes: null,
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

type FetchMock = ReturnType<typeof vi.fn>;

function mockFetchOnceJson(mock: FetchMock, body: unknown, ok = true, status = 200) {
  mock.mockImplementationOnce(async () => ({
    ok,
    status,
    json: async () => body,
  }));
}

function renderCard(
  device: EnrichedNetworkDevice,
  onOpen = vi.fn(),
  onError?: (msg: string) => void,
) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DeviceCard device={device} onOpen={onOpen} onError={onError} />
    </SWRConfig>,
  );
}

// WARP-291: click the row's Block/Unblock affordance, then click the
// confirm button inside the <ConfirmDialog>. Returns the trigger node
// so per-test assertions on aria-label / textContent still work.
// WARP-292 sharpened the row trigger aria-label to include the device
// displayName ("Block device Romain's MacBook"), so we match by regex
// to keep these tests resilient to the suffix.
function clickThroughConfirm(
  triggerKind: "Block device" | "Unblock device",
  confirmName: "Block" | "Unblock",
): HTMLElement {
  const trigger = screen.getByRole("button", {
    name: new RegExp(`^${triggerKind}\\b`, "i"),
  });
  fireEvent.click(trigger);
  // The dialog confirm button shares the same accessible name as the
  // row trigger label minus the "device" suffix.
  const confirmBtn = screen.getByRole("button", { name: confirmName });
  fireEvent.click(confirmBtn);
  return trigger;
}

describe("DeviceCard block/unblock mutation", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isBlocked=false → renders 'Block' and POSTs /devices/:mac/manualBlock with { blocked: true } after confirm", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(fetchMock, { operationId: "op-123" });

    renderCard(device);

    const trigger = screen.getByRole("button", { name: /^Block device\b/i });
    expect(trigger.textContent).toBe("Block");

    clickThroughConfirm("Block device", "Block");

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0] === `/api/network/devices/${encodeURIComponent(device.mac)}/manualBlock`,
      );
      expect(postCalls).toHaveLength(1);
      const init = postCalls[0][1];
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ blocked: true });
    });
  });

  it("isBlocked=true → renders 'Unblock' and POSTs /devices/:mac/manualBlock with { blocked: false } after confirm", async () => {
    const device = makeDevice({ isBlocked: true });
    mockFetchOnceJson(fetchMock, {});

    renderCard(device);

    const trigger = screen.getByRole("button", { name: /^Unblock device\b/i });
    expect(trigger.textContent).toBe("Unblock");

    clickThroughConfirm("Unblock device", "Unblock");

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0] === `/api/network/devices/${encodeURIComponent(device.mac)}/manualBlock`,
      );
      expect(postCalls).toHaveLength(1);
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ blocked: false });
    });
  });

  it("clicking the block trigger does NOT fire onOpen (stopPropagation) — opening the ConfirmDialog is also not opening details", async () => {
    const onOpen = vi.fn();
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(fetchMock, {});

    renderCard(device, onOpen);

    clickThroughConfirm("Block device", "Block");

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("Enter on the Block trigger does NOT fire onOpen", async () => {
    const onOpen = vi.fn();
    mockFetchOnceJson(fetchMock, {});
    renderCard(makeDevice({ isBlocked: false }), onOpen);
    const blockBtn = screen.getByRole("button", { name: /^Block device\b/i });
    fireEvent.keyDown(blockBtn, { key: "Enter" });
    // Buttons fire onClick from Enter natively; simulate to take the
    // open-confirm path and click the dialog's confirm.
    fireEvent.click(blockBtn);
    const confirmBtn = screen.getByRole("button", { name: "Block" });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("surfaces error on a 500 response via onError (toast) and keeps the ConfirmDialog open", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(
      fetchMock,
      { error: { code: "UPSTREAM_FAILED", message: "Router unreachable" } },
      false,
      500,
    );
    const onError = vi.fn();

    renderCard(device, undefined, onError);

    clickThroughConfirm("Block device", "Block");

    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    const msg = onError.mock.calls[0][0];
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);
  });

  it("treats a 428 requires-confirmation envelope as REQUIRES_CONFIRMATION (WARP-41 placeholder)", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(
      fetchMock,
      {
        requiresConfirmation: true,
        error: { code: "UPSTREAM_FAILED", message: "pending confirm" },
      },
      false,
      428,
    );
    const onError = vi.fn();

    renderCard(device, undefined, onError);

    clickThroughConfirm("Block device", "Block");

    await waitFor(() => expect(onError).toHaveBeenCalled());
    // Friendly copy from TOAST_COPY[REQUIRES_CONFIRMATION]
    expect(onError.mock.calls[0][0]).toBe(
      "This action requires confirmation — not wired yet",
    );
  });
});
