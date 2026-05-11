import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { QuickSchedulePopover } from "../QuickSchedulePopover";

type FetchMock = ReturnType<typeof vi.fn>;

function renderPopover(
  subject: React.ComponentProps<typeof QuickSchedulePopover>["subject"] = {
    type: "device",
    deviceMac: "aa:bb:cc:dd:ee:01",
  },
  onClose = vi.fn(),
) {
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <QuickSchedulePopover subject={subject} onClose={onClose} />
    </SWRConfig>,
  );
}

describe("QuickSchedulePopover", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders with the Bedtime preset copy", () => {
    renderPopover();
    expect(screen.getByText("Apply Bedtime?")).toBeInTheDocument();
    expect(
      screen.getByText(/Sun–Thu 9pm–7am, Fri–Sat 11pm–8am/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Apply quick schedule" }),
    ).toBeInTheDocument();
  });

  it("Apply POSTs /api/network/schedules with Bedtime windows and device subject", async () => {
    const subject = {
      type: "device" as const,
      deviceMac: "aa:bb:cc:dd:ee:01",
    };
    const onClose = vi.fn();
    renderPopover(subject, onClose);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) =>
          typeof c[0] === "string" &&
          c[0] === "/api/network/schedules" &&
          c[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body.name).toBe("Bedtime");
      expect(body.enabled).toBe(true);
      expect(body.subjectType).toBe("device");
      expect(body.deviceMac).toBe(subject.deviceMac);
      expect(body.windows).toHaveLength(2);
      // Sun-Thu mask = 1|2|4|8|16 = 31; Fri-Sat = 32|64 = 96.
      expect(body.windows[0]).toEqual({
        daysOfWeek: 31,
        startMin: 21 * 60,
        endMin: 7 * 60,
      });
      expect(body.windows[1]).toEqual({
        daysOfWeek: 96,
        startMin: 23 * 60,
        endMin: 8 * 60,
      });
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("Apply uses groupId when subject is a group", async () => {
    const onClose = vi.fn();
    renderPopover({ type: "group", groupId: "g-kids" }, onClose);

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await waitFor(() => {
      const postCalls = fetchMock.mock.calls.filter(
        (c) => c[0] === "/api/network/schedules" && c[1]?.method === "POST",
      );
      expect(postCalls).toHaveLength(1);
      const body = JSON.parse(postCalls[0][1].body);
      expect(body.subjectType).toBe("group");
      expect(body.groupId).toBe("g-kids");
      expect(body.deviceMac).toBeUndefined();
    });
  });

  it("Customize swaps to the schedule editor modal", async () => {
    renderPopover();

    fireEvent.click(screen.getByRole("button", { name: "Customize" }));

    // WARP-289: the editor modal is now named by its heading via
    // aria-labelledby. "Customize" enters the creation path, so the
    // heading reads "New schedule".
    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: /new schedule/i }),
      ).toBeInTheDocument();
    });
  });

  it("ESC closes the popover", () => {
    const onClose = vi.fn();
    renderPopover(undefined, onClose);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
