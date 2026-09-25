/**
 * WARP-2980 (ADR-059 P5 PR-B, brief §4.4) — the "Expected activity" card on
 * /security/patterns.
 *
 * Pins:
 *   - a read that fails is the friendly copy and Retry, never the empty state
 *     ("nothing is marked as expected" and "Droplet couldn't say" must not
 *     look the same) and never the server's message;
 *   - Add and Remove come from route 32's `canManage` only — the card takes
 *     no role or level, so an owner whose list says `canManage: false` sees
 *     neither;
 *   - each row's words: what and where, the site's days and hours, the flags
 *     it stops, the reason, "Until … · added by …" on the SITE's calendar,
 *     "Removed area" for an archived area, "Kept N flags quiet" only when the
 *     server sent a number;
 *   - Remove names its row, calls route 34, toasts, and refreshes through the
 *     hook's own mutate — also when it fails (friendly toast);
 *   - Add opens the form and a save calls route 33, toasts the site date and
 *     refreshes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SecurityPatternsOverview, SecuritySuppressionList, SecuritySuppressionView } from "@/lib/types";

const h = vi.hoisted(() => ({
  list: null as unknown,
  error: undefined as Error | undefined,
  mutate: vi.fn(),
  toast: vi.fn(),
  create: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("@/lib/hooks/useSecurity", () => ({
  useSecuritySuppressions: () => ({ list: h.list, error: h.error, isLoading: h.list === null && !h.error, mutate: h.mutate }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, createSecuritySuppression: h.create, removeSecuritySuppression: h.remove };
});

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));

import { ExpectedActivityCard, expectedWhat, expectedWhen } from "@/components/security/ExpectedActivityCard";
import { EXPECTED_COPY as C, EXPECTED_DIALOG_COPY as D } from "@/components/security/patterns-copy";

const TZ = "America/New_York";
/** 22:30 on Sep 24 in New York; Sep 25 in UTC. */
const NOW = new Date("2026-09-25T02:30:00.000Z");

const OVERVIEW: SecurityPatternsOverview = {
  state: "ready",
  reason: null,
  timezone: TZ,
  window: { from: "2026-08-27T04:00:00.000Z", to: "2026-09-24T04:00:00.000Z", builtAt: "2026-09-24T07:00:00.000Z" },
  release: { out_of_place: "trial", unusual_volume: "trial", long_dwell: "trial" },
  sources: [],
  keys: [
    { zoneKey: "zone:z-stock", kind: "area", zoneId: "z-stock", name: "Stock room", cameras: ["stock"], labels: ["person", "car"], learning: false },
    { zoneKey: "camera:back", kind: "camera", zoneId: null, name: "Back camera", cameras: ["back"], labels: ["car"], learning: false },
  ],
  waitingProposals: 0,
  precision: null,
};

/** Expires 23:30 on Oct 24 in New York — Oct 25 in UTC. */
const ROW: SecuritySuppressionView = {
  id: "sup-1",
  target: { kind: "area", zoneId: "z-stock", name: "Stock room", archived: false },
  label: "person",
  days: "weekdays",
  hourFrom: 22,
  hourCount: 2,
  codes: ["out_of_place", "long_dwell"],
  reason: "The cleaner comes on weekday evenings",
  createdByName: "Stefan",
  createdAt: "2026-09-25T02:00:00.000Z",
  expiresAt: "2026-10-25T03:30:00.000Z",
  quietedFlags: 3,
};

const CAR_ROW: SecuritySuppressionView = {
  ...ROW,
  id: "sup-2",
  target: { kind: "camera", camera: "back", name: "Back camera" },
  label: "car",
  days: "every_day",
  hourFrom: 0,
  hourCount: 24,
  codes: ["unusual_volume"],
  reason: "Deliveries",
  quietedFlags: null,
};

function listOf(suppressions: SecuritySuppressionView[], canManage: boolean): SecuritySuppressionList {
  return { suppressions, canManage, limit: 100 };
}

function typedError(code: string, status: number, message = "raw server words"): Error {
  return Object.assign(new Error(message), { code, status });
}

const REMOVE_ROW = "Remove expected activity: Person in Stock room, Weekdays, 10 PM–12 AM";

function renderCard(overview: SecurityPatternsOverview = OVERVIEW) {
  return render(<ExpectedActivityCard overview={overview} now={NOW} />);
}

beforeEach(() => {
  h.list = null;
  h.error = undefined;
  h.mutate.mockReset().mockResolvedValue(undefined);
  h.toast.mockReset();
  h.create.mockReset();
  h.remove.mockReset();
});

