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

function renderCard(device: EnrichedNetworkDevice, onOpen = vi.fn()) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <DeviceCard device={device} onOpen={onOpen} />
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

  it("isBlocked=false → renders 'Block' and POSTs /api/network/firewall/block with mac on click", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(fetchMock, { operationId: "op-123" });

    renderCard(device);

    const btn = screen.getByRole("button", { name: "Block device" });
    expect(btn.textContent).toBe("Block");

    fireEvent.click(btn);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/network/firewall/block",
      );
      expect(postCalls).toHaveLength(1);
      const init = postCalls[0][1];
      expect(init.method).toBe("POST");
      expect(JSON.parse(init.body)).toEqual({ mac: device.mac });
    });
  });

  it("isBlocked=true → renders 'Unblock' and POSTs /api/network/firewall/unblock on click", async () => {
    const device = makeDevice({ isBlocked: true });
    mockFetchOnceJson(fetchMock, {});

    renderCard(device);

    const btn = screen.getByRole("button", { name: "Unblock device" });
    expect(btn.textContent).toBe("Unblock");

    fireEvent.click(btn);

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/network/firewall/unblock",
      );
      expect(postCalls).toHaveLength(1);
      expect(JSON.parse(postCalls[0][1].body)).toEqual({ mac: device.mac });
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

  it("surfaces error on a 500 response and does NOT optimistically flip state", async () => {
    const device = makeDevice({ isBlocked: false });
    mockFetchOnceJson(
      fetchMock,
      { error: { code: "UPSTREAM_FAILED", message: "Router unreachable" } },
      false,
      500,
    );

    renderCard(device);

    const btn = screen.getByRole("button", { name: "Block device" });
    fireEvent.click(btn);

    // After the failed request, button should still say "Block" (no optimistic
    // flip — we rely on SWR revalidation from the reconciler) and the tooltip
    // should carry the error message.
    await waitFor(() => {
      expect(btn.getAttribute("title")).toBe("Router unreachable");
    });
    expect(btn.textContent).toBe("Block");
    expect(btn.getAttribute("aria-label")).toBe("Block device");
  });
});
