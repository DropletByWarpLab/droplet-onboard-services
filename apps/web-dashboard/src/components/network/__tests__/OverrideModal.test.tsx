import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { OverrideModal } from "../OverrideModal";
import type { Schedule, ScheduleOverride } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function renderModal(
  props: Partial<React.ComponentProps<typeof OverrideModal>> = {},
) {
  const onClose = props.onClose ?? vi.fn();
  return {
    onClose,
    ...render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <OverrideModal
          subject={{ type: "device", deviceMac: "aa:bb:cc:dd:ee:ff" }}
          subjectName="Emma's iPad"
          onClose={onClose}
          {...props}
        />
      </SWRConfig>,
    ),
  };
}

/**
 * Default mock: no schedules, no active overrides, POST / DELETE succeed.
 */
function installDefaultMocks(
  fetchMock: FetchMock,
  opts: { schedules?: Schedule[]; overrides?: ScheduleOverride[] } = {},
) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (url.startsWith("/api/network/schedules") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ schedules: opts.schedules ?? [] }),
      };
    }
    if (url.startsWith("/api/network/overrides") && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ overrides: opts.overrides ?? [] }),
      };
    }
    if (url === "/api/network/overrides" && method === "POST") {
      const body = JSON.parse((init!.body as string) ?? "{}");
      return {
        ok: true,
        status: 201,
        json: async () => ({
          override: {
            id: "o-new",
            subjectType: body.subjectType,
            deviceMac: body.deviceMac,
            groupId: body.groupId,
            action: body.action,
            startAt: body.startAt ?? new Date().toISOString(),
            endAt: body.endAt,
            note: body.note,
            createdAt: new Date().toISOString(),
          } satisfies ScheduleOverride,
        }),
      };
    }
    if (url.startsWith("/api/network/overrides/") && method === "DELETE") {
      return { ok: true, status: 204, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  });
}