describe("ExpectedActivityCard — reading", () => {
  it("a failed read is the friendly copy and Retry — never the empty state, never the server's words", () => {
    h.error = typedError("SUPPRESSIONS_UNAVAILABLE", 503);
    renderCard();
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Droplet couldn't load expected activity right now. This is not the same as there being none.");
    expect(screen.queryByText(C.empty)).toBeNull();
    expect(screen.queryByText(C.emptyManage)).toBeNull();
    expect(screen.queryByText("raw server words")).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: C.retry }));
    expect(h.mutate).toHaveBeenCalledTimes(1);
  });

  it("while loading shows neither the empty state nor Add", () => {
    renderCard();
    expect(screen.getByTestId("expected-loading")).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText(C.empty)).toBeNull();
    expect(screen.queryByRole("button", { name: C.add })).toBeNull();
  });

  it("an empty list says so, in the manager's words only when the server says they can manage", () => {
    h.list = listOf([], false);
    const { unmount } = renderCard();
    expect(screen.getByText(C.empty)).toBeInTheDocument();
    unmount();
    h.list = listOf([], true);
    renderCard();
    expect(screen.getByText(C.emptyManage)).toBeInTheDocument();
  });

  it("reads each row in the owner's words, the dates on the site's calendar", () => {
    h.list = listOf([ROW], false);
    renderCard();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Person in Stock room");
    expect(row).toHaveTextContent("Weekdays, 10 PM–12 AM");
    expect(row).toHaveTextContent("Not usual at this time · Stayed longer than usual");
    expect(row).toHaveTextContent("“The cleaner comes on weekday evenings”");
    // 03:30 UTC on Oct 25 is 23:30 on Oct 24 at the site.
    expect(row).toHaveTextContent("Until Oct 24 · added by Stefan");
    expect(row).toHaveTextContent("Kept 3 flags quiet");
    expect(row).not.toHaveTextContent(C.removedArea);
  });

  it("names a camera target, says All day, and shows no quiet count when the server sent none", () => {
    h.list = listOf([CAR_ROW], false);
    renderCard();
    const row = screen.getByRole("listitem");
    expect(row).toHaveTextContent("Car on Back camera");
    expect(row).toHaveTextContent("Every day, All day");
    expect(row).toHaveTextContent("Busier than usual");
    expect(row).not.toHaveTextContent("Kept");
  });

  it("says one flag in the singular and nothing for zero", () => {
    h.list = listOf([{ ...ROW, quietedFlags: 1 }, { ...ROW, id: "sup-3", quietedFlags: 0 }], false);
    renderCard();
    const [one, zero] = screen.getAllByRole("listitem");
    expect(one).toHaveTextContent("Kept 1 flag quiet");
    expect(zero).not.toHaveTextContent("Kept");
  });

  it("marks a row whose area was archived as a Removed area", () => {
    h.list = listOf([{ ...ROW, target: { kind: "area", zoneId: "z-stock", name: "Stock room", archived: true } }], false);
    renderCard();
    expect(within(screen.getByRole("listitem")).getByText(C.removedArea)).toBeInTheDocument();
  });

  it("expectedWhat / expectedWhen", () => {
    expect(expectedWhat(ROW)).toBe("Person in Stock room");
    expect(expectedWhat(CAR_ROW)).toBe("Car on Back camera");
    expect(expectedWhen(ROW)).toBe("Weekdays, 10 PM–12 AM");
    expect(expectedWhen({ days: "weekends", hourFrom: 23, hourCount: 3 })).toBe("Weekends, 11 PM–2 AM");
  });
});

describe("ExpectedActivityCard — the controls come from the server's canManage", () => {
  it("canManage false: no Add and no Remove, whatever the viewer's role", () => {
    h.list = listOf([ROW, CAR_ROW], false);
    renderCard();
    expect(screen.queryByRole("button", { name: C.add })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("canManage true: Add, and a Remove per row that names the row", () => {
    h.list = listOf([ROW, CAR_ROW], true);
    renderCard();
    expect(screen.getByRole("button", { name: C.add })).toBeEnabled();
    expect(screen.getByRole("button", { name: REMOVE_ROW })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove expected activity: Car on Back camera, Every day, All day" })).toBeInTheDocument();
  });

  it("with nothing learned yet, Add is disabled and says why", () => {
    h.list = listOf([], true);
    renderCard({ ...OVERVIEW, keys: [] });
    const add = screen.getByRole("button", { name: C.add });
    expect(add).toBeDisabled();
    expect(add).toHaveAccessibleDescription(D.noKeys);
  });
});

describe("ExpectedActivityCard — remove", () => {
  it("calls route 34 for that row, toasts, and refreshes", async () => {
    h.list = listOf([ROW, CAR_ROW], true);
    h.remove.mockResolvedValue({ changed: true });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: REMOVE_ROW }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
    expect(h.remove).toHaveBeenCalledWith("sup-1");
    expect(h.toast).toHaveBeenCalledWith(C.removed, "success");
  });

  it("a refusal is a friendly toast (never the server's words), then a refresh", async () => {
    h.list = listOf([ROW], true);
    h.remove.mockRejectedValue(typedError("SUPPRESSION_NOT_FOUND", 404));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: REMOVE_ROW }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
    expect(h.toast).toHaveBeenCalledWith("That expected activity isn't there any more. Refresh the page.", "error");
    expect(h.toast).not.toHaveBeenCalledWith(expect.stringContaining("raw server words"), expect.anything());
  });
});

describe("ExpectedActivityCard — add", () => {
  it("opens the form; a save calls route 33, toasts the site date it ends, and refreshes", async () => {
    h.list = listOf([], true);
    h.create.mockResolvedValue({ suppression: ROW });
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: C.add }));
    const dialog = await screen.findByRole("dialog", { name: D.title });
    fireEvent.change(within(dialog).getByLabelText(D.reason), { target: { value: "Stocktake" } });
    fireEvent.click(within(dialog).getByRole("button", { name: D.save }));
    await waitFor(() => expect(h.mutate).toHaveBeenCalledTimes(1));
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.create.mock.calls[0][0]).toMatchObject({ target: { kind: "area", zoneId: "z-stock" }, reason: "Stocktake" });
    expect(h.toast).toHaveBeenCalledWith("Added. Droplet won't flag this as unusual until Oct 24.", "success");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
