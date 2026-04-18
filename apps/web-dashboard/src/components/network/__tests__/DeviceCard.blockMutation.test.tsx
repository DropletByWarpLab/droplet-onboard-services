import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { DeviceCard } from "../DeviceCard";
import type { EnrichedNetworkDevice } from "@/lib/types";

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

describe("DeviceCard block/unblock mutation", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("isBlocked=false → renders 'Block' and POSTs /devices/:mac/manualBlock with { blocked: true } on click", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(fetchMock, { operationId: "op-123" });

    renderCard(device);

    const btn = screen.getByRole("button", { name: "Block device" });
    expect(btn.textContent).toBe("Block");

    fireEvent.click(btn);

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

  it("isBlocked=true → renders 'Unblock' and POSTs /devices/:mac/manualBlock with { blocked: false } on click", async () => {
    const device = makeDevice({ isBlocked: true });
    mockFetchOnceJson(fetchMock, {});

    renderCard(device);

    const btn = screen.getByRole("button", { name: "Unblock device" });
    expect(btn.textContent).toBe("Unblock");

    fireEvent.click(btn);

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

  it("clicking the block button does NOT fire onOpen (stopPropagation)", async () => {
    const onOpen = vi.fn();
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(fetchMock, {});

    renderCard(device, onOpen);

    fireEvent.click(screen.getByRole("button", { name: "Block device" }));

    // Wait a tick to let the fetch promise settle — regardless, onOpen
    // must not have been called because of stopPropagation on the inner
    // button's onClick handler.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("pressing Enter on the Block button does NOT fire onOpen", async () => {
    const onOpen = vi.fn();
    mockFetchOnceJson(fetchMock, {});
    renderCard(makeDevice({ isBlocked: false }), onOpen);
    const blockBtn = screen.getByRole("button", { name: "Block device" });
    fireEvent.keyDown(blockBtn, { key: "Enter" });
    // Native buttons also treat Enter as click — simulate the click side too
    // so the mutation path is exercised and onError/toast is wired.
    fireEvent.click(blockBtn);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("surfaces error on a 500 response via onError (toast) and falls back to title", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(
      fetchMock,
      { error: { code: "UPSTREAM_FAILED", message: "Router unreachable" } },
      false,
      500,
    );
    const onError = vi.fn();

    renderCard(device, undefined, onError);

    const btn = screen.getByRole("button", { name: "Block device" });
    fireEvent.click(btn);

    // Primary expectation: the page-level toast handler was invoked with a
    // user-facing message (either the friendly mapped copy or the raw err
    // message as fallback). Using toHaveBeenCalled + string assertion so we
    // accept either branch.
    await waitFor(() => {
      expect(onError).toHaveBeenCalledTimes(1);
    });
    const msg = onError.mock.calls[0][0];
    expect(typeof msg).toBe("string");
    expect((msg as string).length).toBeGreaterThan(0);

    // Secondary expectation (fallback behaviour): the title tooltip still
    // carries the message for callers that don't wire up a toast handler.
    expect(btn.getAttribute("title")).toBe(msg);

    // And no optimistic flip — still says "Block".
    expect(btn.textContent).toBe("Block");
    expect(btn.getAttribute("aria-label")).toBe("Block device");
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

    fireEvent.click(screen.getByRole("button", { name: "Block device" }));

    await waitFor(() => expect(onError).toHaveBeenCalled());
    // Friendly copy from TOAST_COPY[REQUIRES_CONFIRMATION]
    expect(onError.mock.calls[0][0]).toBe(
      "This action requires confirmation — not wired yet",
    );
  });
});
