/**
 * WARP-2977 P2b (ADR-059 §3.4) — /security/zones, "Areas".
 *
 * Pins:
 *   - below manage (none / view / act) NO manage control is in the DOM —
 *     never rendered-then-refused, because a refused click writes an
 *     access-denied row the Security feed then shows as a warning;
 *   - the sources are fetched at every level, and archived areas are asked
 *     for only at manage;
 *   - the "Covered by" wording, the missing / couldn't-check flags, the
 *     empty state per level, the remove confirmation's exact words;
 *   - every write's failure is a translateError toast (never the server's
 *     message) followed by a refresh through the hooks' own mutate.
 */
import type { ReactNode } from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ModuleLevel } from "@/lib/hooks/useModuleGate";
import type { SecuritySourcesView, SecurityZoneLinkView, SecurityZoneView } from "@/lib/types";

const h = vi.hoisted(() => ({
  level: "manage" as string,
  zones: null as unknown,
  zonesError: undefined as Error | undefined,
  sources: null as unknown,
  sourcesError: undefined as Error | undefined,
  zonesOpts: [] as Array<{ includeArchived?: boolean } | undefined>,
  sourcesCalls: 0,
  create: vi.fn(),
  patch: vi.fn(),
  archive: vi.fn(),
  unarchive: vi.fn(),
  putLinks: vi.fn(),
  zonesMutate: vi.fn(),
  sourcesMutate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@/lib/hooks/useSecurity", () => ({
  useSecurityZones: (opts?: { includeArchived?: boolean }) => {
    h.zonesOpts.push(opts);
    return {
      zones: h.zones,
      error: h.zonesError,
      isLoading: h.zones === null && !h.zonesError,
      mutate: h.zonesMutate,
      create: h.create,
      patch: h.patch,
      archive: h.archive,
      unarchive: h.unarchive,
      putLinks: h.putLinks,
    };
  },
  useSecuritySources: () => {
    h.sourcesCalls += 1;
    return { sources: h.sources, error: h.sourcesError, isLoading: false, mutate: h.sourcesMutate };
  },
}));

vi.mock("@/lib/hooks/useModuleGate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/hooks/useModuleGate")>();
  return { ...actual, useModuleLevel: () => h.level as ModuleLevel };
});

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: h.toast }) }));

vi.mock("@/components/shell/ShellPage", () => ({
  ShellPage: ({ title, sub, children }: { title?: string; sub?: string; children?: ReactNode }) => (
    <div>
      <h1>{title}</h1>
      <p data-testid="page-sub">{sub}</p>
      {children}
    </div>
  ),
}));

import { AreasPanel, COPY, coveredByLine, linkProblems } from "@/components/security/AreasPanel";
import { COPY as DIALOG_COPY } from "@/components/security/AreaDialog";
import { COPY as LINKS_COPY } from "@/components/security/AreaLinksDialog";
import SecurityAreasPage from "@/app/security/zones/page";

const AT = "2026-09-23T10:00:00.000Z";
const RAW_SERVER_MESSAGE = "prisma P2034 write conflict on SecurityZone row";

function link(id: string, sourceKind: SecurityZoneLinkView["sourceKind"], sourceRef: string, label: string): SecurityZoneLinkView {
  return { id, sourceKind, sourceRef, label, state: "active", stateChangedAt: AT };
}

const FRONT: SecurityZoneView = {
  id: "z-front",
  name: "Front door",
  kind: "entry",
  state: "active",
  version: 3,
  links: [link("l1", "camera", "front_cam", "Front camera"), link("l2", "camera_zone", "back_cam/till", "Back camera")],
};
const STOCK: SecurityZoneView = {
  id: "z-stock",
  name: "Stock room",
  kind: "restricted",
  state: "active",
  version: 1,
  links: [
    link("l3", "camera", "cam_3", "Cam 3"),
    link("l4", "camera_zone", "back_cam/shelf", "Back camera"),
    link("l5", "camera_zone", "gone_cam/door", "Gone camera"),
  ],
};
const BARE: SecurityZoneView = { id: "z-bare", name: "Shop floor", kind: "interior", state: "active", version: 0, links: [] };
const OLD: SecurityZoneView = { id: "z-old", name: "Car park", kind: "parking", state: "archived", version: 5, links: [] };

