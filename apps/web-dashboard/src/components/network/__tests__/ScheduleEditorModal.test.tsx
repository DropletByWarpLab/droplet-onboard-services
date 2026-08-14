import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { ScheduleEditorModal } from "../ScheduleEditorModal";
import type { Schedule } from "@/lib/types";

type FetchMock = ReturnType<typeof vi.fn>;

function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "s1",
    name: "Bedtime",
    enabled: true,
    subjectType: "group",
    groupId: "kids",
    windows: [{ id: "w1", daysOfWeek: 31, startMin: 21 * 60, endMin: 7 * 60 }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function renderModal(
  opts: {
    scheduleId?: string | "new" | null;
    onClose?: () => void;
    schedules?: Schedule[];
  } = {},
) {
  const onClose = opts.onClose ?? vi.fn();
  return {
    onClose,
    ...render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ScheduleEditorModal
          scheduleId={opts.scheduleId ?? "new"}
          onClose={onClose}
        />
      </SWRConfig>,
    ),
  };
}

function mockEndpoints(fetchMock: FetchMock, schedules: Schedule[]) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.startsWith("/api/network/schedules") && (!init || init.method === undefined || init.method === "GET"))
      return { ok: true, status: 200, json: async () => ({ schedules }) };
    if (url.startsWith("/api/network/devices"))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          devices: [
            {
              mac: "aa:bb",
              displayName: "iPad",
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
    if (url.startsWith("/api/network/groups"))
      return {
        ok: true,
        status: 200,
        json: async () => ({
          groups: [{ id: "kids", name: "Kids", _count: { devices: 2 } }],
        }),
      };
    return { ok: true, status: 200, json: async () => ({ schedule: { id: "s1" } }) };
  });
}

