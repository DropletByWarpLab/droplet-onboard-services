/**
 * WARP-2977 P2b (ADR-059 §3.4) — "What covers it?".
 *
 * Pins: a checklist per camera with its Whole view and nested parts, all
 * reachable by label; the no-parts sentence; ONE save carrying the whole
 * desired set in display order with the version the ticks came from; links
 * the camera system no longer lists stay in the set until unticked; the
 * 32-link cap; loading and failure states that cannot save; and the labelled
 * Close control.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import {
  AREA_LINK_LIMIT,
  AreaLinksDialog,
  COPY,
  linkPhrase,
  partOf,
  type AreaLinksDialogProps,
} from "@/components/security/AreaLinksDialog";
import type { SecuritySourcesView, SecurityZoneLinkView, SecurityZoneView } from "@/lib/types";

const AT = "2026-09-23T10:00:00.000Z";

function link(id: string, sourceKind: SecurityZoneLinkView["sourceKind"], sourceRef: string, label: string): SecurityZoneLinkView {
  return { id, sourceKind, sourceRef, label, state: "active", stateChangedAt: AT };
}

const SOURCES: SecuritySourcesView = {
  frigate: "ok",
  cameras: [
    { name: "front_cam", label: "Front camera", parts: ["porch", "path"] },
    { name: "back_cam", label: "Back camera", parts: ["till"] },
    { name: "yard_cam", label: "Yard camera", parts: [] },
  ],
  linkStatus: [],
  // WARP-2977 P2b-2: a viewer without Devices view — no door locks anywhere.
  locks: { state: "hidden", items: [] },
};

const ZONE: SecurityZoneView = {
  id: "z-front",
  name: "Front door",
  kind: "entry",
  state: "active",
  version: 3,
  links: [link("l1", "camera", "front_cam", "Front camera"), link("l2", "camera_zone", "back_cam/till", "Back camera")],
};

function renderDialog(over: Partial<AreaLinksDialogProps> = {}) {
  const props: AreaLinksDialogProps = {
    open: true,
    zone: ZONE,
    sources: SOURCES,
    onRetrySources: vi.fn(),
    onClose: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
  const utils = render(<AreaLinksDialog {...props} />);
  return { ...utils, props };
}

const camera = (label: string) => screen.getByRole("group", { name: label });
const saveButton = () => screen.getByRole("button", { name: COPY.save });

describe("AreaLinksDialog", () => {
  it("lists each camera's Whole view and its parts, reachable by label, ticked from the area's links", () => {
    renderDialog();
    expect(screen.getByRole("dialog", { name: "What covers Front door?" })).toBeInTheDocument();

    const front = within(camera("Front camera"));
    expect(front.getByLabelText("Whole view")).toBeChecked();
    expect(front.getByLabelText("porch")).not.toBeChecked();
    expect(front.getByLabelText("path")).not.toBeChecked();

    const back = within(camera("Back camera"));
    expect(back.getByLabelText("Whole view")).not.toBeChecked();
    expect(back.getByLabelText("till")).toBeChecked();

    const yard = within(camera("Yard camera"));
    expect(yard.getByLabelText("Whole view")).not.toBeChecked();
    expect(yard.getByText(COPY.noParts)).toBeInTheDocument();
    expect(COPY.noParts).toBe(
      "Only the whole view. You can mark parts of this camera's picture in its camera settings.",
    );
  });

  it("can't save until something changed", () => {
    renderDialog();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    expect(saveButton()).not.toBeDisabled();
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    expect(saveButton()).toBeDisabled();
  });

  it("saves the whole desired set once, in display order, with the version the ticks came from", async () => {
    const { props } = renderDialog();
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    fireEvent.click(within(camera("Yard camera")).getByLabelText("Whole view"));
    fireEvent.click(within(camera("Back camera")).getByLabelText("till")); // untick
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith("z-front", {
      links: [
        { sourceKind: "camera", sourceRef: "front_cam" },
        { sourceKind: "camera_zone", sourceRef: "front_cam/porch" },
        { sourceKind: "camera", sourceRef: "yard_cam" },
      ],
      expectedVersion: 3,
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps links the camera system no longer lists, ticked, until someone unticks them", async () => {
    const zone: SecurityZoneView = {
      ...ZONE,
      links: [
        link("l1", "camera", "front_cam", "Front camera"),
        link("l3", "camera", "cam_3", "Cam 3"),
        link("l4", "camera_zone", "back_cam/shelf", "Back camera"),
      ],
    };
    const sources: SecuritySourcesView = {
      ...SOURCES,
      linkStatus: [
        { linkId: "l1", status: "present" },
        { linkId: "l3", status: "missing" },
        { linkId: "l4", status: "missing" },
      ],
    };
    const { props } = renderDialog({ zone, sources });
    const gone = within(screen.getByRole("group", { name: COPY.goneLegend }));
    expect(gone.getByText(COPY.goneHint)).toBeInTheDocument();
    expect(gone.getByLabelText("Cam 3 (whole view)")).toBeChecked();
    expect(gone.getByLabelText("Back camera (the 'shelf' part of the view)")).toBeChecked();

    // A change elsewhere keeps both gone links in the set.
    fireEvent.click(within(camera("Yard camera")).getByLabelText("Whole view"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenLastCalledWith("z-front", {
      links: [
        { sourceKind: "camera", sourceRef: "front_cam" },
        { sourceKind: "camera", sourceRef: "yard_cam" },
        { sourceKind: "camera", sourceRef: "cam_3" },
        { sourceKind: "camera_zone", sourceRef: "back_cam/shelf" },
      ],
      expectedVersion: 3,
    });
  });

  it("drops a gone link when it is unticked", async () => {
    const zone: SecurityZoneView = { ...ZONE, links: [link("l3", "camera", "cam_3", "Cam 3")] };
    const { props } = renderDialog({ zone, sources: { ...SOURCES, linkStatus: [{ linkId: "l3", status: "missing" }] } });
    fireEvent.click(screen.getByLabelText("Cam 3 (whole view)"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledWith("z-front", { links: [], expectedVersion: 3 }));
  });

  it(`refuses more than ${AREA_LINK_LIMIT} links before asking the server`, () => {
    const cameras = Array.from({ length: AREA_LINK_LIMIT + 1 }, (_, i) => ({
      name: `cam_${i}`,
      label: `Camera ${i}`,
      parts: [],
    }));
    const zone: SecurityZoneView = {
      ...ZONE,
      links: cameras.slice(0, AREA_LINK_LIMIT).map((c, i) => link(`l${i}`, "camera", c.name, c.label)),
    };
    renderDialog({ zone, sources: { ...SOURCES, cameras } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(within(camera(`Camera ${AREA_LINK_LIMIT}`)).getByLabelText("Whole view"));
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.overLimit);
    expect(saveButton()).toBeDisabled();
  });

  it("stays open when the save is rejected (the panel has shown why)", async () => {
    const onSave = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { code: "VERSION_CONFLICT", status: 409 }));
    const { props } = renderDialog({ onSave });
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(saveButton()).not.toBeDisabled());
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it("refills from a newer version of the area, and saves against that version", async () => {
    const { props, rerender } = renderDialog();
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    const newer: SecurityZoneView = { ...ZONE, version: 4, links: [link("l9", "camera", "yard_cam", "Yard camera")] };
    rerender(<AreaLinksDialog {...props} zone={newer} />);
    await waitFor(() => expect(within(camera("Yard camera")).getByLabelText("Whole view")).toBeChecked());
    expect(within(camera("Front camera")).getByLabelText("porch")).not.toBeChecked();
    expect(within(camera("Front camera")).getByLabelText("Whole view")).not.toBeChecked();
    fireEvent.click(within(camera("Back camera")).getByLabelText("till"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith("z-front", {
        links: [
          { sourceKind: "camera_zone", sourceRef: "back_cam/till" },
          { sourceKind: "camera", sourceRef: "yard_cam" },
        ],
        expectedVersion: 4,
      }),
    );
  });

  it("while the cameras load, shows no checklist and can't save", () => {
    renderDialog({ sources: null });
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(saveButton()).toBeDisabled();
  });

  it("can't save a changed checklist once the camera list is gone (it would drop links it can't show)", () => {
    const { props, rerender } = renderDialog();
    fireEvent.click(within(camera("Front camera")).getByLabelText("porch"));
    expect(saveButton()).not.toBeDisabled();
    rerender(<AreaLinksDialog {...props} sources={null} sourcesError={new Error("down")} />);
    expect(saveButton()).toBeDisabled();
  });

  it("when the cameras can't load, says so, offers a retry, and can't save", () => {
    const { props } = renderDialog({ sources: null, sourcesError: new Error("down") });
    expect(screen.getByRole("alert")).toHaveTextContent(COPY.sourcesDown);
    fireEvent.click(screen.getByRole("button", { name: COPY.retry }));
    expect(props.onRetrySources).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(saveButton()).toBeDisabled();
  });

  it("says when the camera system couldn't be checked", () => {
    renderDialog({ sources: { ...SOURCES, frigate: "unavailable" } });
    expect(screen.getByText(COPY.cameraSystemDown)).toBeInTheDocument();
  });

  // With the camera system down, /sources lists the cameras (from Droplet's
  // own camera list) with NO parts, and every linked part reads `unknown`.
  // Those parts still exist as far as anyone knows: they must stay under their
  // camera, ticked, and never be filed under "Not set up any more".
  it("with the camera system down, keeps a linked part under its camera, not under Not set up any more", async () => {
    const down: SecuritySourcesView = {
      frigate: "unavailable",
      cameras: [
        { name: "front_cam", label: "Front camera", parts: [] },
        { name: "back_cam", label: "Back camera", parts: [] },
      ],
      linkStatus: [
        { linkId: "l1", status: "present" },
        { linkId: "l2", status: "unknown" },
      ],
      locks: { state: "hidden", items: [] },
    };
    const { props } = renderDialog({ sources: down });
    expect(screen.queryByRole("group", { name: COPY.goneLegend })).toBeNull();
    expect(within(camera("Back camera")).getByLabelText("till")).toBeChecked();
    // No camera is claimed to have "only the whole view" when its parts couldn't be read.
    expect(screen.queryByText(COPY.noParts)).toBeNull();

    fireEvent.click(within(camera("Front camera")).getByLabelText("Whole view")); // untick
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith("z-front", {
        links: [{ sourceKind: "camera_zone", sourceRef: "back_cam/till" }],
        expectedVersion: 3,
      }),
    );
  });

  it("files a link it couldn't check under Couldn't check, never under Not set up any more", async () => {
    const zone: SecurityZoneView = { ...ZONE, links: [link("l1", "camera", "front_cam", "Front camera"), link("l7", "camera", "old_cam", "Old camera")] };
    const sources: SecuritySourcesView = {
      ...SOURCES,
      linkStatus: [
        { linkId: "l1", status: "present" },
        { linkId: "l7", status: "unknown" },
      ],
    };
    const { props } = renderDialog({ zone, sources });
    expect(screen.queryByRole("group", { name: COPY.goneLegend })).toBeNull();
    const unchecked = within(screen.getByRole("group", { name: COPY.uncheckedLegend }));
    expect(unchecked.getByText(COPY.uncheckedHint)).toBeInTheDocument();
    expect(unchecked.getByLabelText("Old camera (whole view)")).toBeChecked();

    fireEvent.click(within(camera("Yard camera")).getByLabelText("Whole view"));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith("z-front", {
        links: [
          { sourceKind: "camera", sourceRef: "front_cam" },
          { sourceKind: "camera", sourceRef: "yard_cam" },
          { sourceKind: "camera", sourceRef: "old_cam" },
        ],
        expectedVersion: 3,
      }),
    );
  });

  it("says when no cameras are set up at all", () => {
    renderDialog({ sources: { ...SOURCES, cameras: [] }, zone: { ...ZONE, links: [] } });
    expect(screen.getByText(COPY.noCameras)).toBeInTheDocument();
  });

  it("renders a labelled Close control that closes it", () => {
    const { props } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("link wording", () => {
  it("a part is always sourceRef after the '/'", () => {
    expect(partOf("back_cam/till")).toBe("till");
  });

  it("names the camera by its label, and the part in quotes — never the part twice", () => {
    expect(linkPhrase(link("a", "camera", "front_cam", "Front camera"))).toBe("Front camera (whole view)");
    expect(linkPhrase(link("b", "camera_zone", "back_cam/till", "Back camera"))).toBe(
      "Back camera (the 'till' part of the view)",
    );
  });
});

// ── WARP-2977 P2b-2: door locks ──────────────────────────────────────────

describe("AreaLinksDialog — door locks (WARP-2977 P2b-2)", () => {
  const LOCK_A = "matter:4660/1";
  const LOCK_B = "matter:99/2";
  const WITH_LOCKS: SecuritySourcesView = {
    ...SOURCES,
    locks: {
      state: "ok",
      items: [
        { ref: LOCK_B, nodeId: "99", endpointId: 2, label: "Annex lock", room: null, connected: false },
        { ref: LOCK_A, nodeId: "4660", endpointId: 1, label: "Back door lock", room: "Hall", connected: true },
      ],
    },
  };
  const locked = (over: Partial<SecurityZoneView> = {}): SecurityZoneView => ({
    ...ZONE,
    links: [...ZONE.links, link("l9", "lock", LOCK_A, "Back door lock")],
    ...over,
  });
  const doors = () => screen.getByRole("group", { name: COPY.locksLegend });

  it("lists every paired lock by name under Door locks, ticked from the area's lock links, with its room and whether it reports", () => {
    renderDialog({ zone: locked(), sources: WITH_LOCKS });
    const group = within(doors());
    expect(group.getByLabelText("Back door lock")).toBeChecked();
    expect(group.getByLabelText("Annex lock")).not.toBeChecked();
    expect(group.getByLabelText("Back door lock")).toHaveAccessibleDescription("Hall");
    expect(group.getByLabelText("Annex lock")).toHaveAccessibleDescription(COPY.lockNotReporting);
  });

  it("saves lock links with the cameras, after them, in the one PUT", async () => {
    const { props } = renderDialog({ zone: locked(), sources: WITH_LOCKS });
    fireEvent.click(within(doors()).getByLabelText("Annex lock"));
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave).toHaveBeenCalledWith("z-front", {
      links: [
        { sourceKind: "camera", sourceRef: "front_cam" },
        { sourceKind: "camera_zone", sourceRef: "back_cam/till" },
        { sourceKind: "lock", sourceRef: LOCK_B },
        { sourceKind: "lock", sourceRef: LOCK_A },
      ],
      expectedVersion: 3,
    });
  });

  it("a lock the smart-home service no longer lists (missing) sits under Not set up any more, ticked, until unticked", async () => {
    const zone = locked({ links: [...ZONE.links, link("l9", "lock", "matter:7/1", "Old gate lock")] });
    const { props } = renderDialog({ zone, sources: { ...WITH_LOCKS, linkStatus: [{ linkId: "l9", status: "missing" }] } });
    const gone = screen.getByRole("group", { name: COPY.goneLegend });
    const box = within(gone).getByLabelText("Old gate lock (door lock)");
    expect(box).toBeChecked();
    fireEvent.click(box);
    fireEvent.click(saveButton());
    await waitFor(() => expect(props.onSave).toHaveBeenCalledTimes(1));
    expect(props.onSave.mock.calls[0][1].links).not.toContainEqual({ sourceKind: "lock", sourceRef: "matter:7/1" });
  });

  it("the locks couldn't be checked: says so, and keeps a linked lock under Couldn't check these — never as gone", () => {
    renderDialog({
      zone: locked(),
      sources: { ...SOURCES, locks: { state: "unavailable", items: [] }, linkStatus: [{ linkId: "l9", status: "unknown" }] },
    });
    expect(screen.getByText(COPY.locksDown)).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: COPY.locksLegend })).toBeNull();
    const unchecked = screen.getByRole("group", { name: COPY.uncheckedLegend });
    expect(within(unchecked).getByLabelText("Back door lock (door lock)")).toBeChecked();
    expect(screen.queryByRole("group", { name: COPY.goneLegend })).toBeNull();
  });

  it("without Devices view there is no Door locks section at all", () => {
    renderDialog();
    expect(screen.queryByRole("group", { name: COPY.locksLegend })).toBeNull();
    expect(screen.queryByText(COPY.locksDown)).toBeNull();
  });

  it("no lock paired: no empty Door locks section", () => {
    renderDialog({ sources: { ...SOURCES, locks: { state: "ok", items: [] } } });
    expect(screen.queryByRole("group", { name: COPY.locksLegend })).toBeNull();
  });

  it("a lock link reads as '<name> (door lock)'", () => {
    expect(linkPhrase({ sourceKind: "lock", sourceRef: LOCK_A, label: "Back door lock" })).toBe("Back door lock (door lock)");
  });
});