const SOURCES: SecuritySourcesView = {
  frigate: "ok",
  cameras: [
    { name: "front_cam", label: "Front camera", parts: ["porch"] },
    { name: "back_cam", label: "Back camera", parts: ["till"] },
  ],
  linkStatus: [
    { linkId: "l1", status: "present" },
    { linkId: "l2", status: "present" },
    { linkId: "l3", status: "missing" },
    { linkId: "l4", status: "missing" },
    { linkId: "l5", status: "missing" },
  ],
  // WARP-2977 P2b-2: a viewer without Devices view — no door locks anywhere.
  locks: { state: "hidden", items: [] },
};

function typedError(code: string, status: number): Error {
  return Object.assign(new Error(RAW_SERVER_MESSAGE), { code, status });
}

/**
 * A closed <Dialog> lingers in the DOM for its exit animation, so "still
 * open" is only proven once that animation would have finished.
 */
async function expectStillOpen(name: string) {
  await new Promise((r) => setTimeout(r, 600));
  expect(screen.getByRole("dialog", { name })).toBeInTheDocument();
}

const card = (name: string) => {
  const heading = screen.getByRole("heading", { name });
  const li = heading.closest("li");
  if (!li) throw new Error(`no card for ${name}`);
  return within(li);
};

beforeEach(() => {
  h.level = "manage";
  h.zones = [FRONT, STOCK, BARE, OLD];
  h.zonesError = undefined;
  h.sources = SOURCES;
  h.sourcesError = undefined;
  h.zonesOpts = [];
  h.sourcesCalls = 0;
  for (const fn of [h.create, h.patch, h.archive, h.unarchive, h.putLinks, h.zonesMutate, h.sourcesMutate, h.toast]) {
    fn.mockReset();
  }
  h.zonesMutate.mockResolvedValue(undefined);
  h.sourcesMutate.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("the /security/zones page", () => {
  it("is titled Areas, with the spec's sub line", () => {
    render(<SecurityAreasPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Areas" })).toBeInTheDocument();
    expect(screen.getByTestId("page-sub")).toHaveTextContent(
      "Name the places you care about and say which cameras cover each. The feed then says where things happened.",
    );
  });
});

describe("AreasPanel — levels", () => {
  it.each(["none", "view", "act"])("at %s, renders the cards but NO manage control", (level) => {
    h.level = level;
    // An archived row in the answer (the server ignores include=archived
    // below manage, so this is belt and braces) must still not surface.
    h.zones = [FRONT, STOCK, OLD];
    render(<AreasPanel />);
    expect(screen.getByRole("heading", { name: "Front door" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: COPY.add })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.whatCovers })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.edit })).toBeNull();
    expect(screen.queryByRole("button", { name: COPY.remove })).toBeNull();
    expect(screen.queryByText(COPY.removedTitle)).toBeNull();
    expect(screen.queryByText("Car park")).toBeNull();
    expect(screen.queryByRole("button", { name: /Restore/ })).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each(["none", "view", "act"])("at %s, still fetches the sources and does not ask for archived areas", (level) => {
    h.level = level;
    render(<AreasPanel />);
    expect(h.sourcesCalls).toBeGreaterThan(0);
    // Non-empty first, or `every` below passes on nothing.
    expect(h.zonesOpts.length).toBeGreaterThan(0);
    expect(h.zonesOpts.every((o) => o?.includeArchived === false)).toBe(true);
  });

  it("at manage, shows every control and asks for archived areas too", () => {
    render(<AreasPanel />);
    expect(h.sourcesCalls).toBeGreaterThan(0);
    expect(h.zonesOpts.at(-1)).toEqual({ includeArchived: true });
    expect(screen.getByRole("button", { name: COPY.add })).toBeInTheDocument();
    const front = card("Front door");
    // Every card repeats these words, so each button is described by its area's name.
    for (const name of [COPY.whatCovers, COPY.edit, COPY.remove]) {
      expect(front.getByRole("button", { name })).toHaveAccessibleDescription("Front door");
    }
  });

  it("lists archived areas only under the collapsed Removed areas, not as cards", () => {
    render(<AreasPanel />);
    expect(screen.queryByRole("heading", { name: "Car park" })).toBeNull();
    const removed = screen.getByText(COPY.removedTitle).closest("details");
    expect(removed).not.toBeNull();
    expect(removed).not.toHaveAttribute("open");
    expect(within(removed as HTMLElement).getByText("Car park")).toBeInTheDocument();
  });
});

describe("AreasPanel — what each card says", () => {
  it("names each camera and part that covers the area", () => {
    render(<AreasPanel />);
    expect(card("Front door").getByText(/^Covered by:/)).toHaveTextContent(
      "Covered by: Front camera (whole view), Back camera (the 'till' part of the view)",
    );
    expect(card("Front door").getByText("Way in")).toBeInTheDocument();
    expect(card("Shop floor").getByText(COPY.notCovered)).toBeInTheDocument();
  });

  it("flags each missing link in words, and says a returning camera covers it again", () => {
    render(<AreasPanel />);
    const stock = card("Stock room");
    expect(stock.getByText("Cam 3 isn't set up any more")).toHaveClass("badge", "warn");
    expect(stock.getByText("The 'shelf' part of Back camera was removed in its camera settings")).toHaveClass(
      "badge",
      "warn",
    );
    // The whole camera is gone, so it reads as the camera, not its part.
    expect(stock.getByText("Gone camera isn't set up any more")).toBeInTheDocument();
    expect(stock.getByText(COPY.reuseHint)).toBeInTheDocument();
    expect(card("Front door").queryByText(/isn't set up any more|was removed/)).toBeNull();
  });

  it("names a gone camera once, however many of its parts cover the area", () => {
    h.zones = [
      {
        ...BARE,
        id: "z-yard",
        name: "Yard",
        links: [
          link("m1", "camera", "gone_cam", "Gone camera"),
          link("m2", "camera_zone", "gone_cam/gate", "Gone camera"),
          link("m3", "camera_zone", "gone_cam/bins", "Gone camera"),
        ],
      },
    ];
    h.sources = {
      ...SOURCES,
      linkStatus: ["m1", "m2", "m3"].map((linkId) => ({ linkId, status: "missing" as const })),
    };
    render(<AreasPanel />);
    expect(card("Yard").getAllByText("Gone camera isn't set up any more")).toHaveLength(1);
  });

  it("says once per card when a link couldn't be checked", () => {
    h.sources = { ...SOURCES, frigate: "unavailable", linkStatus: SOURCES.linkStatus.map((s) => ({ ...s, status: "unknown" })) };
    render(<AreasPanel />);
    expect(card("Front door").getAllByText("Couldn't check the camera system")).toHaveLength(1);
    expect(card("Shop floor").queryByText("Couldn't check the camera system")).toBeNull();
  });

  it("treats a failed sources read as couldn't-check, and a loading one as nothing yet", () => {
    h.sources = null;
    h.sourcesError = typedError("SOURCE_CHECK_UNAVAILABLE", 503);
    const { unmount } = render(<AreasPanel />);
    expect(card("Stock room").getByText("Couldn't check the camera system")).toBeInTheDocument();
    unmount();

    h.sourcesError = undefined;
    render(<AreasPanel />);
    expect(screen.queryByText("Couldn't check the camera system")).toBeNull();
    expect(screen.queryByText(/isn't set up any more/)).toBeNull();
  });

  it("pure helpers agree with the cards", () => {
    expect(coveredByLine(FRONT)).toBe(
      "Covered by: Front camera (whole view), Back camera (the 'till' part of the view)",
    );
    // WARP-2977 P2b-2: the lock halves ride along (intended change to these pins).
    const none = { missing: [], unknown: false, missingLocks: [], unknownLocks: false };
    expect(linkProblems(STOCK, null)).toEqual(none);
    expect(linkProblems(BARE, "failed")).toEqual(none);
    expect(linkProblems(STOCK, "failed")).toEqual({ ...none, unknown: true });
  });
});

describe("AreasPanel — door locks (WARP-2977 P2b-2)", () => {
  const DOOR: SecurityZoneView = {
    id: "z-door",
    name: "Back door",
    kind: "entry",
    state: "active",
    version: 2,
    links: [link("k1", "lock", "matter:4660/1", "Back door lock"), link("k2", "lock", "matter:7/1", "Old gate lock")],
  };

  it("names a linked lock as a door lock on the card", () => {
    expect(coveredByLine({ links: [FRONT.links[0]!, DOOR.links[0]!] })).toBe(
      "Covered by: Front camera (whole view), Back door lock (door lock)",
    );
  });

  it("a lock no longer paired: its own words and its own hint — never the camera's 'comes back under the same name'", () => {
    h.zones = [DOOR];
    h.sources = {
      ...SOURCES,
      linkStatus: [
        { linkId: "k1", status: "present" },
        { linkId: "k2", status: "missing" },
      ],
      locks: { state: "ok", items: [] },
    };
    render(<AreasPanel />);
    const door = card("Back door");
    expect(door.getByText("Old gate lock isn't paired any more")).toHaveClass("badge", "warn");
    expect(door.getByText(COPY.lockReuseHint)).toBeInTheDocument();
    expect(door.queryByText(COPY.reuseHint)).toBeNull();
    expect(door.queryByText("Back door lock isn't paired any more")).toBeNull();
  });

  it("the locks couldn't be checked: 'Couldn't check the door locks', not the camera system", () => {
    h.zones = [DOOR];
    h.sources = {
      ...SOURCES,
      linkStatus: DOOR.links.map((l) => ({ linkId: l.id, status: "unknown" as const })),
      locks: { state: "unavailable", items: [] },
    };
    render(<AreasPanel />);
    expect(card("Back door").getAllByText(COPY.unknownLocks)).toHaveLength(1);
    expect(card("Back door").queryByText(COPY.unknown)).toBeNull();
  });

  it("linkProblems: a failed read flags each kind the card has — cameras, locks, or both", () => {
    expect(linkProblems(DOOR, "failed")).toEqual({ missing: [], unknown: false, missingLocks: [], unknownLocks: true });
    const both = { links: [...FRONT.links, DOOR.links[0]!] };
    expect(linkProblems(both, "failed")).toMatchObject({ unknown: true, unknownLocks: true });
  });
});

describe("AreasPanel — empty and failed reads", () => {
  it("manage sees the suggestions in the empty state", () => {
    h.zones = [OLD];
    render(<AreasPanel />);
    expect(screen.getByText(COPY.emptyTitle).closest(".empty")).toHaveTextContent(
      "No areas yet.Try Front door, Stock room or Car park.",
    );
  });

  it.each(["view", "act"])("at %s the empty state says an admin sets these up", (level) => {
    h.level = level;
    h.zones = [];
    render(<AreasPanel />);
    expect(screen.getByText(COPY.emptyTitle).closest(".empty")).toHaveTextContent(
      "No areas yet.Someone who manages Security can set these up.",
    );
  });

  it("a failed read shows the Security copy, never the server's message, and retries through mutate", () => {
    h.zones = null;
    h.zonesError = typedError("ZONES_UNAVAILABLE", 503);
    render(<AreasPanel />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Droplet couldn't load the areas right now. Try again in a moment.");
    expect(alert).not.toHaveTextContent(RAW_SERVER_MESSAGE);
    fireEvent.click(within(alert).getByRole("button", { name: COPY.retry }));
    expect(h.zonesMutate).toHaveBeenCalled();
  });
});

describe("AreasPanel — removing and restoring", () => {
  it("asks with the spec's words, then archives at the area's version", async () => {
    h.archive.mockResolvedValue({ zone: { ...STOCK, state: "archived", version: 2 }, changed: true });
    render(<AreasPanel />);
    fireEvent.click(card("Stock room").getByRole("button", { name: COPY.remove }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Stock room?" });
    expect(dialog).toHaveTextContent(
      "Events stay in the feed. They just won't be labelled Stock room any more. You can restore it later.",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.removeConfirm }));
    await waitFor(() => expect(h.archive).toHaveBeenCalledWith("z-stock", 1));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Removed Stock room.", "success"));
  });

  it("a 409 is the panel's own conflict toast (their version is already on screen — never 'refresh') and a re-read; the confirm stays open", async () => {
    h.archive.mockRejectedValue(typedError("VERSION_CONFLICT", 409));
    render(<AreasPanel />);
    fireEvent.click(card("Stock room").getByRole("button", { name: COPY.remove }));
    const dialog = await screen.findByRole("dialog", { name: "Remove Stock room?" });
    fireEvent.click(within(dialog).getByRole("button", { name: COPY.removeConfirm }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(COPY.conflict, "error"));
    expect(COPY.conflict).not.toMatch(/refresh/i);
    expect(h.toast.mock.calls.flat().join(" ")).not.toContain(RAW_SERVER_MESSAGE);
    expect(h.zonesMutate).toHaveBeenCalled();
    expect(h.sourcesMutate).toHaveBeenCalled();
    await expectStillOpen("Remove Stock room?");
  });

  it("Restore unarchives at the archived row's version", async () => {
    h.unarchive.mockResolvedValue({ zone: { ...OLD, state: "active", version: 6 }, changed: true });
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Car park" }));
    await waitFor(() => expect(h.unarchive).toHaveBeenCalledWith("z-old", 5));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Restored Car park.", "success"));
  });

  it("Restore can't be sent twice while the first is on its way", async () => {
    let settle!: (v: unknown) => void;
    h.unarchive.mockReturnValue(new Promise((r) => (settle = r)));
    render(<AreasPanel />);
    const restore = screen.getByRole("button", { name: "Restore Car park" });
    fireEvent.click(restore);
    fireEvent.click(restore);
    expect(h.unarchive).toHaveBeenCalledTimes(1);
    expect(restore).toBeDisabled();
    settle({ zone: { ...OLD, state: "active", version: 6 }, changed: true });
    await waitFor(() => expect(restore).not.toBeDisabled());
  });

  it("a refused Restore (too many areas) is a translateError toast", async () => {
    h.unarchive.mockRejectedValue(typedError("ZONE_LIMIT", 409));
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Restore Car park" }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        "You've reached the limit of 64 areas. Remove one before adding another.",
        "error",
      ),
    );
    expect(h.zonesMutate).toHaveBeenCalled();
  });
});

describe("AreasPanel — adding, changing, and what covers an area", () => {
  it("Add an area opens the side panel; a save creates it", async () => {
    h.create.mockResolvedValue({ zone: { ...BARE, id: "z-new", name: "Till", kind: "interior" } });
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_COPY.addTitle });
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Till" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Inside" }));
    fireEvent.click(within(dialog).getByRole("button", { name: DIALOG_COPY.add }));
    await waitFor(() => expect(h.create).toHaveBeenCalledWith({ name: "Till", kind: "interior" }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("Added Till. Use What covers it? to choose its cameras.", "success"),
    );
  });

  it("a taken name is a translateError toast, and the panel stays open to fix it", async () => {
    h.create.mockRejectedValue(typedError("ZONE_NAME_TAKEN", 409));
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_COPY.addTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: "Front door" }));
    fireEvent.click(within(dialog).getByRole("button", { name: DIALOG_COPY.add }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith("There's already an area with that name. Pick another name.", "error"),
    );
    await expectStillOpen(DIALOG_COPY.addTitle);
  });

  // Z1: the name is held by a REMOVED area (the server adds archivedZoneId).
  function takenByRemoved(archivedZoneId: string): Error {
    return Object.assign(new Error(RAW_SERVER_MESSAGE), {
      code: "ZONE_NAME_TAKEN",
      status: 409,
      body: { error: { code: "ZONE_NAME_TAKEN", message: RAW_SERVER_MESSAGE, archivedZoneId } },
    });
  }
  const RESTORE_INSTEAD = "A removed area already has that name. Restore it instead, or pick another name.";

  it("a name a removed area holds: says so, and the toast's Restore brings that area back and closes the add panel", async () => {
    h.create.mockRejectedValue(takenByRemoved("z-old"));
    h.unarchive.mockResolvedValue({ zone: { ...OLD, state: "active", version: 6 }, changed: true });
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_COPY.addTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: "Car park" }));
    fireEvent.click(within(dialog).getByRole("button", { name: DIALOG_COPY.add }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(RESTORE_INSTEAD, "error", { label: "Restore Car park", onClick: expect.any(Function) }),
    );
    expect(JSON.stringify(h.toast.mock.calls)).not.toContain(RAW_SERVER_MESSAGE);
    expect(h.zonesMutate).toHaveBeenCalled();
    // Still open until the person picks Restore…
    await expectStillOpen(DIALOG_COPY.addTitle);
    const action = h.toast.mock.calls.find((c) => c[0] === RESTORE_INSTEAD)![2] as { onClick: () => void };
    action.onClick();
    await waitFor(() => expect(h.unarchive).toHaveBeenCalledWith("z-old", 5));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith("Restored Car park.", "success"));
    // …then the add panel closes: the area it was about to duplicate is back.
    await waitFor(() => expect(screen.queryByRole("dialog", { name: DIALOG_COPY.addTitle })).toBeNull(), { timeout: 2000 });
  });

  it("a name a removed area holds that the page has not loaded: the copy, without a Restore action", async () => {
    h.create.mockRejectedValue(takenByRemoved("z-unknown"));
    render(<AreasPanel />);
    fireEvent.click(screen.getByRole("button", { name: COPY.add }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_COPY.addTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: "Car park" }));
    fireEvent.click(within(dialog).getByRole("button", { name: DIALOG_COPY.add }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith(RESTORE_INSTEAD, "error"));
    expect(h.unarchive).not.toHaveBeenCalled();
  });

  it("Change edits one area at its version", async () => {
    h.patch.mockResolvedValue({ zone: { ...FRONT, version: 4, kind: "perimeter" }, changed: true });
    render(<AreasPanel />);
    fireEvent.click(card("Front door").getByRole("button", { name: COPY.edit }));
    const dialog = await screen.findByRole("dialog", { name: DIALOG_COPY.editTitle });
    expect(within(dialog).getByLabelText("Name")).toHaveValue("Front door");
    fireEvent.click(within(dialog).getByRole("button", { name: "Outside" }));
    fireEvent.click(within(dialog).getByRole("button", { name: DIALOG_COPY.save }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledWith("z-front", { expectedVersion: 3, kind: "perimeter" }));
  });

  it("What covers it? opens the checklist; one Save puts the links with the area's version", async () => {
    h.putLinks.mockResolvedValue({ zone: FRONT, changed: true });
    render(<AreasPanel />);
    fireEvent.click(card("Front door").getByRole("button", { name: COPY.whatCovers }));
    const dialog = await screen.findByRole("dialog", { name: "What covers Front door?" });
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeInTheDocument();
    fireEvent.click(within(within(dialog).getByRole("group", { name: "Front camera" })).getByLabelText("porch"));
    fireEvent.click(within(dialog).getByRole("button", { name: LINKS_COPY.save }));
    await waitFor(() =>
      expect(h.putLinks).toHaveBeenCalledWith("z-front", {
        links: [
          { sourceKind: "camera", sourceRef: "front_cam" },
          { sourceKind: "camera_zone", sourceRef: "front_cam/porch" },
          { sourceKind: "camera_zone", sourceRef: "back_cam/till" },
        ],
        expectedVersion: 3,
      }),
    );
  });

  it("a link the server can't find is a translateError toast and a refresh", async () => {
    h.putLinks.mockRejectedValue(typedError("SOURCE_NOT_FOUND", 422));
    render(<AreasPanel />);
    fireEvent.click(card("Front door").getByRole("button", { name: COPY.whatCovers }));
    const dialog = await screen.findByRole("dialog", { name: "What covers Front door?" });
    fireEvent.click(within(within(dialog).getByRole("group", { name: "Front camera" })).getByLabelText("porch"));
    fireEvent.click(within(dialog).getByRole("button", { name: LINKS_COPY.save }));
    await waitFor(() =>
      expect(h.toast).toHaveBeenCalledWith(
        // WARP-2977 P2b-2: a link can be a door lock too (intended change to this pin).
        "One of those cameras, camera parts or door locks isn't set up any more, so nothing was changed. Refresh the list and try again.",
        "error",
      ),
    );
    expect(h.sourcesMutate).toHaveBeenCalled();
    await expectStillOpen("What covers Front door?");
  });
});

describe("the Areas copy", () => {
  // The page's own words (Z1's lint covers every exported COPY in the folder).
  const BANNED = [/monitor/i, /armed/i, /\barm\b/i, /alarm/i, /\bsecure\b/i, /protected/i, /guard/i, /space/i, /\bzones?\b/i];
  it.each([
    ["AreasPanel", COPY],
    ["AreaDialog", DIALOG_COPY],
    ["AreaLinksDialog", LINKS_COPY],
  ])("%s COPY uses none of the banned words", (_name, copy) => {
    const text = Object.values(copy).join(" \n ");
    for (const re of BANNED) expect(text).not.toMatch(re);
  });
});
