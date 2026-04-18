import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
    expect(
      screen.getByRole("dialog", { name: /create override/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/override for emma's ipad/i)).toBeInTheDocument();
    const blockRadio = screen.getByRole("radio", { name: /block/i }) as HTMLInputElement;
    expect(blockRadio.checked).toBe(true);
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
});