describe("ScheduleEditorModal", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders pre-filled fields for an existing schedule", async () => {
    mockEndpoints(fetchMock, [makeSchedule()]);
    renderModal({ scheduleId: "s1" });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^name$/i) as HTMLInputElement).value,
      ).toBe("Bedtime");
    });
  });

  it("subject selector is disabled when editing an existing schedule", async () => {
    mockEndpoints(fetchMock, [makeSchedule()]);
    renderModal({ scheduleId: "s1" });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^name$/i) as HTMLInputElement).value,
      ).toBe("Bedtime");
    });
    const deviceRadio = screen.getByRole("radio", { name: /device/i });
    const groupRadio = screen.getByRole("radio", { name: /^group$/i });
    expect(deviceRadio).toBeDisabled();
    expect(groupRadio).toBeDisabled();
    // The dropdown for the current subject type should also be disabled.
    expect(screen.getByRole("combobox", { name: /^group$/i })).toBeDisabled();
  });

  it("ESC key closes the modal (calls onClose)", async () => {
    mockEndpoints(fetchMock, []);
    const onClose = vi.fn();
    renderModal({ scheduleId: "new", onClose });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("click on backdrop closes the modal", () => {
    mockEndpoints(fetchMock, []);
    const onClose = vi.fn();
    renderModal({ scheduleId: "new", onClose });
    // WARP-289: the visible backdrop is rendered by the shared
    // <Dialog> primitive as the dialog container's parent element.
    const dialog = screen.getByRole("dialog");
    fireEvent.click(dialog.parentElement!);
    expect(onClose).toHaveBeenCalled();
  });

  // WARP-289: full modal ARIA via the shared <Dialog> primitive.
  it("renders as a role=dialog with aria-modal and aria-labelledby", () => {
    mockEndpoints(fetchMock, []);
    renderModal();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy!);
    expect(heading).not.toBeNull();
    expect(heading!.textContent).toMatch(/New schedule|Edit schedule/);
  });

  it("Save on update path calls PATCH without subject fields", async () => {
    mockEndpoints(fetchMock, [makeSchedule()]);
    renderModal({ scheduleId: "s1" });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^name$/i) as HTMLInputElement).value,
      ).toBe("Bedtime");
    });
    fireEvent.change(screen.getByLabelText(/^name$/i), {
      target: { value: "Bedtime v2" },
    });
    // WARP-288: confirm the Save button uses the canonical primary-button
    // class (was `dp-button-primary`, which Tailwind silently dropped).
    // WARP-1084 moved this surface onto the indigo shell, so the canonical
    // class is now the shell's `.btn primary`.
    const saveBtn = screen.getByRole("button", { name: /^save$/i });
    expect(saveBtn).toHaveClass("btn", "primary");
    fireEvent.click(saveBtn);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) =>
          c[0] === "/api/network/schedules/s1" &&
          (c[1]?.method === "PATCH"),
      );
      expect(call).toBeDefined();
      const body = JSON.parse(call![1].body);
      expect(body.name).toBe("Bedtime v2");
      expect(body).not.toHaveProperty("subjectType");
      expect(body).not.toHaveProperty("groupId");
      expect(body).not.toHaveProperty("deviceMac");
    });
  });

  it("Save strips window ids from the API body (update path)", async () => {
    // Existing schedule with a window that has an id.
    mockEndpoints(fetchMock, [makeSchedule()]);
    renderModal({ scheduleId: "s1" });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^name$/i) as HTMLInputElement).value,
      ).toBe("Bedtime");
    });
    // Add a new window (no id) via the editor's "Add window" button.
    fireEvent.click(screen.getByRole("button", { name: /add window/i }));
    // Save.
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      const patchCall = fetchMock.mock.calls.find(
        (c) =>
          c[0] === "/api/network/schedules/s1" && c[1]?.method === "PATCH",
      );
      expect(patchCall).toBeDefined();
      const body = JSON.parse(patchCall![1].body);
      expect(Array.isArray(body.windows)).toBe(true);
      expect(body.windows.length).toBeGreaterThanOrEqual(2);
      for (const w of body.windows) {
        expect(w).not.toHaveProperty("id");
        expect(w.daysOfWeek).toBeDefined();
        expect(w.startMin).toBeDefined();
        expect(w.endMin).toBeDefined();
      }
    });
  });

  it("initialPreset='school' pre-fills name + windows from SCHEDULE_PRESETS", async () => {
    mockEndpoints(fetchMock, []);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ScheduleEditorModal
          scheduleId="new"
          initialPreset="school"
          onClose={vi.fn()}
        />
      </SWRConfig>,
    );
    const nameInput = (await screen.findByLabelText(
      /^name$/i,
    )) as HTMLInputElement;
    expect(nameInput.value).toBe("School hours");
    // School preset has exactly one window (Mon–Fri 8am–3pm).
    const windows = screen.getAllByRole("group", { name: /^window \d+$/i });
    expect(windows).toHaveLength(1);
  });

  it("Save with a typed error shows a toast and keeps the form open", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.startsWith("/api/network/schedules/s1") && init?.method === "PATCH") {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: { code: "SCHEDULE_INVALID_WINDOW", message: "bad" },
          }),
        };
      }
      if (url.startsWith("/api/network/schedules"))
        return {
          ok: true,
          status: 200,
          json: async () => ({ schedules: [makeSchedule()] }),
        };
      if (url.startsWith("/api/network/devices"))
        return { ok: true, status: 200, json: async () => ({ devices: [] }) };
      if (url.startsWith("/api/network/groups"))
        return {
          ok: true,
          status: 200,
          json: async () => ({
            groups: [{ id: "kids", name: "Kids", _count: { devices: 0 } }],
          }),
        };
      return { ok: true, status: 200, json: async () => ({}) };
    });
    const onClose = vi.fn();
    renderModal({ scheduleId: "s1", onClose });
    await waitFor(() => {
      expect(
        (screen.getByLabelText(/^name$/i) as HTMLInputElement).value,
      ).toBe("Bedtime");
    });
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /check your schedule windows/i,
      );
    });
    expect(onClose).not.toHaveBeenCalled();
    // Form still open.
    expect(
      screen.getByRole("dialog", { name: /edit schedule/i }),
    ).toBeInTheDocument();
  });
});
