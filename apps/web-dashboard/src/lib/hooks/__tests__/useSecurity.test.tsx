/**
 * WARP-2977 P2b — the Security hooks' write paths, driven for real.
 *
 * Every page and component test for P2b replaces `@/lib/hooks/useSecurity`
 * (or the api fetchers) wholesale, so nothing there can see what a hook does
 * with the server's answer: which SWR keys it writes, which it re-reads. This
 * file mocks one layer LOWER — the `@/lib/api` fetchers and writers — and
 * drives the real hooks inside a real SWRConfig, so a hook that stops
 * refreshing the mode after an hours save, or a manager's own Areas list
 * after a links save, turns a test red. (The wire itself — URL, method,
 * body — is pinned in lib/api.security.test.ts.)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import type { ReactNode } from "react";

const api = vi.hoisted(() => ({
  getSecurityHours: vi.fn(),
  getSecurityMode: vi.fn(),
  getSecurityZones: vi.fn(),
  getSecuritySources: vi.fn(),
  putSecurityHours: vi.fn(),
  putSecurityHoursException: vi.fn(),
  deleteSecurityHoursException: vi.fn(),
  createSecurityZone: vi.fn(),
  patchSecurityZone: vi.fn(),
  archiveSecurityZone: vi.fn(),
  unarchiveSecurityZone: vi.fn(),
  putSecurityZoneLinks: vi.fn(),
}));

vi.mock("@/lib/api", async (orig) => ({
  ...(await orig<typeof import("@/lib/api")>()),
  ...api,
}));

import { useSecurityHours, useSecurityMode, useSecuritySources, useSecurityZones } from "../useSecurity";

function wrapper({ children }: { children: ReactNode }) {
  return <SWRConfig value={{ dedupingInterval: 0, provider: () => new Map() }}>{children}</SWRConfig>;
}

const HOURS = (version: number) => ({ state: "set", timezone: "Europe/London", version, days: [], exceptions: [], preview: [], hint: { workspaceTimezone: null, typicalDay: "" } });
const MODE = (mode: string, version: number) => ({ mode, source: "schedule", version });

beforeEach(() => {
  vi.clearAllMocks();
  api.getSecurityHours.mockResolvedValue(HOURS(3));
  api.getSecurityMode.mockResolvedValue(MODE("open", 1));
  api.getSecurityZones.mockResolvedValue({ zones: [] });
  api.getSecuritySources.mockResolvedValue({ frigate: "ok", cameras: [], linkStatus: [] });
});

function mountHours() {
  return renderHook(() => ({ hours: useSecurityHours(), mode: useSecurityMode() }), { wrapper });
}

describe("useSecurityHours", () => {
  it("a save's views go straight into the hours AND mode caches, with no re-read", async () => {
    const { result } = mountHours();
    await waitFor(() => expect(result.current.hours.hours?.version).toBe(3));
    await waitFor(() => expect(result.current.mode.mode?.mode).toBe("open"));
    api.putSecurityHours.mockResolvedValue({ hours: HOURS(4), mode: MODE("closed", 2) });
    const reads = api.getSecurityHours.mock.calls.length;
    await act(async () => {
      await result.current.hours.save({ state: "not_set", expectedVersion: 3 });
    });
    expect(result.current.hours.hours?.version).toBe(4);
    expect(result.current.mode.mode?.mode).toBe("closed");
    expect(api.getSecurityHours.mock.calls.length).toBe(reads);
  });

  it("a special day's views go into both caches too (a special day can move the mode)", async () => {
    const { result } = mountHours();
    await waitFor(() => expect(result.current.mode.mode?.mode).toBe("open"));
    api.putSecurityHoursException.mockResolvedValue({ hours: HOURS(4), mode: MODE("closed", 2) });
    await act(async () => {
      await result.current.hours.saveException("2026-12-25", { kind: "closed", expectedVersion: 3 });
    });
    expect(result.current.hours.hours?.version).toBe(4);
    expect(result.current.mode.mode?.mode).toBe("closed");
  });

  it("removing a special day (204, no views) re-reads both the hours and the mode", async () => {
    const { result } = mountHours();
    await waitFor(() => expect(result.current.mode.mode?.mode).toBe("open"));
    api.deleteSecurityHoursException.mockResolvedValue(undefined);
    api.getSecurityHours.mockResolvedValue(HOURS(5));
    api.getSecurityMode.mockResolvedValue(MODE("closed", 3));
    await act(async () => {
      await result.current.hours.deleteException("2026-12-25", 4);
    });
    expect(result.current.hours.hours?.version).toBe(5);
    expect(result.current.mode.mode?.mode).toBe("closed");
  });

  // Saved and audited, but the server couldn't read it back: 200 {hours: null, mode: null}.
  it.each(["save", "saveException"] as const)("%s answered with null views re-reads BOTH, and never writes null into the cache", async (method) => {
    const { result } = mountHours();
    await waitFor(() => expect(result.current.hours.hours?.version).toBe(3));
    await waitFor(() => expect(result.current.mode.mode?.mode).toBe("open"));
    api.putSecurityHours.mockResolvedValue({ hours: null, mode: null });
    api.putSecurityHoursException.mockResolvedValue({ hours: null, mode: null });
    api.getSecurityHours.mockResolvedValue(HOURS(4));
    api.getSecurityMode.mockResolvedValue(MODE("closed", 2));
    let r: unknown;
    await act(async () => {
      r =
        method === "save"
          ? await result.current.hours.save({ state: "not_set", expectedVersion: 3 })
          : await result.current.hours.saveException("2026-12-25", { kind: "closed", expectedVersion: 3 });
    });
    expect(r).toEqual({ hours: null, mode: null });
    expect(result.current.hours.hours?.version).toBe(4);
    expect(result.current.mode.mode?.mode).toBe("closed");
  });
});

describe("useSecurityZones", () => {
  /** Both area lists (the feed's, and a manager's with removed areas) and the sources, mounted together. */
  function mountZones() {
    return renderHook(
      () => ({
        zones: useSecurityZones(),
        withArchived: useSecurityZones({ includeArchived: true }),
        sources: useSecuritySources(),
      }),
      { wrapper },
    );
  }

  const ZONE = { id: "z1", name: "Front door", kind: "entry", state: "active", version: 1, links: [] };

  it.each([
    ["create", (h: ReturnType<typeof useSecurityZones>) => h.create({ name: "Front door", kind: "entry" }), api.createSecurityZone],
    ["patch", (h: ReturnType<typeof useSecurityZones>) => h.patch("z1", { name: "Back door", expectedVersion: 1 }), api.patchSecurityZone],
    ["archive", (h: ReturnType<typeof useSecurityZones>) => h.archive("z1", 1), api.archiveSecurityZone],
    ["unarchive", (h: ReturnType<typeof useSecurityZones>) => h.unarchive("z1", 1), api.unarchiveSecurityZone],
    ["putLinks", (h: ReturnType<typeof useSecurityZones>) => h.putLinks("z1", { expectedVersion: 1, links: [] }), api.putSecurityZoneLinks],
  ] as const)("%s re-reads BOTH area lists and the sources' link statuses", async (_n, write, writer) => {
    const { result } = mountZones();
    await waitFor(() => expect(result.current.zones.zones).toEqual([]));
    await waitFor(() => expect(result.current.withArchived.zones).toEqual([]));
    await waitFor(() => expect(result.current.sources.sources).not.toBeNull());
    writer.mockResolvedValue({ zone: ZONE, changed: true });
    api.getSecurityZones.mockResolvedValue({ zones: [ZONE] });
    api.getSecuritySources.mockResolvedValue({ frigate: "ok", cameras: [], linkStatus: [{ linkId: "l1", status: "present" }] });
    await act(async () => {
      await write(result.current.zones);
    });
    await waitFor(() => expect(result.current.zones.zones).toEqual([ZONE]));
    await waitFor(() => expect(result.current.withArchived.zones).toEqual([ZONE]));
    await waitFor(() => expect(result.current.sources.sources?.linkStatus).toHaveLength(1));
    expect(api.getSecurityZones).toHaveBeenCalledWith({ includeArchived: true });
  });
});
