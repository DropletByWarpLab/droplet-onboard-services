import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor, act } from "@testing-library/react";
import { SWRConfig } from "swr";
import { useSchedules } from "@/lib/hooks/useSchedules";
import { useActiveOverrides } from "@/lib/hooks/useActiveOverrides";
import { useScheduleEvents } from "@/lib/hooks/useScheduleEvents";
import { useScheduleMutations } from "@/lib/hooks/useScheduleMutations";

type FetchMock = ReturnType<typeof vi.fn>;

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

// Helper — mounts a component that captures whatever the hook returns so
// tests can inspect SWR keys (via the fetch mock call log) and the shape
// of the mutation API without needing @testing-library/react-hooks.
function Probe<T>({ use, onValue }: { use: () => T; onValue: (v: T) => void }) {
  const v = use();
  onValue(v);
  return null;
}

describe("useSchedules", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keys off /api/network/schedules", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ schedules: [] }),
    });
    render(
      <Probe use={useSchedules} onValue={() => {}} />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/network/schedules");
  });
});

describe("useActiveOverrides", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("includes active=1 and no filter params by default", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ overrides: [] }),
    });
    render(
      <Probe use={() => useActiveOverrides()} onValue={() => {}} />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe("/api/network/overrides?active=1");
  });

  it("includes deviceMac when supplied", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ overrides: [] }),
    });
    render(
      <Probe
        use={() => useActiveOverrides({ deviceMac: "aa:bb:cc:dd:ee:01" })}
        onValue={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toContain(
      "deviceMac=aa%3Abb%3Acc%3Add%3Aee%3A01",
    );
    expect(fetchMock.mock.calls[0][0]).toContain("active=1");
  });

  it("includes groupId when supplied", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ overrides: [] }),
    });
    render(
      <Probe
        use={() => useActiveOverrides({ groupId: "kids" })}
        onValue={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toContain("groupId=kids");
  });
});

describe("useScheduleEvents", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("keys with default limit=50", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events: [] }),
    });
    render(
      <Probe use={() => useScheduleEvents()} onValue={() => {}} />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/network/schedule-events?limit=50",
    );
  });

  it("suspends fetch when enabled: false (null key)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events: [] }),
    });
    render(
      <Probe
        use={() => useScheduleEvents({ enabled: false })}
        onValue={() => {}}
      />,
      { wrapper },
    );
    // Give SWR a microtask to run before asserting nothing happened.
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honours custom limit", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ events: [] }),
    });
    render(
      <Probe
        use={() => useScheduleEvents({ limit: 10, enabled: true })}
        onValue={() => {}}
      />,
      { wrapper },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe(
      "/api/network/schedule-events?limit=10",
    );
  });
});

describe("useScheduleMutations", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("createSchedule POSTs to /api/network/schedules", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ schedule: { id: "s1", name: "Bedtime" } }),
    });
    let m: ReturnType<typeof useScheduleMutations> | null = null;
    render(
      <Probe use={useScheduleMutations} onValue={(v) => (m = v)} />,
      { wrapper },
    );
    await act(async () => {
      await m!.createSchedule({
        name: "Bedtime",
        enabled: true,
        subjectType: "group",
        groupId: "kids",
        windows: [{ daysOfWeek: 31, startMin: 21 * 60, endMin: 7 * 60 }],
      });
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/network/schedules",
    );
    expect(call).toBeDefined();
    expect(call![1].method).toBe("POST");
    const body = JSON.parse(call![1].body);
    expect(body.name).toBe("Bedtime");
    expect(body.windows).toHaveLength(1);
  });

  it("updateSchedule PATCHes /api/network/schedules/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ schedule: { id: "s1", enabled: false } }),
    });
    let m: ReturnType<typeof useScheduleMutations> | null = null;
    render(
      <Probe use={useScheduleMutations} onValue={(v) => (m = v)} />,
      { wrapper },
    );
    await act(async () => {
      await m!.updateSchedule("s1", { enabled: false });
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/network/schedules/s1",
    );
    expect(call).toBeDefined();
    expect(call![1].method).toBe("PATCH");
    expect(JSON.parse(call![1].body)).toEqual({ enabled: false });
  });

  it("deleteSchedule DELETEs /api/network/schedules/:id", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
    let m: ReturnType<typeof useScheduleMutations> | null = null;
    render(
      <Probe use={useScheduleMutations} onValue={(v) => (m = v)} />,
      { wrapper },
    );
    await act(async () => {
      await m!.deleteSchedule("s1");
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/network/schedules/s1",
    );
    expect(call).toBeDefined();
    expect(call![1].method).toBe("DELETE");
  });

  it("toggleSchedule routes through updateSchedule with the new enabled flag", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ schedule: { id: "s1", enabled: true } }),
    });
    let m: ReturnType<typeof useScheduleMutations> | null = null;
    render(
      <Probe use={useScheduleMutations} onValue={(v) => (m = v)} />,
      { wrapper },
    );
    await act(async () => {
      await m!.toggleSchedule("s1", true);
    });
    const call = fetchMock.mock.calls.find(
      (c) => c[0] === "/api/network/schedules/s1",
    );
    expect(call).toBeDefined();
    expect(call![1].method).toBe("PATCH");
    expect(JSON.parse(call![1].body)).toEqual({ enabled: true });
  });
});