describe("OverrideModal", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("renders with subject name and the default action preselected", async () => {
    installDefaultMocks(fetchMock);
    renderModal({ defaultAction: "block" });
    // WARP-289: after migration the dialog is named by the visible
    // "Override for <subject>" heading instead of the previous
    // aria-label="Create override".
    expect(
      screen.getByRole("dialog", { name: /override for/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/override for emma's ipad/i)).toBeInTheDocument();
    const blockRadio = screen.getByRole("radio", { name: /block/i }) as HTMLInputElement;
    expect(blockRadio.checked).toBe(true);
  });

  // WARP-289: full modal ARIA via the shared <Dialog> primitive.
  it("renders as a role=dialog with aria-modal and aria-labelledby (WARP-289)", async () => {
    installDefaultMocks(fetchMock);
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/Override for/i);
  });

  it("clicking the 1h chip + Apply POSTs endAt = now + 1h", async () => {
    const FIXED = new Date("2026-04-14T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED);
    installDefaultMocks(fetchMock);
    renderModal();
    // Default is "1h", so clicking is idempotent — still verify.
    fireEvent.click(screen.getByRole("button", { name: "1h" }));
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/overrides" && c[1]?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      expect(body.subjectType).toBe("device");
      expect(body.deviceMac).toBe("aa:bb:cc:dd:ee:ff");
      expect(body.action).toBe("allow");
      // endAt = now + 60m.
      const endAt = new Date(body.endAt).getTime();
      expect(endAt).toBe(FIXED.getTime() + 60 * 60_000);
    });
  });

  it('"until next transition" chip label is computed and Apply sends the matching endAt', async () => {
    // Tue 10:00 local. Schedule: Sun-Thu 21:00-07:00 → next transition Tue 21:00.
    const FIXED = new Date("2026-04-14T10:00:00");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED);
    const schedule: Schedule = {
      id: "s1",
      name: "Bedtime",
      enabled: true,
      subjectType: "device",
      deviceMac: "aa:bb:cc:dd:ee:ff",
      windows: [
        {
          id: "w1",
          daysOfWeek: 1 | 2 | 4 | 8 | 16,
          startMin: 21 * 60,
          endMin: 7 * 60,
        },
      ],
      createdAt: "",
      updatedAt: "",
    };
    installDefaultMocks(fetchMock, { schedules: [schedule] });
    renderModal();
    // The transition chip should render with a label that includes "21:00".
    const chip = await screen.findByTestId("chip-transition");
    expect(chip.textContent).toMatch(/until 21:00/i);
    fireEvent.click(chip);
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/overrides" && c[1]?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      const expected = new Date("2026-04-14T21:00:00").getTime();
      expect(new Date(body.endAt).getTime()).toBe(expected);
    });
  });

  it('when no applicable schedule, renders the "+30m" fallback chip instead', async () => {
    installDefaultMocks(fetchMock, { schedules: [] });
    renderModal();
    const fallback = await screen.findByTestId("chip-fallback");
    expect(fallback).toHaveTextContent(/\+30m/);
    expect(screen.queryByTestId("chip-transition")).not.toBeInTheDocument();
  });

  it("renders the active-override banner when one exists", async () => {
    const existing: ScheduleOverride = {
      id: "o-active",
      subjectType: "device",
      deviceMac: "aa:bb:cc:dd:ee:ff",
      action: "allow",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    installDefaultMocks(fetchMock, { overrides: [existing] });
    renderModal();
    await waitFor(() => {
      expect(screen.getByTestId("active-override-banner")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("active-override-banner").textContent,
    ).toMatch(/current override/i);
  });

  it("Cancel on the active-override banner issues DELETE", async () => {
    const existing: ScheduleOverride = {
      id: "o-active",
      subjectType: "device",
      deviceMac: "aa:bb:cc:dd:ee:ff",
      action: "block",
      startAt: new Date(Date.now() - 60_000).toISOString(),
      endAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      createdAt: new Date().toISOString(),
    };
    installDefaultMocks(fetchMock, { overrides: [existing] });
    renderModal();
    const banner = await screen.findByTestId("active-override-banner");
    const cancelBtn = banner.querySelector("button")!;
    fireEvent.click(cancelBtn);
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c) =>
          typeof c[0] === "string" &&
          c[0].startsWith("/api/network/overrides/o-active") &&
          c[1]?.method === "DELETE",
      );
      expect(deleteCall).toBeDefined();
    });
  });

  it("Custom datetime + Apply sends that datetime as endAt", async () => {
    const FIXED = new Date("2026-04-14T10:00:00");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED);
    installDefaultMocks(fetchMock);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    const input = await screen.findByLabelText(/^end at$/i);
    // Pick 3pm the same day.
    fireEvent.change(input, { target: { value: "2026-04-14T15:00" } });
    fireEvent.click(screen.getByRole("button", { name: /^apply$/i }));
    await waitFor(() => {
      const postCall = fetchMock.mock.calls.find(
        (c) => c[0] === "/api/network/overrides" && c[1]?.method === "POST",
      );
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall![1].body);
      const expected = new Date("2026-04-14T15:00").getTime();
      expect(new Date(body.endAt).getTime()).toBe(expected);
    });
  });

  it("Custom with empty endAt leaves Apply disabled", async () => {
    installDefaultMocks(fetchMock);
    renderModal();
    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    const applyBtn = screen.getByRole("button", {
      name: /^apply$/i,
    }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);
  });

  it("does NOT render the subject picker when subject is pre-filled", async () => {
    installDefaultMocks(fetchMock);
    renderModal();
    // Default renderModal fixture passes a device subject, so the picker
    // should be hidden (existing WARP-97/98 behavior is preserved).
    expect(screen.queryByTestId("subject-picker")).not.toBeInTheDocument();
  });

  it("renders the subject picker and disables Apply until a subject is chosen", async () => {
    // Provide at least one device so the dropdown has something to pick.
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (url.startsWith("/api/network/schedules") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ schedules: [] }) };
      }
      if (url.startsWith("/api/network/overrides") && method === "GET") {
        return { ok: true, status: 200, json: async () => ({ overrides: [] }) };
      }
      if (url.startsWith("/api/network/devices")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            devices: [
              {
                mac: "aa:bb:cc:dd:ee:01",
                displayName: "Emma's iPad",
                icon: null,
                notes: null,
                vendor: null,
                hostname: "ipad",
                lastIp: null,
                firstSeen: "",
                lastSeen: "",
                isBlocked: false,
                online: true,
                groups: [],
              },
            ],
          }),
        };
      }
      if (url.startsWith("/api/network/groups")) {
        return { ok: true, status: 200, json: async () => ({ groups: [] }) };
      }
      if (url === "/api/network/overrides" && method === "POST") {
        return { ok: true, status: 201, json: async () => ({ override: {} }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    });

    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <OverrideModal
          subject={{ type: "device" }}
          defaultAction="block"
          defaultDurationMin={90}
          onClose={vi.fn()}
        />
      </SWRConfig>,
    );

    expect(screen.getByTestId("subject-picker")).toBeInTheDocument();
    const applyBtn = screen.getByRole("button", {
      name: /^apply$/i,
    }) as HTMLButtonElement;
    expect(applyBtn.disabled).toBe(true);

    // The subject picker exposes a Device <select> inside the fieldset.
    const picker = screen.getByTestId("subject-picker");
    // Wait for SWR to populate the dropdown before picking an option.
    await waitFor(() => {
      const sel = picker.querySelector("select")!;
      expect(sel.querySelectorAll("option").length).toBeGreaterThan(1);
    });
    const deviceSelect = picker.querySelector("select") as HTMLSelectElement;
    fireEvent.change(deviceSelect, { target: { value: "aa:bb:cc:dd:ee:01" } });

    await waitFor(() => {
      expect(applyBtn.disabled).toBe(false);
    });
  });

  // WARP-103: the "until next transition" chip and computed endAt are driven by
  // a 60s tick so they don't go stale if the modal stays open across the
  // transition boundary. We fake all timers (so advanceTimersByTime fires the
  // interval) and flush microtasks via act() rather than using findBy/waitFor,
  // which poll on real timers that fake timers would stall.
  it("refreshes the transition chip label as wall-clock advances past the boundary (WARP-103)", async () => {
    // Tue 20:59 local, one minute before the 21:00-07:00 bedtime window opens.
    const FIXED = new Date("2026-04-14T20:59:00");
    vi.useFakeTimers();
    vi.setSystemTime(FIXED);
    const schedule: Schedule = {
      id: "s1",
      name: "Bedtime",
      enabled: true,
      subjectType: "device",
      deviceMac: "aa:bb:cc:dd:ee:ff",
      windows: [
        {
          id: "w1",
          daysOfWeek: 1 | 2 | 4 | 8 | 16,
          startMin: 21 * 60,
          endMin: 7 * 60,
        },
      ],
      createdAt: "",
      updatedAt: "",
    };
    installDefaultMocks(fetchMock, { schedules: [schedule] });
    renderModal();

    // Flush the SWR fetch + effects so the schedule-driven chip renders.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    // At 20:59 the next transition is 21:00, one minute out.
    const chip = screen.getByTestId("chip-transition");
    expect(chip.textContent).toMatch(/until 21:00 \(1m\)/i);

    // Advance two minutes of wall-clock; the 60s interval should fire and force
    // a re-render. We're now at 21:01 — inside the window — so the next
    // transition flips to the 07:00 window close the following morning.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    const refreshed = screen.getByTestId("chip-transition");
    expect(refreshed.textContent).toMatch(/until 07:00/i);
    expect(refreshed.textContent).not.toMatch(/until 21:00/i);
  });

  // WARP-103 AC3: once wall-clock ticks past the selected endAt, Apply flips to
  // disabled — the disable is driven by the same nowTick, not a stale render.
  it("disables Apply once the tick crosses the selected endAt (WARP-103)", async () => {
    // 20:59 local; pick a custom endAt one minute out (21:00).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T20:59:00"));
    installDefaultMocks(fetchMock);
    renderModal();

    fireEvent.click(screen.getByRole("button", { name: /custom/i }));
    const input = screen.getByLabelText(/^end at$/i);
    fireEvent.change(input, { target: { value: "2026-04-14T21:00" } });

    const applyBtn = screen.getByRole("button", {
      name: /^apply$/i,
    }) as HTMLButtonElement;
    // endAt (21:00) is still ahead of now (20:59) → enabled.
    expect(applyBtn.disabled).toBe(false);

    // Advance two minutes (to 21:01) so the tick fires and now is past endAt.
    await act(async () => {
      vi.advanceTimersByTime(120_000);
      await Promise.resolve();
    });

    expect(applyBtn.disabled).toBe(true);
  });

  // WARP-103 AC4: the 60s interval is cleared on unmount so it stops bumping
  // state after the modal closes.
  it("clears the 60s tick interval on unmount (WARP-103)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-14T20:59:00"));
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    installDefaultMocks(fetchMock);
    const { unmount } = renderModal();
    // Let the initial render + effects settle.
    await act(async () => {
      await Promise.resolve();
    });
    const before = clearSpy.mock.calls.length;
    unmount();
    expect(clearSpy.mock.calls.length).toBeGreaterThan(before);
    clearSpy.mockRestore();
  });
});
